import type {Step} from '@/lib/types';

export const triageEventsStep: Step = {
  id: 'events',
  title: 'triage.decided keyed by tenant, recorded before it is committed',
  concept: 'kafka',
  file: 'events',
  focus: ['triage', 'kafka', 'consumer', 'db'],
  task: `## Task

**Starting point.** The starter is the routing path. \`publish_decision(ticket, decision)\` takes the
ticket (\`ticket_id, tenant, text, received_at\`) and its decision (step 3's \`classify\`), produces
the event to \`triage.decided\` keyed by the decision's queue, and writes it to the outbox
(\`store.insert_outbox\`) when \`produce\` raises. \`run()\` is the routing consumer: group
\`routing\`, auto-commit off, it commits each record and then records the routing
(\`store.record_routing\`) the queue summary reads. It serves the demo and hides four flaws.

**Failure mode the checks target.** One tenant's tickets scatter over partitions, so the consumer
sees a ticket's correction before the ticket; the customer's words are copied into a retained,
replicated topic; a record the broker refuses is lost, because the refusal arrives after
\`produce\` returned; and a consumer that dies between its commit and its write loses the ticket
for good.

- Key every event by the **tenant**.
- The event is \`{ticket_id, tenant, queue, priority, confidence, fallback_reason, received_at}\`:
  no text.
- Write the outbox row where the broker answers: the delivery report (\`on_delivery\`, a rejected
  \`send\`, kafka-go's \`Completion\`, \`dr_cb\`, a producer \`Callback\`).
- \`run()\` records the routing, then commits.`,
  sequence: {
    participants: ['triage-api', 'triage.decided', 'outbox', 'Routing consumer', 'routing store'],
    messages: [
      {from: 'triage-api', to: 'triage.decided', label: 'produce · key = tenant · ids and scores', kind: 'async'},
      {from: 'triage.decided', to: 'triage-api', label: 'delivery report: refused', kind: 'reply'},
      {from: 'triage-api', to: 'outbox', label: 'insert_outbox(event) · the relay republishes it', kind: 'async'},
      {
        from: 'triage.decided',
        to: 'Routing consumer',
        label: 'group routing · one partition per tenant',
        kind: 'async',
      },
      {from: 'Routing consumer', to: 'routing store', label: 'record_routing(event)', kind: 'sync'},
      {from: 'Routing consumer', to: 'triage.decided', label: 'commit, after the record', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keys triage.decided by tenant',
      detail:
        "Every event is keyed by the ticket's tenant, so one tenant's tickets share a partition and the routing consumer sees them in order. Keyed by queue, a tenant's tickets interleave across partitions.",
      match: {
        python: {all: [/key\s*=\s*ticket\[\s*["']tenant["']\s*\]/]},
        typescript: {all: [/key:\s*ticket\.tenant/]},
        go: {all: [/Key:\s*\[\]byte\(ticket\.Tenant\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*ticket\.tenant/]},
        cpp: {all: [/ticket\.tenant\.c_str\(\)/]},
      },
    },
    {
      id: 'ids-not-text',
      title: 'Carries ids and scores, not the ticket text',
      detail:
        'The event is ticket_id, tenant, queue, priority, confidence, fallback_reason and received_at; nothing reads the ticket text into it.',
      match: {
        python: {none: [/ticket\[\s*["']text["']\s*\]/]},
        typescript: {none: [/ticket\.text/]},
        go: {none: [/ticket\.Text/]},
        scala: {none: [/ticket\.text/]},
        cpp: {none: [/ticket\.text/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Writes the outbox row from the delivery report',
      detail:
        "A record the broker refuses is written to the outbox where the broker's answer arrives (the delivery callback, the rejected send, the writer's completion); a `try` around the enqueue sees none of those.",
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /store\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/\.catch\(|await\s+producer\.send\(/, /insertOutbox\(/]},
        go: {all: [/store\.InsertOutbox\(/], none: [/Async:\s*true(?![\s\S]*Completion:)/]},
        scala: {all: [/new Callback|onCompletion/, /Store\.insertOutbox\(/]},
        cpp: {all: [/dr_cb/, /store::insertOutbox\(/]},
      },
    },
    {
      id: 'record-before-commit',
      title: 'Records the routing before committing the offset',
      detail:
        'The consumer writes the routing record and only then commits, so a crash between the two redelivers the event instead of losing the ticket.',
      match: {
        python: {order: [/store\.record_routing\(/, /\.commit\(/]},
        typescript: {order: [/await recordRouting\(/, /commitOffsets\(/]},
        go: {order: [/store\.RecordRouting\(/, /CommitMessages\(/]},
        scala: {order: [/Store\.recordRouting\(/, /commitSync\(/]},
        cpp: {order: [/store::recordRouting\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, KafkaException, Producer

from triage import store  # store.insert_outbox(event), store.record_routing(event)

TOPIC = "triage.decided"

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def publish_decision(ticket: dict, decision: dict) -> None:
    """Announce a routed ticket. ticket: ticket_id, tenant, text, received_at; decision: queue, priority, confidence, fallback_reason, ruleset_version."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    event = {
        "ticket_id": ticket["ticket_id"],
        "tenant": ticket["tenant"],
        "text": ticket["text"],
        "queue": decision["queue"],
        "priority": decision["priority"],
        "confidence": decision["confidence"],
        "fallback_reason": decision["fallback_reason"],
        "received_at": ticket["received_at"],
    }
    try:
        producer.produce(TOPIC, key=decision["queue"], value=json.dumps(event))
    except KafkaException:
        store.insert_outbox(event)
    producer.poll(0)


def run() -> None:
    """The routing consumer: records every routed ticket in its queue."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "routing", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(message=msg, asynchronous=False)
        store.record_routing(json.loads(msg.value()))
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, Producer

from triage import store  # store.insert_outbox(event), store.record_routing(event)

TOPIC = "triage.decided"
log = logging.getLogger("triage.events")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def publish_decision(ticket: dict, decision: dict) -> None:
    """Announce a routed ticket. ticket: ticket_id, tenant, text, received_at; decision: queue, priority, confidence, fallback_reason, ruleset_version."""
    # Ids and scores only: the topic is retained and replicated, the ticket's words stay in the ticket.
    event = {
        "ticket_id": ticket["ticket_id"],
        "tenant": ticket["tenant"],
        "queue": decision["queue"],
        "priority": decision["priority"],
        "confidence": decision["confidence"],
        "fallback_reason": decision["fallback_reason"],
        "received_at": ticket["received_at"],
    }

    def on_delivery(err, msg) -> None:
        if err is not None:
            store.insert_outbox(event)  # the broker said no: the relay republishes it later
            log.warning("triage.decided not delivered ticket=%s: %s", event["ticket_id"], err)

    producer.produce(TOPIC, key=ticket["tenant"], value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery reports already in; returns at once


def run() -> None:
    """The routing consumer: records every routed ticket in its queue."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "routing", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        store.record_routing(json.loads(msg.value()))
        consumer.commit(message=msg, asynchronous=False)  # after the record: a crash before this line redelivers
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import type {Decision} from 'triage/rules';
import {type Routing, insertOutbox, recordRouting} from 'triage/store';

export const TOPIC = 'triage.decided';

const kafka = new Kafka({clientId: 'triage-api', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true});
void producer.connect();

export interface Ticket {
  ticket_id: string;
  tenant: string;
  text: string;
  received_at: number;
}

/** Announce a routed ticket. */
export async function publishDecision(ticket: Ticket, decision: Decision): Promise<void> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const event = {
    ticket_id: ticket.ticket_id,
    tenant: ticket.tenant,
    text: ticket.text,
    queue: decision.queue,
    priority: decision.priority,
    confidence: decision.confidence,
    fallback_reason: decision.fallback_reason,
    received_at: ticket.received_at,
  };
  try {
    void producer.send({topic: TOPIC, messages: [{key: decision.queue, value: JSON.stringify(event)}], acks: -1});
  } catch {
    await insertOutbox(event);
  }
}

/** The routing consumer: records every routed ticket in its queue. */
export async function run(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'routing'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await recordRouting(JSON.parse(message.value?.toString() ?? '{}') as Routing);
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

import type {Decision} from 'triage/rules';
import {type Routing, insertOutbox, recordRouting} from 'triage/store';

export const TOPIC = 'triage.decided';

const kafka = new Kafka({clientId: 'triage-api', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true}); // idempotent implies acks: -1 (all)
void producer.connect();

export interface Ticket {
  ticket_id: string;
  tenant: string;
  text: string;
  received_at: number;
}

/** Announce a routed ticket. */
export async function publishDecision(ticket: Ticket, decision: Decision): Promise<void> {
  // Ids and scores only: the topic is retained and replicated, the ticket's words stay in the ticket.
  const event: Routing = {
    ticket_id: ticket.ticket_id,
    tenant: ticket.tenant,
    queue: decision.queue,
    priority: decision.priority,
    confidence: decision.confidence,
    fallback_reason: decision.fallback_reason,
    received_at: ticket.received_at,
  };
  // Not awaited: the ticket is already routed. The broker's refusal rejects the send; the relay republishes the row.
  producer
    .send({topic: TOPIC, messages: [{key: ticket.tenant, value: JSON.stringify(event)}], acks: -1})
    .catch(() => insertOutbox({...event}));
}

/** The routing consumer: records every routed ticket in its queue. */
export async function run(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'routing'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await recordRouting(JSON.parse(message.value?.toString() ?? '{}') as Routing);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]); // after the record
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

	"github.com/segmentio/kafka-go"

	"triage/rules" // rules.Decision
	"triage/store" // store.InsertOutbox(ctx, eventJSON), store.RecordRouting(ctx, store.Routing)
)

const topic = "triage.decided"

// Async: WriteMessages hands the record over and returns. kafka-go has no idempotent producer:
// RequireAll is what it can promise.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	Async:        true,
}

// Ticket is what the triage service knows about a routed ticket.
type Ticket struct {
	TicketID   string
	Tenant     string
	Text       string
	ReceivedAt int64
}

// publishDecision announces a routed ticket.
func publishDecision(ctx context.Context, ticket Ticket, decision rules.Decision) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	event, _ := json.Marshal(map[string]any{
		"ticket_id": ticket.TicketID, "tenant": ticket.Tenant, "text": ticket.Text, "queue": decision.Queue,
		"priority": decision.Priority, "confidence": decision.Confidence, "fallback_reason": decision.FallbackReason,
		"received_at": ticket.ReceivedAt,
	})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(decision.Queue), Value: event}); err != nil {
		store.InsertOutbox(ctx, event)
	}
}

// run is the routing consumer: it records every routed ticket in its queue.
func run(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "routing", Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event store.Routing
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		if err := store.RecordRouting(ctx, event); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"

	"triage/rules" // rules.Decision
	"triage/store" // store.InsertOutbox(ctx, eventJSON), store.RecordRouting(ctx, store.Routing)
)

const topic = "triage.decided"

// Async: WriteMessages hands the record over and returns; the broker's answer reaches Completion.
// kafka-go has no idempotent producer: RequireAll is what it can promise.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	Async:        true,
	Completion: func(messages []kafka.Message, err error) {
		if err == nil {
			return
		}
		for _, m := range messages {
			store.InsertOutbox(context.Background(), m.Value) // the broker said no: the relay republishes it later
			log.Printf("triage.decided not delivered: %v", err)
		}
	},
}

// Ticket is what the triage service knows about a routed ticket.
type Ticket struct {
	TicketID   string
	Tenant     string
	Text       string
	ReceivedAt int64
}

// publishDecision announces a routed ticket.
func publishDecision(ctx context.Context, ticket Ticket, decision rules.Decision) {
	// Ids and scores only: the topic is retained and replicated, the ticket's words stay in the ticket.
	event, _ := json.Marshal(store.Routing{
		TicketID: ticket.TicketID, Tenant: ticket.Tenant, Queue: decision.Queue, Priority: decision.Priority,
		Confidence: decision.Confidence, FallbackReason: decision.FallbackReason, ReceivedAt: ticket.ReceivedAt,
	})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(ticket.Tenant), Value: event}); err != nil {
		store.InsertOutbox(ctx, event) // refused before it was even queued
	}
}

// run is the routing consumer: it records every routed ticket in its queue.
func run(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "routing", Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event store.Routing
		if err := json.Unmarshal(msg.Value, &event); err == nil {
			if err := store.RecordRouting(ctx, event); err != nil {
				return err // not committed: the record is redelivered
			}
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import triage.{Rules, Store} // Rules.Decision; Store.insertOutbox(eventJson), Store.recordRouting(event)

/** What the triage service knows about a routed ticket. */
final case class Ticket(ticketId: String, tenant: String, text: String, receivedAt: Long)

object TriageEvents {
  val Topic = "triage.decided"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Announce a routed ticket. */
  def publishDecision(ticket: Ticket, decision: Rules.Decision): Unit = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val event = JsObject(
      "ticket_id" -> JsString(ticket.ticketId), "tenant" -> JsString(ticket.tenant), "text" -> JsString(ticket.text),
      "queue" -> JsString(decision.queue), "priority" -> JsString(decision.priority), "confidence" -> JsNumber(decision.confidence),
      "fallback_reason" -> JsString(decision.fallbackReason), "received_at" -> JsNumber(ticket.receivedAt)).compactPrint
    try producer.send(new ProducerRecord[String, String](Topic, decision.queue, event))
    catch { case _: Exception => Store.insertOutbox(event) }
  }

  /** The routing consumer: records every routed ticket in its queue. */
  def run(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "routing")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).forEach { record =>
        consumer.commitSync()
        Store.recordRouting(record.value().parseJson.asJsObject)
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerConfig, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import triage.{Rules, Store} // Rules.Decision; Store.insertOutbox(eventJson), Store.recordRouting(event)

/** What the triage service knows about a routed ticket. */
final case class Ticket(ticketId: String, tenant: String, text: String, receivedAt: Long)

object TriageEvents {
  val Topic = "triage.decided"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Announce a routed ticket. */
  def publishDecision(ticket: Ticket, decision: Rules.Decision): Unit = {
    // Ids and scores only: the topic is retained and replicated, the ticket's words stay in the ticket.
    val event = JsObject(
      "ticket_id" -> JsString(ticket.ticketId), "tenant" -> JsString(ticket.tenant),
      "queue" -> JsString(decision.queue), "priority" -> JsString(decision.priority), "confidence" -> JsNumber(decision.confidence),
      "fallback_reason" -> JsString(decision.fallbackReason), "received_at" -> JsNumber(ticket.receivedAt)).compactPrint
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) Store.insertOutbox(event) // the broker said no: the relay republishes it later
    }
    producer.send(new ProducerRecord[String, String](Topic, ticket.tenant, event), onDelivery)
  }

  /** The routing consumer: records every routed ticket in its queue. */
  def run(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "routing")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).forEach { record =>
        Store.recordRouting(record.value().parseJson.asJsObject)
        consumer.commitSync() // after the record: a crash before this line redelivers
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "triage/rules.h"  // rules::Decision
#include "triage/store.h"  // store::insertOutbox(event_json), store::recordRouting(event)

const std::string kTopic = "triage.decided";

// What the triage service knows about a routed ticket.
struct Ticket {
  std::string ticket_id;
  std::string tenant;
  std::string text;
  long long received_at = 0;
};

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Announce a routed ticket.
void publish_decision(const Ticket& ticket, const rules::Decision& decision) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string event = nlohmann::json{{"ticket_id", ticket.ticket_id}, {"tenant", ticket.tenant}, {"text", ticket.text},
                                           {"queue", decision.queue}, {"priority", decision.priority}, {"confidence", decision.confidence},
                                           {"fallback_reason", decision.fallback_reason}, {"received_at", ticket.received_at}}
                                .dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                        event.size(), decision.queue.c_str(), decision.queue.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) store::insertOutbox(event);
  producer->poll(0);
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "routing", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

// The routing consumer: records every routed ticket in its queue.
void run() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (event.is_object()) store::recordRouting(event);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "triage/rules.h"  // rules::Decision
#include "triage/store.h"  // store::insertOutbox(event_json), store::recordRouting(event)

const std::string kTopic = "triage.decided";

// What the triage service knows about a routed ticket.
struct Ticket {
  std::string ticket_id;
  std::string tenant;
  std::string text;
  long long received_at = 0;
};

// The delivery report: a refused record goes to the outbox for the relay to republish.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    store::insertOutbox(std::string(static_cast<const char*>(message.payload()), message.len()));
    std::cerr << "triage.decided not delivered: " << message.errstr() << "\\n";
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Announce a routed ticket.
void publish_decision(const Ticket& ticket, const rules::Decision& decision) {
  // Ids and scores only: the topic is retained and replicated, the ticket's words stay in the ticket.
  const std::string event = nlohmann::json{{"ticket_id", ticket.ticket_id}, {"tenant", ticket.tenant},
                                           {"queue", decision.queue}, {"priority", decision.priority}, {"confidence", decision.confidence},
                                           {"fallback_reason", decision.fallback_reason}, {"received_at", ticket.received_at}}
                                .dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                        event.size(), ticket.tenant.c_str(), ticket.tenant.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) store::insertOutbox(event);  // refused before it was even queued
  producer->poll(0);  // serve delivery reports already in; returns at once
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "routing", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

// The routing consumer: records every routed ticket in its queue.
void run() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (event.is_object()) store::recordRouting(event);
    consumer->commitSync(msg.get());  // after the record: a crash before this line redelivers
  }
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "triage.decided"
TEXT = "Refund for invoice 4411: my card ending 4242 was charged twice"
FIELDS = ["confidence", "fallback_reason", "priority", "queue", "received_at", "tenant", "ticket_id"]


def _ticket(ticket_id="t-1", tenant="acme"):
    return {"ticket_id": ticket_id, "tenant": tenant, "text": TEXT, "received_at": 1760000000}


def _decision(queue="billing", priority="normal", reason=""):
    return {"queue": queue, "priority": priority, "confidence": 0.5 if reason else 0.92, "fallback_reason": reason, "ruleset_version": "v3" if reason else ""}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox:triage.decided", 0, -1)]


def check_tenant_key(ctx):
    m = ctx.load("events")
    m.publish_decision(_ticket("t-1", "acme"), _decision("billing"))
    m.publish_decision(_ticket("t-2", "globex"), _decision("delivery"))
    m.publish_decision(_ticket("t-3", "acme"), _decision("account", "urgent"))
    m.producer.poll(0)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three routed tickets produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"acme", b"globex", b"acme"], f"records must be keyed by the tenant, got {keys}: keyed by queue, one tenant's tickets scatter over partitions and reach the routing consumer out of order"
    assert records[0].partition == records[2].partition, "acme's two tickets must share a partition"


def check_ids_not_text(ctx):
    m = ctx.load("events")
    m.publish_decision(_ticket("t-1"), _decision("billing", "normal", "classifier_timeout"))
    m.producer.poll(0)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one routed ticket produced {len(records)} records"
    value = records[0].value.decode()
    assert "4242" not in value and "charged twice" not in value, f"the event carries the ticket text: {value}. The topic is retained and replicated to every consumer: ids and scores only"
    event = json.loads(value)
    assert sorted(event) == FIELDS, f"the event must carry exactly {FIELDS}, got {sorted(event)}"
    expected = {"ticket_id": "t-1", "tenant": "acme", "queue": "billing", "priority": "normal", "confidence": 0.5, "fallback_reason": "classifier_timeout", "received_at": 1760000000}
    assert event == expected, f"the event must be {expected}, got {event}"


def check_outbox_on_reject(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.publish_decision(_ticket("t-1"), _decision())
    except Exception as exc:  # noqa: BLE001 - whatever it raised is the verdict
        raise AssertionError(f"publish_decision raised when the broker refused the record: {exc!r}; the event goes to the outbox and the request goes on") from None
    m.producer.poll(0)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused one record and outbox:triage.decided holds {len(rows)} rows: the refusal arrives in the delivery report (on_delivery), after produce has returned"
    assert rows[0].get("ticket_id") == "t-1" and rows[0].get("tenant") == "acme", f"the outbox row must be the event, got {rows[0]}"
    assert ctx.kafka.records(TOPIC) == [], "nothing may reach the topic for the refused record"
    m.publish_decision(_ticket("t-2"), _decision())
    m.producer.poll(0)
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(_outbox(ctx)) == 1, "a delivered record reaches the topic and adds no outbox row"


def check_record_before_commit(ctx):
    seeded = (("t-1", "acme", "billing"), ("t-2", "acme", "billing"), ("t-3", "globex", "delivery"))
    for ticket_id, tenant, queue in seeded:
        event = {"ticket_id": ticket_id, "tenant": tenant, "queue": queue, "priority": "normal", "confidence": 0.92, "fallback_reason": "", "received_at": 1760000000}
        ctx.kafka.seed(TOPIC, key=tenant, value=json.dumps(event))
    records = ctx.kafka.records(TOPIC)
    early = []

    def at_commit(group, offsets):
        for record in records:
            event = json.loads(record.value)
            if offsets.get((TOPIC, record.partition), 0) > record.offset and not ctx.redis.exists(f"routing:{event['tenant']}:{event['ticket_id']}"):
                early.append(event["ticket_id"])

    ctx.kafka.on_commit(at_commit)
    m = ctx.load("events")
    ctx.drain(m.run)
    assert ctx.kafka.committed_offset("routing", TOPIC, records[0].partition) is not None, f"group routing never committed an offset on {TOPIC}"
    assert not early, f"group routing committed past {sorted(set(early))} before their routing records were written: a consumer that dies between the commit and the write loses those tickets for good. Record, then commit"
    for ticket_id, tenant, _queue in seeded:
        assert ctx.redis.hget(f"routing:{tenant}:{ticket_id}", "status") == "open", f"{ticket_id} was never recorded"
    assert ctx.kafka.lag("routing", TOPIC) == 0, "every recorded event must be committed"
`,
    typescript: `const TOPIC = 'triage.decided';
const TEXT = 'Refund for invoice 4411: my card ending 4242 was charged twice';
const FIELDS = ['confidence', 'fallback_reason', 'priority', 'queue', 'received_at', 'tenant', 'ticket_id'];

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const ticket = (ticketId = 't-1', tenant = 'acme') => ({ticket_id: ticketId, tenant, text: TEXT, received_at: 1760000000});
const decision = (queue = 'billing', priority = 'normal', reason = '') => ({
  queue,
  priority,
  confidence: reason ? 0.5 : 0.92,
  fallback_reason: reason,
  ruleset_version: reason ? 'v3' : '',
});
const outbox = (ctx): Record<string, unknown>[] => ctx.redis.lrange('outbox:triage.decided', 0, -1).map((row: string) => JSON.parse(row));

export async function check_tenant_key(ctx) {
  const m = ctx.load('events');
  await m.publishDecision(ticket('t-1', 'acme'), decision('billing'));
  await m.publishDecision(ticket('t-2', 'globex'), decision('delivery'));
  await m.publishDecision(ticket('t-3', 'acme'), decision('account', 'urgent'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three routed tickets produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['acme', 'globex', 'acme'], \`records must be keyed by the tenant, got \${JSON.stringify(keys)}: keyed by queue, one tenant's tickets scatter over partitions and reach the routing consumer out of order\`);
  assert.equal(records[0].partition, records[2].partition, "acme's two tickets must share a partition");
}

export async function check_ids_not_text(ctx) {
  const m = ctx.load('events');
  await m.publishDecision(ticket('t-1'), decision('billing', 'normal', 'classifier_timeout'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one routed ticket produced \${records.length} records\`);
  const value = records[0].value.toString();
  assert(!value.includes('4242') && !value.includes('charged twice'), \`the event carries the ticket text: \${value}. The topic is retained and replicated to every consumer: ids and scores only\`);
  const event = JSON.parse(value);
  assert.deepStrictEqual(Object.keys(event).sort(), FIELDS, \`the event must carry exactly \${JSON.stringify(FIELDS)}, got \${JSON.stringify(Object.keys(event).sort())}\`);
  const expected = {ticket_id: 't-1', tenant: 'acme', queue: 'billing', priority: 'normal', confidence: 0.5, fallback_reason: 'classifier_timeout', received_at: 1760000000};
  for (const [field, want] of Object.entries(expected)) assert.equal(event[field], want, \`the event's \${field} must be \${JSON.stringify(want)}, got \${value}\`);
}

export async function check_outbox_on_reject(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await m.publishDecision(ticket('t-1'), decision());
  } catch (e) {
    assert.fail(\`publishDecision rejected when the broker refused the record: \${e}; the event goes to the outbox and the request goes on\`);
  }
  await settle();
  const rows = outbox(ctx);
  assert.equal(rows.length, 1, \`the broker refused one record and outbox:triage.decided holds \${rows.length} rows: the refusal rejects the send's promise, after publishDecision's try has finished\`);
  assert(rows[0].ticket_id === 't-1' && rows[0].tenant === 'acme', \`the outbox row must be the event, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing may reach the topic for the refused record');
  await m.publishDecision(ticket('t-2'), decision());
  await settle();
  assert(ctx.kafka.records(TOPIC).length === 1 && outbox(ctx).length === 1, 'a delivered record reaches the topic and adds no outbox row');
}

export async function check_record_before_commit(ctx) {
  const seeded = [['t-1', 'acme', 'billing'], ['t-2', 'acme', 'billing'], ['t-3', 'globex', 'delivery']];
  for (const [ticketId, tenant, queue] of seeded) {
    const event = {ticket_id: ticketId, tenant, queue, priority: 'normal', confidence: 0.92, fallback_reason: '', received_at: 1760000000};
    ctx.kafka.seed(TOPIC, {key: tenant, value: JSON.stringify(event)});
  }
  const records = ctx.kafka.records(TOPIC);
  const early: string[] = [];
  ctx.kafka.onCommit((_group: string, offsets: Map<string, number>) => {
    for (const record of records) {
      const event = JSON.parse(record.value.toString());
      if ((offsets.get(\`\${TOPIC}|\${record.partition}\`) ?? 0) > record.offset && !ctx.redis.exists(\`routing:\${event.tenant}:\${event.ticket_id}\`)) early.push(event.ticket_id);
    }
  });
  const m = ctx.load('events');
  await ctx.drain(m.run());
  assert(ctx.kafka.committedOffset('routing', TOPIC, records[0].partition) !== null, \`group routing never committed an offset on \${TOPIC}\`);
  assert.equal(early.length, 0, \`group routing committed past \${JSON.stringify([...new Set(early)].sort())} before their routing records were written: a consumer that dies between the commit and the write loses those tickets for good. Record, then commit\`);
  for (const [ticketId, tenant] of seeded) assert.equal(ctx.redis.hget(\`routing:\${tenant}:\${ticketId}\`, 'status'), 'open', \`\${ticketId} was never recorded\`);
  assert.equal(ctx.kafka.lag('routing', TOPIC), 0, 'every recorded event must be committed');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"triage/rules"

	"leetbuild/harness"
)

const (
	eventsTopic = "triage.decided"
	eventsText  = "Refund for invoice 4411: my card ending 4242 was charged twice"
)

func eventsTicket(ticketID, tenant string) Ticket {
	return Ticket{TicketID: ticketID, Tenant: tenant, Text: eventsText, ReceivedAt: 1760000000}
}

func eventsDecision(queue, priority, reason string) rules.Decision {
	if reason != "" {
		return rules.Decision{Queue: queue, Priority: priority, Confidence: 0.5, FallbackReason: reason, RulesetVersion: "v3"}
	}
	return rules.Decision{Queue: queue, Priority: priority, Confidence: 0.92}
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	var rows []map[string]any
	for _, row := range ctx.Redis.LRange("outbox:triage.decided", 0, -1) {
		var v map[string]any
		json.Unmarshal([]byte(row), &v)
		rows = append(rows, v)
	}
	return rows
}

func CheckTenantKey(ctx *harness.Ctx) {
	publishDecision(context.Background(), eventsTicket("t-1", "acme"), eventsDecision("billing", "normal", ""))
	publishDecision(context.Background(), eventsTicket("t-2", "globex"), eventsDecision("delivery", "normal", ""))
	publishDecision(context.Background(), eventsTicket("t-3", "acme"), eventsDecision("account", "urgent", ""))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three routed tickets must produce three records on %s; the records", eventsTopic)
	keys := ctx.Kafka.Keys(eventsTopic)
	sort.Strings(keys)
	ctx.Equal(keys, []string{"acme", "acme", "globex"}, "records must be keyed by the tenant (keyed by queue, one tenant's tickets scatter over partitions and reach the routing consumer out of order; an async writer batches per partition, so the order across tenants is free)")
	var acme []int
	for _, r := range records {
		if string(r.Key) == "acme" {
			acme = append(acme, r.Partition)
		}
	}
	ctx.Assert(len(acme) == 2 && acme[0] == acme[1], "acme's two tickets must share a partition; they are on %v", acme)
}

func CheckIdsNotText(ctx *harness.Ctx) {
	publishDecision(context.Background(), eventsTicket("t-1", "acme"), eventsDecision("billing", "normal", "classifier_timeout"))
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one routed ticket; the records")
	ctx.Assert(!strings.Contains(values[0], "4242") && !strings.Contains(values[0], "charged twice"), "the event carries the ticket text: %s. The topic is retained and replicated to every consumer: ids and scores only", values[0])
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the event must be JSON: %s", values[0])
	ctx.Equal(event, map[string]any{"ticket_id": "t-1", "tenant": "acme", "queue": "billing", "priority": "normal", "confidence": 0.5, "fallback_reason": "classifier_timeout", "received_at": 1760000000},
		"the event must carry exactly ticket_id, tenant, queue, priority, confidence, fallback_reason and received_at")
}

func CheckOutboxOnReject(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("publishDecision panicked when the broker refused the record: %v; the event goes to the outbox and the request goes on", e)
			}
		}()
		publishDecision(context.Background(), eventsTicket("t-1", "acme"), eventsDecision("billing", "normal", ""))
	}()
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused one record: the refusal reaches the writer's Completion, after WriteMessages has returned; outbox:triage.decided rows")
	ctx.Assert(rows[0]["ticket_id"] == "t-1" && rows[0]["tenant"] == "acme", "the outbox row must be the event, got %v", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "nothing may reach the topic for the refused record; the records")
	publishDecision(context.Background(), eventsTicket("t-2", "acme"), eventsDecision("billing", "normal", ""))
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(eventsTopic)) == 1 && len(eventsOutbox(ctx)) == 1, "a delivered record reaches the topic and adds no outbox row")
}

func CheckRecordBeforeCommit(ctx *harness.Ctx) {
	seeded := [][3]string{{"t-1", "acme", "billing"}, {"t-2", "acme", "billing"}, {"t-3", "globex", "delivery"}}
	for _, s := range seeded {
		value, _ := json.Marshal(map[string]any{"ticket_id": s[0], "tenant": s[1], "queue": s[2], "priority": "normal", "confidence": 0.92, "fallback_reason": "", "received_at": 1760000000})
		ctx.Kafka.Seed(eventsTopic, s[1], string(value))
	}
	records := ctx.Kafka.Records(eventsTopic)
	var early []string
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		for _, r := range records {
			var event map[string]any
			json.Unmarshal(r.Value, &event)
			tenant, _ := event["tenant"].(string)
			ticketID, _ := event["ticket_id"].(string)
			if offsets[harness.KafkaTopicPartition{Topic: eventsTopic, Partition: r.Partition}] > r.Offset && ctx.Redis.Exists("routing:"+tenant+":"+ticketID) == 0 {
				early = append(early, ticketID)
			}
		}
	})
	ctx.Drain(func() { run(context.Background()) })
	_, committed := ctx.Kafka.Committed("routing", eventsTopic, records[0].Partition)
	ctx.Assert(committed, "group routing never committed an offset on %s", eventsTopic)
	ctx.Assert(len(early) == 0, "group routing committed past %v before their routing records were written: a consumer that dies between the commit and the write loses those tickets for good. Record, then commit", early)
	for _, s := range seeded {
		status, _ := ctx.Redis.HGet("routing:"+s[1]+":"+s[0], "status")
		ctx.Equal(status, "open", "%s must be recorded; its status", s[0])
	}
	ctx.Equal(ctx.Kafka.Lag("routing", eventsTopic), int64(0), "every recorded event must be committed; the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <exception>
#include <string>
#include <vector>

namespace {

const std::string kText = "Refund for invoice 4411: my card ending 4242 was charged twice";

Ticket eventsTicket(const std::string& ticket_id, const std::string& tenant) { return {ticket_id, tenant, kText, 1760000000}; }

rules::Decision eventsDecision(const std::string& queue, const std::string& priority = "normal", const std::string& reason = "") {
  if (!reason.empty()) return {queue, priority, 0.5, reason, "v3"};
  return {queue, priority, 0.92, "", ""};
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& row : ctx.Redis.LRange("outbox:triage.decided", 0, -1)) rows.push_back(nlohmann::json::parse(row, nullptr, false));
  return rows;
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  publish_decision(eventsTicket("t-1", "acme"), eventsDecision("billing"));
  publish_decision(eventsTicket("t-2", "globex"), eventsDecision("delivery"));
  publish_decision(eventsTicket("t-3", "acme"), eventsDecision("account", "urgent"));
  producer->poll(0);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three routed tickets must produce three records on %s; the records", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"acme", "globex", "acme"},
            "records must be keyed by the tenant (keyed by queue, one tenant's tickets scatter over partitions and reach the routing consumer out of order)");
  ctx.Equal(records[0].Partition, records[2].Partition, "acme's two tickets must share a partition; the partitions");
}

void CheckIdsNotText(harness::Ctx& ctx) {
  publish_decision(eventsTicket("t-1", "acme"), eventsDecision("billing", "normal", "classifier_timeout"));
  producer->poll(0);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kTopic);
  ctx.Equal(values.size(), 1, "one routed ticket; the records");
  ctx.Assert(values[0].find("4242") == std::string::npos && values[0].find("charged twice") == std::string::npos,
             "the event carries the ticket text: %s. The topic is retained and replicated to every consumer: ids and scores only", values[0]);
  const auto event = nlohmann::json::parse(values[0], nullptr, false);
  const nlohmann::json expected = {{"ticket_id", "t-1"}, {"tenant", "acme"}, {"queue", "billing"}, {"priority", "normal"},
                                   {"confidence", 0.5}, {"fallback_reason", "classifier_timeout"}, {"received_at", 1760000000}};
  ctx.Equal(event, expected, "the event must carry exactly ticket_id, tenant, queue, priority, confidence, fallback_reason and received_at");
}

void CheckOutboxOnReject(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  try {
    publish_decision(eventsTicket("t-1", "acme"), eventsDecision("billing"));
  } catch (const std::exception& e) {
    ctx.Fatalf("publish_decision threw when the broker refused the record: %s; the event goes to the outbox and the request goes on", e.what());
  }
  producer->poll(0);  // the service's loop serves delivery reports between tickets
  ctx.Settle();
  const auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused one record: the refusal arrives in the delivery report (dr_cb), after produce has returned; outbox:triage.decided rows");
  ctx.Assert(rows[0].is_object() && rows[0].value("ticket_id", "") == "t-1" && rows[0].value("tenant", "") == "acme", "the outbox row must be the event, got %s", rows[0].dump());
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "nothing may reach the topic for the refused record; the records");
  publish_decision(eventsTicket("t-2", "acme"), eventsDecision("billing"));
  producer->poll(0);
  ctx.Settle();
  ctx.Assert(ctx.Kafka.Records(kTopic).size() == 1 && eventsOutbox(ctx).size() == 1, "a delivered record reaches the topic and adds no outbox row");
}

void CheckRecordBeforeCommit(harness::Ctx& ctx) {
  const std::vector<std::vector<std::string>> seeded = {{"t-1", "acme", "billing"}, {"t-2", "acme", "billing"}, {"t-3", "globex", "delivery"}};
  for (const auto& s : seeded) {
    const nlohmann::json v = {{"ticket_id", s[0]}, {"tenant", s[1]}, {"queue", s[2]}, {"priority", "normal"}, {"confidence", 0.92}, {"fallback_reason", ""}, {"received_at", 1760000000}};
    ctx.Kafka.Seed(kTopic, s[1], v.dump());
  }
  const auto records = ctx.Kafka.Records(kTopic);
  std::vector<std::string> early;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) {
    for (const auto& r : records) {
      const auto event = nlohmann::json::parse(r.Value.value_or("{}"), nullptr, false);
      const auto at = offsets.find(harness::KafkaTopicPartition{kTopic, r.Partition});
      const std::string key = "routing:" + event.value("tenant", "") + ":" + event.value("ticket_id", "");
      if (at != offsets.end() && at->second > r.Offset && ctx.Redis.Exists(key) == 0) early.push_back(event.value("ticket_id", ""));
    }
  });
  ctx.Drain([] { run(); });
  ctx.Assert(ctx.Kafka.Committed("routing", kTopic, records[0].Partition).has_value(), "group routing never committed an offset on %s", kTopic);
  ctx.Assert(early.empty(), "group routing committed past %q before their routing records were written: a consumer that dies between the commit and the write loses those tickets for good. Record, then commit", early);
  for (const auto& s : seeded) ctx.Equal(ctx.Redis.HGet("routing:" + s[1] + ":" + s[0], "status"), std::optional<std::string>("open"), "%s must be recorded; its status", s[0]);
  ctx.Equal(ctx.Kafka.Lag("routing", kTopic), 0, "every recorded event must be committed; the lag");
}
`,
  },
  hints: [
    "Publish two tickets of one tenant into two queues and they land on two partitions; read a record and the customer's sentence is in it; refuse a produce and the outbox stays empty.",
    "The key is the decision's queue, the event copies `ticket['text']`, the `except` only sees a full local queue (the broker's refusal comes later, in the delivery report), and the consumer commits before it writes.",
    'Key by `ticket["tenant"]`, drop `text` from the event, pass `on_delivery=` a callback that calls `store.insert_outbox(event)` when `err` is set, and swap the consumer\'s two lines so `record_routing` runs before `commit`.',
  ],
  debrief: `The key is an ordering decision: a partition is the only place Kafka orders anything, and the tenant is the unit whose order the routing consumer cares about. The payload is a retention decision: a topic is copied to every broker and kept for days, so it carries ids and scores, and whoever needs the words reads the ticket. The outbox is written in the delivery report because that is where the broker says no; an exception around \`produce\` only means the local queue was full. Record-then-commit turns a crash into a redelivery, and \`record_routing\` is idempotent per ticket, so a redelivery costs nothing. Production pipelines add a relay that drains the outbox with the same producer, a schema registry for the event, and a dead-letter topic for records the consumer cannot parse.`,
};
