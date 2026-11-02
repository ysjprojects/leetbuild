import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Command events keyed by device for fleet audit',
  concept: 'kafka',
  file: 'events',
  focus: ['hub', 'broker', 'audit', 'outbox'],
  task: `## Task

**Starting point.** The starter's \`POST /v1/devices/{id}/commands\` logs the request, builds an
event \`{id, fleet, door_code, outcome: "accepted"}\`, produces it to \`iot.command\` with
\`key=body.fleet\` from a \`Producer\` configured with only \`bootstrap.servers\`, and flushes. The
\`fleet-audit\` consumer appends a history row and commits. It compiles and hides five flaws.

**Failure mode the checks target.** Every device in a fleet shares one partition, so a device's
history interleaves with its neighbours. The door code sits in a retained, replicated topic and in
the log. A produce retry can duplicate a transition, a rejected produce drops the command from
history, and nothing after \`accepted\` is ever recorded.

Requirements:

- Produce with \`key=device\` and carry \`command_id\` in the event.
- Publish all four transitions, \`accepted\`, \`delivered\`, \`acknowledged\`, \`expired\`, each with
  the command id and the outcome, from wherever they happen.
- No door code, secret or payload field in the event or in any log line; ids and outcomes only.
- Producer config: \`enable.idempotence\` with \`acks: "all"\` (KafkaJS \`idempotent: true\` with
  \`acks: -1\`; kafka-go \`RequireAll\` with a \`Hash\` balancer).
- Wrap the produce: on \`KafkaException\` call \`outbox.insert_outbox(device, event)\` so a relay can
  republish when the broker recovers.
- The audit consumer appends the history row and only then commits the offset; keep that order.`,
  sequence: {
    participants: ['IoT Hub', 'iot.command', 'Fleet Audit', 'Outbox'],
    messages: [
      {from: 'IoT Hub', to: 'iot.command', label: 'produce · key = device id · acks = all', kind: 'sync'},
      {from: 'iot.command', to: 'IoT Hub', label: 'ack / broker error', kind: 'reply'},
      {from: 'IoT Hub', to: 'Outbox', label: 'insertOutbox(device, event) on failure', kind: 'sync'},
      {from: 'iot.command', to: 'Fleet Audit', label: 'consume · group fleet-audit', kind: 'async'},
      {
        from: 'Fleet Audit',
        to: 'Fleet Audit',
        label: 'append accepted / delivered / acknowledged / expired',
        kind: 'sync',
      },
      {from: 'Fleet Audit', to: 'iot.command', label: 'commit offset after the append', kind: 'async'},
    ],
  },
  hints: [
    'The fleet team asks why lock 7 shows `delivered` before `accepted` in its history, and why the history for lock 9 ends at `accepted` although the door opened.',
    '`key=body.fleet` puts every device of a fleet in one partition, so order holds per fleet, not per device; and `accept` is the only place anything is produced.',
    'Produce with `key=device` and an event of `command_id`, `device_id`, `outcome`, from one `publish` used by all four transitions. The checks also cover `enable.idempotence`, `acks`, `insert_outbox` and the door code.',
  ],
  checks: [
    {
      id: 'device-key',
      title: 'Keyed by device id, carrying the command id',
      detail:
        'The message key is the device id — `key=device`, `key: device`, `Key: []byte(device)`, `ProducerRecord("iot.command", device, …)`, the key argument of `produce` — and the event carries the command id. The starter keys by the fleet, so every device in a fleet interleaves in one partition and a device’s history is no longer the order it happened.',
      match: {
        python: {all: [/key=device/, /command_id/]},
        typescript: {all: [/key:\s*device\b/, /commandId|command_id/]},
        go: {all: [/Key:\s*\[\]byte\(device/, /CommandID/]},
        scala: {all: [/ProducerRecord\("iot\.command",\s*device/, /commandId/]},
        cpp: {all: [/produce\([^;\n]*device/, /commandId/]},
      },
    },
    {
      id: 'no-secrets',
      title: 'No door codes or payload fields in the events or the logs',
      detail:
        'Neither the event nor a log line carries the command payload: no door code, no `payload` field, nothing secret. The starter copies the door code into the event and logs it. `message->payload()` — librdkafka’s accessor for the record bytes — is not a leak.',
      match: {
        python: {none: [/\bdoor_?codes?\b|\bsecrets?\b|\bpayloads?\b(?!\s*\()/i]},
        typescript: {none: [/\bdoor_?codes?\b|\bsecrets?\b|\bpayloads?\b(?!\s*\()/i]},
        go: {none: [/\bdoor_?codes?\b|\bsecrets?\b|\bpayloads?\b(?!\s*\()/i]},
        scala: {none: [/\bdoor_?codes?\b|\bsecrets?\b|\bpayloads?\b(?!\s*\()/i]},
        cpp: {none: [/\bdoor_?codes?\b|\bsecrets?\b|\bpayloads?\b(?!\s*\()/i]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence with `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true` + `acks: -1`, kafka-go’s `RequireAll` + a hash balancer. A retried produce must not duplicate a transition in the history, and idempotence only holds while the message key stays the same across retries.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Writes an outbox row when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox` / `insertOutbox`) inside the error branch instead of dropping the event; a relay republishes the row when the broker recovers. The starter has no outbox at all, so a refused produce silently removes the command from the history.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'event-outcomes',
      title: 'Every transition is published with its outcome',
      detail:
        'All four transitions of a command — `accepted`, `delivered`, `acknowledged`, `expired` — are published, so the audit shows what happened after accept. The starter publishes `accepted` and nothing else, so a delivered or expired command vanishes from the history.',
      match: {
        python: {all: [/["']accepted["']/, /["']delivered["']/, /["']acknowledged["']/, /["']expired["']/]},
        typescript: {all: [/["']accepted["']/, /["']delivered["']/, /["']acknowledged["']/, /["']expired["']/]},
        go: {all: [/["']accepted["']/, /["']delivered["']/, /["']acknowledged["']/, /["']expired["']/]},
        scala: {all: [/["']accepted["']/, /["']delivered["']/, /["']acknowledged["']/, /["']expired["']/]},
        cpp: {all: [/["']accepted["']/, /["']delivered["']/, /["']acknowledged["']/, /["']expired["']/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("iothub")

COMMAND_TOPIC = "iot.command"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class CommandBody(BaseModel):
    command_id: str
    fleet: str
    door_code: str


class CommandHistory:
    def append(self, device: str, command_id: str, outcome: str) -> None:
        """One row per transition of a device's command history; the fleet audit reads it."""
        raise NotImplementedError


history = CommandHistory()


@app.post("/v1/devices/{device_id}/commands")
def accept(device_id: str, body: CommandBody) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    logger.info("command device=%s fleet=%s door_code=%s", device_id, body.fleet, body.door_code)
    event = {"id": body.command_id, "fleet": body.fleet, "door_code": body.door_code, "outcome": "accepted"}
    payload = json.dumps(event)
    producer.produce(COMMAND_TOPIC, key=body.fleet, value=payload)
    producer.flush()
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "fleet-audit"})
    consumer.subscribe([COMMAND_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        history.append(event["fleet"], event["id"], event["outcome"])
        consumer.commit(msg)
`,
      solution: `import json

from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

COMMAND_TOPIC = "iot.command"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class CommandBody(BaseModel):
    command_id: str
    fleet: str


class OutboxStore:
    def insert_outbox(self, device: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it when the broker recovers."""
        raise NotImplementedError


outbox = OutboxStore()


class CommandHistory:
    def append(self, device: str, command_id: str, outcome: str) -> None:
        """One row per transition of a device's command history; the fleet audit reads it."""
        raise NotImplementedError


history = CommandHistory()


def publish(device: str, command_id: str, outcome: str) -> None:
    """One event per transition, keyed by the device so its history keeps the order it happened."""
    event = {"command_id": command_id, "device_id": device, "outcome": outcome}
    line = json.dumps(event)
    try:
        producer.produce(COMMAND_TOPIC, key=device, value=line)
        producer.flush(2.0)
    except KafkaException:
        outbox.insert_outbox(device, event)


@app.post("/v1/devices/{device_id}/commands")
def accept(device_id: str, body: CommandBody) -> dict:
    publish(device_id, body.command_id, "accepted")
    return {"accepted": True}


def delivered(device_id: str, command_id: str) -> None:
    publish(device_id, command_id, "delivered")


def acknowledged(device_id: str, command_id: str) -> None:
    publish(device_id, command_id, "acknowledged")


def expired(device_id: str, command_id: str) -> None:
    publish(device_id, command_id, "expired")


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "fleet-audit", "enable.auto.commit": False}
    )
    consumer.subscribe([COMMAND_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        history.append(event["device_id"], event["command_id"], event["outcome"])
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** iot.command: publishes command events for the fleet audit. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'iothub', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

const COMMAND_TOPIC = 'iot.command';

const history = {
  /** One row per transition of a device's command history; the fleet audit reads it. */
  async append(device: string, commandId: string, outcome: string): Promise<void> {
    throw new Error('not implemented');
  },
};

interface CommandBody {
  command_id: string;
  fleet: string;
  door_code: string;
}

app.post('/v1/devices/:deviceId/commands', async (request, reply) => {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const deviceId = (request.params as {deviceId: string}).deviceId;
  const body = request.body as CommandBody;
  request.log.info({device: deviceId, fleet: body.fleet, door_code: body.door_code}, 'command');
  const event = {id: body.command_id, fleet: body.fleet, door_code: body.door_code, outcome: 'accepted'};
  const payload = JSON.stringify(event);
  await producer.send({
    topic: COMMAND_TOPIC,
    messages: [{key: body.fleet, value: payload}],
  });
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'fleet-audit'});
  await consumer.connect();
  await consumer.subscribe({topic: COMMAND_TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        fleet: string;
        id: string;
        outcome: string;
      };
      await history.append(event.fleet, event.id, event.outcome);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** iot.command: one event per transition, keyed by device, outbox row when the produce fails. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'iothub', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const COMMAND_TOPIC = 'iot.command';

const outbox = {
  /** One row per undelivered event; a relay republishes it when the broker recovers. */
  async insertOutbox(device: string, event: unknown): Promise<void> {
    throw new Error('not implemented');
  },
};

const history = {
  /** One row per transition of a device's command history; the fleet audit reads it. */
  async append(device: string, commandId: string, outcome: string): Promise<void> {
    throw new Error('not implemented');
  },
};

interface CommandBody {
  command_id: string;
  fleet: string;
}

async function publish(device: string, commandId: string, outcome: string): Promise<void> {
  const event = {command_id: commandId, device_id: device, outcome};
  try {
    await producer.send({
      topic: COMMAND_TOPIC,
      acks: -1,
      messages: [{key: device, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await outbox.insertOutbox(device, event);
  }
}

app.post('/v1/devices/:deviceId/commands', async (request, reply) => {
  const deviceId = (request.params as {deviceId: string}).deviceId;
  const body = request.body as CommandBody;
  await publish(deviceId, body.command_id, 'accepted');
  return reply.code(202).send({accepted: true});
});

export const delivered = (device: string, commandId: string): Promise<void> =>
  publish(device, commandId, 'delivered');

export const acknowledged = (device: string, commandId: string): Promise<void> =>
  publish(device, commandId, 'acknowledged');

export const expired = (device: string, commandId: string): Promise<void> =>
  publish(device, commandId, 'expired');

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'fleet-audit'});
  await consumer.connect();
  await consumer.subscribe({topic: COMMAND_TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        command_id: string;
        device_id: string;
        outcome: string;
      };
      await history.append(event.device_id, event.command_id, event.outcome);
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
	"log"
	"net/http"

	"github.com/segmentio/kafka-go"
)

var commandWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "iot.command"}

type CommandBody struct {
	CommandID string \`json:"command_id"\`
	Fleet     string \`json:"fleet"\`
	DoorCode  string \`json:"door_code"\`
}

type CommandHistory struct{}

func (h *CommandHistory) Append(ctx context.Context, device string, commandID string, outcome string) error {
	return nil
}

var history = &CommandHistory{}

func accept(rw http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("id")
	body := CommandBody{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	log.Printf("command device=%s fleet=%s door_code=%s", deviceID, body.Fleet, body.DoorCode)
	event := map[string]any{"id": body.CommandID, "fleet": body.Fleet, "door_code": body.DoorCode, "outcome": "accepted"}
	value, _ := json.Marshal(event)
	_ = commandWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.Fleet), Value: value})
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "iot.command",
		GroupID: "fleet-audit",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			CommandID string \`json:"command_id"\`
			Fleet     string \`json:"fleet"\`
			Outcome   string \`json:"outcome"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		_ = history.Append(ctx, event.Fleet, event.CommandID, event.Outcome)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and a retry of the same key
// lands on the same partition instead of duplicating the transition across partitions.
var commandWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "iot.command",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type CommandBody struct {
	CommandID string \`json:"command_id"\`
	Fleet     string \`json:"fleet"\`
}

type OutboxStore struct{}

// InsertOutbox writes one row per undelivered event; a relay republishes it when the broker is back.
func (s *OutboxStore) InsertOutbox(ctx context.Context, device string, event map[string]any) error {
	return nil
}

var outbox = &OutboxStore{}

type CommandHistory struct{}

// Append writes one row per transition of a device's command history; the fleet audit reads it.
func (h *CommandHistory) Append(ctx context.Context, device string, commandID string, outcome string) error {
	return nil
}

var history = &CommandHistory{}

func publish(ctx context.Context, device string, commandID string, outcome string) {
	event := map[string]any{"command_id": commandID, "device_id": device, "outcome": outcome}
	value, _ := json.Marshal(event)
	if err := commandWriter.WriteMessages(ctx, kafka.Message{Key: []byte(device), Value: value}); err != nil {
		_ = outbox.InsertOutbox(ctx, device, event)
	}
}

func accept(rw http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("id")
	body := CommandBody{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	publish(r.Context(), deviceID, body.CommandID, "accepted")
	rw.WriteHeader(http.StatusAccepted)
}

func delivered(ctx context.Context, deviceID string, commandID string) {
	publish(ctx, deviceID, commandID, "delivered")
}

func acknowledged(ctx context.Context, deviceID string, commandID string) {
	publish(ctx, deviceID, commandID, "acknowledged")
}

func expired(ctx context.Context, deviceID string, commandID string) {
	publish(ctx, deviceID, commandID, "expired")
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "iot.command",
		GroupID: "fleet-audit",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			CommandID string \`json:"command_id"\`
			DeviceID  string \`json:"device_id"\`
			Outcome   string \`json:"outcome"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		_ = history.Append(ctx, event.DeviceID, event.CommandID, event.Outcome)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object CommandHistory {
  /** One row per transition of a device's command history; the fleet audit reads it. */
  def append(device: String, commandId: String, outcome: String): Unit = ()
}

object CommandEvents {
  private val log = Logger.getLogger("iothub")
  val producer = new KafkaProducer[String, String](new Properties())

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def accepted(device: String, commandId: String, fleet: String, doorCode: String): Unit = {
    log.info(s"command device=$device fleet=$fleet door_code=$doorCode")
    val event = Map("id" -> commandId, "fleet" -> fleet, "door_code" -> doorCode, "outcome" -> "accepted").toJson.compactPrint
    producer.send(new ProducerRecord("iot.command", fleet, event))
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "fleet-audit")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("iot.command"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        CommandHistory.append(event("fleet").convertTo[String], event("id").convertTo[String], event("outcome").convertTo[String])
        consumer.commitSync()
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object Outbox {
  /** One row per undelivered event; a relay republishes it when the broker recovers. */
  def insertOutbox(device: String, event: String): Unit = ()
}

object CommandHistory {
  /** One row per transition of a device's command history; the fleet audit reads it. */
  def append(device: String, commandId: String, outcome: String): Unit = ()
}

object CommandEvents {
  private val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  /** One event per transition, keyed by the device so its history keeps the order it happened. */
  def publish(device: String, commandId: String, outcome: String): Unit = {
    val event = Map("command_id" -> commandId, "device_id" -> device, "outcome" -> outcome).toJson.compactPrint
    try {
      producer.send(new ProducerRecord("iot.command", device, event))
    } catch {
      case _: org.apache.kafka.common.KafkaException => Outbox.insertOutbox(device, event)
    }
  }

  def accepted(device: String, commandId: String): Unit = publish(device, commandId, "accepted")

  def delivered(device: String, commandId: String): Unit = publish(device, commandId, "delivered")

  def acknowledged(device: String, commandId: String): Unit = publish(device, commandId, "acknowledged")

  def expired(device: String, commandId: String): Unit = publish(device, commandId, "expired")

  def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "fleet-audit")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("iot.command"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        CommandHistory.append(
          event("device_id").convertTo[String],
          event("command_id").convertTo[String],
          event("outcome").convertTo[String]
        )
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

const std::string kCommandTopic = "iot.command";

struct CommandHistory {
  /** One row per transition of a device's command history; the fleet audit reads it. */
  void append(const std::string& device, const std::string& commandId, const std::string& outcome);
};

CommandHistory history;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
void accepted(const std::string& device, const std::string& commandId, const std::string& fleet, const std::string& doorCode) {
  std::cerr << "command device=" << device << " fleet=" << fleet << " door_code=" << doorCode << "\\n";
  const json event = {{"id", commandId}, {"fleet", fleet}, {"door_code", doorCode}, {"outcome", "accepted"}};
  const auto payload = event.dump();
  producer->produce(kCommandTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), fleet.data(), fleet.size(), 0, nullptr);
  producer->flush(2000);
}

void consumeHistory(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kCommandTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const std::string text(static_cast<const char*>(msg->payload()), msg->len());
    const json event = json::parse(text);
    history.append(event["fleet"].get<std::string>(), event["id"].get<std::string>(), event["outcome"].get<std::string>());
    consumer->commitSync();
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kCommandTopic = "iot.command";

struct OutboxStore {
  /** One row per undelivered event; a relay republishes it when the broker recovers. */
  void insertOutbox(const std::string& device, const json& event);
};

OutboxStore outbox;

struct CommandHistory {
  /** One row per transition of a device's command history; the fleet audit reads it. */
  void append(const std::string& device, const std::string& commandId, const std::string& outcome);
};

CommandHistory history;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

/** One event per transition, keyed by the device so its history keeps the order it happened. */
void publish(const std::string& device, const std::string& commandId, const std::string& outcome) {
  const json event = {{"command_id", commandId}, {"device_id", device}, {"outcome", outcome}};
  const auto line = event.dump();
  const auto err = producer->produce(kCommandTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(line.data()), line.size(), device.data(), device.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox.insertOutbox(device, event);
  }
  producer->flush(2000);
}

void accepted(const std::string& device, const std::string& commandId) {
  publish(device, commandId, "accepted");
}

void delivered(const std::string& device, const std::string& commandId) {
  publish(device, commandId, "delivered");
}

void acknowledged(const std::string& device, const std::string& commandId) {
  publish(device, commandId, "acknowledged");
}

void expired(const std::string& device, const std::string& commandId) {
  publish(device, commandId, "expired");
}

void consumeHistory(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kCommandTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const std::string text(static_cast<const char*>(msg->payload()), msg->len());
    const json event = json::parse(text);
    history.append(event["device_id"].get<std::string>(), event["command_id"].get<std::string>(), event["outcome"].get<std::string>());
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The message key is an ordering contract, which is why the fix keys by device: Kafka orders
within a partition, and the audit needs one device's transitions in sequence, not one fleet's. The
event shrinks to \`command_id\`, \`device_id\` and \`outcome\` because the topic retains and
replicates whatever it is given, so a door code written there has the topic's retention.
\`enable.idempotence\` with \`acks=all\` lets the producer retry a transient broker error without a
duplicate transition, and the outbox row in the \`KafkaException\` branch is the durable path when
the broker refuses outright. One \`publish\` serving all four transitions keeps the audit from ending
at \`accepted\`. A production platform also registers the event shape in a schema registry and
compacts the topic so the last outcome per command survives retention.`,
};
