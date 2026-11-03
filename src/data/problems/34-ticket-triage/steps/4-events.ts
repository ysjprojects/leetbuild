import type {Step} from '@/lib/types';

export const triageEventsStep: Step = {
  id: 'events',
  title: 'Triage events keyed by ticket for downstream routing',
  concept: 'kafka',
  file: 'events',
  focus: ['triage', 'kafka', 'consumer', 'db'],
  task: `## Task

**Starting point.** The starter's \`publish\` builds \`{ticket_id, queue, text}\`, produces it to
\`triage.decided\` keyed by the queue and polls once; \`consume\` joins the \`routing\` group with
default settings, commits the offset, then records the routing. It serves the demo and hides five
flaws.

**Failure mode the checks target.** A queue-keyed topic scatters one tenant's tickets across
partitions, so the routing consumer can no longer assert order. Ticket text in a topic is customer
content with a retention policy, replicated to every broker. A produce nobody checks is an event
nobody notices losing, and a commit before the routing record is a silent data-loss window on every
rebalance.

- **Topic and key.** The decision is published to \`triage.decided\` **keyed by tenant**, so every
  ticket of one tenant lands on the same partition and the tenant's stream stays ordered.
- **Payload.** The event carries ids and scores: \`ticket_id\`, \`tenant\`, \`queue\`, \`priority\`,
  \`confidence\`, \`fallback_reason\`. The ticket text stays out of the payload.
- **Outbox on rejection.** When the broker rejects the produce (or the delivery report says the
  message did not land), the event is written to an **outbox row** for republishing.
- **Record before commit.** The consumer writes the routing record **before** it commits its offset.
- The consumer commits its own offsets (\`enable.auto.commit=false\`) inside the group
  \`routing\`, and the producer waits for all in-sync replicas (\`acks=all\`).`,
  sequence: {
    participants: ['triage-api', 'triage.decided', 'Routing consumer'],
    messages: [
      {
        from: 'triage-api',
        to: 'triage.decided',
        label: 'produce triage.decided · key = tenant · {ticket_id, queue, priority, confidence}',
        kind: 'async',
      },
      {from: 'triage.decided', to: 'triage-api', label: 'delivery report: rejected → outbox row', kind: 'reply'},
      {
        from: 'triage.decided',
        to: 'Routing consumer',
        label: 'consume · group routing · one partition per tenant',
        kind: 'async',
      },
      {from: 'Routing consumer', to: 'Routing consumer', label: 'recordRouting(event)', kind: 'sync'},
      {from: 'Routing consumer', to: 'triage.decided', label: 'commitOffsets after the routing record', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Publishes triage.decided keyed by tenant',
      detail:
        'The message key is the tenant on `triage.decided`, so one tenant’s tickets share a partition and stay ordered. The starter keys by the queue, which interleaves tenants.',
      match: {
        python: {all: [/triage\.decided/, /key=tenant/]},
        typescript: {all: [/triage\.decided/, /key:\s*tenant/]},
        go: {all: [/triage\.decided/, /Key:\s*\[\]byte\(tenant\)/]},
        scala: {all: [/triage\.decided/, /ProducerRecord\[String, String\]\(TriageTopic, tenant/]},
        cpp: {all: [/triage\.decided/, /RD_KAFKA_V_KEY\(tenant/]},
      },
    },
    {
      id: 'ids-not-text',
      title: 'Carries ids and scores, not the ticket text',
      detail:
        'The event has `ticket_id`, `queue`, `priority` and `confidence`; the ticket text is not published. The starter puts the raw text in the payload, so a retained topic becomes a copy of the customer inbox.',
      match: {
        python: {all: [/ticket_id/, /confidence/, /queue/], none: [/"text"/]},
        typescript: {all: [/ticket_id/, /confidence/, /queue/], none: [/text:/]},
        go: {all: [/"ticket_id"/, /"confidence"/, /"queue"/], none: [/"text"/]},
        scala: {all: [/ticket_id/, /confidence/, /queue/], none: [/"text"/]},
        cpp: {all: [/"ticket_id"/, /"confidence"/, /"queue"/], none: [/"text"/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A rejected produce (a thrown error, a non-zero result or a failed delivery report) writes an outbox row instead of dropping the event. The starter assumes the produce always lands.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+\w+/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/insertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /case Failure/]},
        cpp: {all: [/outbox\.insert\(/, /RD_KAFKA_RESP_ERR_NO_ERROR/]},
      },
    },
    {
      id: 'record-before-commit',
      title: 'Records the routing before committing the offset',
      detail:
        'The consumer stores the routing record and only then commits its offset, so a crash between the two replays the event instead of losing it. The starter commits first.',
      match: {
        python: {order: [/store\.record_routing\(/, /\.commit\(/]},
        typescript: {order: [/store\.recordRouting\(/, /commitOffsets\(/]},
        go: {order: [/store\.recordRouting\(/, /CommitMessages\(/]},
        scala: {order: [/store\.recordRouting\(/, /commitSync\(/]},
        cpp: {order: [/recordRouting\(/, /rd_kafka_commit\(/]},
      },
    },
    {
      id: 'manual-commit',
      title: 'Commits its own offsets and produces with acks=all',
      detail:
        'The consumer runs in the `routing` group with `enable.auto.commit=false` and commits offsets itself; auto-commit would advance the offset before the routing record is written. The producer waits for all in-sync replicas, and Go’s reader commits through `CommitMessages`. The starter configures neither.',
      match: {
        python: {all: [/enable\.auto\.commit/, /False/, /acks": "all"/]},
        typescript: {all: [/autoCommit:\s*false/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /GroupID/, /CommitMessages\(/]},
        scala: {all: [/ConsumerConfig\.ENABLE_AUTO_COMMIT_CONFIG/, /"false"/, /ACKS_CONFIG/]},
        cpp: {all: [/"enable\.auto\.commit",\s*"false"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer

log = logging.getLogger("triage")

TRIAGE_TOPIC = "triage.decided"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish(ticket: dict, decision: dict) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "ticket_id": ticket["ticket_id"],
        "queue": decision["queue"],
        "text": ticket["text"],
    }
    producer.produce(TRIAGE_TOPIC, key=decision["queue"], value=json.dumps(event))
    producer.poll(0)


def consume(store) -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "routing"})
    consumer.subscribe([TRIAGE_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        consumer.commit(msg)
        store.record_routing(event)
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, Producer

log = logging.getLogger("triage")

TRIAGE_TOPIC = "triage.decided"

producer = Producer(
    {"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"}
)


def build_event(ticket: dict, decision: dict) -> dict:
    """Ids and scores travel; the ticket text stays in the routing record and never in the topic."""
    return {
        "ticket_id": ticket["ticket_id"],
        "tenant": ticket["tenant"],
        "queue": decision["queue"],
        "priority": decision["priority"],
        "confidence": decision["confidence"],
        "fallback_reason": decision["fallback_reason"],
    }


def publish(store, ticket: dict, decision: dict) -> None:
    event = build_event(ticket, decision)
    tenant = ticket["tenant"]
    try:
        producer.produce(TRIAGE_TOPIC, key=tenant, value=json.dumps(event))
        producer.poll(0)
    except BufferError:
        store.insert_outbox(event)


def consume(store) -> None:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "routing",
            "enable.auto.commit": False,
            "auto.offset.reset": "earliest",
        }
    )
    consumer.subscribe([TRIAGE_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        store.record_routing(event)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** triage.decided. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'triage-api', brokers: ['kafka:9092']});
const producer = kafka.producer();
const TRIAGE_TOPIC = 'triage.decided';

interface RoutingEvent {
  ticket_id: string;
  queue: string;
  text: string;
}

export async function publish(ticket: {ticket_id: string; tenant: string; text: string}, queue: string): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const event: RoutingEvent = {ticket_id: ticket.ticket_id, queue, text: ticket.text};
  await producer.send({
    topic: TRIAGE_TOPIC,
    messages: [{key: queue, value: JSON.stringify(event)}],
  });
}

export async function consume(store: {
  recordRouting(event: RoutingEvent): Promise<void>;
}): Promise<void> {
  const consumer = kafka.consumer({groupId: 'routing'});
  await consumer.connect();
  await consumer.subscribe({topic: TRIAGE_TOPIC});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as RoutingEvent;
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await store.recordRouting(event);
    },
  });
}
`,
      solution: `/** triage.decided: tenant-keyed routing events with ids and scores, an outbox and a late commit. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'triage-api', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
const TRIAGE_TOPIC = 'triage.decided';

interface Ticket {
  ticket_id: string;
  tenant: string;
}

interface Decision {
  queue: string;
  priority: string;
  confidence: number;
  fallback_reason: string;
}

interface RoutingEvent {
  ticket_id: string;
  tenant: string;
  queue: string;
  priority: string;
  confidence: number;
  fallback_reason: string;
}

interface RoutingStore {
  insertOutbox(event: RoutingEvent): Promise<void>;
  recordRouting(event: RoutingEvent): Promise<void>;
}

export function buildEvent(ticket: Ticket, decision: Decision): RoutingEvent {
  return {
    ticket_id: ticket.ticket_id,
    tenant: ticket.tenant,
    queue: decision.queue,
    priority: decision.priority,
    confidence: decision.confidence,
    fallback_reason: decision.fallback_reason,
  };
}

export async function publish(store: RoutingStore, ticket: Ticket, decision: Decision): Promise<void> {
  const event = buildEvent(ticket, decision);
  const tenant = ticket.tenant;
  try {
    await producer.send({
      topic: TRIAGE_TOPIC,
      acks: -1,
      messages: [{key: tenant, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(event);
  }
}

export async function consume(store: RoutingStore): Promise<void> {
  const consumer = kafka.consumer({groupId: 'routing'});
  await consumer.connect();
  await consumer.subscribe({topic: TRIAGE_TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as RoutingEvent;
      await store.recordRouting(event);
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
	"log"

	"github.com/segmentio/kafka-go"
)

const triageTopic = "triage.decided"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: triageTopic}

type Ticket struct {
	TicketID string \`json:"ticket_id"\`
	Tenant   string \`json:"tenant"\`
	Text     string \`json:"text"\`
}

type RoutingEvent struct {
	TicketID string \`json:"ticket_id"\`
	Queue    string \`json:"queue"\`
	Text     string \`json:"text"\`
}

func publish(ctx context.Context, ticket Ticket, queue string) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	event := RoutingEvent{TicketID: ticket.TicketID, Queue: queue, Text: ticket.Text}
	payload, _ := json.Marshal(event)
	_ = writer.WriteMessages(ctx, kafka.Message{Key: []byte(queue), Value: payload})
}

func consume(ctx context.Context, store *RoutingStore) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   triageTopic,
		GroupID: "routing",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event RoutingEvent
		_ = json.Unmarshal(msg.Value, &event)
		if err := reader.CommitMessages(ctx, msg); err != nil {
			log.Printf("commit failed: %v", err)
		}
		store.recordRouting(ctx, event)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const triageTopic = "triage.decided"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        triageTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type Ticket struct {
	TicketID string \`json:"ticket_id"\`
	Tenant   string \`json:"tenant"\`
}

type Decision struct {
	Queue          string  \`json:"queue"\`
	Priority       string  \`json:"priority"\`
	Confidence     float64 \`json:"confidence"\`
	FallbackReason string  \`json:"fallback_reason"\`
}

// RoutingEvent is what downstream routing consumes: ids and scores, never the ticket text.
type RoutingEvent struct {
	TicketID       string  \`json:"ticket_id"\`
	Tenant         string  \`json:"tenant"\`
	Queue          string  \`json:"queue"\`
	Priority       string  \`json:"priority"\`
	Confidence     float64 \`json:"confidence"\`
	FallbackReason string  \`json:"fallback_reason"\`
}

type RoutingStore struct{}

func (s *RoutingStore) insertOutbox(ctx context.Context, event RoutingEvent) {}

func (s *RoutingStore) recordRouting(ctx context.Context, event RoutingEvent) {}

func buildEvent(ticket Ticket, decision Decision) RoutingEvent {
	return RoutingEvent{
		TicketID:       ticket.TicketID,
		Tenant:         ticket.Tenant,
		Queue:          decision.Queue,
		Priority:       decision.Priority,
		Confidence:     decision.Confidence,
		FallbackReason: decision.FallbackReason,
	}
}

func publish(ctx context.Context, store *RoutingStore, ticket Ticket, decision Decision) {
	event := buildEvent(ticket, decision)
	tenant := ticket.Tenant
	payload, err := json.Marshal(event)
	if err != nil {
		store.insertOutbox(ctx, event)
		return
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: payload}); err != nil {
		store.insertOutbox(ctx, event)
	}
}

func consume(ctx context.Context, store *RoutingStore) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   triageTopic,
		GroupID: "routing",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event RoutingEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed event: %v", err)
			continue
		}
		store.recordRouting(ctx, event)
		if err := reader.CommitMessages(ctx, msg); err != nil {
			log.Printf("commit failed: %v", err)
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.{Collections, Properties}

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

final case class Ticket(ticket_id: String, tenant: String, text: String)
final case class RoutingEvent(ticket_id: String, queue: String, text: String)

trait RoutingStore {
  def recordRouting(event: RoutingEvent): Unit
}

object TriageEvents {
  val TriageTopic = "triage.decided"

  val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  val producer = new KafkaProducer[String, String](producerProps)

  def publish(ticket: Ticket, queue: String): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val event = RoutingEvent(ticket.ticket_id, queue, ticket.text).toJson.compactPrint
    producer.send(new ProducerRecord[String, String](TriageTopic, queue, event))
  }

  def consume(store: RoutingStore): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "routing")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(Collections.singletonList(TriageTopic))
    val records = consumer.poll(java.time.Duration.ofMillis(500))
    records.forEach { record =>
      val event = RoutingEvent(record.key(), record.topic(), record.value())
      consumer.commitSync()
      store.recordRouting(event)
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.{Collections, Properties}
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.util.{Failure, Success, Try}

final case class Ticket(ticket_id: String, tenant: String)
final case class Decision(queue: String, priority: String, confidence: Double, fallback_reason: String)

/** Ids and scores travel; the ticket text stays in the routing record and out of the topic. */
final case class RoutingEvent(
    ticket_id: String,
    tenant: String,
    queue: String,
    priority: String,
    confidence: Double,
    fallback_reason: String
)

trait RoutingStore {
  def insertOutbox(event: RoutingEvent): Unit
  def recordRouting(event: RoutingEvent): Unit
}

object TriageEvents {
  val TriageTopic = "triage.decided"
  val log = Logger.getLogger("triage")

  implicit val eventFormat: RootJsonFormat[RoutingEvent] = jsonFormat6(RoutingEvent)

  val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  producerProps.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  producerProps.put(ProducerConfig.ACKS_CONFIG, "all")
  val producer = new KafkaProducer[String, String](producerProps)

  def buildEvent(ticket: Ticket, decision: Decision): RoutingEvent =
    RoutingEvent(
      ticket.ticket_id,
      ticket.tenant,
      decision.queue,
      decision.priority,
      decision.confidence,
      decision.fallback_reason
    )

  def publish(store: RoutingStore, ticket: Ticket, decision: Decision): Unit = {
    val event = buildEvent(ticket, decision)
    val tenant = ticket.tenant
    Try(producer.send(new ProducerRecord[String, String](TriageTopic, tenant, event.toJson.compactPrint))) match {
      case Failure(error) => store.insertOutbox(event)
      case Success(_) => ()
    }
  }

  def consume(store: RoutingStore): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "routing")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(Collections.singletonList(TriageTopic))
    while (true) {
      val records = consumer.poll(Duration.ofMillis(500))
      records.forEach { record =>
        val event = record.value().parseJson.convertTo[RoutingEvent]
        log.info(s"routing ticket=\${event.ticket_id} queue=\${event.queue}")
        store.recordRouting(event)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <chrono>
#include <iostream>
#include <string>

#include <librdkafka/rdkafka.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

static rd_kafka_t* make_producer(char* errstr, std::size_t errlen) {
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, errlen);
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, errlen);
}

static void publish(rd_kafka_t* producer, const json& ticket, const std::string& queue) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const json event = {
      {"ticket_id", ticket["ticket_id"]},
      {"queue", queue},
      {"text", ticket["text"]},
  };
  const std::string payload = event.dump();
  rd_kafka_producev(
      producer,
      RD_KAFKA_V_TOPIC("triage.decided"),
      RD_KAFKA_V_MSGFLAGS(RD_KAFKA_MSG_F_COPY),
      RD_KAFKA_V_KEY(queue.data(), queue.size()),
      RD_KAFKA_V_VALUE(payload.data(), payload.size()),
      RD_KAFKA_V_END);
  rd_kafka_poll(producer, 0);
}

static void consume(rd_kafka_t* consumer) {
  while (true) {
    rd_kafka_message_t* msg = rd_kafka_consumer_poll(consumer, 500);
    if (!msg) continue;
    if (msg->err) {
      rd_kafka_message_destroy(msg);
      continue;
    }
    const auto event = json::parse(std::string(static_cast<const char*>(msg->payload), msg->len));
    rd_kafka_commit(consumer, nullptr, 0);
    recordRouting(event);
    rd_kafka_message_destroy(msg);
  }
}
`,
      solution: `#include <chrono>
#include <string>
#include <vector>

#include <librdkafka/rdkafka.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

struct Outbox {
  void insert(const json& event, const std::string& reason) {}
};

static Outbox outbox;

static rd_kafka_t* make_producer(char* errstr, std::size_t errlen) {
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, errlen);
  rd_kafka_conf_set(conf, "enable.idempotence", "true", errstr, errlen);
  rd_kafka_conf_set(conf, "acks", "all", errstr, errlen);
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, errlen);
}

static rd_kafka_t* make_consumer(char* errstr, std::size_t errlen) {
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, errlen);
  rd_kafka_conf_set(conf, "group.id", "routing", errstr, errlen);
  rd_kafka_conf_set(conf, "enable.auto.commit", "false", errstr, errlen);
  return rd_kafka_new(RD_KAFKA_CONSUMER, conf, errstr, errlen);
}

static json buildEvent(const json& ticket, const json& decision) {
  return json{
      {"ticket_id", ticket["ticket_id"]},
      {"tenant", ticket["tenant"]},
      {"queue", decision["queue"]},
      {"priority", decision["priority"]},
      {"confidence", decision["confidence"]},
      {"fallback_reason", decision["fallback_reason"]},
  };
}

static void publish(rd_kafka_t* producer, const json& ticket, const json& decision) {
  const json event = buildEvent(ticket, decision);
  const std::string tenant = ticket["tenant"].get<std::string>();
  const std::string payload = event.dump();
  const rd_kafka_resp_err_t err = rd_kafka_producev(
      producer,
      RD_KAFKA_V_TOPIC("triage.decided"),
      RD_KAFKA_V_MSGFLAGS(RD_KAFKA_MSG_F_COPY),
      RD_KAFKA_V_KEY(tenant.data(), tenant.size()),
      RD_KAFKA_V_VALUE(payload.data(), payload.size()),
      RD_KAFKA_V_END);
  if (err != RD_KAFKA_RESP_ERR_NO_ERROR) {
    outbox.insert(event, rd_kafka_err2str(err));
  }
  rd_kafka_poll(producer, 0);
}

static void consume(rd_kafka_t* consumer) {
  while (true) {
    rd_kafka_message_t* msg = rd_kafka_consumer_poll(consumer, 500);
    if (!msg) continue;
    if (msg->err) {
      rd_kafka_message_destroy(msg);
      continue;
    }
    const auto event = json::parse(std::string(static_cast<const char*>(msg->payload), msg->len));
    recordRouting(event);
    rd_kafka_commit(consumer, nullptr, 0);
    rd_kafka_message_destroy(msg);
  }
}
`,
    },
  },
  hints: [
    'Read the topic from a second consumer: one tenant’s tickets arrive out of order across partitions, and every message carries the customer’s full ticket. Kill the consumer mid-batch and a routing record vanishes.',
    'The producer key is `decision["queue"]`, the event dict includes `ticket["text"]`, nothing catches a failed produce, the consumer runs with auto-commit on, and `consumer.commit(msg)` precedes `store.record_routing(event)`.',
    'Key by `tenant`, build the event from ids and scores, wrap the produce in `except` that calls `insert_outbox`, set `enable.auto.commit` to `False` and `acks` to `all`, and commit only after `record_routing`.',
  ],
  debrief: `The key is the ordering contract: one tenant per partition gives the routing consumer a stream it can reason about, while keying by queue only buys parallelism the consumer did not ask for. Ids and scores travel because the text already lives in the routing record, where retention and access control apply; a topic is replicated and readable by any group that subscribes. The outbox and the record-before-commit order are two halves of the same promise: an event the broker rejected is kept for republishing, and an event the broker delivered is not acknowledged until the routing exists. Production platforms add a schema registry so a later producer cannot smuggle a text field back in, an outbox republisher that dedupes on \`ticket_id\`, and a lag alert on the routing group.`,
};
