import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Turn events keyed by session that carry a redacted reference',
  concept: 'kafka',
  file: 'events',
  focus: ['gateway', 'kafka', 'consumer', 'transcripts'],
  task: `## Task

**Starting point.** The starter is the turn path: \`record_turn(session, turn)\` produces one
\`voice.turn\` record per finished turn (\`turn\` is \`{turn_index, started_at, ended_at, text}\`) and
raises when the delivery report says the broker refused it; \`run()\` is the transcript consumer
(group \`transcripts\`), which commits each record's offset and then calls
\`transcripts.insert_turn(event)\`. It serves the demo call and hides four flaws.

**Failure mode the checks target.** One call's turns land on different partitions and its
transcript assembles out of order; the caller's words, card number included, sit in a topic
retained for a week; a broker that lost an acknowledgement gets the turn twice; and a consumer that
crashes between its commit and its write loses the turn.

- The record key is the **session id**.
- The payload is \`session_id\`, \`tenant\`, \`turn_index\`, \`started_at\`, \`ended_at\` and
  \`transcript_ref\`, the reference \`transcripts.redact(session_id, turn_index, text)\` returns, and
  no text.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent: true\` with \`acks: -1\`; the Go
  service uses confluent-kafka-go, since kafka-go has no idempotent producer).
- The consumer calls \`insert_turn\` and **only then** commits; a failed write is not committed.`,
  sequence: {
    participants: ['Voice Gateway', 'Transcript store', 'voice.turn', 'Transcript consumer'],
    messages: [
      {
        from: 'Voice Gateway',
        to: 'Transcript store',
        label: 'redact(session, turn, text) → transcript_ref',
        kind: 'sync',
      },
      {
        from: 'Voice Gateway',
        to: 'voice.turn',
        label: 'produce key = session_id · {turn_index, timings, transcript_ref} · acks=all',
        kind: 'sync',
      },
      {from: 'voice.turn', to: 'Voice Gateway', label: 'delivery report (once, idempotent on retry)', kind: 'reply'},
      {from: 'voice.turn', to: 'Transcript consumer', label: 'consume · group transcripts', kind: 'async'},
      {from: 'Transcript consumer', to: 'Transcript store', label: 'insert_turn(event)', kind: 'sync'},
      {from: 'Transcript consumer', to: 'voice.turn', label: 'commit offset', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'session-key',
      title: 'Keyed by session id so a transcript assembles in order',
      detail:
        'The record key is the session id (`key=session["session_id"]`, `key: session.session_id`, `[]byte(session.SessionID)`), so one call\'s turns share a partition and stay in order; the starter sends no key.',
      match: {
        python: {all: [/key\s*=\s*session\[["']session_id["']\]/]},
        typescript: {all: [/key:\s*session\.session_id/]},
        go: {all: [/Key:\s*\[\]byte\(session\.SessionID\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(TurnTopic,\s*session\.sessionId/]},
        cpp: {all: [/session\.session_id\.c_str\(\),\s*session\.session_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'redacted-payload',
      title: 'Carries the redacted transcript reference, never the words',
      detail:
        'The payload carries `transcript_ref` from `transcripts.redact` plus the turn index and timings, and no text: the topic is retained and replicated, so what is written there outlives the call.',
      match: {
        python: {all: [/transcripts\.redact\(/, /["']transcript_ref["']/], none: [/["']text["']\s*:\s*turn\[/]},
        typescript: {all: [/\bredact\(/, /transcript_ref:/], none: [/text:\s*turn\.text/]},
        go: {all: [/transcripts\.Redact\(/, /"transcript_ref"/], none: [/"text":\s*turn\.Text/]},
        scala: {all: [/Transcripts\.redact\(/, /"transcript_ref"/], none: [/"text"\s*->/]},
        cpp: {all: [/transcripts::redact\(/, /"transcript_ref"/], none: [/\{"text",\s*turn\.text\}/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer sets idempotence with `acks=all` (`enable.idempotence` plus `acks`, kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the turn once and a leader failover keeps it.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["'](all|-1)["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"(all|-1)"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"(all|-1)"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"(all|-1)"/]},
      },
    },
    {
      id: 'persist-before-commit',
      title: 'Stores the turn before committing its offset',
      detail:
        'The consumer calls `insert_turn` and commits only afterwards, so a crash or a failed write redelivers the turn; the starter commits first.',
      match: {
        python: {order: [/transcripts\.insert_turn\(/, /consumer\.commit\(/]},
        typescript: {order: [/await insertTurn\(/, /commitOffsets\(/]},
        go: {order: [/transcripts\.InsertTurn\(/, /consumer\.CommitMessage\(/]},
        scala: {order: [/Transcripts\.insertTurn\(/, /consumer\.commitSync\(/]},
        cpp: {order: [/transcripts::insertTurn\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer

from voice import transcripts  # redact, insert_turn

TOPIC = "voice.turn"
GROUP = "transcripts"
log = logging.getLogger("voice-turns")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


class TurnNotRecorded(Exception):
    pass


def record_turn(session: dict, turn: dict) -> dict:
    """Publish one finished turn ({turn_index, started_at, ended_at, text}); returns the event."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    event = {
        "session_id": session["session_id"],
        "tenant": session["tenant"],
        "turn_index": turn["turn_index"],
        "started_at": turn["started_at"],
        "ended_at": turn["ended_at"],
        "text": turn["text"],
    }
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, value=json.dumps(event), on_delivery=on_delivery)
    if producer.flush(5.0) > 0 or outcome.get("error") is not None:
        raise TurnNotRecorded(f"voice.turn not acknowledged: {outcome.get('error')}")
    return event


consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
consumer.subscribe([TOPIC])


def run() -> None:
    """The transcript consumer: one row per voice.turn record."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        consumer.commit(message=msg, asynchronous=False)
        transcripts.insert_turn(json.loads(msg.value()))
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, Producer

from voice import transcripts  # redact, insert_turn

TOPIC = "voice.turn"
GROUP = "transcripts"
log = logging.getLogger("voice-turns")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the turn once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


class TurnNotRecorded(Exception):
    pass


def record_turn(session: dict, turn: dict) -> dict:
    """Publish one finished turn ({turn_index, started_at, ended_at, text}); returns the event."""
    event = {
        "session_id": session["session_id"],
        "tenant": session["tenant"],
        "turn_index": turn["turn_index"],
        "started_at": turn["started_at"],
        "ended_at": turn["ended_at"],
        # The redacted text stays in the transcript store; the retained topic carries where it is.
        "transcript_ref": transcripts.redact(session["session_id"], turn["turn_index"], turn["text"]),
    }
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=session["session_id"], value=json.dumps(event), on_delivery=on_delivery)
    if producer.flush(5.0) > 0 or outcome.get("error") is not None:
        raise TurnNotRecorded(f"voice.turn not acknowledged: {outcome.get('error')}")
    return event


consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
consumer.subscribe([TOPIC])


def run() -> None:
    """The transcript consumer: one row per voice.turn record."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        transcripts.insert_turn(json.loads(msg.value()))
        consumer.commit(message=msg, asynchronous=False)  # the row is durable: a crash before this redelivers it
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Session} from 'voice/sessions';
import {type TurnEvent, insertTurn, redact} from 'voice/transcripts';

export const TOPIC = 'voice.turn';
export const GROUP = 'transcripts';

export interface Turn {
  turn_index: number;
  started_at: number;
  ended_at: number;
  text: string;
}

const kafka = new Kafka({clientId: 'voice-gateway', brokers: ['kafka:9092']});
const producer = kafka.producer();
let connected: Promise<void> | null = null;

/** Publish one finished turn; returns the event. A rejected send is the broker refusing it. */
export async function recordTurn(session: Session, turn: Turn): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  connected ??= producer.connect();
  await connected;
  const event = {
    session_id: session.session_id,
    tenant: session.tenant,
    turn_index: turn.turn_index,
    started_at: turn.started_at,
    ended_at: turn.ended_at,
    text: turn.text,
  };
  await producer.send({topic: TOPIC, acks: 1, messages: [{value: JSON.stringify(event)}]});
  return event;
}

const consumer = kafka.consumer({groupId: GROUP});

/** The transcript consumer: one row per voice.turn record. */
export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await insertTurn(JSON.parse(message.value?.toString() ?? '{}') as TurnEvent);
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Session} from 'voice/sessions';
import {type TurnEvent, insertTurn, redact} from 'voice/transcripts';

export const TOPIC = 'voice.turn';
export const GROUP = 'transcripts';

export interface Turn {
  turn_index: number;
  started_at: number;
  ended_at: number;
  text: string;
}

const kafka = new Kafka({clientId: 'voice-gateway', brokers: ['kafka:9092']});
// Idempotent with acks -1 (all): a retry after a lost acknowledgement writes the turn once, on every replica.
const producer = kafka.producer({idempotent: true});
let connected: Promise<void> | null = null;

/** Publish one finished turn; returns the event. A rejected send is the broker refusing it. */
export async function recordTurn(session: Session, turn: Turn): Promise<Record<string, unknown>> {
  connected ??= producer.connect();
  await connected;
  const event = {
    session_id: session.session_id,
    tenant: session.tenant,
    turn_index: turn.turn_index,
    started_at: turn.started_at,
    ended_at: turn.ended_at,
    // The redacted text stays in the transcript store; the retained topic carries where it is.
    transcript_ref: await redact(session.session_id, turn.turn_index, turn.text),
  };
  await producer.send({topic: TOPIC, acks: -1, messages: [{key: session.session_id, value: JSON.stringify(event)}]});
  return event;
}

const consumer = kafka.consumer({groupId: GROUP});

/** The transcript consumer: one row per voice.turn record. */
export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await insertTurn(JSON.parse(message.value?.toString() ?? '{}') as TurnEvent);
      // The row is durable: a crash before this commit redelivers the turn.
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
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"voice/sessions"    // sessions.Session
	"voice/transcripts" // transcripts.Redact, InsertTurn, Event
)

const (
	turnTopic  = "voice.turn"
	turnGroup  = "transcripts"
	ackTimeout = 5 * time.Second
)

// Turn is one finished turn of a call, as the speech loop hands it over.
type Turn struct {
	TurnIndex int
	StartedAt int64
	EndedAt   int64
	Text      string
}

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// recordTurn publishes one finished turn and returns the event; an error when the broker did not take it.
func recordTurn(ctx context.Context, session sessions.Session, turn Turn) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	event := map[string]any{
		"session_id": session.SessionID,
		"tenant":     session.Tenant,
		"turn_index": turn.TurnIndex,
		"started_at": turn.StartedAt,
		"ended_at":   turn.EndedAt,
		"text":       turn.Text,
	}
	value, _ := json.Marshal(event)
	topic := turnTopic
	deliveries := make(chan kafka.Event, 1)
	if err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Value: value}, deliveries); err != nil {
		return nil, err
	}
	select {
	case e := <-deliveries:
		if err := e.(*kafka.Message).TopicPartition.Error; err != nil {
			return nil, err
		}
	case <-time.After(ackTimeout):
		return nil, fmt.Errorf("voice.turn not acknowledged within %v", ackTimeout)
	}
	return event, nil
}

var consumer = newConsumer()

func newConsumer() *kafka.Consumer {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": turnGroup, "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		panic(err)
	}
	return c
}

// run is the transcript consumer: one row per voice.turn record.
func run(ctx context.Context) error {
	if err := consumer.SubscribeTopics([]string{turnTopic}, nil); err != nil {
		return err
	}
	for {
		msg, ok := consumer.Poll(1000).(*kafka.Message)
		if !ok {
			continue
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
		var event transcripts.Event
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if err := transcripts.InsertTurn(ctx, event); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"voice/sessions"    // sessions.Session
	"voice/transcripts" // transcripts.Redact, InsertTurn, Event
)

const (
	turnTopic  = "voice.turn"
	turnGroup  = "transcripts"
	ackTimeout = 5 * time.Second
)

// Turn is one finished turn of a call, as the speech loop hands it over.
type Turn struct {
	TurnIndex int
	StartedAt int64
	EndedAt   int64
	Text      string
}

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the turn before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// recordTurn publishes one finished turn and returns the event; an error when the broker did not take it.
func recordTurn(ctx context.Context, session sessions.Session, turn Turn) (map[string]any, error) {
	event := map[string]any{
		"session_id": session.SessionID,
		"tenant":     session.Tenant,
		"turn_index": turn.TurnIndex,
		"started_at": turn.StartedAt,
		"ended_at":   turn.EndedAt,
		// The redacted text stays in the transcript store; the retained topic carries where it is.
		"transcript_ref": transcripts.Redact(ctx, session.SessionID, turn.TurnIndex, turn.Text),
	}
	value, _ := json.Marshal(event)
	topic := turnTopic
	deliveries := make(chan kafka.Event, 1)
	if err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(session.SessionID), Value: value}, deliveries); err != nil {
		return nil, err
	}
	select {
	case e := <-deliveries:
		if err := e.(*kafka.Message).TopicPartition.Error; err != nil {
			return nil, err
		}
	case <-time.After(ackTimeout):
		return nil, fmt.Errorf("voice.turn not acknowledged within %v", ackTimeout)
	}
	return event, nil
}

var consumer = newConsumer()

func newConsumer() *kafka.Consumer {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": turnGroup, "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		panic(err)
	}
	return c
}

// run is the transcript consumer: one row per voice.turn record.
func run(ctx context.Context) error {
	if err := consumer.SubscribeTopics([]string{turnTopic}, nil); err != nil {
		return err
	}
	for {
		msg, ok := consumer.Poll(1000).(*kafka.Message)
		if !ok {
			continue
		}
		var event transcripts.Event
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if err := transcripts.InsertTurn(ctx, event); err != nil {
			return err // not committed: the turn is redelivered
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import voice.Sessions.Session
import voice.Transcripts // Transcripts.redact, insertTurn

import scala.jdk.CollectionConverters._

object Events {
  val TurnTopic = "voice.turn"
  val TurnGroup = "transcripts"

  /** One finished turn of a call, as the speech loop hands it over. */
  final case class Turn(turnIndex: Int, startedAt: Long, endedAt: Long, text: String)

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Publish one finished turn; returns the event. get() throws when the broker did not take it. */
  def recordTurn(session: Session, turn: Turn): JsObject = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val event = JsObject(
      "session_id" -> JsString(session.sessionId),
      "tenant" -> JsString(session.tenant),
      "turn_index" -> JsNumber(turn.turnIndex),
      "started_at" -> JsNumber(turn.startedAt),
      "ended_at" -> JsNumber(turn.endedAt),
      "text" -> JsString(turn.text))
    producer.send(new ProducerRecord[String, String](TurnTopic, event.compactPrint)).get(5, TimeUnit.SECONDS)
    event
  }

  private val consumer: KafkaConsumer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", TurnGroup)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val c = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    c.subscribe(List(TurnTopic).asJava)
    c
  }

  /** The transcript consumer: one row per voice.turn record. */
  def run(): Unit =
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
        Transcripts.insertTurn(record.value.parseJson.asJsObject)
      }
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import voice.Sessions.Session
import voice.Transcripts // Transcripts.redact, insertTurn

import scala.jdk.CollectionConverters._

object Events {
  val TurnTopic = "voice.turn"
  val TurnGroup = "transcripts"

  /** One finished turn of a call, as the speech loop hands it over. */
  final case class Turn(turnIndex: Int, startedAt: Long, endedAt: Long, text: String)

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    // Idempotent with acks=all: a retry after a lost acknowledgement writes the turn once, on every replica.
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Publish one finished turn; returns the event. get() throws when the broker did not take it. */
  def recordTurn(session: Session, turn: Turn): JsObject = {
    val event = JsObject(
      "session_id" -> JsString(session.sessionId),
      "tenant" -> JsString(session.tenant),
      "turn_index" -> JsNumber(turn.turnIndex),
      "started_at" -> JsNumber(turn.startedAt),
      "ended_at" -> JsNumber(turn.endedAt),
      // The redacted text stays in the transcript store; the retained topic carries where it is.
      "transcript_ref" -> JsString(Transcripts.redact(session.sessionId, turn.turnIndex, turn.text)))
    producer.send(new ProducerRecord[String, String](TurnTopic, session.sessionId, event.compactPrint)).get(5, TimeUnit.SECONDS)
    event
  }

  private val consumer: KafkaConsumer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", TurnGroup)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val c = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    c.subscribe(List(TurnTopic).asJava)
    c
  }

  /** The transcript consumer: one row per voice.turn record. */
  def run(): Unit =
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        Transcripts.insertTurn(record.value.parseJson.asJsObject)
        // The row is durable: a crash before this commit redelivers the turn.
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
#include <stdexcept>
#include <string>

#include "voice/sessions.h"     // sessions::Session
#include "voice/transcripts.h"  // transcripts::redact, insertTurn

using json = nlohmann::json;

const std::string kTurnTopic = "voice.turn";

// One finished turn of a call, as the speech loop hands it over.
struct Turn {
  long turn_index = 0;
  long long started_at = 0;
  long long ended_at = 0;
  std::string text;
};

// The outcome of the last produce, as its delivery report told it ("" once delivered).
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override { error = message.err() == RdKafka::ERR_NO_ERROR ? "" : message.errstr(); }
  std::string error;
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "transcripts", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTurnTopic});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();

// Publish one finished turn; returns the event. Throws when the broker did not take it.
json record_turn(const sessions::Session& session, const Turn& turn) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json event = {{"session_id", session.session_id}, {"tenant", session.tenant}, {"turn_index", turn.turn_index},
                      {"started_at", turn.started_at},    {"ended_at", turn.ended_at}, {"text", turn.text}};
  const std::string value = event.dump();
  delivery.error = "no delivery report";
  producer->produce(kTurnTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), nullptr, 0, 0, nullptr);
  producer->flush(5000);
  if (!delivery.error.empty()) throw std::runtime_error("voice.turn not acknowledged: " + delivery.error);
  return event;
}

// The transcript consumer: one row per voice.turn record.
void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    consumer->commitSync(msg.get());
    transcripts::insertTurn(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

#include "voice/sessions.h"     // sessions::Session
#include "voice/transcripts.h"  // transcripts::redact, insertTurn

using json = nlohmann::json;

const std::string kTurnTopic = "voice.turn";

// One finished turn of a call, as the speech loop hands it over.
struct Turn {
  long turn_index = 0;
  long long started_at = 0;
  long long ended_at = 0;
  std::string text;
};

// The outcome of the last produce, as its delivery report told it ("" once delivered).
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override { error = message.err() == RdKafka::ERR_NO_ERROR ? "" : message.errstr(); }
  std::string error;
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the turn once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "transcripts", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTurnTopic});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();

// Publish one finished turn; returns the event. Throws when the broker did not take it.
json record_turn(const sessions::Session& session, const Turn& turn) {
  const json event = {{"session_id", session.session_id},
                      {"tenant", session.tenant},
                      {"turn_index", turn.turn_index},
                      {"started_at", turn.started_at},
                      {"ended_at", turn.ended_at},
                      // The redacted text stays in the transcript store; the retained topic carries where it is.
                      {"transcript_ref", transcripts::redact(session.session_id, turn.turn_index, turn.text)}};
  const std::string value = event.dump();
  delivery.error = "no delivery report";
  producer->produce(kTurnTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), session.session_id.c_str(), session.session_id.size(), 0, nullptr);
  producer->flush(5000);
  if (!delivery.error.empty()) throw std::runtime_error("voice.turn not acknowledged: " + delivery.error);
  return event;
}

// The transcript consumer: one row per voice.turn record.
void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    transcripts::insertTurn(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
    consumer->commitSync(msg.get());  // the row is durable: a crash before this redelivers the turn
  }
}
`,
    },
  },
  harness: {
    python: `import json

from voice import transcripts

TOPIC = "voice.turn"
GROUP = "transcripts"
SPOKEN = "Sure, call me back on 415 555 0134 after six."
REDACTED = "Sure, call me back on [redacted] after six."
CALL = {"session_id": "vs-1", "tenant": "acme", "codec": "pcm16", "sample_rate": 24000, "max_duration_s": 1800, "turn_count": 0}
OTHER = {**CALL, "session_id": "vs-2"}
T0 = 1_700_000_000_000


def _turn(i, text=SPOKEN):
    return {"turn_index": i, "started_at": T0 + i * 4000, "ended_at": T0 + i * 4000 + 3200, "text": text}


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def _seed(ctx, turn_index, ref):
    event = {"session_id": "vs-1", "tenant": "acme", "turn_index": turn_index, "started_at": T0, "ended_at": T0 + 3200, "transcript_ref": ref}
    ctx.kafka.seed(TOPIC, key="vs-1", value=json.dumps(event))


def check_session_key(ctx):
    m = ctx.load("events")
    for i in range(3):
        m.record_turn(CALL, _turn(i))
        m.record_turn(OTHER, _turn(i))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 6, f"six turns produced {len(records)} records on {TOPIC}"
    mine = [r for r in records if _payload(r).get("session_id") == "vs-1"]
    keys = sorted({r.key for r in mine}, key=repr)
    assert keys == [b"vs-1"], f"vs-1's turns were keyed {keys}: keyed by anything but the session id, one call's turns scatter across partitions"
    partitions = sorted({r.partition for r in mine})
    assert len(partitions) == 1, f"vs-1's turns landed on partitions {partitions}: one call's transcript must sit on one partition, in order"
    order = [_payload(r).get("turn_index") for r in sorted(mine, key=lambda r: r.offset)]
    assert order == [0, 1, 2], f"vs-1's turns sit on its partition in the order {order}"


def check_redacted_payload(ctx):
    m = ctx.load("events")
    event = m.record_turn(CALL, _turn(3))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one turn produced {len(records)} records"
    raw = records[0].value.decode()
    assert "415 555 0134" not in raw and "call me back" not in raw, f"the voice.turn record carries the caller's words: {raw}. The topic is retained and replicated; carry transcript_ref, not the text"
    payload = json.loads(raw)
    expected = {"session_id": "vs-1", "tenant": "acme", "turn_index": 3, "started_at": T0 + 12000, "ended_at": T0 + 15200}
    for name, value in expected.items():
        assert payload.get(name) == value, f"the event must carry {name} = {value!r}, got {payload}"
    ref = payload.get("transcript_ref")
    assert isinstance(ref, str) and ctx.redis.hget(ref, "text") == REDACTED, f"transcript_ref {ref!r} must name the redacted text transcripts.redact stored, got {ctx.redis.hgetall(ref) if isinstance(ref, str) else None}"
    assert event == payload, f"record_turn must return the event it produced: returned {event}, produced {payload}"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    m.record_turn(CALL, _turn(0))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one turn whose acknowledgement was lost left {len(records)} records: the producer's retry wrote the turn twice. Enable idempotence (with acks=all)"
    m.record_turn(CALL, _turn(1))
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the second turn and lost it. Use acks=all"


def check_persist_before_commit(ctx):
    _seed(ctx, 0, transcripts.redact("vs-1", 0, SPOKEN))
    m = ctx.load("events")
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(ctx.redis.exists("voice:turn:vs-1:0")))
    ctx.drain(m.run)
    assert at_commit, "the transcript consumer never committed an offset"
    assert at_commit[0] == 1, "the offset was committed before voice:turn:vs-1:0 existed: a crash between the commit and insert_turn loses the turn"
    stored = transcripts.list_turns("vs-1", -1, 10)
    assert [t["text"] for t in stored] == [REDACTED], f"the consumer must store the turn, the store holds {stored}"
    # The next turn's write fails: its offset must stay uncommitted, so the turn is redelivered.
    _seed(ctx, 1, "voice:redacted:vs-1:missing")
    try:
        ctx.drain(m.run)
    except Exception:
        pass  # the consumer surfaces the store's error; what matters is what was committed
    assert ctx.kafka.lag(GROUP, TOPIC) == 1, f"insert_turn failed for turn 1 but its offset was committed (lag {ctx.kafka.lag(GROUP, TOPIC)}): the turn is lost"
`,
    typescript: `const TOPIC = 'voice.turn';
const GROUP = 'transcripts';
const SPOKEN = 'Sure, call me back on 415 555 0134 after six.';
const REDACTED = 'Sure, call me back on [redacted] after six.';
const CALL = {session_id: 'vs-1', tenant: 'acme', codec: 'pcm16', sample_rate: 24000, max_duration_s: 1800, turn_count: 0};
const OTHER = {...CALL, session_id: 'vs-2'};
const T0 = 1_700_000_000_000;

const turnAt = (i: number) => ({turn_index: i, started_at: T0 + i * 4000, ended_at: T0 + i * 4000 + 3200, text: SPOKEN});

function payload(record) {
  try {
    return JSON.parse(String(record.value));
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

function seed(ctx, turnIndex: number, ref: string): void {
  const event = {session_id: 'vs-1', tenant: 'acme', turn_index: turnIndex, started_at: T0, ended_at: T0 + 3200, transcript_ref: ref};
  ctx.kafka.seed(TOPIC, {key: 'vs-1', value: JSON.stringify(event)});
}

export async function check_session_key(ctx) {
  const m = ctx.load('events');
  for (let i = 0; i < 3; i += 1) {
    await m.recordTurn(CALL, turnAt(i));
    await m.recordTurn(OTHER, turnAt(i));
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 6, \`six turns produced \${records.length} records on \${TOPIC}\`);
  const mine = records.filter(r => payload(r).session_id === 'vs-1');
  const keys = [...new Set(mine.map(r => (r.key === null || r.key === undefined ? null : String(r.key))))];
  assert.deepStrictEqual(keys, ['vs-1'], \`vs-1's turns were keyed \${JSON.stringify(keys)}: keyed by anything but the session id, one call's turns scatter across partitions\`);
  const partitions = [...new Set(mine.map(r => r.partition))];
  assert.equal(partitions.length, 1, \`vs-1's turns landed on partitions \${JSON.stringify(partitions)}: one call's transcript must sit on one partition, in order\`);
  const order = [...mine].sort((a, b) => Number(a.offset) - Number(b.offset)).map(r => payload(r).turn_index);
  assert.deepStrictEqual(order, [0, 1, 2], \`vs-1's turns sit on its partition in the order \${JSON.stringify(order)}\`);
}

export async function check_redacted_payload(ctx) {
  const m = ctx.load('events');
  const event = await m.recordTurn(CALL, turnAt(3));
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one turn produced \${records.length} records\`);
  const raw = String(records[0].value);
  assert(!raw.includes('415 555 0134') && !raw.includes('call me back'), \`the voice.turn record carries the caller's words: \${raw}. The topic is retained and replicated; carry transcript_ref, not the text\`);
  const p = JSON.parse(raw);
  const expected = {session_id: 'vs-1', tenant: 'acme', turn_index: 3, started_at: T0 + 12000, ended_at: T0 + 15200};
  for (const [name, value] of Object.entries(expected)) assert.equal(p[name], value, \`the event must carry \${name} = \${value}, got \${raw}\`);
  const ref = p.transcript_ref;
  assert(typeof ref === 'string' && ctx.redis.hget(ref, 'text') === REDACTED, \`transcript_ref \${JSON.stringify(ref)} must name the redacted text redact stored\`);
  assert.deepStrictEqual(event, p, \`recordTurn must return the event it produced: returned \${JSON.stringify(event)}, produced \${raw}\`);
}

export async function check_idempotent_producer(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC);
  await m.recordTurn(CALL, turnAt(0));
  let n = ctx.kafka.records(TOPIC).length;
  assert.equal(n, 1, \`one turn whose acknowledgement was lost left \${n} records: the producer's retry wrote the turn twice. Use an idempotent producer\`);
  await m.recordTurn(CALL, turnAt(1));
  ctx.kafka.failover(TOPIC);
  n = ctx.kafka.records(TOPIC).length;
  assert.equal(n, 2, \`after a leader failover the topic holds \${n} records, expected 2: with acks 1 the leader alone acknowledged the second turn and lost it. Use acks -1 (all)\`);
}

export async function check_persist_before_commit(ctx) {
  const transcripts = ctx.load('/support/voice/transcripts.ts');
  seed(ctx, 0, await transcripts.redact('vs-1', 0, SPOKEN));
  const m = ctx.load('events');
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.exists('voice:turn:vs-1:0')));
  await ctx.drain(m.run());
  assert(atCommit.length > 0, 'the transcript consumer never committed an offset');
  assert.equal(atCommit[0], 1, 'the offset was committed before voice:turn:vs-1:0 existed: a crash between the commit and insertTurn loses the turn');
  const stored = await transcripts.listTurns('vs-1', -1, 10);
  assert.deepStrictEqual(stored.map(t => t.text), [REDACTED], \`the consumer must store the turn, the store holds \${JSON.stringify(stored)}\`);
  // The next turn's write fails: its offset must stay uncommitted, so the turn is redelivered.
  seed(ctx, 1, 'voice:redacted:vs-1:missing');
  try {
    await ctx.drain(m.run());
  } catch {
    // the consumer surfaces the store's error; what matters is what was committed
  }
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 1, \`insertTurn failed for turn 1 but its offset was committed (lag \${ctx.kafka.lag(GROUP, TOPIC)}): the turn is lost\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"leetbuild/harness"

	"voice/sessions"
	"voice/transcripts"
)

const (
	eventsTopic = "voice.turn"
	eventsGroup = "transcripts"
	spoken      = "Sure, call me back on 415 555 0134 after six."
	redacted    = "Sure, call me back on [redacted] after six."
	t0          = int64(1_700_000_000_000)
)

var (
	eventsBg  = context.Background()
	callOne   = sessions.Session{SessionID: "vs-1", Tenant: "acme", Codec: "pcm16", SampleRate: 24000, MaxDurationS: 1800}
	callOther = sessions.Session{SessionID: "vs-2", Tenant: "acme", Codec: "pcm16", SampleRate: 24000, MaxDurationS: 1800}
)

func turnAt(i int) Turn {
	return Turn{TurnIndex: i, StartedAt: t0 + int64(i)*4000, EndedAt: t0 + int64(i)*4000 + 3200, Text: spoken}
}

func mustRecord(ctx *harness.Ctx, session sessions.Session, turn Turn) map[string]any {
	event, err := recordTurn(eventsBg, session, turn)
	ctx.NoError(err, "recordTurn(%s, turn %d) failed", session.SessionID, turn.TurnIndex)
	return event
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func seedTurn(ctx *harness.Ctx, turnIndex int, ref string) {
	event, _ := json.Marshal(transcripts.Event{SessionID: "vs-1", Tenant: "acme", TurnIndex: turnIndex, StartedAt: t0, EndedAt: t0 + 3200, TranscriptRef: ref})
	ctx.Kafka.Seed(eventsTopic, "vs-1", event)
}

func CheckSessionKey(ctx *harness.Ctx) {
	for i := 0; i < 3; i++ {
		mustRecord(ctx, callOne, turnAt(i))
		mustRecord(ctx, callOther, turnAt(i))
	}
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 6, "six turns must produce six records on %s; the records", eventsTopic)
	keys := map[string]bool{}
	partitions := map[int]bool{}
	type placed struct {
		offset int64
		turn   any
	}
	var mine []placed
	for _, r := range records {
		p := payloadOf(ctx, r.Value)
		if p["session_id"] != "vs-1" {
			continue
		}
		keys[string(r.Key)] = true
		partitions[r.Partition] = true
		mine = append(mine, placed{r.Offset, p["turn_index"]})
	}
	ctx.Assert(len(keys) == 1 && keys["vs-1"], "vs-1's turns were keyed %v: keyed by anything but the session id, one call's turns scatter across partitions", keys)
	ctx.Assert(len(partitions) == 1, "vs-1's turns landed on partitions %v: one call's transcript must sit on one partition, in order", partitions)
	sort.Slice(mine, func(i, j int) bool { return mine[i].offset < mine[j].offset })
	order := []any{}
	for _, m := range mine {
		order = append(order, m.turn)
	}
	ctx.Equal(order, []any{0, 1, 2}, "vs-1's turns on its partition, in offset order")
}

func CheckRedactedPayload(ctx *harness.Ctx) {
	event := mustRecord(ctx, callOne, turnAt(3))
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 1, "one turn; the records")
	raw := string(records[0].Value)
	ctx.Assert(!strings.Contains(raw, "415 555 0134") && !strings.Contains(raw, "call me back"), "the voice.turn record carries the caller's words: %s. The topic is retained and replicated; carry transcript_ref, not the text", raw)
	p := payloadOf(ctx, records[0].Value)
	for name, value := range map[string]any{"session_id": "vs-1", "tenant": "acme", "turn_index": 3, "started_at": t0 + 12000, "ended_at": t0 + 15200} {
		ctx.Equal(p[name], value, "the event's %s (%s)", name, raw)
	}
	ref, _ := p["transcript_ref"].(string)
	text, _ := ctx.Redis.HGet(ref, "text")
	ctx.Equal(text, redacted, "transcript_ref %q must name the redacted text Redact stored; its text", ref)
	ctx.Equal(event["transcript_ref"], p["transcript_ref"], "recordTurn must return the event it produced; its transcript_ref")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1)
	mustRecord(ctx, callOne, turnAt(0))
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "one turn whose acknowledgement was lost: the producer's retry wrote the turn twice. Enable idempotence (with acks=all); the records")
	mustRecord(ctx, callOne, turnAt(1))
	lost := ctx.Kafka.Failover(eventsTopic)
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the turn. Use acks=all; the records", lost)
}

func CheckPersistBeforeCommit(ctx *harness.Ctx) {
	seedTurn(ctx, 0, transcripts.Redact(eventsBg, "vs-1", 0, spoken))
	var atCommit []int64
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, ctx.Redis.Exists("voice:turn:vs-1:0")) })
	ctx.Drain(func() { run(eventsBg) })
	ctx.Assert(len(atCommit) > 0, "the transcript consumer never committed an offset")
	ctx.Equal(atCommit[0], int64(1), "the offset was committed before voice:turn:vs-1:0 existed: a crash between the commit and InsertTurn loses the turn; the row at the commit")
	stored := transcripts.ListTurns(eventsBg, "vs-1", -1, 10)
	ctx.Assert(len(stored) == 1 && stored[0].Text == redacted, "the consumer must store the turn, the store holds %+v", stored)
	// The next turn's write fails: its offset must stay uncommitted, so the turn is redelivered.
	seedTurn(ctx, 1, "voice:redacted:vs-1:missing")
	ctx.Drain(func() { run(eventsBg) })
	ctx.Equal(ctx.Kafka.Lag(eventsGroup, eventsTopic), int64(1), "InsertTurn failed for turn 1 and its offset must stay uncommitted (else the turn is lost); the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <exception>
#include <set>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

namespace {

const std::string kTopic = "voice.turn";
const std::string kGroup = "transcripts";
const std::string kSpoken = "Sure, call me back on 415 555 0134 after six.";
const std::string kRedacted = "Sure, call me back on [redacted] after six.";
const long long kT0 = 1700000000000LL;
const sessions::Session kCall{"vs-1", "acme", "pcm16", 24000, 1800, 0};
const sessions::Session kOther{"vs-2", "acme", "pcm16", 24000, 1800, 0};

Turn turnAt(long i) { return Turn{i, kT0 + i * 4000, kT0 + i * 4000 + 3200, kSpoken}; }

json mustRecord(harness::Ctx& ctx, const sessions::Session& session, const Turn& turn) {
  try {
    return record_turn(session, turn);
  } catch (const std::exception& e) {
    ctx.Fatalf("record_turn(%s, turn %d) threw %s", session.session_id, turn.turn_index, e.what());
  }
}

json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  try {
    return json::parse(record.Value.value_or(""));
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", record.Value.value_or(""), e.what());
  }
}

void seedTurn(harness::Ctx& ctx, long turn_index, const std::string& ref) {
  const json event = {{"session_id", "vs-1"}, {"tenant", "acme"}, {"turn_index", turn_index}, {"started_at", kT0}, {"ended_at", kT0 + 3200}, {"transcript_ref", ref}};
  ctx.Kafka.Seed(kTopic, std::string("vs-1"), event.dump());
}

}  // namespace

void CheckSessionKey(harness::Ctx& ctx) {
  for (long i = 0; i < 3; i++) {
    mustRecord(ctx, kCall, turnAt(i));
    mustRecord(ctx, kOther, turnAt(i));
  }
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 6, "six turns must produce six records on %s; the records", kTopic);
  std::set<std::string> keys;
  std::set<int> partitions;
  std::vector<std::pair<int64_t, long>> mine;
  for (const auto& r : records) {
    const json p = payloadOf(ctx, r);
    if (p.value("session_id", "") != "vs-1") continue;
    keys.insert(r.Key.value_or("(no key)"));
    partitions.insert(r.Partition);
    mine.emplace_back(r.Offset, p.value("turn_index", -1L));
  }
  ctx.Assert(keys == std::set<std::string>{"vs-1"}, "vs-1's turns were keyed %v: keyed by anything but the session id, one call's turns scatter across partitions", keys);
  ctx.Assert(partitions.size() == 1, "vs-1's turns landed on partitions %v: one call's transcript must sit on one partition, in order", partitions);
  std::sort(mine.begin(), mine.end());
  std::vector<long> order;
  for (const auto& [offset, turn] : mine) order.push_back(turn);
  ctx.Equal(order, std::vector<long>{0, 1, 2}, "vs-1's turns on its partition, in offset order");
}

void CheckRedactedPayload(harness::Ctx& ctx) {
  const json event = mustRecord(ctx, kCall, turnAt(3));
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 1, "one turn; the records");
  const std::string raw = records[0].Value.value_or("");
  ctx.Assert(raw.find("415 555 0134") == std::string::npos && raw.find("call me back") == std::string::npos,
             "the voice.turn record carries the caller's words: %s. The topic is retained and replicated; carry transcript_ref, not the text", raw);
  const json p = payloadOf(ctx, records[0]);
  ctx.Assert(p.value("session_id", "") == "vs-1" && p.value("tenant", "") == "acme" && p.value("turn_index", -1L) == 3 &&
                 p.value("started_at", 0LL) == kT0 + 12000 && p.value("ended_at", 0LL) == kT0 + 15200,
             "the event must carry session_id, tenant, turn_index and the timings, got %s", raw);
  const std::string ref = p.value("transcript_ref", "");
  ctx.Equal(ctx.Redis.HGet(ref, "text").value_or(""), kRedacted, "transcript_ref %q must name the redacted text redact stored; its text", ref);
  ctx.Equal(event.dump(), p.dump(), "record_turn must return the event it produced");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);
  mustRecord(ctx, kCall, turnAt(0));
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one turn whose acknowledgement was lost: the producer's retry wrote the turn twice. Set enable.idempotence (with acks=all); the records");
  mustRecord(ctx, kCall, turnAt(1));
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the turn. Use acks=all; the records", lost);
}

void CheckPersistBeforeCommit(harness::Ctx& ctx) {
  seedTurn(ctx, 0, transcripts::redact("vs-1", 0, kSpoken));
  std::vector<long long> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(ctx.Redis.Exists("voice:turn:vs-1:0")); });
  ctx.Drain([] { run(); });
  ctx.Assert(!atCommit.empty(), "the transcript consumer never committed an offset");
  ctx.Equal(atCommit[0], 1, "the offset was committed before voice:turn:vs-1:0 existed: a crash between the commit and insertTurn loses the turn; the row at the commit");
  const auto stored = transcripts::listTurns("vs-1", -1, 10);
  ctx.Assert(stored.size() == 1 && stored[0].text == kRedacted, "the consumer must store the turn, the store holds %d turn(s)", stored.size());
  // The next turn's write fails: its offset must stay uncommitted, so the turn is redelivered.
  seedTurn(ctx, 1, "voice:redacted:vs-1:missing");
  ctx.Drain([] {
    try {
      run();
    } catch (const std::exception&) {
      // the consumer surfaces the store's error; what matters is what was committed
    }
  });
  ctx.Equal(ctx.Kafka.Lag(kGroup, kTopic), 1, "insertTurn failed for turn 1 and its offset must stay uncommitted (else the turn is lost); the lag");
}
`,
  },
  hints: [
    "Support opens a transcript and two turns are swapped; a compliance scan finds a caller's card number in the voice.turn topic a week later; after a broker failover one turn shows up twice.",
    'The producer sends no key, so the partitioner spreads one call over every partition; the payload copies the spoken text; the producer has `acks=1` and no idempotence; the consumer commits before `insert_turn`.',
    'Key by `session["session_id"]`, send `transcript_ref = transcripts.redact(...)` instead of the text, set `enable.idempotence` with `acks=all`, and move `consumer.commit(...)` after `transcripts.insert_turn(...)`.',
  ],
  debrief: `The key is the session because order matters within one call and nowhere else, and Kafka only orders within a partition. The payload carries a reference because a topic is retained, replicated and read by every consumer group anyone adds later; redaction has to happen before the words are copied that widely, and the redacted text then lives in one store with one retention rule. Idempotence with acks=all makes the producer's own retry after a lost acknowledgement land once and survive a leader failover. Committing after the write turns a crash into a redelivery, and \`insert_turn\` rewrites the same row, so the replay is harmless. Production pipelines also expire the redacted text with the call's retention and send undecodable records to a dead-letter topic instead of stalling the partition.`,
};
