import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Approval events keyed by request id',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: an event reaches the topic and
the trail consumer writes it down, so the demo shows approvals flowing through Kafka. The key, the
payload and the order of the two writes are all wrong. Review it, fix it, and prove the fix.

Implement the event path for submit, decision, delegation and completion events. \`publish_event(
request_id, kind, step, actor, actor_role, decision)\` is the one code path they all take.

- **One topic**, \`approval.event\`, and **one key: the request id**. Partitioning by request id is
  what keeps a single request's chain — submit, step 0, delegation, step 1, completion — in order.
  Keying by the approver scatters one chain across partitions, and a consumer then sees step 1
  before step 0.
- The payload carries **ids and enums only**: \`request_id\`, \`kind\`, \`step\`, \`actor\`,
  \`actor_role\`, \`decision\`. **Never** the \`why\` text and never attachments. The topic is
  retained for days and replicated across brokers, so anything written there outlives the request,
  the tenant and every retention policy the request path has.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks \`all\`
  plus hashed, stable keys), so a retry of a produce cannot duplicate a record.
- When the broker rejects the produce, write the event to the **outbox** instead of dropping it or
  failing the caller; a relay republishes outbox rows when the broker recovers.
- **A decision publishes only after the state commit**: \`state.commit_step\` runs first, then the
  produce. Acknowledging the produce first means the broker can announce a step that a crash a
  millisecond later never committed — an approval that exists in the trail and not in the state.
- The trail consumer writes the step into \`approval:{request_id}:trail\` and commits its offset
  after that write, so a crash between the two replays the record instead of losing it.

**Failure mode the checks target.** The draft keys by approver, so one request's events are ordered
only within a partition that no longer corresponds to the request. It copies the \`why\` text and the
attachment list into a retained topic, which is a data leak with a very long tail. And it acks the
produce before the state commit, so the trail can contain a step the state never recorded.`,
  sequence: {
    participants: ['Approval API', 'approval.event', 'Trail consumer', 'Redis'],
    messages: [
      {from: 'Approval API', to: 'Redis', label: 'state.commit_step(request_id, step, actor, decision)', kind: 'sync'},
      {from: 'Redis', to: 'Approval API', label: 'step committed', kind: 'reply'},
      {from: 'Approval API', to: 'approval.event', label: 'produce · key = request_id · acks = all', kind: 'sync'},
      {from: 'approval.event', to: 'Approval API', label: 'ack / broker error → insertOutbox', kind: 'reply'},
      {from: 'approval.event', to: 'Trail consumer', label: 'consume · group trail', kind: 'async'},
      {from: 'Trail consumer', to: 'Redis', label: 'HSET approval:{request_id}:trail step:{n}', kind: 'sync'},
      {from: 'Trail consumer', to: 'approval.event', label: 'commit the offset after the write', kind: 'async'},
    ],
  },
  hints: [
    'The key is the ordering contract: `key=request_id` (`Key: []byte(requestID)`, `key: request_id`, `ProducerRecord("approval.event", requestId, …)`). Partitioned by approver, one request’s chain is spread over as many partitions as it has approvers and the trail can be assembled out of order.',
    'Build the event from ids and enums only — `request_id`, `kind`, `step`, `actor`, `actor_role`, `decision`. The `why` text and the attachments stay where they belong: in the request record and the object store. A topic is a retained, replicated, replicated-again data store, not a log line.',
    'Idempotence is producer configuration (`enable.idempotence` + `acks=all`, `idempotent: true`, required acks `all` with hashed routing), and the outbox is the durability half: catch the produce error and insert the event as an outbox row. Ordering is the third half: commit the step in state, then publish.',
  ],
  checks: [
    {
      id: 'request-key',
      title: 'Keyed by the request id, carrying ids and enums',
      detail:
        'The message key is the request id, so every event of one chain lands in one partition and stays ordered, and the payload carries `step` and `actor_role`. The draft keys by the approver, so one request’s chain is scattered.',
      match: {
        python: {all: [/key=request_id/, /actor_role/]},
        typescript: {all: [/key:\s*requestId/, /actor_role/]},
        go: {all: [/Key:\s*\[\]byte\(body\.RequestID\)/, /ActorRole/]},
        scala: {all: [/ProducerRecord\[String,\s*String\]\(Topic,\s*event\.request_id/, /actor_role/]},
        cpp: {all: [/produce\(kApprovalTopic[^;\n]*requestId/, /actor_role/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` plus `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. A retry of a produce must not duplicate a record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-content',
      title: 'No why text and no attachments in the event',
      detail:
        'Nothing that carries request content — the `why` field, an attachment list, a file name — reaches the topic or the logs. The draft copies both into a retained, replicated topic.',
      match: {
        python: {none: [/\bwhy\b/, /attachment/i]},
        typescript: {none: [/\bwhy\b/, /attachment/i]},
        go: {none: [/\bwhy\b/, /attachment/i]},
        scala: {none: [/\bwhy\b/, /attachment/i]},
        cpp: {none: [/\bwhy\b/, /attachment/i]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Publishes only after the state commit',
      detail:
        'A decision commits the step in Redis (`state.commit_step` / `commitStep` / `CommitStep`) before the produce, so a crash between the two replays the decision instead of reporting a step that was never recorded. The draft acks the broker first and commits afterwards.',
      match: {
        python: {order: [/state\.commit_step\(/, /producer\.produce\(/]},
        typescript: {order: [/state\.commitStep\(/, /producer\.send\(/]},
        go: {order: [/state\.CommitStep\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/state\.commitStep\(/, /producer\.send\(/]},
        cpp: {order: [/state::commit_step\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox` / `insertOutbox`) inside the error branch instead of dropping the event or failing the caller, and the consumer commits its offset only after the trail write.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, KafkaException, Producer

import state

logger = logging.getLogger("approval.events")

TOPIC = "approval.event"

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class OutboxStore:
    def insert_outbox(self, request_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it when the broker recovers."""
        raise NotImplementedError


store = OutboxStore()


def on_delivery(err, _msg) -> None:
    if err is not None:
        logger.warning("approval.event delivery failed: %s", err)


def publish_event(
    request_id: str,
    kind: str,
    step: int,
    actor: str,
    actor_role: str,
    why: str,
    attachments: list[str],
    decision: str = "",
) -> dict:
    # TODO: this draft keys by the approver, copies the why text and the attachments into the
    # payload, and acknowledges the broker before the step is committed in state. Review all three.
    event = {
        "request_id": request_id,
        "kind": kind,
        "step": step,
        "actor": actor,
        "actor_role": actor_role,
        "why": why,
        "attachments": attachments,
        "decision": decision,
    }
    try:
        producer.produce(TOPIC, key=actor, value=json.dumps(event), on_delivery=on_delivery)
        producer.flush(5)
    except KafkaException:
        store.insert_outbox(request_id, event)
    if kind == "decision":
        state.commit_step(request_id, step, actor, decision)
    return event


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "trail", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(0.2)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        consumer.commit(msg)
        r.hset(f"approval:{event['request_id']}:trail", f"step:{event['step']}", json.dumps(event))
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, KafkaException, Producer

import state

logger = logging.getLogger("approval.events")

TOPIC = "approval.event"

producer = Producer(
    {"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"}
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class OutboxStore:
    def insert_outbox(self, request_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it when the broker recovers."""
        raise NotImplementedError


store = OutboxStore()


def on_delivery(err, _msg) -> None:
    if err is not None:
        logger.warning("approval.event delivery failed: %s", err)


def publish_event(
    request_id: str,
    kind: str,
    step: int,
    actor: str,
    actor_role: str,
    decision: str = "",
) -> dict:
    """One approval.event per step change, keyed by the request id so a chain stays ordered."""
    event = {
        "request_id": request_id,
        "kind": kind,
        "step": step,
        "actor": actor,
        "actor_role": actor_role,
        "decision": decision,
    }
    # The step is durable before the broker hears about it, never the other way round.
    if kind == "decision":
        state.commit_step(request_id, step, actor, decision)
    try:
        producer.produce(TOPIC, key=request_id, value=json.dumps(event), on_delivery=on_delivery)
        producer.flush(5)
    except KafkaException:
        store.insert_outbox(request_id, event)
    return event


def consume() -> None:
    """The trail consumer writes the step into Redis, then commits the offset."""
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "trail", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(0.2)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        r.hset(f"approval:{event['request_id']}:trail", f"step:{event['step']}", json.dumps(event))
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** approval.event: a model-generated draft keyed by approver that still commits after the ack. */
import {Kafka} from 'kafkajs';

import {state} from './state';

const kafka = new Kafka({clientId: 'approval-workflow', brokers: ['kafka:9092']});
const producer = kafka.producer({});
const r = undefined as unknown;

export const TOPIC = 'approval.event';

export const store = {
  async insertOutbox(requestId: string, event: Record<string, unknown>): Promise<void> {
    throw new Error('the outbox is not wired up');
  },
};

export interface ApprovalEvent {
  request_id: string;
  kind: string;
  step: number;
  actor: string;
  actor_role: string;
  decision: string;
}

export async function publishEvent(
  requestId: string,
  kind: string,
  step: number,
  actor: string,
  actorRole: string,
  why: string,
  attachments: string[],
  decision = '',
): Promise<Record<string, unknown>> {
  // TODO: this draft keys by the approver, copies the why text and the attachments into the
  // payload, and acknowledges the broker before the step is committed in state. Review all three.
  const event = {
    request_id: requestId,
    kind,
    step,
    actor,
    actor_role: actorRole,
    why,
    attachments,
    decision,
  };
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{key: actor, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(requestId, event);
  }
  if (kind === 'decision') await state.commitStep(requestId, step, actor, decision);
  return event;
}

async function runConsumer(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'trail'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as ApprovalEvent;
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      void event;
      void r;
    },
  });
}

void runConsumer();
void producer.connect();
`,
      solution: `/** approval.event: one request-keyed event per step change, published after the commit. */
import {Kafka} from 'kafkajs';

import {state} from './state';

const kafka = new Kafka({clientId: 'approval-workflow', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});

export const TOPIC = 'approval.event';

export const store = {
  async insertOutbox(requestId: string, event: Record<string, unknown>): Promise<void> {
    throw new Error('the outbox is not wired up');
  },
};

export interface ApprovalEvent {
  request_id: string;
  kind: string;
  step: number;
  actor: string;
  actor_role: string;
  decision: string;
}

/** One approval.event per step change, keyed by the request id so a chain stays ordered. */
export async function publishEvent(
  requestId: string,
  kind: string,
  step: number,
  actor: string,
  actorRole: string,
  decision = '',
): Promise<Record<string, unknown>> {
  const event = {
    request_id: requestId,
    kind,
    step,
    actor,
    actor_role: actorRole,
    decision,
  };
  // The step is durable before the broker hears about it, never the other way round.
  if (kind === 'decision') await state.commitStep(requestId, step, actor, decision);
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: requestId, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(requestId, event);
  }
  return event;
}

async function runConsumer(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'trail'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as ApprovalEvent;
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      void event;
    },
  });
}

void runConsumer();
void producer.connect();
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const topic = "approval.event"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, requestID string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

type EventBody struct {
	RequestID string   \`json:"request_id"\`
	Kind      string   \`json:"kind"\`
	Step      int      \`json:"step"\`
	Actor     string   \`json:"actor"\`
	ActorRole string   \`json:"actor_role"\`
	Decision  string   \`json:"decision"\`
	Why       string   \`json:"why"\`
	Attachments []string \`json:"attachments"\`
}

func publishEvent(ctx context.Context, body EventBody) (map[string]any, error) {
	// TODO: this draft keys by the approver, copies the why text and the attachments into the
	// payload, and acknowledges the broker before the step is committed in state. Review all three.
	event := map[string]any{
		"request_id":  body.RequestID,
		"kind":        body.Kind,
		"step":        body.Step,
		"actor":       body.Actor,
		"actor_role":  body.ActorRole,
		"decision":    body.Decision,
		"why":         body.Why,
		"attachments": body.Attachments,
	}
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(body.Actor), Value: payload}); err != nil {
		_ = store.InsertOutbox(ctx, body.RequestID, event)
	}
	if body.Kind == "decision" {
		state.CommitStep(ctx, body.RequestID, body.Step, body.Actor, body.Decision)
	}
	return event, nil
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: "trail",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const topic = "approval.event"

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, requestID string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

type EventBody struct {
	RequestID string \`json:"request_id"\`
	Kind      string \`json:"kind"\`
	Step      int    \`json:"step"\`
	Actor     string \`json:"actor"\`
	ActorRole string \`json:"actor_role"\`
	Decision  string \`json:"decision"\`
}

// publishEvent writes one approval.event, keyed by the request id so a chain stays ordered.
func publishEvent(ctx context.Context, body EventBody) (map[string]any, error) {
	event := map[string]any{
		"request_id": body.RequestID,
		"kind":       body.Kind,
		"step":       body.Step,
		"actor":      body.Actor,
		"actor_role": body.ActorRole,
		"decision":   body.Decision,
	}
	// The step is durable before the broker hears about it, never the other way round.
	if body.Kind == "decision" {
		state.CommitStep(ctx, body.RequestID, body.Step, body.Actor, body.Decision)
	}
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(body.RequestID), Value: payload}); err != nil {
		_ = store.InsertOutbox(ctx, body.RequestID, event)
	}
	return event, nil
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: "trail",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event EventBody
		_ = json.Unmarshal(msg.Value, &event)
		state.WriteTrail(ctx, event.RequestID, event.Step, msg.Value)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json.DefaultJsonProtocol._
import spray.json._

import java.util.Properties
import scala.jdk.CollectionConverters._

final case class ApprovalEvent(
    request_id: String,
    kind: String,
    step: Int,
    actor: String,
    actor_role: String,
    decision: String,
    why: String,
    attachments: List[String]
)

object Events {
  implicit val eventFormat: RootJsonFormat[ApprovalEvent] = jsonFormat8(ApprovalEvent)

  val Topic = "approval.event"

  val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  object store {
    def insertOutbox(requestId: String, event: String): Unit = throw new NotImplementedError("outbox")
  }

  def publishEvent(event: ApprovalEvent): Unit = {
    // TODO: this draft keys by the approver, copies the why text and the attachments into the
    // payload, and acknowledges the broker before the step is committed in state. Review all three.
    val payload = event.toJson.compactPrint
    try {
      producer.send(new ProducerRecord[String, String](Topic, event.actor, payload))
    } catch {
      case _: Exception => store.insertOutbox(event.request_id, payload)
    }
    if (event.kind == "decision") {
      state.commitStep(event.request_id, event.step, event.actor, event.decision)
    }
  }

  def consume(groupId: String): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", groupId)
    props.put("enable.auto.commit", "false")
    val consumer = new org.apache.kafka.clients.consumer.KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        jedis.hset(s"approval:\${event("request_id").convertTo[String]}:trail", s"step:\${event("step")}", record.value())
      }
    }
  }
}
`,
      solution: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json.DefaultJsonProtocol._
import spray.json._

import java.util.Properties

final case class ApprovalEvent(
    request_id: String,
    kind: String,
    step: Int,
    actor: String,
    actor_role: String,
    decision: String
)

object Events {
  implicit val eventFormat: RootJsonFormat[ApprovalEvent] = jsonFormat6(ApprovalEvent)

  val Topic = "approval.event"

  val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  val producer = new KafkaProducer[String, String](props)

  object store {
    def insertOutbox(requestId: String, event: String): Unit = throw new NotImplementedError("outbox")
  }

  /** One approval.event per step change, keyed by the request id so a chain stays ordered. */
  def publishEvent(event: ApprovalEvent): Unit = {
    val payload = event.toJson.compactPrint
    // The step is durable before the broker hears about it, never the other way round.
    if (event.kind == "decision") {
      state.commitStep(event.request_id, event.step, event.actor, event.decision)
    }
    try {
      producer.send(new ProducerRecord[String, String](Topic, event.request_id, payload))
    } catch {
      case _: Exception => store.insertOutbox(event.request_id, payload)
    }
  }

  def consume(groupId: String): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", groupId)
    props.put("enable.auto.commit", "false")
    val consumer = new org.apache.kafka.clients.consumer.KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        jedis.hset(s"approval:\${event("request_id").convertTo[String]}:trail", s"step:\${event("step")}", record.value())
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kApprovalTopic = "approval.event";

struct OutboxStore {
  void insertOutbox(const std::string& requestId, const json& event);
};

OutboxStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: this draft keys by the approver, copies the why text and the attachments into the payload,
// and acknowledges the broker before the step is committed in state. Review all three.
void publishEvent(
    const std::string& requestId,
    const std::string& kind,
    int step,
    const std::string& actor,
    const std::string& actorRole) {
  const json event = {
      {"request_id", requestId},
      {"kind", kind},
      {"step", step},
      {"actor", actor},
      {"actor_role", actorRole},
      {"attachments", json::array()},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(kApprovalTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), actor.data(), actor.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(requestId, event);
  }
  producer->flush(2000);
  if (kind == "decision") {
    state::commit_step(requestId, step, actor, "");
  }
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"approval.event"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kApprovalTopic = "approval.event";

struct OutboxStore {
  void insertOutbox(const std::string& requestId, const json& event);
};

OutboxStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

/** One approval.event per step change, keyed by the request id so a chain stays ordered. */
void publishEvent(
    const std::string& requestId,
    const std::string& kind,
    int step,
    const std::string& actor,
    const std::string& actorRole,
    const std::string& decision) {
  const json event = {
      {"request_id", requestId},
      {"kind", kind},
      {"step", step},
      {"actor", actor},
      {"actor_role", actorRole},
      {"decision", decision},
  };
  const auto payload = event.dump();
  // The step is durable before the broker hears about it, never the other way round.
  if (kind == "decision") {
    state::commit_step(requestId, step, actor, decision);
  }
  const auto err = producer->produce(kApprovalTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), requestId.data(), requestId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(requestId, event);
  }
  producer->flush(2000);
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"approval.event"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()));
    redis->hset("approval:" + event["request_id"].get<std::string>() + ":trail", "step:" + event["step"].dump(), static_cast<const char*>(msg->payload()));
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  debrief: `Three Kafka contracts are being tested here, and each one is invisible until production. The
  message key decides ordering: keyed by the request id, one request's submit, decisions, delegation
  and completion events land in the same partition and are consumed in the order they happened;
  keyed by the approver, the chain is spread across partitions and the trail is assembled by luck.
  The payload decides the blast radius of a leak: an id and an enum can live in a retained topic, but
  the \`why\` text and the attachment list cannot — the topic outlives the request and every retention
  policy around it. The order of the two writes decides durability: commit the step in state, then
  publish; acking first lets a crash between the two announce an approval the state never recorded.
  Real platforms add a schema registry that makes the payload shape a compile-time contract, a relay
  that drains the outbox with the same idempotent producer, and a dead-letter topic for records the
  consumer can never apply.`,
};
