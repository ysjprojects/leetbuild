import type {Step} from '@/lib/types';

export const sqlEventsStep: Step = {
  id: 'events',
  title: 'Query events keyed by schema, with no literal values',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

The starter is a plausible model-generated draft: every generation outcome reaches
\`copilot.query\`, the audit consumer reads it back, and the demo shows a history. Four production
contracts are broken. Find them, fix them, and prove the fix.

One \`copilot.query\` event per generation is what the copilot's own review loop runs on: the audit
consumer group turns those events into the per-schema history that answers "is this schema getting
better or worse to generate for?".

- Key the record by the **schema handle** — \`key=schema_handle.encode()\`. Partition by schema
  handle and one schema's generation history arrives in order, which is the only reason the history
  reads like a story instead of a shuffle.
- The payload carries \`schema\`, \`tables\`, \`latency_ms\` and a **SHA-256 fingerprint of the
  question**. The question text and the generated SQL never enter the topic, and never a log line
  either: a topic is retained for days and replicated, so anything written there outlives every
  retention policy the request pipeline has — and generated SQL spells out the customer's tables
  and literals.
- The producer must be **accountable**: \`acks=all\` so a broker failover cannot acknowledge a
  record that is not replicated, and idempotence so a retry of a produce cannot duplicate it.
- When the broker rejects the produce, write an **outbox row** instead of dropping the event; a
  relay republishes outbox rows when the broker recovers.
- The consumer stores the record under its schema handle and **only then** commits the offset.

**Failure mode the checks target.** The draft keys by user id, so one schema's history scatters
across partitions and loses its order; it copies the question *and* the generated SQL into a
retained topic; a rejected produce is dropped, because the draft has no outbox at all; and the
producer is built with the library defaults — no \`acks\`, no idempotence — so a broker failover can
silently lose or duplicate an event. The fingerprint is the piece the draft never builds, and it is
what makes the payload safe: a hash lets the audit dedupe and debug an outcome without ever copying
the caller's content.`,
  sequence: {
    participants: ['SQL Copilot', 'copilot.query', 'Query audit'],
    messages: [
      {from: 'SQL Copilot', to: 'copilot.query', label: 'produce · key = schema handle · acks = all', kind: 'sync'},
      {from: 'copilot.query', to: 'SQL Copilot', label: 'ack / broker error', kind: 'reply'},
      {
        from: 'SQL Copilot',
        to: 'SQL Copilot',
        label: 'outbox row on rejection · relay republishes later',
        kind: 'sync',
      },
      {from: 'copilot.query', to: 'Query audit', label: 'consume · group sql-copilot-history', kind: 'async'},
      {from: 'Query audit', to: 'Query audit', label: 'append to history under the schema handle', kind: 'sync'},
      {from: 'Query audit', to: 'copilot.query', label: 'commit offset after the record is stored', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'topic',
      title: 'Publishes to copilot.query',
      detail: 'Generation outcomes are published to the `copilot.query` topic. (The draft already does.)',
      match: {
        python: {all: [/TOPIC\s*=\s*"copilot\.query"/]},
        typescript: {all: [/TOPIC\s*=\s*'copilot\.query'/]},
        go: {all: [/topic\s*=\s*"copilot\.query"/]},
        scala: {all: [/Topic\s*=\s*"copilot\.query"/]},
        cpp: {all: [/kTopic\s*=\s*"copilot\.query"/]},
      },
    },
    {
      id: 'schema-key',
      title: 'Keys every event by the schema handle',
      detail:
        "The record is keyed by the schema handle (`key=schema_handle.encode()`), so one schema's history stays in one partition. The draft keys by user id, scattering the history and breaking per-schema ordering.",
      match: {
        python: {all: [/key\s*=\s*schema_handle\.encode\(\)/], none: [/key\s*=\s*user_id\.encode\(\)/]},
        typescript: {all: [/key:\s*schemaHandle/], none: [/key:\s*userId/]},
        go: {all: [/Key:\s*\[\]byte\(schemaHandle\)/], none: [/Key:\s*\[\]byte\(userID\)/]},
        scala: {
          all: [/ProducerRecord\[\s*String\s*,\s*String\s*\]\(\s*Topic\s*,\s*schemaHandle/],
          none: [/ProducerRecord\[[^\]]*\]\([^)]*userId/],
        },
        cpp: {all: [/RD_KAFKA_V_KEY\(schema_handle/], none: [/RD_KAFKA_V_KEY\(user_id/]},
      },
    },
    {
      id: 'no-literals',
      title: 'No question text and no literal values in the payload',
      detail:
        'The event carries `schema`, `tables`, `latency_ms` and a SHA-256 `fingerprint` of the question; the question text and the generated SQL never enter the topic. The draft copies both.',
      match: {
        python: {all: [/hashlib\.sha256\(/, /fingerprint/], none: [/"question":\s*question\b/, /"sql":\s*sql\b/]},
        typescript: {
          all: [/createHash\(\s*'sha256'\s*\)/, /fingerprint/],
          none: [/question:\s*question\b/, /sql:\s*sql\b/],
        },
        go: {all: [/sha256\.Sum256\(|sha256\.New\(\)/, /fingerprint/], none: [/json:"question"/, /json:"sql"/]},
        scala: {
          all: [/MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/, /fingerprint/],
          none: [/"question":\s*\$question\b/, /"sql":\s*\$sql\b/],
        },
        cpp: {all: [/sha256Hex\(/, /fingerprint/], none: [/"question",\s*question\b/, /"sql",\s*sql\b/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce writes an outbox row',
      detail:
        'When the broker rejects the produce the event is written to the outbox for a later republish instead of being dropped. The draft has no outbox at all.',
      match: {
        python: {order: [/except\s+\w/, /outbox\.put\(/]},
        typescript: {order: [/catch\s*\(/, /outbox\.put\(/]},
        go: {order: [/if err\s*!=\s*nil/, /outbox\.Put\(/]},
        scala: {order: [/case ex:/, /outbox\.put\(/]},
        cpp: {order: [/rd_kafka_err2str/, /outbox\.put\(/]},
      },
    },
    {
      id: 'durable-produce',
      title: 'Produce is accountable: acks=all and idempotence',
      detail:
        'The producer is configured for `acks=all` and idempotence so a broker failover cannot silently drop or duplicate the event.',
      match: {
        python: {all: [/"acks":\s*"all"/, /enable\.idempotence/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /MaxAttempts:\s*\d/]},
        scala: {all: [/ACKS_CONFIG/, /ENABLE_IDEMPOTENCE_CONFIG/]},
        cpp: {all: [/"acks"\s*,\s*"all"/, /"enable\.idempotence"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

TOPIC = "copilot.query"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class GenerateRequest(BaseModel):
    schema_handle: str
    user_id: str
    question: str
    sql: str
    tables: list[str]
    latency_ms: int


class History:
    def append(self, schema_handle: str, event: dict) -> None:
        """One row per generation outcome, in the order the partition delivered it."""
        raise NotImplementedError


history = History()


def publish(user_id: str, question: str, sql: str, latency_ms: int) -> None:
    # TODO: key by the schema handle instead of the user id, publish the schema handle, the tables,
    # the latency and a SHA-256 fingerprint instead of the question and the SQL, configure the
    # producer with acks=all and idempotence, and write an outbox row when the broker rejects it.
    event = {"user": user_id, "question": question, "sql": sql, "latency_ms": latency_ms}
    producer.produce(TOPIC, key=user_id.encode(), value=json.dumps(event))
    producer.flush()


@app.post("/v1/queries/generate")
def generate(body: GenerateRequest) -> dict:
    publish(body.user_id, body.question, body.sql, body.latency_ms)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "sql-copilot-history"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        history.append(msg.key().decode(), json.loads(msg.value()))
        consumer.commit(msg)
`,
      solution: `"""copilot.query: one generation event per query, keyed by the schema handle."""
import hashlib
import json
import logging

from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("copilot.events")

TOPIC = "copilot.query"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
    }
)


class GenerateRequest(BaseModel):
    schema_handle: str
    user_id: str
    question: str
    tables: list[str]
    latency_ms: int


class Outbox:
    def put(self, schema_handle: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it when the broker recovers."""
        raise NotImplementedError


outbox = Outbox()


class History:
    def append(self, schema_handle: str, event: dict) -> None:
        """One row per generation outcome, in the order the partition delivered it."""
        raise NotImplementedError


history = History()


def publish(schema_handle: str, question: str, tables: list[str], latency_ms: int) -> None:
    """Report one outcome without copying the question or the generated SQL."""
    fingerprint = hashlib.sha256(question.encode()).hexdigest()
    event = {
        "schema": schema_handle,
        "tables": tables,
        "latency_ms": latency_ms,
        "fingerprint": fingerprint,
    }
    try:
        producer.produce(TOPIC, key=schema_handle.encode(), value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException as exc:
        logger.warning("produce to %s rejected: %s", TOPIC, exc)
        outbox.put(schema_handle, event)


@app.post("/v1/queries/generate")
def generate(body: GenerateRequest) -> dict:
    publish(body.schema_handle, body.question, body.tables, body.latency_ms)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "sql-copilot-history",
            "enable.auto.commit": False,
        }
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        history.append(event["schema"], event)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** events: a model-generated draft that keys by user and copies the question and the SQL. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const TOPIC = 'copilot.query';
const kafka = new Kafka({clientId: 'sql-copilot', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface GenerateBody {
  schema_handle: string;
  user_id: string;
  question: string;
  sql: string;
  tables: string[];
  latency_ms: number;
}

class History {
  async append(schemaHandle: string, record: unknown): Promise<void> {
    void schemaHandle;
    void record;
    throw new Error('the per-schema history store is provided by the audit service');
  }
}
const history = new History();

export async function publish(
  userId: string,
  question: string,
  sql: string,
  latencyMs: number,
): Promise<void> {
  // TODO: key by the schema handle instead of the user id, publish the schema handle, the tables,
  // the latency and a SHA-256 fingerprint instead of the question and the SQL, configure the
  // producer with acks=-1 and idempotence, and write an outbox row when the broker rejects it.
  const event = {user: userId, question: question, sql: sql, latency_ms: latencyMs};
  await producer.send({
    topic: TOPIC,
    messages: [{key: userId, value: JSON.stringify(event)}],
  });
}

app.post('/v1/queries/generate', async (request, reply) => {
  const body = request.body as GenerateBody;
  await publish(body.user_id, body.question, body.sql, body.latency_ms);
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'sql-copilot-history'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const record = JSON.parse(message.value?.toString() ?? '{}') as {schema: string};
      await history.append(record.schema, record);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** events: one copilot.query event per generation, keyed by the schema handle. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const TOPIC = 'copilot.query';
const kafka = new Kafka({clientId: 'sql-copilot', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface GenerateBody {
  schema_handle: string;
  user_id: string;
  question: string;
  tables: string[];
  latency_ms: number;
}

interface QueryEvent {
  schema: string;
  tables: string[];
  latency_ms: number;
  fingerprint: string;
}

class Outbox {
  async put(schemaHandle: string, event: QueryEvent): Promise<void> {
    void schemaHandle;
    void event;
    throw new Error('the outbox table is provided by the platform layer; a relay republishes it');
  }
}
const outbox = new Outbox();

class History {
  async append(schemaHandle: string, event: QueryEvent): Promise<void> {
    void schemaHandle;
    void event;
    throw new Error('the per-schema history store is provided by the audit service');
  }
}
const history = new History();

export async function publish(
  schemaHandle: string,
  question: string,
  tables: string[],
  latencyMs: number,
): Promise<void> {
  const fingerprint = createHash('sha256').update(question).digest('hex');
  const event: QueryEvent = {schema: schemaHandle, tables, latency_ms: latencyMs, fingerprint};
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: schemaHandle, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await outbox.put(schemaHandle, event);
  }
}

app.post('/v1/queries/generate', async (request, reply) => {
  const body = request.body as GenerateBody;
  await publish(body.schema_handle, body.question, body.tables, body.latency_ms);
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'sql-copilot-history'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as QueryEvent;
      await history.append(event.schema, event);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const topic = "copilot.query"

// Outcome is one generation result handed over by the API layer.
type Outcome struct {
	UserID       string
	SchemaHandle string
	Question     string
	SQL          string
	Tables       []string
	LatencyMS    int
}

type queryEvent struct {
	UserID    string \`json:"user"\`
	Question  string \`json:"question"\`
	SQL       string \`json:"sql"\`
	LatencyMS int    \`json:"latency_ms"\`
}

var writer = &kafka.Writer{
	Addr:  kafka.TCP("kafka:9092"),
	Topic: topic,
}

// History is the per-schema audit trail the consumer group builds.
type History struct{}

func (h *History) Append(ctx context.Context, schemaHandle string, payload []byte) error {
	return nil
}

var history = &History{}

// TODO: key the record by the schema handle instead of the user id, configure acks=all and
// idempotence, publish the schema handle, the tables, the latency and a SHA-256 fingerprint
// instead of the question and the SQL, and write an outbox row when the broker rejects the
// produce.
func Publish(ctx context.Context, outcome Outcome) error {
	userID := outcome.UserID
	event := queryEvent{
		UserID:    userID,
		Question:  outcome.Question,
		SQL:       outcome.SQL,
		LatencyMS: outcome.LatencyMS,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(userID), Value: payload})
}

// Consume stores each record under its key and commits only after the store answered.
func Consume(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: "sql-copilot-history",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := history.Append(ctx, string(msg.Key), msg.Value); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const topic = "copilot.query"

// Outcome is one generation result handed over by the API layer. It is an internal Go value:
// nothing here tags the question, so the text cannot reach the topic by accident.
type Outcome struct {
	SchemaHandle string
	Question     string
	Tables       []string
	LatencyMS    int
}

type queryEvent struct {
	Schema      string   \`json:"schema"\`
	Tables      []string \`json:"tables"\`
	LatencyMS   int      \`json:"latency_ms"\`
	Fingerprint string   \`json:"fingerprint"\`
}

// RequiredAcks=RequireAll is kafka-go's acks=all: the broker acknowledges a record only once it is
// replicated, and MaxAttempts retries a produce that failed retriably.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	RequiredAcks: kafka.RequireAll,
	MaxAttempts:  3,
}

// Outbox holds one row per undelivered event; a relay republishes it when the broker recovers.
type Outbox struct{}

func (o *Outbox) Put(ctx context.Context, schemaHandle string, payload []byte) error {
	return nil
}

var outbox = &Outbox{}

// History is the per-schema audit trail the consumer group builds.
type History struct{}

func (h *History) Append(ctx context.Context, schemaHandle string, payload []byte) error {
	return nil
}

var history = &History{}

// Publish reports one generation outcome, keyed by the schema handle and without the question.
func Publish(ctx context.Context, outcome Outcome) error {
	schemaHandle := outcome.SchemaHandle
	sum := sha256.Sum256([]byte(outcome.Question))
	event := queryEvent{
		Schema:      schemaHandle,
		Tables:      outcome.Tables,
		LatencyMS:   outcome.LatencyMS,
		Fingerprint: hex.EncodeToString(sum[:]),
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(schemaHandle), Value: payload}); err != nil {
		return outbox.Put(ctx, schemaHandle, payload)
	}
	return nil
}

// Consume stores each record under its key and commits only after the store answered.
func Consume(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: "sql-copilot-history",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := history.Append(ctx, string(msg.Key), msg.Value); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object QueryEvents {
  private val Topic = "copilot.query"

  private val producer = new KafkaProducer[String, String](new Properties())

  /** The per-schema audit trail the consumer group builds. */
  object history {
    def append(schemaHandle: String, payload: String): Unit = ()
  }

  // TODO: key by the schema handle instead of the user id, configure acks=all and idempotence,
  // publish the schema handle, the tables, the latency and a SHA-256 fingerprint instead of the
  // question and the SQL, and write an outbox row when the broker rejects the produce.
  def publish(userId: String, question: String, sql: String, latencyMs: Int): Unit = {
    val payload = s"""{"user":"$userId","question":$question,"sql":$sql,"latency_ms":$latencyMs}"""
    producer.send(new ProducerRecord[String, String](Topic, userId, payload))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        history.append(record.key(), record.value())
        consumer.commitSync()
      }
    }
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.KafkaException
import spray.json._

object QueryEvents {
  private val Topic = "copilot.query"

  private val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ProducerConfig.ACKS_CONFIG, "all")
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
    props
  })

  /** One row per undelivered event; a relay republishes it when the broker recovers. */
  object outbox {
    def put(schemaHandle: String, payload: String): Unit = ()
  }

  /** The per-schema audit trail the consumer group builds. */
  object history {
    def append(schemaHandle: String, payload: String): Unit = ()
  }

  /** Reports one outcome without copying the question or the generated SQL. */
  def publish(schemaHandle: String, question: String, tables: List[String], latencyMs: Int): Unit = {
    val digest = MessageDigest.getInstance("SHA-256").digest(question.getBytes("UTF-8"))
    val fingerprint = digest.map("%02x".format(_)).mkString
    val payload =
      s"""{"schema":"$schemaHandle","tables":\${tables.toJson.compactPrint},"latency_ms":$latencyMs,"fingerprint":"$fingerprint"}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, schemaHandle, payload))
    } catch {
      case ex: KafkaException =>
        outbox.put(schemaHandle, payload)
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "sql-copilot-history")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        history.append(record.key(), record.value())
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafka.h>

#include <iostream>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "copilot.query";

rd_kafka_t* makeProducer() {
  char errstr[512];
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, sizeof(errstr));
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, sizeof(errstr));
}

rd_kafka_t* producer = makeProducer();

/** The per-schema audit trail the consumer group builds. */
struct History {
  void append(const std::string& schemaHandle, const std::string& payload);
};
History history;

// TODO: key the record by the schema handle instead of the user id, configure the producer with
// acks=all and idempotence, publish the schema handle, the tables, the latency and a SHA-256
// fingerprint instead of the question and the SQL, and write an outbox row when the broker rejects
// the produce.
void publish(const std::string& user_id, const std::string& question, const std::string& sql,
             int latency_ms) {
  const json event = {{"user", user_id}, {"question", question}, {"sql", sql}, {"latency_ms", latency_ms}};
  const std::string payload = event.dump();
  rd_kafka_producev(
      producer,
      RD_KAFKA_MSG_F_COPY,
      RD_KAFKA_V_TOPIC(kTopic.c_str()),
      RD_KAFKA_V_KEY(user_id.data(), user_id.size()),
      RD_KAFKA_V_VALUE(payload.data(), payload.size()),
      RD_KAFKA_V_END);
  rd_kafka_flush(producer, 2000);
}

void consume() {
  char errstr[512];
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, sizeof(errstr));
  rd_kafka_conf_set(conf, "group.id", "sql-copilot-history", errstr, sizeof(errstr));
  rd_kafka_t* consumer = rd_kafka_new(RD_KAFKA_CONSUMER, conf, errstr, sizeof(errstr));
  rd_kafka_poll_set_consumer(consumer);
  rd_kafka_topic_partition_list_t* topics = rd_kafka_topic_partition_list_new(1);
  rd_kafka_topic_partition_list_add(topics, kTopic.c_str(), RD_KAFKA_PARTITION_UA);
  rd_kafka_subscribe(consumer, topics);
  rd_kafka_topic_partition_list_destroy(topics);
  while (true) {
    rd_kafka_message_t* msg = rd_kafka_consumer_poll(consumer, 200);
    if (msg == nullptr) {
      continue;
    }
    if (msg->err == RD_KAFKA_RESP_ERR_NO_ERROR) {
      history.append(std::string(static_cast<const char*>(msg->key), msg->key_len),
                     std::string(static_cast<const char*>(msg->payload), msg->len));
      rd_kafka_commit(consumer, nullptr, 0);
    }
    rd_kafka_message_destroy(msg);
  }
}
`,
      solution: `#include <librdkafka/rdkafka.h>

#include "sha256.h"  // std::string sha256Hex(const std::string&): the platform's digest helper
#include <iostream>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "copilot.query";

/** One row per undelivered event; a relay republishes it when the broker recovers. */
struct Outbox {
  void put(const std::string& schemaHandle, const std::string& payload);
};
Outbox outbox;

/** The per-schema audit trail the consumer group builds. */
struct History {
  void append(const std::string& schemaHandle, const std::string& payload);
};
History history;

rd_kafka_t* makeProducer() {
  char errstr[512];
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, sizeof(errstr));
  rd_kafka_conf_set(conf, "acks", "all", errstr, sizeof(errstr));
  rd_kafka_conf_set(conf, "enable.idempotence", "true", errstr, sizeof(errstr));
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, sizeof(errstr));
}

rd_kafka_t* producer = makeProducer();

/** Reports one outcome without copying the question or the generated SQL. */
void publish(const std::string& schema_handle, const std::string& question,
             const std::vector<std::string>& tables, int latency_ms) {
  const json event = {
      {"schema", schema_handle},
      {"tables", tables},
      {"latency_ms", latency_ms},
      {"fingerprint", sha256Hex(question)},
  };
  const std::string payload = event.dump();
  const rd_kafka_resp_err_t err = rd_kafka_producev(
      producer,
      RD_KAFKA_MSG_F_COPY,
      RD_KAFKA_V_TOPIC(kTopic.c_str()),
      RD_KAFKA_V_KEY(schema_handle.data(), schema_handle.size()),
      RD_KAFKA_V_VALUE(payload.data(), payload.size()),
      RD_KAFKA_V_END);
  if (err != RD_KAFKA_RESP_ERR_NO_ERROR) {
    const std::string detail = rd_kafka_err2str(err);
    std::cerr << "produce to " << kTopic << " rejected: " << detail << "\\n";
    outbox.put(schema_handle, payload);
  }
  rd_kafka_flush(producer, 2000);
}

void consume() {
  char errstr[512];
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, sizeof(errstr));
  rd_kafka_conf_set(conf, "group.id", "sql-copilot-history", errstr, sizeof(errstr));
  rd_kafka_t* consumer = rd_kafka_new(RD_KAFKA_CONSUMER, conf, errstr, sizeof(errstr));
  rd_kafka_poll_set_consumer(consumer);
  rd_kafka_topic_partition_list_t* topics = rd_kafka_topic_partition_list_new(1);
  rd_kafka_topic_partition_list_add(topics, kTopic.c_str(), RD_KAFKA_PARTITION_UA);
  rd_kafka_subscribe(consumer, topics);
  rd_kafka_topic_partition_list_destroy(topics);
  while (true) {
    rd_kafka_message_t* msg = rd_kafka_consumer_poll(consumer, 200);
    if (msg == nullptr) {
      continue;
    }
    if (msg->err == RD_KAFKA_RESP_ERR_NO_ERROR) {
      history.append(std::string(static_cast<const char*>(msg->key), msg->key_len),
                     std::string(static_cast<const char*>(msg->payload), msg->len));
      rd_kafka_commit(consumer, nullptr, 0);
    }
    rd_kafka_message_destroy(msg);
  }
}
`,
    },
  },
  hints: [
    "The partition key decides ordering: key by the schema handle so one schema's generation history stays ordered in one partition. Keying by user scatters one schema's events across partitions and the history stops making sense.",
    "A topic is retained and replicated: publish `schema`, `tables`, `latency_ms` and a SHA-256 `fingerprint` of the question. The question and the generated SQL are the caller's content — the fingerprint is what lets you dedupe and debug without copying it.",
    'A rejected produce must not lose the event: catch the produce failure and write an outbox row, then let a retry republish it. Configure `acks=all` and idempotence so a broker failover cannot silently drop or duplicate the event.',
  ],
  debrief: `The interviewer is checking the three things a generated Kafka snippet gets wrong. First, the message key is an ordering contract: key the record by the schema handle and one schema's history replays in the order the schema was used; key it by user id and that history scatters across partitions and stops being a history. Second, a topic is retained and replicated, so it must not carry the caller's content: the question goes in as a SHA-256 fingerprint — enough to dedupe and debug, never enough to read — and the generated SQL, which spells out tables and literals, never enters the topic at all. Third, a broker is not a database: when the produce is rejected the durable path is an outbox row a relay republishes, and a producer only deserves to be trusted with a record when \\\`acks=all\\\` and idempotence are on. Real platforms add schema registry validation on the topic, a republisher that drains the outbox and marks rows sent, and retention and redaction policies that assume someone will eventually write the wrong field.`,
};
