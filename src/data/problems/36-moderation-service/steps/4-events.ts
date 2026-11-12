import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Moderation events keyed by content id, reporter stripped',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'db'],
  task: `## Task

**Starting point.** The starter is the \`moderation.action\` stream: \`publish_action(report_case,
action)\` produces one record per action on a case (\`action\` is \`{action, label, confidence,
model_version, actor}\`), built by \`build_event\` from the whole case plus the action, keyed by the
case id, and answers true; \`consume_actions()\` commits each record's offset, then persists the
action with \`store.put_action\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** A removal and its reversal on one post land on two partitions
and are applied out of order; the reporter's id and words sit on a retained topic; a lost
acknowledgement writes an action twice; a refused produce vanishes; and a consumer that crashes
after its commit loses the removal.

- Key every record by the content id.
- The event carries exactly \`action_id\` (\`{case_id}:{action}\`), \`case_id\`, \`content_id\`,
  \`tenant\`, \`action\`, \`label\`, \`confidence\`, \`model_version\` and \`actor\`.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent: true\`; the Go stack uses
  confluent-kafka-go, which has an idempotent producer).
- A delivery the broker refuses goes to the outbox (\`store.insert_outbox(topic, key, payload)\`)
  from the delivery report, and \`publish_action\` answers false.
- \`consume_actions\` persists the action before it commits the offset.`,
  sequence: {
    participants: ['Moderation API', 'moderation.action', 'Moderation consumer', 'case store'],
    messages: [
      {from: 'Moderation API', to: 'moderation.action', label: 'produce · key = content_id · acks = all', kind: 'sync'},
      {from: 'moderation.action', to: 'Moderation API', label: 'delivery report: refused', kind: 'reply'},
      {from: 'Moderation API', to: 'case store', label: 'insert_outbox(topic, key, payload)', kind: 'async'},
      {
        from: 'moderation.action',
        to: 'Moderation consumer',
        label: 'consume · one partition per content',
        kind: 'async',
      },
      {from: 'Moderation consumer', to: 'case store', label: 'put_action(event)', kind: 'sync'},
      {from: 'Moderation consumer', to: 'moderation.action', label: 'commit the offset after the write', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'content-key',
      title: 'Keys every event by content id',
      detail:
        'The record key is the content id, so every action on one post shares a partition and is applied in order; the starter keys by case id, and two reports on one post are two cases.',
      match: {
        python: {
          all: [/key\s*=\s*report_case\[["']content_id["']\]|key=content_id\b/, /moderation\.action/],
          none: [/key=report_case\[["'](case_id|reporter_id)["']\]/],
        },
        typescript: {
          all: [/key:\s*reportCase\.content_id|key:\s*contentId\b/, /moderation\.action/],
          none: [/key:\s*reportCase\.(case_id|reporter_id)/],
        },
        go: {
          all: [/Key:\s*\[\]byte\(reportCase\.ContentID\)|Key:\s*\[\]byte\(contentID\)/, /moderation\.action/],
          none: [/Key:\s*\[\]byte\(reportCase\.(CaseID|ReporterID)\)/],
        },
        scala: {
          all: [/ProducerRecord\[String, String\]\(Topic,\s*(reportCase\.contentId|contentId)\b/, /moderation\.action/],
          none: [/Topic,\s*reportCase\.(caseId|reporterId)/],
        },
        cpp: {
          all: [
            /report_case\.content_id\.c_str\(\),\s*report_case\.content_id\.(size|length)\(\)/,
            /moderation\.action/,
          ],
          none: [/report_case\.(case_id|reporter_id)\.c_str\(\)/],
        },
      },
    },
    {
      id: 'no-reporter',
      title: 'Ships no reporter identity and no report text',
      detail:
        '`build_event`/`buildEvent` names its fields one by one and leaves out `reporter_id` and `detail`; the starter copies the whole case onto a retained topic every consumer can read.',
      match: {
        python: {
          all: [/def build_event\(/],
          none: [/def build_event(?:(?!\ndef )[\s\S])*?(\*\*report_case|reporter_id|detail)/],
        },
        typescript: {
          all: [/function buildEvent\(/],
          none: [/function buildEvent(?:(?!\nexport )[\s\S])*?(\.\.\.reportCase|reporter_id|detail)/],
        },
        go: {all: [/func buildEvent\(/], none: [/func buildEvent(?:(?!\n\})[\s\S])*?(ReporterID|Detail)/]},
        scala: {all: [/def buildEvent\(/], none: [/def buildEvent(?:(?!\n {2}def )[\s\S])*?(reporterId|detail)/]},
        cpp: {all: [/json buildEvent\(/], none: [/json buildEvent(?:(?!\n\})[\s\S])*?(reporter_id|detail)/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Produces idempotently with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all`, so a retry after a lost acknowledgement writes the record once and a leader failover keeps it; the starter acknowledges on the leader alone.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/], none: [/acks:\s*1\b/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox',
      title: 'A refused delivery leaves an outbox row',
      detail:
        'Where the broker answers (the delivery callback, the rejected send, the delivery report’s error), a refusal writes `insert_outbox(topic, key, payload)` and the call answers false; the starter logs the refusal and answers true.',
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /store\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /\bcatch\b/]},
        go: {all: [/store\.InsertOutbox\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /onCompletion/]},
        cpp: {all: [/store::insertOutbox\(/, /dr_cb/]},
      },
    },
    {
      id: 'persist-before-commit',
      title: 'Persists the action before committing the offset',
      detail:
        'The consumer writes the action (`put_action`/`putAction`) and only then commits the record’s offset; the starter commits first, so a crash between the two skips the action for good.',
      match: {
        python: {order: [/def consume_actions/, /store\.put_action\(/, /consumer\.commit\(/]},
        typescript: {order: [/function consumeActions/, /putAction\(/, /commitOffsets\(/]},
        go: {order: [/func consumeActions/, /store\.PutAction\(/, /consumer\.CommitMessage\(/]},
        scala: {order: [/def consumeActions/, /Store\.putAction\(/, /commitSync\(/]},
        cpp: {order: [/void consumeActions/, /store::putAction\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer

from moderation import store  # put_action, insert_outbox

TOPIC = "moderation.action"
GROUP = "moderation-actions"
log = logging.getLogger("moderation.events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("moderation action not delivered: %s", err)


def build_event(report_case: dict, action: dict) -> dict:
    """The record for one action on a case."""
    return {
        **report_case,  # the whole case: the audit view downstream wants the reporter and their words
        "action_id": f"{report_case['case_id']}:{action['action']}",
        "action": action["action"],
        "label": action["label"],
        "confidence": action["confidence"],
        "model_version": action["model_version"],
        "actor": action["actor"],
    }


def publish_action(report_case: dict, action: dict) -> bool:
    """One record on moderation.action; True once the broker acknowledged it, False when it went to the outbox."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = build_event(report_case, action)
    producer.produce(TOPIC, key=report_case["case_id"], value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    return True


def consume_actions() -> None:
    """Persist every action on the topic, in order per partition."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(message=msg, asynchronous=False)
        store.put_action(json.loads(msg.value()))
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, Producer

from moderation import store  # put_action, insert_outbox

TOPIC = "moderation.action"
GROUP = "moderation-actions"
ACK_TIMEOUT_S = 2.0
log = logging.getLogger("moderation.events")

# Idempotent with acks=all: a retry after a lost acknowledgement lands once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def build_event(report_case: dict, action: dict) -> dict:
    """The record for one action on a case: ids and evidence; the reporter stays in the case store."""
    return {
        "action_id": f"{report_case['case_id']}:{action['action']}",
        "case_id": report_case["case_id"],
        "content_id": report_case["content_id"],
        "tenant": report_case["tenant"],
        "action": action["action"],
        "label": action["label"],
        "confidence": action["confidence"],
        "model_version": action["model_version"],
        "actor": action["actor"],
    }


def publish_action(report_case: dict, action: dict) -> bool:
    """One record on moderation.action; True once the broker acknowledged it, False when it went to the outbox."""
    key = report_case["content_id"]
    payload = json.dumps(build_event(report_case, action))
    delivered = []

    def on_delivery(err, msg) -> None:
        if err is not None:
            # The broker said no: the relay publishes the row later, so the action is late, not lost.
            store.insert_outbox(TOPIC, key, payload)
            log.warning("moderation action for %s not delivered: %s", key, err)
        delivered.append(err is None)

    producer.produce(TOPIC, key=key, value=payload, on_delivery=on_delivery)
    producer.flush(ACK_TIMEOUT_S)  # the delivery report fires here, delivered or refused
    return delivered == [True]


def consume_actions() -> None:
    """Persist every action on the topic, in order per partition."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        # Written first: a crash before the commit replays the record, and put_action ignores the replay.
        store.put_action(json.loads(msg.value()))
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Case, insertOutbox, putAction} from 'moderation/store';

export const TOPIC = 'moderation.action';
export const GROUP = 'moderation-actions';

/** What was decided about a case and the evidence behind it. */
export interface ModerationAction {
  action: string;
  label: string;
  confidence: number;
  model_version: string;
  actor: string;
}

const kafka = new Kafka({clientId: 'moderated', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** The record for one action on a case. */
export function buildEvent(reportCase: Case, action: ModerationAction): Record<string, unknown> {
  return {
    ...reportCase, // the whole case: the audit view downstream wants the reporter and their words
    action_id: \`\${reportCase.case_id}:\${action.action}\`,
    action: action.action,
    label: action.label,
    confidence: action.confidence,
    model_version: action.model_version,
    actor: action.actor,
  };
}

/** One record on moderation.action; true once the broker acknowledged it, false when it went to the outbox. */
export async function publishAction(reportCase: Case, action: ModerationAction): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const payload = JSON.stringify(buildEvent(reportCase, action));
  await producer
    .send({topic: TOPIC, messages: [{key: reportCase.case_id, value: payload}], acks: 1})
    .catch((e: Error) => console.warn(\`moderation action not delivered: \${e.message}\`));
  return true;
}

/** Persist every action on the topic, in order per partition. */
export async function consumeActions(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await putAction(JSON.parse(String(message.value)) as Record<string, unknown>);
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Case, insertOutbox, putAction} from 'moderation/store';

export const TOPIC = 'moderation.action';
export const GROUP = 'moderation-actions';

/** What was decided about a case and the evidence behind it. */
export interface ModerationAction {
  action: string;
  label: string;
  confidence: number;
  model_version: string;
  actor: string;
}

const kafka = new Kafka({clientId: 'moderated', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true}); // the idempotent producer requires acks: -1 (all)
void producer.connect();

/** The record for one action on a case: ids and evidence; the reporter stays in the case store. */
export function buildEvent(reportCase: Case, action: ModerationAction): Record<string, unknown> {
  return {
    action_id: \`\${reportCase.case_id}:\${action.action}\`,
    case_id: reportCase.case_id,
    content_id: reportCase.content_id,
    tenant: reportCase.tenant,
    action: action.action,
    label: action.label,
    confidence: action.confidence,
    model_version: action.model_version,
    actor: action.actor,
  };
}

/** One record on moderation.action; true once the broker acknowledged it, false when it went to the outbox. */
export async function publishAction(reportCase: Case, action: ModerationAction): Promise<boolean> {
  const payload = JSON.stringify(buildEvent(reportCase, action));
  try {
    await producer.send({topic: TOPIC, messages: [{key: reportCase.content_id, value: payload}], acks: -1});
    return true;
  } catch (e) {
    // The broker said no: the relay publishes the row later, so the action is late, not lost.
    await insertOutbox(TOPIC, reportCase.content_id, payload);
    console.warn(\`moderation action for \${reportCase.content_id} not delivered: \${(e as Error).message}\`);
    return false;
  }
}

/** Persist every action on the topic, in order per partition. */
export async function consumeActions(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      // Written first: a crash before the commit replays the record, and putAction ignores the replay.
      await putAction(JSON.parse(String(message.value)) as Record<string, unknown>);
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"moderation/store" // store.Case, PutAction, InsertOutbox
)

const (
	topic = "moderation.action"
	group = "moderation-actions"
)

// ModerationAction is what was decided about a case and the evidence behind it.
type ModerationAction struct {
	Action       string  \`json:"action"\`
	Label        string  \`json:"label"\`
	Confidence   float64 \`json:"confidence"\`
	ModelVersion string  \`json:"model_version"\`
	Actor        string  \`json:"actor"\`
}

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// buildEvent is the record for one action on a case.
func buildEvent(reportCase *store.Case, action ModerationAction) map[string]any {
	// The whole case: the audit view downstream wants the reporter and their words.
	return map[string]any{
		"action_id": fmt.Sprintf("%s:%s", reportCase.CaseID, action.Action), "case_id": reportCase.CaseID,
		"content_id": reportCase.ContentID, "tenant": reportCase.Tenant, "reporter_id": reportCase.ReporterID,
		"reason": reportCase.Reason, "detail": reportCase.Detail, "action": action.Action, "label": action.Label,
		"confidence": action.Confidence, "model_version": action.ModelVersion, "actor": action.Actor,
	}
}

// publishAction puts one record on moderation.action: true once the broker acknowledged it, false
// when it went to the outbox.
func publishAction(ctx context.Context, reportCase *store.Case, action ModerationAction) bool {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(buildEvent(reportCase, action))
	t := topic
	producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(reportCase.CaseID), Value: payload}, nil)
	producer.Flush(2000)
	return true
}

// consumeActions persists every action on the topic, in order per partition.
func consumeActions(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": group, "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		return err
	}
	if err := consumer.SubscribeTopics([]string{topic}, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
		var event map[string]any
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		store.PutAction(ctx, event)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"moderation/store" // store.Case, PutAction, InsertOutbox
)

const (
	topic      = "moderation.action"
	group      = "moderation-actions"
	ackTimeout = 2 * time.Second
)

// ModerationAction is what was decided about a case and the evidence behind it.
type ModerationAction struct {
	Action       string  \`json:"action"\`
	Label        string  \`json:"label"\`
	Confidence   float64 \`json:"confidence"\`
	ModelVersion string  \`json:"model_version"\`
	Actor        string  \`json:"actor"\`
}

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// buildEvent is the record for one action on a case: ids and evidence; the reporter stays in the case store.
func buildEvent(reportCase *store.Case, action ModerationAction) map[string]any {
	return map[string]any{
		"action_id": fmt.Sprintf("%s:%s", reportCase.CaseID, action.Action), "case_id": reportCase.CaseID,
		"content_id": reportCase.ContentID, "tenant": reportCase.Tenant, "action": action.Action, "label": action.Label,
		"confidence": action.Confidence, "model_version": action.ModelVersion, "actor": action.Actor,
	}
}

// publishAction puts one record on moderation.action: true once the broker acknowledged it, false
// when it went to the outbox.
func publishAction(ctx context.Context, reportCase *store.Case, action ModerationAction) bool {
	payload, _ := json.Marshal(buildEvent(reportCase, action))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(reportCase.ContentID), Value: payload}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error // the delivery report: acknowledged or refused
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded
		}
	}
	if err != nil {
		// The broker said no: the relay publishes the row later, so the action is late, not lost.
		store.InsertOutbox(ctx, topic, reportCase.ContentID, string(payload))
		log.Printf("moderation action for %s not delivered: %v", reportCase.ContentID, err)
		return false
	}
	return true
}

// consumeActions persists every action on the topic, in order per partition.
func consumeActions(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": group, "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		return err
	}
	if err := consumer.SubscribeTopics([]string{topic}, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		var event map[string]any
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		// Written first: a crash before the commit replays the record, and PutAction ignores the replay.
		store.PutAction(ctx, event)
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import scala.jdk.CollectionConverters._

import moderation.Store // Store.Case, putAction, insertOutbox

/** What was decided about a case and the evidence behind it. */
final case class ModerationAction(action: String, label: String, confidence: Double, modelVersion: String, actor: String)

object Events {
  val Topic = "moderation.action"
  val Group = "moderation-actions"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** The record for one action on a case. */
  def buildEvent(reportCase: Store.Case, action: ModerationAction): JsObject = JsObject(
    // The whole case: the audit view downstream wants the reporter and their words.
    "action_id" -> JsString(s"\${reportCase.caseId}:\${action.action}"),
    "case_id" -> JsString(reportCase.caseId),
    "content_id" -> JsString(reportCase.contentId),
    "tenant" -> JsString(reportCase.tenant),
    "reporter_id" -> JsString(reportCase.reporterId),
    "reason" -> JsString(reportCase.reason),
    "detail" -> JsString(reportCase.detail),
    "action" -> JsString(action.action),
    "label" -> JsString(action.label),
    "confidence" -> JsNumber(action.confidence),
    "model_version" -> JsString(action.modelVersion),
    "actor" -> JsString(action.actor))

  private val logFailure: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"moderation action not delivered: \${exception.getMessage}")
  }

  /** One record on moderation.action; true once the broker acknowledged it, false when it went to the outbox. */
  def publishAction(reportCase: Store.Case, action: ModerationAction): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    producer.send(new ProducerRecord[String, String](Topic, reportCase.caseId, buildEvent(reportCase, action).compactPrint), logFailure)
    producer.flush()
    true
  }

  /** Persist every action on the topic, in order per partition. */
  def consumeActions(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true)
      consumer.poll(java.time.Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
        Store.putAction(record.value().parseJson.asJsObject)
      }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import scala.concurrent.duration._
import scala.concurrent.{Await, Promise}
import scala.jdk.CollectionConverters._

import moderation.Store // Store.Case, putAction, insertOutbox

/** What was decided about a case and the evidence behind it. */
final case class ModerationAction(action: String, label: String, confidence: Double, modelVersion: String, actor: String)

object Events {
  val Topic = "moderation.action"
  val Group = "moderation-actions"

  // Idempotent with acks=all: a retry after a lost acknowledgement lands once, on every replica.
  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all")
    props.put("enable.idempotence", "true")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** The record for one action on a case: ids and evidence; the reporter stays in the case store. */
  def buildEvent(reportCase: Store.Case, action: ModerationAction): JsObject = JsObject(
    "action_id" -> JsString(s"\${reportCase.caseId}:\${action.action}"),
    "case_id" -> JsString(reportCase.caseId),
    "content_id" -> JsString(reportCase.contentId),
    "tenant" -> JsString(reportCase.tenant),
    "action" -> JsString(action.action),
    "label" -> JsString(action.label),
    "confidence" -> JsNumber(action.confidence),
    "model_version" -> JsString(action.modelVersion),
    "actor" -> JsString(action.actor))

  /** One record on moderation.action; true once the broker acknowledged it, false when it went to the outbox. */
  def publishAction(reportCase: Store.Case, action: ModerationAction): Boolean = {
    val payload = buildEvent(reportCase, action).compactPrint
    val delivered = Promise[Boolean]()
    val report: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit = {
        // The broker said no: the relay publishes the row later, so the action is late, not lost.
        if (exception != null) Store.insertOutbox(Topic, reportCase.contentId, payload)
        delivered.success(exception == null)
      }
    }
    producer.send(new ProducerRecord[String, String](Topic, reportCase.contentId, payload), report)
    producer.flush()
    Await.result(delivered.future, 2.seconds)
  }

  /** Persist every action on the topic, in order per partition. */
  def consumeActions(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true)
      consumer.poll(java.time.Duration.ofSeconds(1)).asScala.foreach { record =>
        // Written first: a crash before the commit replays the record, and putAction ignores the replay.
        Store.putAction(record.value().parseJson.asJsObject)
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
      }
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

#include "moderation/store.h"  // store::Case, putAction, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "moderation.action";
const std::string kGroup = "moderation-actions";

// What was decided about a case and the evidence behind it.
struct ModerationAction {
  std::string action;
  std::string label;
  double confidence = 0;
  std::string model_version;
  std::string actor;
};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "moderation action not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// The record for one action on a case.
json buildEvent(const store::Case& report_case, const ModerationAction& action) {
  // The whole case: the audit view downstream wants the reporter and their words.
  return json{{"action_id", report_case.case_id + ":" + action.action},
              {"case_id", report_case.case_id},
              {"content_id", report_case.content_id},
              {"tenant", report_case.tenant},
              {"reporter_id", report_case.reporter_id},
              {"reason", report_case.reason},
              {"detail", report_case.detail},
              {"action", action.action},
              {"label", action.label},
              {"confidence", action.confidence},
              {"model_version", action.model_version},
              {"actor", action.actor}};
}

// One record on moderation.action; true once the broker acknowledged it, false when it went to the outbox.
bool publishAction(const store::Case& report_case, const ModerationAction& action) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string payload = buildEvent(report_case, action).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(),
                    report_case.case_id.c_str(), report_case.case_id.size(), 0, nullptr);
  producer->flush(2000);
  return true;
}

// Persist every action on the topic, in order per partition.
void consumeActions() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    store::putAction(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "moderation/store.h"  // store::Case, putAction, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "moderation.action";
const std::string kGroup = "moderation-actions";
constexpr int kAckTimeoutMs = 2000;

// What was decided about a case and the evidence behind it.
struct ModerationAction {
  std::string action;
  std::string label;
  double confidence = 0;
  std::string model_version;
  std::string actor;
};

// The delivery report: a record the broker refused goes to the outbox, for the relay to publish later.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  bool delivered = false;
  void dr_cb(RdKafka::Message& message) override {
    delivered = message.err() == RdKafka::ERR_NO_ERROR;
    if (delivered) return;
    const std::string key = message.key() ? *message.key() : "";
    store::insertOutbox(kTopic, key, std::string(static_cast<const char*>(message.payload()), message.len()));
    std::cerr << "moderation action for " << key << " not delivered: " << message.errstr() << "\\n";
  }
};

ToOutbox deliveries;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                 // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &deliveries, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// The record for one action on a case: ids and evidence; the reporter stays in the case store.
json buildEvent(const store::Case& report_case, const ModerationAction& action) {
  return json{{"action_id", report_case.case_id + ":" + action.action},
              {"case_id", report_case.case_id},
              {"content_id", report_case.content_id},
              {"tenant", report_case.tenant},
              {"action", action.action},
              {"label", action.label},
              {"confidence", action.confidence},
              {"model_version", action.model_version},
              {"actor", action.actor}};
}

// One record on moderation.action; true once the broker acknowledged it, false when it went to the outbox.
bool publishAction(const store::Case& report_case, const ModerationAction& action) {
  const std::string payload = buildEvent(report_case, action).dump();
  deliveries.delivered = false;
  const RdKafka::ErrorCode queued =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(),
                        report_case.content_id.c_str(), report_case.content_id.size(), 0, nullptr);
  if (queued != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(kTopic, report_case.content_id, payload);
    return false;
  }
  producer->flush(kAckTimeoutMs);  // the delivery report fires here, delivered or refused
  return deliveries.delivered;
}

// Persist every action on the topic, in order per partition.
void consumeActions() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    // Written first: a crash before the commit replays the record, and putAction ignores the replay.
    store::putAction(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

from moderation import store

TOPIC = "moderation.action"
GROUP = "moderation-actions"
FIELDS = {"action_id", "case_id", "content_id", "tenant", "action", "label", "confidence", "model_version", "actor"}
REMOVE = {"action": "remove", "label": "harassment", "confidence": 0.99, "model_version": "clf-2026-10", "actor": "classifier"}
RESTORE = {"action": "restore", "label": "harassment", "confidence": 0.99, "model_version": "clf-2026-10", "actor": "moderator"}


def _case(reporter, content_id="c-1", detail="They keep posting my address"):
    return store.insert_case("acme", content_id, reporter, "harassment", detail)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_content_key(ctx):
    m = ctx.load("events")
    first, second, other = _case("u-17"), _case("u-18"), _case("u-17", content_id="c-2")
    for report_case, action in ((first, REMOVE), (second, RESTORE), (other, REMOVE)):
        assert m.publish_action(report_case, action) is True, f"publish_action({report_case['case_id']}) on a healthy broker must answer True"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three actions produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"c-1", b"c-1", b"c-2"], f"records must be keyed by the content id, got {keys}: the removal and the restore of c-1 came from two cases"
    assert records[0].partition == records[1].partition, "both actions on c-1 must share a partition, or the restore can be applied before the removal"


def check_no_reporter(ctx):
    m = ctx.load("events")
    report_case = _case("u-17", detail="He posted my home address, 12 Elm St")
    assert m.publish_action(report_case, REMOVE) is True, "publish_action on a healthy broker must answer True"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one action produced {len(records)} records"
    text = records[0].value.decode()
    assert "u-17" not in text, f"the event names the reporter: {text}. The topic is retained and every consumer reads it"
    assert "Elm St" not in text, f"the event carries the reporter's words: {text}"
    event = json.loads(text)
    assert set(event) == FIELDS, f"the event has fields {sorted(event)}, expected exactly {sorted(FIELDS)}"
    assert (event["action_id"], event["content_id"], event["tenant"], event["confidence"]) == (f"{report_case['case_id']}:remove", "c-1", "acme", 0.99), f"the event's values must come from the case and the action: {text}"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    first, second = _case("u-17"), _case("u-18")
    ctx.kafka.lose_acks(TOPIC, 1)
    assert m.publish_action(first, REMOVE) is True, "a lost acknowledgement is retried by the client, not reported: publish_action must answer True"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"after one lost acknowledgement the topic holds {len(records)} records, expected 1: the retry wrote the action twice (enable.idempotence)"
    m.publish_action(second, RESTORE)
    ctx.kafka.failover(TOPIC)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 2, f"after a leader failover the topic holds {len(records)} records, expected 2: a record acknowledged by the leader alone is lost (acks=all)"


def check_outbox(ctx):
    m = ctx.load("events")
    report_case = _case("u-17")
    ctx.kafka.fail_next(TOPIC, 1)
    delivered = m.publish_action(report_case, REMOVE)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"after the broker refused the produce the outbox holds {rows}, expected one row: the removal has no record anywhere"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "c-1", f"the outbox row must carry the topic and the record key (the content id) so the relay keeps the order: {row}"
    assert json.loads(row.get("payload", "{}")).get("action_id") == f"{report_case['case_id']}:remove", f"the outbox row must carry the event: {row}"
    assert delivered is False, f"publish_action answered {delivered!r} for a delivery the broker refused, expected False"
    assert ctx.kafka.records(TOPIC) == [], "a refused produce cannot be on the topic"
    assert m.publish_action(report_case, RESTORE) is True, "once the broker answers again publish_action must answer True"
    assert len(_outbox(ctx)) == 1, "a delivered action leaves no outbox row"


def check_persist_before_commit(ctx):
    m = ctx.load("events")
    for n, action in ((1, "remove"), (2, "restore")):
        event = {"action_id": f"case-{n}:{action}", "case_id": f"case-{n}", "content_id": "c-1", "tenant": "acme", "action": action, "label": "harassment", "confidence": 0.99, "model_version": "clf-2026-10", "actor": "moderator"}
        ctx.kafka.seed(TOPIC, key="c-1", value=json.dumps(event))
    persisted = []
    ctx.kafka.on_commit(lambda group, offsets: persisted.append(ctx.redis.llen("actions:c-1")))
    ctx.drain(m.consume_actions)
    assert persisted, "the consumer committed nothing"
    assert persisted == [1, 2], f"at each commit the store held {persisted} actions on c-1, expected [1, 2]: an offset committed before its action is written loses the action if the consumer crashes in between"
    actions = [a["action"] for a in store.actions_of("c-1")]
    assert actions == ["remove", "restore"], f"the store holds {actions} for c-1, expected remove then restore"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, f"the consumer left {ctx.kafka.lag(GROUP, TOPIC)} record(s) uncommitted"
`,
    typescript: `const TOPIC = 'moderation.action';
const GROUP = 'moderation-actions';
const FIELDS = ['action', 'action_id', 'actor', 'case_id', 'confidence', 'content_id', 'label', 'model_version', 'tenant'];
const REMOVE = {action: 'remove', label: 'harassment', confidence: 0.99, model_version: 'clf-2026-10', actor: 'classifier'};
const RESTORE = {action: 'restore', label: 'harassment', confidence: 0.99, model_version: 'clf-2026-10', actor: 'moderator'};

function events(ctx) {
  return {m: ctx.load('events'), store: ctx.load('/support/moderation/store.ts')};
}

const caseOf = (store, reporter: string, contentId = 'c-1', detail = 'They keep posting my address') =>
  store.insertCase('acme', contentId, reporter, 'harassment', detail);

const outbox = ctx => ctx.redis.lrange('outbox', 0, -1).map(row => JSON.parse(row));

export async function check_content_key(ctx) {
  const {m, store} = events(ctx);
  const first = await caseOf(store, 'u-17');
  const second = await caseOf(store, 'u-18');
  const other = await caseOf(store, 'u-17', 'c-2');
  for (const [reportCase, action] of [[first, REMOVE], [second, RESTORE], [other, REMOVE]]) {
    assert.equal(await m.publishAction(reportCase, action), true, \`publishAction(\${reportCase.case_id}) on a healthy broker must answer true\`);
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three actions produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['c-1', 'c-1', 'c-2'], \`records must be keyed by the content id, got \${JSON.stringify(keys)}: the removal and the restore of c-1 came from two cases\`);
  assert.equal(records[0].partition, records[1].partition, 'both actions on c-1 must share a partition, or the restore can be applied before the removal');
}

export async function check_no_reporter(ctx) {
  const {m, store} = events(ctx);
  const reportCase = await caseOf(store, 'u-17', 'c-1', 'He posted my home address, 12 Elm St');
  assert.equal(await m.publishAction(reportCase, REMOVE), true, 'publishAction on a healthy broker must answer true');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one action produced \${records.length} records\`);
  const text = records[0].value.toString();
  assert(!text.includes('u-17'), \`the event names the reporter: \${text}. The topic is retained and every consumer reads it\`);
  assert(!text.includes('Elm St'), \`the event carries the reporter's words: \${text}\`);
  const event = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(event).sort(), FIELDS, \`the event has fields \${JSON.stringify(Object.keys(event).sort())}, expected exactly \${JSON.stringify(FIELDS)}\`);
  assert(
    event.action_id === \`\${reportCase.case_id}:remove\` && event.content_id === 'c-1' && event.tenant === 'acme' && event.confidence === 0.99,
    \`the event's values must come from the case and the action: \${text}\`,
  );
}

export async function check_idempotent_producer(ctx) {
  const {m, store} = events(ctx);
  const first = await caseOf(store, 'u-17');
  const second = await caseOf(store, 'u-18');
  ctx.kafka.loseAcks(TOPIC, 1);
  assert.equal(await m.publishAction(first, REMOVE), true, 'a lost acknowledgement is retried by the client, not reported: publishAction must answer true');
  let records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`after one lost acknowledgement the topic holds \${records.length} records, expected 1: the retry wrote the action twice (idempotent: true)\`);
  await m.publishAction(second, RESTORE);
  ctx.kafka.failover(TOPIC);
  records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 2, \`after a leader failover the topic holds \${records.length} records, expected 2: a record acknowledged by the leader alone is lost (acks: -1)\`);
}

export async function check_outbox(ctx) {
  const {m, store} = events(ctx);
  const reportCase = await caseOf(store, 'u-17');
  ctx.kafka.failNext(TOPIC, 1);
  const delivered = await m.publishAction(reportCase, REMOVE);
  const rows = outbox(ctx);
  assert.equal(rows.length, 1, \`after the broker refused the produce the outbox holds \${JSON.stringify(rows)}, expected one row: the removal has no record anywhere\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'c-1', \`the outbox row must carry the topic and the record key (the content id) so the relay keeps the order: \${JSON.stringify(rows[0])}\`);
  assert.equal(JSON.parse(rows[0].payload ?? '{}').action_id, \`\${reportCase.case_id}:remove\`, \`the outbox row must carry the event: \${JSON.stringify(rows[0])}\`);
  assert.equal(delivered, false, \`publishAction answered \${delivered} for a delivery the broker refused, expected false\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'a refused produce cannot be on the topic');
  assert.equal(await m.publishAction(reportCase, RESTORE), true, 'once the broker answers again publishAction must answer true');
  assert.equal(outbox(ctx).length, 1, 'a delivered action leaves no outbox row');
}

export async function check_persist_before_commit(ctx) {
  const {m, store} = events(ctx);
  for (const [n, action] of [[1, 'remove'], [2, 'restore']]) {
    const event = {action_id: \`case-\${n}:\${action}\`, case_id: \`case-\${n}\`, content_id: 'c-1', tenant: 'acme', action, label: 'harassment', confidence: 0.99, model_version: 'clf-2026-10', actor: 'moderator'};
    ctx.kafka.seed(TOPIC, {key: 'c-1', value: JSON.stringify(event)});
  }
  const persisted: number[] = [];
  ctx.kafka.onCommit(() => persisted.push(ctx.redis.llen('actions:c-1')));
  await ctx.drain(m.consumeActions());
  assert(persisted.length > 0, 'the consumer committed nothing');
  assert.deepStrictEqual(persisted, [1, 2], \`at each commit the store held \${JSON.stringify(persisted)} actions on c-1, expected [1, 2]: an offset committed before its action is written loses the action if the consumer crashes in between\`);
  const actions = (await store.actionsOf('c-1')).map(a => a.action);
  assert.deepStrictEqual(actions, ['remove', 'restore'], \`the store holds \${JSON.stringify(actions)} for c-1, expected remove then restore\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, \`the consumer left \${ctx.kafka.lag(GROUP, TOPIC)} record(s) uncommitted\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"moderation/store"

	"leetbuild/harness"
)

const eventsTopic = "moderation.action"

var (
	eventsBg      = context.Background()
	eventsRemove  = ModerationAction{Action: "remove", Label: "harassment", Confidence: 0.99, ModelVersion: "clf-2026-10", Actor: "classifier"}
	eventsRestore = ModerationAction{Action: "restore", Label: "harassment", Confidence: 0.99, ModelVersion: "clf-2026-10", Actor: "moderator"}
	eventsFields  = []string{"action", "action_id", "actor", "case_id", "confidence", "content_id", "label", "model_version", "tenant"}
)

func eventsCase(reporter, contentID, detail string) *store.Case {
	return store.InsertCase(eventsBg, "acme", contentID, reporter, "harassment", detail)
}

func eventsOutbox(ctx *harness.Ctx) []map[string]string {
	var rows []map[string]string
	for _, raw := range ctx.Redis.LRange("outbox", 0, -1) {
		row := map[string]string{}
		json.Unmarshal([]byte(raw), &row)
		rows = append(rows, row)
	}
	return rows
}

func CheckContentKey(ctx *harness.Ctx) {
	first := eventsCase("u-17", "c-1", "They keep posting my address")
	second := eventsCase("u-18", "c-1", "They keep posting my address")
	other := eventsCase("u-17", "c-2", "")
	ctx.Equal(publishAction(eventsBg, first, eventsRemove), true, "publishAction(%s) on a healthy broker", first.CaseID)
	ctx.Equal(publishAction(eventsBg, second, eventsRestore), true, "publishAction(%s) on a healthy broker", second.CaseID)
	ctx.Equal(publishAction(eventsBg, other, eventsRemove), true, "publishAction(%s) on a healthy broker", other.CaseID)
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three actions must produce three records on %s; the records", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"c-1", "c-1", "c-2"}, "records must be keyed by the content id (the removal and the restore of c-1 came from two cases)")
	ctx.Equal(records[0].Partition, records[1].Partition, "both actions on c-1 must share a partition, or the restore can be applied before the removal; their partitions")
}

func CheckNoReporter(ctx *harness.Ctx) {
	reportCase := eventsCase("u-17", "c-1", "He posted my home address, 12 Elm St")
	ctx.Equal(publishAction(eventsBg, reportCase, eventsRemove), true, "publishAction on a healthy broker")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 1, "one action must produce one record; the records")
	text := string(records[0].Value)
	ctx.Assert(!strings.Contains(text, "u-17"), "the event names the reporter: %s. The topic is retained and every consumer reads it", text)
	ctx.Assert(!strings.Contains(text, "Elm St"), "the event carries the reporter's words: %s", text)
	var event map[string]any
	ctx.NoError(json.Unmarshal(records[0].Value, &event), "the event must be JSON (%s)", text)
	var fields []string
	for field := range event {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	ctx.Equal(fields, eventsFields, "the event's fields")
	ctx.Assert(event["action_id"] == reportCase.CaseID+":remove" && event["content_id"] == "c-1" && event["tenant"] == "acme" && event["confidence"] == 0.99, "the event's values must come from the case and the action: %s", text)
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	first := eventsCase("u-17", "c-1", "")
	second := eventsCase("u-18", "c-1", "")
	ctx.Kafka.LoseAcks(eventsTopic, 1)
	ctx.Equal(publishAction(eventsBg, first, eventsRemove), true, "a lost acknowledgement is retried by the client, not reported; publishAction")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the retry wrote the action twice (enable.idempotence); the records")
	publishAction(eventsBg, second, eventsRestore)
	ctx.Settle()
	lost := ctx.Kafka.Failover(eventsTopic)
	ctx.Equal(lost, 0, "a leader failover lost records acknowledged by the leader alone (acks=all); records lost")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "after a leader failover both records must still be on the topic; the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	reportCase := eventsCase("u-17", "c-1", "")
	ctx.Kafka.FailNext(eventsTopic, 1)
	delivered := publishAction(eventsBg, reportCase, eventsRemove)
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "after the broker refused the produce the outbox must hold one row, or the removal has no record anywhere; rows")
	ctx.Assert(rows[0]["topic"] == eventsTopic && rows[0]["key"] == "c-1", "the outbox row must carry the topic and the record key (the content id) so the relay keeps the order: %v", rows[0])
	var payload map[string]any
	json.Unmarshal([]byte(rows[0]["payload"]), &payload)
	ctx.Equal(fmt.Sprint(payload["action_id"]), reportCase.CaseID+":remove", "the outbox row must carry the event; its action_id")
	ctx.Equal(delivered, false, "publishAction for a delivery the broker refused")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "a refused produce cannot be on the topic; the records")
	ctx.Equal(publishAction(eventsBg, reportCase, eventsRestore), true, "once the broker answers again, publishAction")
	ctx.Settle()
	ctx.Equal(len(eventsOutbox(ctx)), 1, "a delivered action leaves no outbox row; rows")
}

func CheckPersistBeforeCommit(ctx *harness.Ctx) {
	for n, action := range []string{"remove", "restore"} {
		caseID := fmt.Sprintf("case-%d", n+1)
		event := map[string]any{"action_id": caseID + ":" + action, "case_id": caseID, "content_id": "c-1", "tenant": "acme", "action": action, "label": "harassment", "confidence": 0.99, "model_version": "clf-2026-10", "actor": "moderator"}
		raw, _ := json.Marshal(event)
		ctx.Kafka.Seed(eventsTopic, "c-1", string(raw))
	}
	var persisted []int64
	ctx.Kafka.OnCommit(func(group string, offsets harness.KafkaOffsets) {
		persisted = append(persisted, ctx.Redis.LLen("actions:c-1"))
	})
	ctx.Drain(func() { consumeActions(eventsBg) })
	ctx.Assert(len(persisted) > 0, "the consumer committed nothing")
	ctx.Equal(persisted, []int64{1, 2}, "at each commit the store must already hold the committed action (an offset committed before its action is written loses the action if the consumer crashes in between); the actions on c-1 at each commit")
	var actions []string
	for _, a := range store.ActionsOf(eventsBg, "c-1") {
		actions = append(actions, fmt.Sprint(a["action"]))
	}
	ctx.Equal(actions, []string{"remove", "restore"}, "the actions stored for c-1")
	ctx.Equal(ctx.Kafka.Lag("moderation-actions", eventsTopic), int64(0), "records the consumer left uncommitted")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "moderation.action";
const ModerationAction kRemove{"remove", "harassment", 0.99, "clf-2026-10", "classifier"};
const ModerationAction kRestore{"restore", "harassment", 0.99, "clf-2026-10", "moderator"};

store::Case eventsCase(const std::string& reporter, const std::string& content_id = "c-1", const std::string& detail = "They keep posting my address") {
  return store::insertCase("acme", content_id, reporter, "harassment", detail);
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& raw : ctx.Redis.LRange("outbox", 0, -1)) rows.push_back(nlohmann::json::parse(raw, nullptr, false));
  return rows;
}

}  // namespace

void CheckContentKey(harness::Ctx& ctx) {
  const store::Case first = eventsCase("u-17");
  const store::Case second = eventsCase("u-18");
  const store::Case other = eventsCase("u-17", "c-2", "");
  ctx.Equal(publishAction(first, kRemove), true, "publishAction(%s) on a healthy broker", first.case_id);
  ctx.Equal(publishAction(second, kRestore), true, "publishAction(%s) on a healthy broker", second.case_id);
  ctx.Equal(publishAction(other, kRemove), true, "publishAction(%s) on a healthy broker", other.case_id);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three actions must produce three records on %s; the records", kEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"c-1", "c-1", "c-2"}, "records must be keyed by the content id (the removal and the restore of c-1 came from two cases)");
  ctx.Equal(records[0].Partition, records[1].Partition, "both actions on c-1 must share a partition, or the restore can be applied before the removal; their partitions");
}

void CheckNoReporter(harness::Ctx& ctx) {
  const store::Case report_case = eventsCase("u-17", "c-1", "He posted my home address, 12 Elm St");
  ctx.Equal(publishAction(report_case, kRemove), true, "publishAction on a healthy broker");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 1, "one action must produce one record; the records");
  const std::string text = records[0].Value.value_or("");
  ctx.Assert(text.find("u-17") == std::string::npos, "the event names the reporter: %s. The topic is retained and every consumer reads it", text);
  ctx.Assert(text.find("Elm St") == std::string::npos, "the event carries the reporter's words: %s", text);
  const auto event = nlohmann::json::parse(text, nullptr, false);
  ctx.Assert(event.is_object(), "the event must be JSON: %s", text);
  std::vector<std::string> fields;
  for (const auto& item : event.items()) fields.push_back(item.key());
  std::sort(fields.begin(), fields.end());
  ctx.Equal(fields, std::vector<std::string>{"action", "action_id", "actor", "case_id", "confidence", "content_id", "label", "model_version", "tenant"}, "the event's fields");
  ctx.Assert(event.value("action_id", "") == report_case.case_id + ":remove" && event.value("content_id", "") == "c-1" && event.value("tenant", "") == "acme" &&
                 event.value("confidence", 0.0) == 0.99,
             "the event's values must come from the case and the action: %s", text);
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  const store::Case first = eventsCase("u-17");
  const store::Case second = eventsCase("u-18");
  ctx.Kafka.LoseAcks(kEventsTopic, 1);
  ctx.Equal(publishAction(first, kRemove), true, "a lost acknowledgement is retried by the client, not reported; publishAction");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the retry wrote the action twice (enable.idempotence); the records");
  publishAction(second, kRestore);
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "after a leader failover both records must still be on the topic (acks=all); the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  const store::Case report_case = eventsCase("u-17");
  ctx.Kafka.FailNext(kEventsTopic, 1);
  const bool delivered = publishAction(report_case, kRemove);
  ctx.Settle();
  const auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "after the broker refused the produce the outbox must hold one row, or the removal has no record anywhere; rows");
  ctx.Assert(rows[0].is_object() && rows[0].value("topic", "") == kEventsTopic && rows[0].value("key", "") == "c-1",
             "the outbox row must carry the topic and the record key (the content id) so the relay keeps the order: %s", rows[0].dump());
  const auto payload = nlohmann::json::parse(rows[0].value("payload", "{}"), nullptr, false);
  ctx.Equal(payload.is_object() ? payload.value("action_id", "") : "", report_case.case_id + ":remove", "the outbox row must carry the event; its action_id");
  ctx.Equal(delivered, false, "publishAction for a delivery the broker refused");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0, "a refused produce cannot be on the topic; the records");
  ctx.Equal(publishAction(report_case, kRestore), true, "once the broker answers again, publishAction");
  ctx.Settle();
  ctx.Equal(eventsOutbox(ctx).size(), 1, "a delivered action leaves no outbox row; rows");
}

void CheckPersistBeforeCommit(harness::Ctx& ctx) {
  int n = 0;
  for (const std::string action : {"remove", "restore"}) {
    const std::string case_id = "case-" + std::to_string(++n);
    const nlohmann::json event = {{"action_id", case_id + ":" + action}, {"case_id", case_id},  {"content_id", "c-1"},
                                  {"tenant", "acme"},                    {"action", action},    {"label", "harassment"},
                                  {"confidence", 0.99},                  {"model_version", "clf-2026-10"}, {"actor", "moderator"}};
    ctx.Kafka.Seed(kEventsTopic, std::string("c-1"), event.dump());
  }
  auto persisted = std::make_shared<std::vector<long long>>();
  ctx.Kafka.OnCommit([&ctx, persisted](const std::string&, const harness::KafkaOffsets&) { persisted->push_back(ctx.Redis.LLen("actions:c-1")); });
  ctx.Drain([] { consumeActions(); });
  ctx.Assert(!persisted->empty(), "the consumer committed nothing");
  ctx.Equal(*persisted, std::vector<long long>{1, 2},
            "at each commit the store must already hold the committed action (an offset committed before its action is written loses the action if the consumer crashes in between); the actions on c-1 at each commit");
  std::vector<std::string> actions;
  for (const auto& a : store::actionsOf("c-1")) actions.push_back(a.value("action", ""));
  ctx.Equal(actions, std::vector<std::string>{"remove", "restore"}, "the actions stored for c-1");
  ctx.Equal(ctx.Kafka.Lag("moderation-actions", kEventsTopic), 0, "records the consumer left uncommitted");
}
`,
  },
  hints: [
    'Remove a post on one report and restore it on another: the consumer can apply the restore first. Read a record off the topic: it names the reporter. Make the broker refuse a produce: `publish_action` still answers true, and nothing records the removal.',
    'The key is the case id, and two reports on one post are two cases; `build_event` spreads the whole case; the producer acknowledges on the leader alone and retries blind; the delivery callback only logs; the consumer commits before it writes.',
    'Key by `report_case["content_id"]`; name the nine event fields one by one; `enable.idempotence: True` with `acks: all`; in the delivery callback call `store.insert_outbox(TOPIC, key, payload)` on an error and answer false; `store.put_action`, then `consumer.commit`.',
  ],
  debrief: `The key is the content id because a partition is the only unit Kafka keeps in order, and every action on one post must be applied in the order it was decided, whichever report it came from. The event carries ids and evidence because the topic is retained and copied to every consumer; the reporter's identity and words stay in the case store, behind the case file's access rules. Idempotence with \`acks=all\` makes a retried produce land once on every replica, and the outbox row written from the delivery report makes a refused one late instead of lost. Persisting before committing turns a crash into a replay, which \`put_action\` absorbs by action id. Production pipelines also version the event schema and relay the outbox in order per key.`,
};
