import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Moderation events keyed by content id, reporter stripped',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'db'],
  task: `## Task

**Starting point.** The starter's \`publish(content_id, reporter_id, action, rule, detail)\` sends
one record to \`moderation.action\` with a default producer, keyed by the reporter id and carrying
the action, the rule, the reporter id and the report detail, then commits the consumer offset. It
compiles, serves the demo and hides 5 flaws.

**Failure mode the checks target.** A Kafka topic is durable, replicated and long-lived, so it is
the last place that should hold a reporter's identity or their words. The starter fails on data
minimisation, on ordering (the wrong key), on duplicate and dropped produces, and on the crash
window between the commit and the persist.

Requirements for the \`moderation.action\` path:

- Every event is keyed by the **content id**, and the payload carries the **content id**, the
  **action**, the **rule** and the **reviewer role**. Keying by reporter scatters one item's history
  across partitions, so two consumers can apply its actions out of order.
- The payload must not contain the **reporter's identity** or the **verbatim report detail**. A
  private statement about a person does not belong on a retained, widely-readable topic.
- The producer is **idempotent** with \`acks=all\`, so a retry after a timeout does not publish the
  same action twice.
- When the broker rejects the produce, the event goes to an **outbox** instead of being dropped;
  the moderation decision and its audit trail must not depend on the broker being up.
- The consumer **persists the action before it commits the offset**, so a crash between the two
  replays the event instead of losing the removal.`,
  sequence: {
    participants: ['Moderation API', 'moderation.action', 'Moderation consumer', 'case store'],
    messages: [
      {from: 'Moderation API', to: 'moderation.action', label: 'produce · key = content_id', kind: 'sync'},
      {from: 'Moderation API', to: 'case store', label: 'outbox row when the broker rejects', kind: 'async'},
      {
        from: 'moderation.action',
        to: 'Moderation consumer',
        label: 'consume · one partition per content',
        kind: 'async',
      },
      {from: 'Moderation consumer', to: 'case store', label: 'put_action(content_id, action, rule)', kind: 'sync'},
      {
        from: 'Moderation consumer',
        to: 'moderation.action',
        label: 'commit offset after the action is persisted',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'keyed-by-content',
      title: 'Keys every event by content id',
      detail:
        'The producer key is the **content id**, so one item’s actions share a partition and stay in order. The starter keys by reporter, which scatters one item’s history and lets a later event overtake an earlier one.',
      match: {
        python: {all: [/moderation\.action/, /content_key\(/]},
        typescript: {all: [/moderation\.action/, /contentKey\(/]},
        go: {all: [/moderation\.action/, /contentKey\(/]},
        scala: {all: [/moderation\.action/, /contentKey\(/]},
        cpp: {all: [/moderation\.action/, /contentKey\(/]},
      },
    },
    {
      id: 'reporter-stripped',
      title: 'Ships no reporter identity and no free text',
      detail:
        'The event is built from the content id, the action, the rule and the reviewer role only — never `reporter_id` and never the report `detail`. The starter includes both so “fraud can review”, copying private data into a durable topic.',
      match: {
        python: {all: [/build_event\(/], none: [/reporter_id/, /detail/]},
        typescript: {all: [/buildEvent\(/], none: [/reporter_id/, /reporterId/, /detail/]},
        go: {all: [/buildEvent\(/], none: [/ReporterID/, /reporterID/, /detail/]},
        scala: {all: [/buildEvent\(/], none: [/reporterId/, /detail/]},
        cpp: {all: [/buildEvent\(/], none: [/reporterId/, /detail/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Produces idempotently with acks=all',
      detail:
        'The producer is configured with `acks=all` and idempotence enabled, so a retry after a timeout cannot publish the same action twice. The starter uses the client defaults and can duplicate on every retry.',
      match: {
        python: {all: [/acks/, /enable_idempotence/]},
        typescript: {all: [/acks/, /idempotent/]},
        go: {all: [/RequiredAcks/, /Idempotent/]},
        scala: {all: [/ACKS/, /IDEMPOTENCE/]},
        cpp: {all: [/acks/, /idempotence/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the produce fails',
      detail:
        'A rejected produce inserts the event into the outbox instead of dropping it. The starter ignores the failure, so an action that is live in the product has no record anywhere.',
      match: {
        python: {all: [/outbox\.insert\(/]},
        typescript: {all: [/outbox\.insert\(/]},
        go: {all: [/outbox\.Insert\(/]},
        scala: {all: [/outbox\.insert\(/]},
        cpp: {all: [/outbox\.insert\(/]},
      },
    },
    {
      id: 'persist-before-commit',
      title: 'Persists the action before committing the offset',
      detail:
        'The consumer writes the action and only then commits the offset. The starter commits first, so a crash in between replays the event and the removal is never durably recorded.',
      match: {
        python: {order: [/store\.put_action\(/, /consumer\.commit\(/]},
        typescript: {order: [/store\.putAction\(/, /commitOffsets\(/]},
        go: {order: [/store\.PutAction\(/, /session\.Commit\(/]},
        scala: {order: [/store\.putAction\(/, /commitSync\(/]},
        cpp: {order: [/store\.putAction\(/, /rd_kafka_commit\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from kafka import KafkaConsumer, KafkaProducer

producer = KafkaProducer(bootstrap_servers="kafka:9092")
consumer = KafkaConsumer("moderation.action", group_id="moderation-writers")


def publish(content_id: str, reporter_id: str, action: str, rule: str, detail: str) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = {"action": action, "rule": rule, "reporter_id": reporter_id, "detail": detail}
    producer.send("moderation.action", key=reporter_id, value=json.dumps(payload).encode())
    consumer.commit()
`,
      solution: `import json
import logging

from kafka import KafkaConsumer, KafkaProducer

logger = logging.getLogger("moderation")

TOPIC = "moderation.action"
GROUP = "moderation-writers"
PRODUCER_CONFIG = {
    "bootstrap_servers": "kafka:9092",
    "acks": "all",
    "enable_idempotence": True,
}

producer = KafkaProducer(**PRODUCER_CONFIG)
consumer = KafkaConsumer(TOPIC, group_id=GROUP, enable_auto_commit=False)


def content_key(content_id: str) -> str:
    return content_id


def build_event(content_id: str, action: str, rule: str, reviewer_role: str) -> dict:
    return {"content_id": content_id, "action": action, "rule": rule, "reviewer_role": reviewer_role}


def publish(content_id: str, action: str, rule: str, reviewer_role: str) -> None:
    payload = build_event(content_id, action, rule, reviewer_role)
    try:
        producer.send(TOPIC, key=content_key(content_id), value=json.dumps(payload).encode()).get(timeout=5)
    except Exception:
        logger.warning("produce rejected content=%s action=%s", content_id, action)
        outbox.insert(content_id=content_id, payload=payload)


def apply_action(record) -> None:
    event = json.loads(record.value)
    store.put_action(event["content_id"], event["action"], event["rule"])
    consumer.commit()
`,
    },
    typescript: {
      starter: `/** Moderation events. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'moderation-writers', brokers: ['kafka:9092']});

export const producer = kafka.producer();
export const consumer = kafka.consumer({groupId: 'moderation-writers'});

export async function publish(
  contentId: string,
  reporterId: string,
  action: string,
  rule: string,
  detail: string,
): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const payload = {action, rule, reporter_id: reporterId, detail};
  await producer.send({topic: 'moderation.action', messages: [{key: reporterId, value: JSON.stringify(payload)}]});
  await consumer.commitOffsets([]);
}
`,
      solution: `/** Moderation events: keyed by content id, reporter stripped, action persisted before the commit. */
import {Kafka, logLevel} from 'kafkajs';

const TOPIC = 'moderation.action';
const kafka = new Kafka({clientId: 'moderation-writers', brokers: ['kafka:9092'], logLevel: logLevel.WARN});

export const producer = kafka.producer({idempotent: true});
export const consumer = kafka.consumer({groupId: 'moderation-writers'});

export function contentKey(contentId: string): string {
  return contentId;
}

export function buildEvent(
  contentId: string,
  action: string,
  rule: string,
  reviewerRole: string,
): Record<string, string> {
  return {content_id: contentId, action, rule, reviewer_role: reviewerRole};
}

export async function publish(
  contentId: string,
  action: string,
  rule: string,
  reviewerRole: string,
): Promise<void> {
  const payload = buildEvent(contentId, action, rule, reviewerRole);
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: contentKey(contentId), value: JSON.stringify(payload)}],
    });
  } catch {
    await outbox.insert(contentId, payload);
  }
}

export async function run(): Promise<void> {
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value!.toString());
      await store.putAction(event.content_id, event.action, event.rule);
      await consumer.commitOffsets([
        {topic, partition, offset: (Number(message.offset) + 1).toString()},
      ]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"

	"github.com/IBM/sarama"
)

const topic = "moderation.action"

func publish(producer sarama.SyncProducer, contentID, reporterID, action, rule, detail string) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(map[string]string{
		"action": action, "rule": rule, "reporter_id": reporterID, "detail": detail,
	})
	_, _, err := producer.SendMessage(&sarama.ProducerMessage{
		Topic: topic,
		Key:   sarama.StringEncoder(reporterID),
		Value: sarama.ByteEncoder(payload),
	})
	if err != nil {
		return err
	}
	session.Commit()
	return nil
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"

	"github.com/IBM/sarama"
)

const topic = "moderation.action"

type ActionEvent struct {
	ContentID    string \`json:"content_id"\`
	Action       string \`json:"action"\`
	Rule         string \`json:"rule"\`
	ReviewerRole string \`json:"reviewer_role"\`
}

func contentKey(contentID string) string { return contentID }

func buildEvent(contentID, action, rule, reviewerRole string) ActionEvent {
	return ActionEvent{ContentID: contentID, Action: action, Rule: rule, ReviewerRole: reviewerRole}
}

func newProducer(brokers []string) (sarama.SyncProducer, error) {
	config := sarama.NewConfig()
	config.Producer.RequiredAcks = sarama.WaitForAll
	config.Producer.Idempotent = true
	config.Net.MaxOpenRequests = 1
	return sarama.NewSyncProducer(brokers, config)
}

func publish(producer sarama.SyncProducer, contentID, action, rule, reviewerRole string) error {
	payload, err := json.Marshal(buildEvent(contentID, action, rule, reviewerRole))
	if err != nil {
		return err
	}
	message := &sarama.ProducerMessage{
		Topic: topic,
		Key:   sarama.StringEncoder(contentKey(contentID)),
		Value: sarama.ByteEncoder(payload),
	}
	if _, _, err := producer.SendMessage(message); err != nil {
		log.Printf("produce rejected content=%s action=%s", contentID, action)
		return outbox.Insert(contentID, payload)
	}
	return nil
}

func applyAction(session sarama.ConsumerGroupSession, message *sarama.ConsumerMessage, store *ActionStore) {
	var event ActionEvent
	if err := json.Unmarshal(message.Value, &event); err != nil {
		return
	}
	store.PutAction(event.ContentID, event.Action, event.Rule)
	session.Commit()
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

object ModerationEvents {
  val Topic = "moderation.action"

  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def publish(contentId: String, reporterId: String, action: String, rule: String, detail: String): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val payload = s"""{"action":"$action","rule":"$rule","reporter_id":"$reporterId","detail":"$detail"}"""
    producer.send(new ProducerRecord[String, String](Topic, reporterId, payload))
    consumer.commitSync()
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.clients.producer.{ProducerConfig, ProducerRecord, KafkaProducer}
import org.apache.kafka.common.serialization.StringSerializer

object ModerationEvents {
  val Topic = "moderation.action"
  val GroupId = "moderation-writers"

  val ProducerProps = new Properties()
  ProducerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  ProducerProps.put(ProducerConfig.ACKS_CONFIG, "all")
  ProducerProps.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")

  val producer =
    new KafkaProducer[String, String](ProducerProps, new StringSerializer, new StringSerializer)

  def contentKey(contentId: String): String = contentId

  def buildEvent(contentId: String, action: String, rule: String, reviewerRole: String): Map[String, String] =
    Map("content_id" -> contentId, "action" -> action, "rule" -> rule, "reviewer_role" -> reviewerRole)

  def publish(contentId: String, action: String, rule: String, reviewerRole: String): Unit = {
    val payload = buildEvent(contentId, action, rule, reviewerRole)
    val record = new ProducerRecord[String, String](Topic, contentKey(contentId), payload.toString)
    try {
      producer.send(record).get()
    } catch {
      case _: Exception => outbox.insert(contentId, payload)
    }
  }

  def applyAction(store: ActionStore, record: ConsumerRecord[String, String]): Unit = {
    val event = Json.parse(record.value()).as[Map[String, String]]
    store.putAction(event("content_id"), event("action"), event("rule"))
    consumer.commitSync()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafka.h>

#include <string>

const std::string kTopic = "moderation.action";

void publish(rd_kafka_t* producer, const std::string& contentId, const std::string& reporterId,
             const std::string& action, const std::string& rule, const std::string& detail) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto payload = "{\\"action\\":\\"" + action + "\\",\\"rule\\":\\"" + rule + "\\",\\"reporter_id\\":\\"" +
                       reporterId + "\\",\\"detail\\":\\"" + detail + "\\"}";
  rd_kafka_producev(producer, RD_KAFKA_V_TOPIC(kTopic.c_str()),
                    RD_KAFKA_V_KEY(reporterId.data(), reporterId.size()),
                    RD_KAFKA_V_VALUE(const_cast<char*>(payload.data()), payload.size()),
                    RD_KAFKA_V_MSGFLAGS(RD_KAFKA_MSG_F_COPY), RD_KAFKA_V_END);
  rd_kafka_commit(producer, nullptr, 0);
}
`,
      solution: `#include <librdkafka/rdkafka.h>

#include <iostream>
#include <string>

const std::string kTopic = "moderation.action";

std::string contentKey(const std::string& contentId) { return contentId; }

std::string buildEvent(const std::string& contentId, const std::string& action, const std::string& rule,
                       const std::string& reviewerRole) {
  return "{\\"content_id\\":\\"" + contentId + "\\",\\"action\\":\\"" + action + "\\",\\"rule\\":\\"" + rule +
         "\\",\\"reviewer_role\\":\\"" + reviewerRole + "\\"}";
}

rd_kafka_t* newProducer() {
  char errstr[512];
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, sizeof(errstr));
  rd_kafka_conf_set(conf, "acks", "all", errstr, sizeof(errstr));
  rd_kafka_conf_set(conf, "enable.idempotence", "true", errstr, sizeof(errstr));
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, sizeof(errstr));
}

void publish(rd_kafka_t* producer, const std::string& contentId, const std::string& action,
             const std::string& rule, const std::string& reviewerRole) {
  const auto payload = buildEvent(contentId, action, rule, reviewerRole);
  const auto key = contentKey(contentId);
  if (rd_kafka_producev(producer, RD_KAFKA_V_TOPIC(kTopic.c_str()),
                        RD_KAFKA_V_KEY(key.data(), key.size()),
                        RD_KAFKA_V_VALUE(const_cast<char*>(payload.data()), payload.size()),
                        RD_KAFKA_V_MSGFLAGS(RD_KAFKA_MSG_F_COPY), RD_KAFKA_V_END) != 0) {
    outbox.insert(contentId, payload);
  }
}

void applyAction(ActionStore& store, rd_kafka_message_t* message, rd_kafka_t* consumer) {
  const std::string body(static_cast<const char*>(message->payload), message->len);
  store.putAction(body);
  rd_kafka_commit(consumer, nullptr, 0);
}
`,
    },
  },
  hints: [
    'Anyone with read access to the topic can see who reported whom and what they wrote, a restore sometimes resurrects a removed post, and after a broker blip some removals exist in the product but nowhere in the record.',
    "The key is the reporter id, so one item's actions land on different partitions; the payload is built inline with `reporter_id` and `detail`; the producer uses defaults; and `consumer.commit()` runs before anything is stored.",
    'Key with `content_key(content_id)`, build the value with `build_event(content_id, action, rule, reviewer_role)`, configure `acks="all"` and `enable_idempotence`, call `outbox.insert` on a failed send, and `store.put_action` before `consumer.commit`.',
  ],
  debrief: `The key is the contract: it decides the partition, and the partition decides the order consumers see, so one item's history must share a key. The payload is built by one function with four fields because a topic is retained and read far beyond this service; the reporter id and the detail stay in the case store, where fraud can join on the case id under its own access control. Idempotence with \`acks=all\` makes a retry safe, the outbox keeps the audit trail alive when the broker is what failed, and persist-then-commit means a crash replays an event instead of dropping it. Production pipelines also register a schema that rejects any field outside the allowlist, drain the outbox with its own idempotency key, and keep a replay tool that rebuilds a case file from a content id's history.`,
};
