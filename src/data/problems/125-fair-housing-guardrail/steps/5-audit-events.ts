import type {Step} from '@/lib/types';

export const auditEventsStep: Step = {
  id: 'audit-events',
  title: 'fairhousing.audit: keyed by conversation, a text hash, an outbox, append before commit',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'audit_events',
  focus: ['guard', 'kafka', 'consumer', 'audit'],
  task: `## Task

**Starting point.** The starter's \`audit(conversation_id, direction, text, decision,
policy_version)\` builds an event (a fresh \`event_id\`, the conversation, the direction, the text,
the verdict, tier, score, reasons, policy version and a timestamp), produces it to
\`fairhousing.audit\` keyed by the event id on a producer with \`acks=1\`, flushes and answers true.
\`consume()\` polls with \`group.id = audit\`, commits the offset, then calls \`store.append_audit\`.
It serves the demo and hides five flaws.

**Failure mode the checks target.** One conversation's input and output decisions land on different
partitions and a compliance review reads them out of order. The user's question sits in a topic
retained for months. A retry after a lost acknowledgement writes a decision twice. A broker that
refuses the record loses the evidence. A consumer that crashes between its commit and its append
leaves a hole in the one store that must be complete.

- Produce with the \`conversation_id\` as the key; each event keeps its own \`event_id\`.
- The event carries \`text_hash\` (\`cache.text_hash(text)\`, SHA-256 hex) and no text.
- An idempotent producer with \`acks=all\` (the Go stack uses confluent-kafka-go for this).
- Wait at most \`ACK_TIMEOUT_S\` = 2 s for the delivery report; a failure or no report calls
  \`store.insert_outbox(event, reason)\` and \`audit\` answers false.
- The consumer appends, then commits.`,
  sequence: {
    participants: ['fhguard', 'fairhousing.audit', 'Audit consumer', 'audit store'],
    messages: [
      {
        from: 'fhguard',
        to: 'fairhousing.audit',
        label: 'produce · key = conversation_id · idempotent, acks = all',
        kind: 'sync',
      },
      {from: 'fairhousing.audit', to: 'fhguard', label: 'delivery report within 2 s', kind: 'reply'},
      {from: 'fhguard', to: 'fhguard', label: 'store.insert_outbox(event, reason) on failure', kind: 'sync'},
      {from: 'fairhousing.audit', to: 'Audit consumer', label: 'consume · group audit', kind: 'async'},
      {
        from: 'Audit consumer',
        to: 'audit store',
        label: 'append_audit(event): text hash, verdict, policy',
        kind: 'sync',
      },
      {from: 'Audit consumer', to: 'fairhousing.audit', label: 'commit the offset after the append', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'conversation-key',
      title: 'Keyed by conversation, one event id per decision',
      detail:
        "The record key is the conversation id, so one conversation's decisions share a partition and stay in order; each event carries its own `event_id`. The starter keys by the event id.",
      match: {
        python: {all: [/key\s*=\s*conversation_id/, /uuid\.uuid4\(\)/]},
        typescript: {all: [/key:\s*conversationId\b/, /randomUUID\(\)/]},
        go: {all: [/Key:\s*\[\]byte\(conversationID\)/, /uuid\.NewString\(\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(\s*Topic,\s*conversationId/, /UUID\.randomUUID\(\)/]},
        cpp: {all: [/conversation_id\.c_str\(\),\s*conversation_id\.size\(\)/, /new_uuid\(\)/]},
      },
    },
    {
      id: 'text-hash',
      title: 'The event carries a hash of the text, not the text',
      detail:
        'The payload has `text_hash` (the SHA-256 hex of the text) and no text field: the topic is retained and mirrored for months, longer than any rule about who may read a user’s question.',
      match: {
        python: {all: [/text_hash/], none: [/["']text["']\s*:/]},
        typescript: {all: [/text_hash/], none: [/^\s*text,?\s*$/m, /\btext:\s*text\b/]},
        go: {all: [/text_hash/], none: [/"text":\s*text\b/]},
        scala: {all: [/text_hash/], none: [/"text"\s*->/]},
        cpp: {all: [/text_hash/], none: [/\{"text",\s*text\}/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer enables idempotence and waits for every in-sync replica, so a retry after a lost acknowledgement writes the event once and a leader failover keeps it.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/enable\.idempotence|ENABLE_IDEMPOTENCE_CONFIG/, /"acks"|ACKS_CONFIG/]},
        cpp: {all: [/set\("enable\.idempotence",\s*"true"/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'A refused or unacknowledged event goes to the outbox',
      detail:
        'The delivery report (`on_delivery`, the rejected `send`, the delivery channel, the future, `dr_cb`) is awaited for at most 2 s; a failure or no report writes `store.insert_outbox(event, reason)` and `audit` answers false. The starter ignores the report.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /on_delivery\s*=/], none: [/except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*AckTimeoutMs/]},
        cpp: {all: [/store::insertOutbox\(/, /dr_cb/]},
      },
    },
    {
      id: 'append-before-commit',
      title: 'Appends to the audit store before committing the offset',
      detail:
        'The consumer appends the event (`append_audit`) and only then commits its offset; committed first, a crash in between loses the row for good.',
      match: {
        python: {order: [/store\.append_audit\(/, /consumer\.commit\(/]},
        typescript: {order: [/appendAudit\(/, /commitOffsets\(/]},
        go: {order: [/store\.AppendAudit\(/, /\.CommitMessage\(/]},
        scala: {order: [/Store\.appendAudit\(/, /\.commitSync\(/]},
        cpp: {order: [/store::appendAudit\(/, /->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time
import uuid

from confluent_kafka import Consumer, Producer

from fhguard import cache  # text_hash(text) -> SHA-256 hex
from fhguard import store  # append_audit(event) -> bool, insert_outbox(event, reason)
from fhguard.store import Decision

AUDIT_TOPIC = "fairhousing.audit"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def audit(conversation_id: str, direction: str, text: str, decision: Decision, policy_version: str) -> bool:
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
    producer.flush(2)
    return True


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "audit", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([AUDIT_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(msg, asynchronous=False)
        store.append_audit(json.loads(msg.value()))
`,
      solution: `import json
import time
import uuid

from confluent_kafka import Consumer, Producer

from fhguard import cache  # text_hash(text) -> SHA-256 hex
from fhguard import store  # append_audit(event) -> bool, insert_outbox(event, reason)
from fhguard.store import Decision

AUDIT_TOPIC = "fairhousing.audit"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "enable.idempotence": True,  # a retry after a lost acknowledgement lands once
    "acks": "all",  # every in-sync replica has the event before the broker answers
})


def audit(conversation_id: str, direction: str, text: str, decision: Decision, policy_version: str) -> bool:
    event = {
        "event_id": str(uuid.uuid4()),
        "conversation_id": conversation_id,
        "direction": direction,
        "text_hash": cache.text_hash(text),
        "allowed": decision.allowed,
        "tier": decision.tier,
        "score": decision.score,
        "reasons": decision.reasons,
        "policy_version": policy_version,
        "ts": int(time.time() * 1000),
    }
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(AUDIT_TOPIC, key=conversation_id, value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        store.insert_outbox(event, str(outcome.get("error") or "no acknowledgement within 2 s"))
        return False
    return True


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "audit", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([AUDIT_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        store.append_audit(json.loads(msg.value()))
        consumer.commit(msg, asynchronous=False)  # after the append: a crash in between redelivers, and the append dedupes by event_id
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {textHash} from 'fhguard/cache';
import {type Decision, appendAudit, insertOutbox} from 'fhguard/store';

export const AUDIT_TOPIC = 'fairhousing.audit';

const kafka = new Kafka({clientId: 'fhguard', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export async function audit(
  conversationId: string,
  direction: string,
  text: string,
  decision: Decision,
  policyVersion: string,
): Promise<boolean> {
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
  await producer.send({topic: AUDIT_TOPIC, messages: [{key: eventId, value: JSON.stringify(event)}], acks: 1});
  return true;
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'audit'});
  await consumer.connect();
  await consumer.subscribe({topic: AUDIT_TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await appendAudit(JSON.parse(message.value?.toString() ?? '{}'));
    },
  });
}
`,
      solution: `import {randomUUID} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {textHash} from 'fhguard/cache';
import {type Decision, appendAudit, insertOutbox} from 'fhguard/store';

export const AUDIT_TOPIC = 'fairhousing.audit';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'fhguard', brokers: ['kafka:9092']});
// Idempotent: a retry after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

export async function audit(
  conversationId: string,
  direction: string,
  text: string,
  decision: Decision,
  policyVersion: string,
): Promise<boolean> {
  const event = {
    event_id: randomUUID(),
    conversation_id: conversationId,
    direction,
    text_hash: textHash(text),
    allowed: decision.allowed,
    tier: decision.tier,
    score: decision.score,
    reasons: decision.reasons,
    policy_version: policyVersion,
    ts: Date.now(),
  };
  try {
    // acks: -1 (all): every in-sync replica has the event before the broker answers.
    await producer.send({
      topic: AUDIT_TOPIC,
      messages: [{key: conversationId, value: JSON.stringify(event)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    await insertOutbox(event, (err as Error).message);
    return false;
  }
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'audit'});
  await consumer.connect();
  await consumer.subscribe({topic: AUDIT_TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await appendAudit(JSON.parse(message.value?.toString() ?? '{}'));
      // After the append: a crash in between redelivers, and the append dedupes by event_id.
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/google/uuid"

	"fhguard/store" // AppendAudit(ctx, event) (bool, error), InsertOutbox(ctx, event, reason); Decision
)

const auditTopic = "fairhousing.audit"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func audit(ctx context.Context, conversationID, direction, text string, decision store.Decision, policyVersion string) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	eventID := uuid.NewString()
	event := map[string]any{
		"event_id":        eventID,
		"conversation_id": conversationID,
		"direction":       direction,
		"text":            text,
		"allowed":         decision.Allowed,
		"tier":            decision.Tier,
		"score":           decision.Score,
		"reasons":         decision.Reasons,
		"policy_version":  policyVersion,
		"ts":              time.Now().UnixMilli(),
	}
	value, _ := json.Marshal(event)
	t := auditTopic
	if err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(eventID), Value: value}, nil); err != nil {
		return false, err
	}
	producer.Flush(2000)
	return true, nil
}

func consume(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": "audit", "enable.auto.commit": false, "auto.offset.reset": "earliest"})
	if err != nil {
		return err
	}
	defer consumer.Close()
	if err := consumer.Subscribe(auditTopic, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(time.Second)
		if err != nil {
			continue // nothing new within the second
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
		var event map[string]any
		if json.Unmarshal(msg.Value, &event) != nil {
			continue
		}
		if _, err := store.AppendAudit(ctx, event); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/google/uuid"

	"fhguard/cache" // TextHash(text) string: SHA-256 hex
	"fhguard/store" // AppendAudit(ctx, event) (bool, error), InsertOutbox(ctx, event, reason); Decision
)

const (
	auditTopic = "fairhousing.audit"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"enable.idempotence": true,  // a retry after a lost acknowledgement lands once
		"acks":               "all", // every in-sync replica has the event before the broker answers
	})
	if err != nil {
		panic(err)
	}
	return p
}

func audit(ctx context.Context, conversationID, direction, text string, decision store.Decision, policyVersion string) (bool, error) {
	event := map[string]any{
		"event_id":        uuid.NewString(),
		"conversation_id": conversationID,
		"direction":       direction,
		"text_hash":       cache.TextHash(text),
		"allowed":         decision.Allowed,
		"tier":            decision.Tier,
		"score":           decision.Score,
		"reasons":         decision.Reasons,
		"policy_version":  policyVersion,
		"ts":              time.Now().UnixMilli(),
	}
	value, _ := json.Marshal(event)
	t := auditTopic
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(conversationID), Value: value}, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no acknowledgement within the window
		}
	}
	if err != nil {
		return false, store.InsertOutbox(ctx, event, err.Error())
	}
	return true, nil
}

func consume(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": "audit", "enable.auto.commit": false, "auto.offset.reset": "earliest"})
	if err != nil {
		return err
	}
	defer consumer.Close()
	if err := consumer.Subscribe(auditTopic, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(time.Second)
		if err != nil {
			continue // nothing new within the second
		}
		var event map[string]any
		if json.Unmarshal(msg.Value, &event) == nil {
			if _, err := store.AppendAudit(ctx, event); err != nil {
				return err // not committed: the event is redelivered
			}
		}
		// After the append: a crash in between redelivers, and the append dedupes by event_id.
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.{Properties, UUID}

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import scala.jdk.CollectionConverters._

import fhguard.{Cache, Store} // Cache.textHash(text); Store.appendAudit(event), Store.insertOutbox(event, reason)

object AuditEvents {
  val Topic = "fairhousing.audit"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def audit(conversationId: String, direction: String, text: String, decision: Store.Decision, policyVersion: String): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val eventId = UUID.randomUUID().toString
    val event = JsObject(
      "event_id" -> JsString(eventId),
      "conversation_id" -> JsString(conversationId),
      "direction" -> JsString(direction),
      "text" -> JsString(text),
      "allowed" -> JsBoolean(decision.allowed),
      "tier" -> JsString(decision.tier),
      "score" -> JsNumber(decision.score),
      "reasons" -> JsArray(decision.reasons.map(JsString(_)).toVector),
      "policy_version" -> JsString(policyVersion),
      "ts" -> JsNumber(System.currentTimeMillis()),
    )
    producer.send(new ProducerRecord[String, String](Topic, eventId, event.compactPrint))
    producer.flush()
    true
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "audit")
    props.put("enable.auto.commit", "false")
    props.put("auto.offset.reset", "earliest")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync()
        Store.appendAudit(record.value().parseJson.asJsObject)
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.concurrent.TimeUnit
import java.util.{Properties, UUID}

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import scala.jdk.CollectionConverters._
import scala.util.Try

import fhguard.{Cache, Store} // Cache.textHash(text); Store.appendAudit(event), Store.insertOutbox(event, reason)

object AuditEvents {
  val Topic = "fairhousing.audit"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("enable.idempotence", "true") // a retry after a lost acknowledgement lands once
    props.put("acks", "all") // every in-sync replica has the event before the broker answers
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def audit(conversationId: String, direction: String, text: String, decision: Store.Decision, policyVersion: String): Boolean = {
    val event = JsObject(
      "event_id" -> JsString(UUID.randomUUID().toString),
      "conversation_id" -> JsString(conversationId),
      "direction" -> JsString(direction),
      "text_hash" -> JsString(Cache.textHash(text)),
      "allowed" -> JsBoolean(decision.allowed),
      "tier" -> JsString(decision.tier),
      "score" -> JsNumber(decision.score),
      "reasons" -> JsArray(decision.reasons.map(JsString(_)).toVector),
      "policy_version" -> JsString(policyVersion),
      "ts" -> JsNumber(System.currentTimeMillis()),
    )
    val record = new ProducerRecord[String, String](Topic, conversationId, event.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    acked.failed.foreach(e => Store.insertOutbox(event, String.valueOf(e.getMessage)))
    acked.isSuccess
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "audit")
    props.put("enable.auto.commit", "false")
    props.put("auto.offset.reset", "earliest")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        Store.appendAudit(record.value().parseJson.asJsObject)
        consumer.commitSync() // after the append: a crash in between redelivers, and the append dedupes by event_id
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>

#include "fhguard/cache.h"  // cache::textHash(text): SHA-256 hex
#include "fhguard/store.h"  // store::appendAudit(event), store::insertOutbox(event, reason); Decision
#include "ids.h"            // new_uuid()

using json = nlohmann::json;

const std::string kAuditTopic = "fairhousing.audit";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

bool audit(const std::string& conversation_id, const std::string& direction, const std::string& text, const store::Decision& decision,
           const std::string& policy_version) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string event_id = new_uuid();
  const json event = {{"event_id", event_id},       {"conversation_id", conversation_id}, {"direction", direction},
                      {"text", text},               {"allowed", decision.allowed},        {"tier", decision.tier},
                      {"score", decision.score},    {"reasons", decision.reasons},        {"policy_version", policy_version},
                      {"ts", nowMs()}};
  const std::string value = event.dump();
  producer->produce(kAuditTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), event_id.c_str(), event_id.size(), 0, nullptr);
  producer->flush(2000);
  return true;
}

void consume() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "audit", err);
  conf->set("enable.auto.commit", "false", err);
  conf->set("auto.offset.reset", "earliest", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kAuditTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (event.is_object()) store::appendAudit(event);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>

#include "fhguard/cache.h"  // cache::textHash(text): SHA-256 hex
#include "fhguard/store.h"  // store::appendAudit(event), store::insertOutbox(event, reason); Decision
#include "ids.h"            // new_uuid()

using json = nlohmann::json;

const std::string kAuditTopic = "fairhousing.audit";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the event in flight: audit produces one event and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);  // a retry after a lost acknowledgement lands once
  conf->set("acks", "all", err);                 // every in-sync replica has the event before the broker answers
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

bool audit(const std::string& conversation_id, const std::string& direction, const std::string& text, const store::Decision& decision,
           const std::string& policy_version) {
  const json event = {{"event_id", new_uuid()},             {"conversation_id", conversation_id}, {"direction", direction},
                      {"text_hash", cache::textHash(text)}, {"allowed", decision.allowed},        {"tier", decision.tier},
                      {"score", decision.score},            {"reasons", decision.reasons},        {"policy_version", policy_version},
                      {"ts", nowMs()}};
  const std::string value = event.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kAuditTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), conversation_id.c_str(), conversation_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(event, RdKafka::err2str(err));
    return false;
  }
  return true;
}

void consume() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "audit", err);
  conf->set("enable.auto.commit", "false", err);
  conf->set("auto.offset.reset", "earliest", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kAuditTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (event.is_object()) store::appendAudit(event);
    consumer->commitSync(msg.get());  // after the append: a crash in between redelivers, and the append dedupes by event_id
  }
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

from fhguard import store
from fhguard.store import Decision

TOPIC = "fairhousing.audit"
VERSION = "fh-2024-05-21"
QUESTION = "Which blocks have fewer families with kids?"
BLOCKED = Decision(False, "classifier", 0.4, ["classifier:familial_status"])
ALLOWED = Decision(True, "classifier", 0.04, [])


def _seed(ctx, n, conversation_id):
    event = {"event_id": f"e-{n}", "conversation_id": conversation_id, "direction": "input", "text_hash": f"{n:064x}", "allowed": True, "tier": "classifier", "score": 0.04, "reasons": [], "policy_version": VERSION, "ts": n}
    ctx.kafka.seed(TOPIC, key=conversation_id, value=json.dumps(event))


def check_conversation_key(ctx):
    m = ctx.load("audit_events")
    m.audit("c-1", "input", QUESTION, BLOCKED, VERSION)
    m.audit("c-2", "input", "Homes near light rail under $900k", ALLOWED, VERSION)
    m.audit("c-1", "output", "Columbia City has three-bedroom homes in your budget.", ALLOWED, VERSION)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three audit calls produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"c-1", b"c-2", b"c-1"], f"the records are keyed {keys}, expected the conversation ids c-1, c-2, c-1"
    assert records[0].partition == records[2].partition, "both decisions of conversation c-1 must land on one partition, or a review reads them out of order"
    ids = [json.loads(r.value).get("event_id") for r in records]
    assert all(ids) and len(set(ids)) == 3, f"each event needs its own event_id, got {ids}"


def check_text_hash(ctx):
    m = ctx.load("audit_events")
    m.audit("c-1", "input", QUESTION, BLOCKED, VERSION)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one audit call produced {len(records)} records"
    raw = records[0].value.decode()
    assert "families" not in raw, f"the audit event carries the user's question: {raw}"
    event = json.loads(raw)
    expected = hashlib.sha256(QUESTION.encode("utf-8")).hexdigest()
    assert event.get("text_hash") == expected, f"text_hash is {event.get('text_hash')!r}, expected the SHA-256 hex of the text"
    assert event.get("allowed") is False and event.get("reasons") == BLOCKED.reasons and event.get("policy_version") == VERSION, f"the event must carry the verdict, reasons and policy version: {event}"


def check_idempotent_acks(ctx):
    m = ctx.load("audit_events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.audit("c-1", "input", QUESTION, BLOCKED, VERSION)
    count = len(ctx.kafka.records(TOPIC))
    assert count == 1, f"after one lost acknowledgement the topic holds {count} records: the producer's retry wrote the decision twice. Enable idempotence"
    m.audit("c-2", "input", QUESTION, BLOCKED, VERSION)
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the event the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("audit_events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.audit("c-1", "input", QUESTION, BLOCKED, VERSION)
    rows = store.outbox_rows()
    assert len(rows) == 1, f"the broker refused the event and the outbox holds {len(rows)} rows: the decision is gone from the audit trail"
    event = rows[0].get("event", {})
    assert event.get("conversation_id") == "c-1" and event.get("event_id") and rows[0].get("reason"), f"the outbox row must carry the event and the broker's reason: {rows[0]}"
    assert ok is False, f"audit returned {ok!r} after a refused delivery, expected False"
    ok = m.audit("c-2", "input", QUESTION, BLOCKED, VERSION)
    assert ok is True and len(ctx.kafka.records(TOPIC)) == 1, "once the broker accepts events again they reach the topic and audit returns True"
    assert len(store.outbox_rows()) == 1, "a delivered event must not be written to the outbox"


def check_append_before_commit(ctx):
    for n, conversation_id in ((1, "c-1"), (2, "c-2"), (3, "c-1")):
        _seed(ctx, n, conversation_id)
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(len(store.audit_rows())))
    m = ctx.load("audit_events")
    ctx.drain(m.consume)
    assert at_commit, "the consumer never committed an offset"
    assert at_commit[0] >= 1, f"at the first commit the audit store held {at_commit[0]} rows: append first, or a crash between the commit and the append loses the row"
    ids = sorted(row.get("event_id") for row in store.audit_rows())
    assert ids == ["e-1", "e-2", "e-3"], f"the audit store holds {ids}, expected e-1, e-2, e-3"
    assert ctx.kafka.lag("audit", TOPIC) == 0, "every appended event must be committed"
`,
    typescript: `const TOPIC = 'fairhousing.audit';
const VERSION = 'fh-2024-05-21';
const QUESTION = 'Which blocks have fewer families with kids?';
const BLOCKED = {allowed: false, tier: 'classifier', score: 0.4, reasons: ['classifier:familial_status']};
const ALLOWED = {allowed: true, tier: 'classifier', score: 0.04, reasons: []};

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const store = ctx => ctx.load('/support/fhguard/store.ts');

function seed(ctx, n: number, conversationId: string) {
  const event = {event_id: \`e-\${n}\`, conversation_id: conversationId, direction: 'input', text_hash: String(n).padStart(64, '0'), allowed: true, tier: 'classifier', score: 0.04, reasons: [], policy_version: VERSION, ts: n};
  ctx.kafka.seed(TOPIC, {key: conversationId, value: JSON.stringify(event)});
}

export async function check_conversation_key(ctx) {
  const m = ctx.load('audit_events');
  await m.audit('c-1', 'input', QUESTION, BLOCKED, VERSION);
  await m.audit('c-2', 'input', 'Homes near light rail under $900k', ALLOWED, VERSION);
  await m.audit('c-1', 'output', 'Columbia City has three-bedroom homes in your budget.', ALLOWED, VERSION);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three audit calls produced \${records.length} records on \${TOPIC}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['c-1', 'c-2', 'c-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the conversation ids c-1, c-2, c-1\`);
  assert.equal(records[0].partition, records[2].partition, 'both decisions of conversation c-1 must land on one partition, or a review reads them out of order');
  const ids = ctx.kafka.values(TOPIC).map(v => JSON.parse(v).event_id);
  assert(ids.every(Boolean) && new Set(ids).size === 3, \`each event needs its own event_id, got \${JSON.stringify(ids)}\`);
}

export async function check_text_hash(ctx) {
  const m = ctx.load('audit_events');
  await m.audit('c-1', 'input', QUESTION, BLOCKED, VERSION);
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one audit call produced \${values.length} records\`);
  assert(!values[0].includes('families'), \`the audit event carries the user's question: \${values[0]}\`);
  const event = JSON.parse(values[0]);
  const {textHash} = ctx.load('/support/fhguard/cache.ts');
  assert.equal(event.text_hash, textHash(QUESTION), \`text_hash is \${JSON.stringify(event.text_hash)}, expected the SHA-256 hex of the text\`);
  assert(event.allowed === false && JSON.stringify(event.reasons) === JSON.stringify(BLOCKED.reasons) && event.policy_version === VERSION, \`the event must carry the verdict, reasons and policy version: \${values[0]}\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('audit_events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.audit('c-1', 'input', QUESTION, BLOCKED, VERSION);
  await settle();
  const count = ctx.kafka.records(TOPIC).length;
  assert.equal(count, 1, \`after one lost acknowledgement the topic holds \${count} records: the producer's retry wrote the decision twice. Enable idempotence\`);
  await m.audit('c-2', 'input', QUESTION, BLOCKED, VERSION);
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the event the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('audit_events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok;
  try {
    ok = await m.audit('c-1', 'input', QUESTION, BLOCKED, VERSION);
  } catch (e) {
    assert.fail(\`audit threw when the broker refused the event (\${(e as Error).message}): write the event to the outbox instead\`);
  }
  await settle();
  const rows = await store(ctx).outboxRows();
  assert.equal(rows.length, 1, \`the broker refused the event and the outbox holds \${rows.length} rows: the decision is gone from the audit trail\`);
  assert(rows[0].event?.conversation_id === 'c-1' && rows[0].event?.event_id && rows[0].reason, \`the outbox row must carry the event and the broker's reason: \${JSON.stringify(rows[0])}\`);
  assert.equal(ok, false, \`audit resolved \${JSON.stringify(ok)} after a refused delivery, expected false\`);
  ok = await m.audit('c-2', 'input', QUESTION, BLOCKED, VERSION);
  await settle();
  assert(ok === true && ctx.kafka.records(TOPIC).length === 1, 'once the broker accepts events again they reach the topic and audit resolves true');
  assert.equal((await store(ctx).outboxRows()).length, 1, 'a delivered event must not be written to the outbox');
}

export async function check_append_before_commit(ctx) {
  for (const [n, conversationId] of [[1, 'c-1'], [2, 'c-2'], [3, 'c-1']] as const) seed(ctx, n, conversationId);
  const s = store(ctx);
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.hlen('fhstore:audit')));
  const m = ctx.load('audit_events');
  await ctx.drain(m.consume());
  assert(atCommit.length > 0, 'the consumer never committed an offset');
  assert(atCommit[0] >= 1, \`at the first commit the audit store held \${atCommit[0]} rows: append first, or a crash between the commit and the append loses the row\`);
  const ids = (await s.auditRows()).map(row => row.event_id).sort();
  assert.deepEqual(ids, ['e-1', 'e-2', 'e-3'], \`the audit store holds \${JSON.stringify(ids)}, expected e-1, e-2, e-3\`);
  assert.equal(ctx.kafka.lag('audit', TOPIC), 0, 'every appended event must be committed');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"fhguard/store"

	"leetbuild/harness"
)

const (
	auditTopicName = "fairhousing.audit"
	auditVersion   = "fh-2024-05-21"
	auditQuestion  = "Which blocks have fewer families with kids?"
)

var (
	auditBg      = context.Background()
	auditBlocked = store.Decision{Allowed: false, Tier: "classifier", Score: 0.4, Reasons: []string{"classifier:familial_status"}}
	auditAllowed = store.Decision{Allowed: true, Tier: "classifier", Score: 0.04, Reasons: []string{}}
)

func record(ctx *harness.Ctx, conversationID, direction, text string, decision store.Decision) bool {
	ok, err := audit(auditBg, conversationID, direction, text, decision, auditVersion)
	ctx.NoError(err, "audit(%s) failed", conversationID)
	return ok
}

func seedAudit(ctx *harness.Ctx, n int, conversationID string) {
	event := map[string]any{"event_id": fmt.Sprintf("e-%d", n), "conversation_id": conversationID, "direction": "input", "text_hash": fmt.Sprintf("%064d", n), "allowed": true, "tier": "classifier", "score": 0.04, "reasons": []string{}, "policy_version": auditVersion, "ts": n}
	value, _ := json.Marshal(event)
	ctx.Kafka.Seed(auditTopicName, conversationID, string(value))
}

func CheckConversationKey(ctx *harness.Ctx) {
	record(ctx, "c-1", "input", auditQuestion, auditBlocked)
	record(ctx, "c-2", "input", "Homes near light rail under $900k", auditAllowed)
	record(ctx, "c-1", "output", "Columbia City has three-bedroom homes in your budget.", auditAllowed)
	ctx.Settle()
	records := ctx.Kafka.Records(auditTopicName)
	ctx.Equal(len(records), 3, "three audit calls; the records on %s", auditTopicName)
	ctx.Equal(ctx.Kafka.Keys(auditTopicName), []string{"c-1", "c-2", "c-1"}, "the records must be keyed by the conversation ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both decisions of conversation c-1 must land on one partition, or a review reads them out of order; the partitions")
	seen := map[string]bool{}
	for _, v := range ctx.Kafka.Values(auditTopicName) {
		var event map[string]any
		json.Unmarshal([]byte(v), &event)
		id, _ := event["event_id"].(string)
		ctx.Assert(id != "", "each event needs its own event_id, got %s", v)
		seen[id] = true
	}
	ctx.Equal(len(seen), 3, "each event needs its own event_id; the distinct ids")
}

func CheckTextHash(ctx *harness.Ctx) {
	record(ctx, "c-1", "input", auditQuestion, auditBlocked)
	ctx.Settle()
	values := ctx.Kafka.Values(auditTopicName)
	ctx.Equal(len(values), 1, "one audit call; the records")
	ctx.Assert(!strings.Contains(values[0], "families"), "the audit event carries the user's question: %s", values[0])
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the event must be JSON")
	sum := sha256.Sum256([]byte(auditQuestion))
	ctx.Equal(event["text_hash"], hex.EncodeToString(sum[:]), "text_hash must be the SHA-256 hex of the text")
	ctx.Assert(event["allowed"] == false && event["policy_version"] == auditVersion, "the event must carry the verdict and the policy version: %s", values[0])
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(auditTopicName, 1) // the broker wrote it, the acknowledgement never arrived
	record(ctx, "c-1", "input", auditQuestion, auditBlocked)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(auditTopicName)), 1, "after one lost acknowledgement the producer's retry must not write the decision twice (enable.idempotence); the records")
	record(ctx, "c-2", "input", auditQuestion, auditBlocked)
	ctx.Settle()
	ctx.Kafka.Failover(auditTopicName) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(auditTopicName)), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(auditTopicName, 1)
	ok := record(ctx, "c-1", "input", auditQuestion, auditBlocked)
	ctx.Settle()
	rows := store.OutboxRows(auditBg)
	ctx.Equal(len(rows), 1, "the broker refused the event: without an outbox row the decision is gone from the audit trail; the rows")
	ctx.Assert(rows[0].Event["conversation_id"] == "c-1" && rows[0].Event["event_id"] != nil && rows[0].Reason != "", "the outbox row must carry the event and the broker's reason: %+v", rows[0])
	ctx.Equal(ok, false, "audit's result after a refused delivery")
	ok = record(ctx, "c-2", "input", auditQuestion, auditBlocked)
	ctx.Settle()
	ctx.Assert(ok && len(ctx.Kafka.Records(auditTopicName)) == 1, "once the broker accepts events again they reach the topic and audit returns true")
	ctx.Equal(len(store.OutboxRows(auditBg)), 1, "a delivered event must not be written to the outbox; the rows")
}

func CheckAppendBeforeCommit(ctx *harness.Ctx) {
	seedAudit(ctx, 1, "c-1")
	seedAudit(ctx, 2, "c-2")
	seedAudit(ctx, 3, "c-1")
	var atCommit []int64
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, ctx.Redis.HLen("fhstore:audit")) })
	ctx.Drain(func() { consume(auditBg) })
	ctx.Assert(len(atCommit) > 0, "the consumer never committed an offset")
	ctx.Assert(atCommit[0] >= 1, "at the first commit the audit store held %d rows: append first, or a crash between the commit and the append loses the row", atCommit[0])
	var ids []string
	for _, row := range store.AuditRows(auditBg) {
		id, _ := row["event_id"].(string)
		ids = append(ids, id)
	}
	sort.Strings(ids)
	ctx.Equal(ids, []string{"e-1", "e-2", "e-3"}, "the audit store's event ids")
	ctx.Equal(ctx.Kafka.Lag("audit", auditTopicName), 0, "every appended event must be committed; the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

#include "digest.h"
#include "fhguard/store.h"

namespace {

const std::string kTopic = "fairhousing.audit";
const std::string kVersion = "fh-2024-05-21";
const std::string kQuestion = "Which blocks have fewer families with kids?";
const store::Decision kBlocked{false, "classifier", 0.4, {"classifier:familial_status"}};
const store::Decision kAllowed{true, "classifier", 0.04, {}};

void seedAudit(harness::Ctx& ctx, int n, const std::string& conversation_id) {
  const nlohmann::json event = {{"event_id", "e-" + std::to_string(n)}, {"conversation_id", conversation_id}, {"direction", "input"},
                                {"text_hash", std::string(63, '0') + std::to_string(n)}, {"allowed", true}, {"tier", "classifier"},
                                {"score", 0.04}, {"reasons", nlohmann::json::array()}, {"policy_version", kVersion}, {"ts", n}};
  ctx.Kafka.Seed(kTopic, conversation_id, event.dump());
}

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckConversationKey(harness::Ctx& ctx) {
  audit("c-1", "input", kQuestion, kBlocked, kVersion);
  audit("c-2", "input", "Homes near light rail under $900k", kAllowed, kVersion);
  audit("c-1", "output", "Columbia City has three-bedroom homes in your budget.", kAllowed, kVersion);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three audit calls; the records on %s", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"c-1", "c-2", "c-1"}, "the records must be keyed by the conversation ids");
  ctx.Equal(records[0].Partition, records[2].Partition, "both decisions of conversation c-1 must land on one partition, or a review reads them out of order; the partitions");
  std::set<std::string> ids;
  for (const auto& v : ctx.Kafka.Values(kTopic)) {
    const std::string id = field(nlohmann::json::parse(v, nullptr, false), "event_id");
    ctx.Assert(!id.empty(), "each event needs its own event_id, got %s", v);
    ids.insert(id);
  }
  ctx.Equal(ids.size(), 3, "each event needs its own event_id; the distinct ids");
}

void CheckTextHash(harness::Ctx& ctx) {
  audit("c-1", "input", kQuestion, kBlocked, kVersion);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kTopic);
  ctx.Equal(values.size(), 1, "one audit call; the records");
  ctx.Assert(values[0].find("families") == std::string::npos, "the audit event carries the user's question: %s", values[0]);
  const auto event = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Equal(field(event, "text_hash"), sha256_hex(kQuestion), "text_hash must be the SHA-256 hex of the text");
  ctx.Assert(event.is_object() && event.value("allowed", true) == false && field(event, "policy_version") == kVersion, "the event must carry the verdict and the policy version: %s", values[0]);
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  audit("c-1", "input", kQuestion, kBlocked, kVersion);
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the decision twice (enable.idempotence); the records");
  audit("c-2", "input", kQuestion, kBlocked, kVersion);
  ctx.Settle();
  ctx.Kafka.Failover(kTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  bool ok = audit("c-1", "input", kQuestion, kBlocked, kVersion);
  ctx.Settle();
  auto rows = store::outboxRows();
  ctx.Equal(rows.size(), 1, "the broker refused the event: without an outbox row the decision is gone from the audit trail; the rows");
  ctx.Assert(rows[0].contains("event") && field(rows[0]["event"], "conversation_id") == "c-1" && !field(rows[0]["event"], "event_id").empty() && !field(rows[0], "reason").empty(),
             "the outbox row must carry the event and the broker's reason: %s", rows[0].dump());
  ctx.Equal(ok, false, "audit's result after a refused delivery");
  ok = audit("c-2", "input", kQuestion, kBlocked, kVersion);
  ctx.Settle();
  ctx.Assert(ok && ctx.Kafka.Records(kTopic).size() == 1, "once the broker accepts events again they reach the topic and audit returns true");
  ctx.Equal(store::outboxRows().size(), 1, "a delivered event must not be written to the outbox; the rows");
}

void CheckAppendBeforeCommit(harness::Ctx& ctx) {
  seedAudit(ctx, 1, "c-1");
  seedAudit(ctx, 2, "c-2");
  seedAudit(ctx, 3, "c-1");
  std::vector<size_t> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(store::auditRows().size()); });
  ctx.Drain([] { consume(); });
  ctx.Assert(!atCommit.empty(), "the consumer never committed an offset");
  ctx.Assert(atCommit[0] >= 1, "at the first commit the audit store held %d rows: append first, or a crash between the commit and the append loses the row", atCommit[0]);
  std::vector<std::string> ids;
  for (const auto& row : store::auditRows()) ids.push_back(field(row, "event_id"));
  std::sort(ids.begin(), ids.end());
  ctx.Equal(ids, std::vector<std::string>{"e-1", "e-2", "e-3"}, "the audit store's event ids");
  ctx.Equal(ctx.Kafka.Lag("audit", kTopic), 0, "every appended event must be committed; the lag");
}
`,
  },
  hints: [
    'A compliance reviewer sees an output decision before the input decision it followed, reads the user’s question in the row, and finds a decision missing from the hour the broker restarted.',
    'The key decides the partition and the key is a per-event UUID. The event copies the text. The delivery report is never read, so a refusal looks like success. The consumer commits before it appends.',
    'Key by `conversation_id`; put `cache.text_hash(text)` in place of the text; `enable.idempotence` with `acks=all`; an `on_delivery` that records the error, `flush(ACK_TIMEOUT_S)`, then `store.insert_outbox`; `append_audit`, then `commit`.',
  ],
  debrief: `The audit trail is the evidence that the guard did its job, so every choice here protects completeness and order. The conversation key keeps a turn's input and output decisions in one partition, where Kafka orders them. The text hash proves which text was judged without keeping it: a reviewer with the original can match it, and nobody can read it back from the topic. Idempotence plus acks=all makes the record durable and single; the outbox turns a broker outage into a delay. Appending before committing means a crash replays an event, and the store's one-row-per-event_id append absorbs the replay. Production audit pipelines also sign or chain the rows so a deletion is detectable, and keep the outbox in the same transaction as the decision.`,
};
