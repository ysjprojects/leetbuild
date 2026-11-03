import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Submission events keyed by form for delivery tracking',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'outbox'],
  task: `## Task

**Starting point.** The starter stores an accepted submission and produces one \`form.submission\`
event keyed by the submitter, with the raw field map as the payload, through a producer with default
settings and no outbox. It compiles, it serves the demo, and it hides 5 flaws.

**Failure mode the checks target.** A consumer sees submission 2 before submission 1 for one form;
email addresses sit in a retained, replicated topic; and a broker outage loses the event while the
submission is stored, so nothing downstream hears about it.

Requirements:

- The event key is the **form id**, so every event for one form lands on one partition and a form's
  intake stays in order.
- The event carries **field names and a value hash**, not raw values: \`field_names\` lists the
  fields; \`value_hash\` is the SHA-256 of the canonicalised values.
- The producer is configured for durable delivery (\`acks=all\`, and idempotence where the client
  supports it) so a retry does not publish the same event twice.
- When the produce is **rejected**, an **outbox row** records the topic, key and payload so a relay
  can publish it once the broker recovers.`,
  sequence: {
    participants: ['Form API', 'Kafka', 'Outbox relay'],
    messages: [
      {from: 'Form API', to: 'Kafka', label: 'produce form.submission · key=form_id', kind: 'sync'},
      {from: 'Kafka', to: 'Form API', label: 'ack · partition 3 offset 9182', kind: 'reply'},
      {from: 'Form API', to: 'Form API', label: 'payload: {field_names, value_hash} — no raw values', kind: 'sync'},
      {from: 'Form API', to: 'Kafka', label: 'produce rejected · NOT_ENOUGH_REPLICAS', kind: 'sync'},
      {from: 'Kafka', to: 'Form API', label: 'error', kind: 'reply'},
      {from: 'Form API', to: 'Outbox relay', label: 'write outbox row {topic, key, value}', kind: 'async'},
      {from: 'Outbox relay', to: 'Kafka', label: 'replay outbox row after recovery', kind: 'async'},
    ],
  },
  hints: [
    'A CRM consumer reads a form’s second submission before its first, and a grep of the topic for an `@` finds every email address ever submitted through the public form.',
    'Kafka orders within a partition only, and the starter’s key is the submitter, so one form spreads across partitions; the payload is the raw field map; a rejected produce raises and the event is gone.',
    'Produce with `key=form_id`, a payload of `field_names` plus a `sha256` `value_hash`, `acks=all` with `enable.idempotence`, and on rejection append an `outbox` row holding topic, key and payload.',
  ],
  checks: [
    {
      id: 'form-key',
      title: 'Keys the event by the form id',
      detail:
        'The produce key is the form id, so all events for one form share a partition and stay ordered. The starter keys by the submitter, so one form’s events scatter and arrive out of order.',
      match: {
        python: {all: [/"form\.submission"/, /key=form_id/], none: [/submitter/]},
        typescript: {all: [/'form\.submission'/, /key: formId/], none: [/submitter/]},
        go: {all: [/"form\.submission"/, /Key:\s*\[\]byte\(formID\)/], none: [/submitter/]},
        scala: {all: [/"form\.submission", formId/], none: [/submitter/]},
        cpp: {all: [/"form\.submission"/, /->key\(formId\)/], none: [/submitter/]},
      },
    },
    {
      id: 'value-hash',
      title: 'Carries a value hash instead of the values',
      detail:
        'The payload holds a SHA-256 `value_hash` of the canonicalised field values. The starter publishes the raw values, so a retained topic carries the submitter’s personal data.',
      match: {
        python: {all: [/value_hash/, /sha256/]},
        typescript: {all: [/valueHash/, /createHash/]},
        go: {all: [/valueHash/, /sha256/]},
        scala: {all: [/valueHash/, /SHA-256/]},
        cpp: {all: [/value_hash/, /sha256|SHA256/]},
      },
    },
    {
      id: 'no-raw-values',
      title: 'Publishes field names, never raw field values',
      detail:
        'The event names the fields it received rather than copying their values. The starter serialises the raw field map straight into the topic.',
      match: {
        python: {all: [/field_names/], none: [/raw_payload/]},
        typescript: {all: [/fieldNames/], none: [/rawPayload/]},
        go: {all: [/fieldNames/], none: [/rawPayload/]},
        scala: {all: [/fieldNames/], none: [/rawPayload/]},
        cpp: {all: [/field_names/], none: [/RawPayload/]},
      },
    },
    {
      id: 'producer-durable',
      title: 'Configures the producer for durable delivery',
      detail:
        'The producer waits for all replicas (`acks=all`) and enables idempotence where the client supports it, so a retried produce does not duplicate the event.',
      match: {
        python: {all: [/acks/, /idempotence/]},
        typescript: {all: [/acks/, /idempotent/]},
        go: {all: [/RequiredAcks/, /RequireAll/]},
        scala: {all: [/acks/, /idempotence/]},
        cpp: {all: [/acks/, /idempotence/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Writes an outbox row when the produce is rejected',
      detail:
        'A rejected produce leaves a durable outbox row so a relay can publish it later. The starter drops the event when the broker rejects it.',
      match: {
        python: {all: [/outbox/]},
        typescript: {all: [/outbox/]},
        go: {all: [/outbox/]},
        scala: {all: [/outbox/]},
        cpp: {all: [/outbox/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer
from fastapi import FastAPI

app = FastAPI()

producer = Producer({"bootstrap.servers": "kafka:9092"})

submissions = {}


def raw_payload(fields: dict) -> str:
    return json.dumps({"fields": fields})


@app.post("/v1/forms/{form_id}/submissions")
def submit(form_id: str, body: dict) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    submission_id = "sub_" + str(len(submissions) + 1)
    submissions[submission_id] = body
    submitter = body.get("submitter", "")
    producer.produce(
        topic="form.submission",
        key=submitter.encode(),
        value=raw_payload(body).encode(),
    )
    producer.poll(0)
    return {"submission_id": submission_id}
`,
      solution: `import hashlib
import json

from confluent_kafka import KafkaException, Producer
from fastapi import FastAPI

app = FastAPI()

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
    }
)

submissions = {}
outbox = {}


def canonical(fields: dict) -> str:
    return json.dumps(fields, sort_keys=True, separators=(",", ":"))


def value_hash(fields: dict) -> str:
    return hashlib.sha256(canonical(fields).encode()).hexdigest()


def event_payload(fields: dict) -> str:
    return json.dumps(
        {
            "field_names": sorted(fields.keys()),
            "value_hash": value_hash(fields),
        }
    )


@app.post("/v1/forms/{form_id}/submissions")
def submit(form_id: str, body: dict) -> dict:
    submission_id = "sub_" + str(len(submissions) + 1)
    submissions[submission_id] = body
    payload = event_payload(body)
    # The key is the form id, so every event for one form lands on one partition in intake order.
    try:
        producer.produce(topic="form.submission", key=form_id.encode(), value=payload.encode())
        producer.flush(2.0)
    except KafkaException as error:
        outbox[submission_id] = {"topic": "form.submission", "key": form_id, "value": payload}
        return {"submission_id": submission_id, "queued": True, "error": str(error)}
    return {"submission_id": submission_id}
`,
    },
    typescript: {
      starter: `/** Publishes one form.submission event per accepted submission. */
import {Kafka} from 'kafkajs';
import Fastify from 'fastify';

export const app = Fastify();

const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();
const submissions: Record<string, unknown> = {};

function rawPayload(fields: Record<string, unknown>): string {
  return JSON.stringify({fields});
}

app.post('/v1/forms/:id/submissions', async (req, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const {id} = req.params as {id: string};
  const body = req.body as {submitter?: string; fields?: Record<string, unknown>};
  const submissionId = 'sub_' + String(Object.keys(submissions).length + 1);
  submissions[submissionId] = body;
  await producer.send({
    topic: 'form.submission',
    messages: [{key: body.submitter ?? '', value: rawPayload(body.fields ?? {})}],
  });
  return reply.send({submissionId});
});
`,
      solution: `/** Publishes one form.submission event per accepted submission — keyed by form, hashed values. */
import {createHash} from 'node:crypto';
import {Kafka} from 'kafkajs';
import Fastify from 'fastify';

export const app = Fastify();

const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer({acks: -1, idempotent: true});
const submissions: Record<string, unknown> = {};
const outbox: {topic: string; key: string; value: string}[] = [];

function canonical(fields: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const name of Object.keys(fields).sort()) ordered[name] = fields[name];
  return JSON.stringify(ordered);
}

function valueHash(fields: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(fields)).digest('hex');
}

function eventPayload(fields: Record<string, unknown>): string {
  return JSON.stringify({fieldNames: Object.keys(fields).sort(), valueHash: valueHash(fields)});
}

app.post('/v1/forms/:id/submissions', async (req, reply) => {
  const {id: formId} = req.params as {id: string};
  const body = req.body as {fields?: Record<string, unknown>};
  const submissionId = 'sub_' + String(Object.keys(submissions).length + 1);
  submissions[submissionId] = body;
  const payload = eventPayload(body.fields ?? {});
  // The key is the form id, so every event for one form lands on one partition in intake order.
  try {
    await producer.send({topic: 'form.submission', acks: -1, messages: [{key: formId, value: payload}]});
  } catch (error) {
    outbox.push({topic: 'form.submission', key: formId, value: payload});
    return reply.send({submissionId, queued: true, error: (error as Error).message});
  }
  return reply.send({submissionId});
});
`,
    },
    go: {
      starter:
        `package formapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{
	Addr:     kafka.TCP("kafka:9092"),
	Topic:    "form.submission",
	Balancer: &kafka.Hash{},
}

func rawPayload(fields map[string]string) string {
	encoded, _ := json.Marshal(map[string]any{"fields": fields})
	return string(encoded)
}

func Submit(w http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	var body struct {
		Submitter string            ` +
        '`' +
        `json:"submitter"` +
        '`' +
        `
		Fields    map[string]string ` +
        '`' +
        `json:"fields"` +
        '`' +
        `
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	_ = writer.WriteMessages(r.Context(), kafka.Message{
		Key:   []byte(body.Submitter),
		Value: []byte(rawPayload(body.Fields)),
	})
	w.WriteHeader(http.StatusCreated)
}
`,
      solution:
        `package formapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"

	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "form.submission",
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type outboxRow struct {
	Topic string
	Key   string
	Value string
}

var outbox []outboxRow

func canonical(fields map[string]string) string {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	encoded, _ := json.Marshal(fields)
	_ = names
	return string(encoded)
}

func valueHash(fields map[string]string) string {
	sum := sha256.Sum256([]byte(canonical(fields)))
	return hex.EncodeToString(sum[:])
}

func eventPayload(fields map[string]string) string {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	encoded, _ := json.Marshal(map[string]any{"fieldNames": names, "valueHash": valueHash(fields)})
	return string(encoded)
}

func Submit(w http.ResponseWriter, r *http.Request) {
	formID := r.PathValue("id")
	var body struct {
		Fields map[string]string ` +
        '`' +
        `json:"fields"` +
        '`' +
        `
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	payload := eventPayload(body.Fields)
	// The key is the form id, so every event for one form lands on one partition in intake order.
	err := writer.WriteMessages(r.Context(), kafka.Message{
		Key:   []byte(formID),
		Value: []byte(payload),
	})
	if err != nil {
		outbox = append(outbox, outboxRow{Topic: "form.submission", Key: formID, Value: payload})
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.WriteHeader(http.StatusCreated)
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.server.Directives._

import java.util.Properties
import scala.jdk.CollectionConverters._

object Events {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")

  val producer = new KafkaProducer[String, String](props)

  def rawPayload(fields: Map[String, String]): String =
    fields.map { case (k, v) => s""""$k":"$v"""" }.mkString("{", ",", "}")

  val routes: Route = path("v1" / "forms" / Segment / "submissions") { _ =>
    post {
      entity(as[String]) { _ =>
        // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
        val submitter = "anonymous"
        producer.send(new ProducerRecord[String, String]("form.submission", submitter, rawPayload(Map.empty)))
        complete("created")
      }
    }
  }
}
`,
      solution: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.server.Directives._

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Properties
import scala.jdk.CollectionConverters._

object Events {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")

  val producer = new KafkaProducer[String, String](props)

  var outbox: Vector[(String, String, String)] = Vector.empty

  def canonical(fields: Map[String, String]): String =
    fields.toSeq.sortBy(_._1).map { case (k, v) => s""""$k":"$v"""" }.mkString("{", ",", "}")

  def valueHash(fields: Map[String, String]): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(canonical(fields).getBytes(StandardCharsets.UTF_8))
      .map(b => f"$b%02x")
      .mkString

  def eventPayload(fields: Map[String, String]): String = {
    val names = fields.keys.toSeq.sorted.map(name => s""""$name"""").mkString("[", ",", "]")
    s"""{"fieldNames":$names,"valueHash":"\${valueHash(fields)}"}"""
  }

  val routes: Route = path("v1" / "forms" / Segment / "submissions") { formId =>
    post {
      entity(as[String]) { _ =>
        val payload = eventPayload(Map.empty)
        // The key is the form id, so every event for one form lands on one partition in intake order.
        try {
          producer.send(new ProducerRecord[String, String]("form.submission", formId, payload)).get()
          complete("created")
        } catch {
          case _: Exception =>
            outbox = outbox :+ (("form.submission", formId, payload))
            complete("queued")
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <string>

std::string RawPayload(const std::map<std::string, std::string>& fields) {
  std::string payload = "{\\"fields\\":{";
  bool first = true;
  for (const auto& [name, value] : fields) {
    if (!first) payload += ",";
    payload += "\\"" + name + "\\":\\"" + value + "\\"";
    first = false;
  }
  return payload + "}}";
}

void RegisterRoutes(httplib::Server& svr, RdKafka::Producer& producer) {
  svr.Post("/v1/forms/([^/]+)/submissions", [&](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    const std::string submitter = "anonymous";
    const std::string payload = RawPayload({{"name", "ada"}});
    RdKafka::Producer::MessageBuilder builder;
    builder.topic("form.submission")->key(submitter)->payload(payload);
    producer.produce(builder, nullptr);
    res.status = 201;
  });
}
`,
      solution: `#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <openssl/sha.h>

#include <map>
#include <string>
#include <vector>

struct OutboxRow {
  std::string topic;
  std::string key;
  std::string value;
};

static std::vector<OutboxRow> outbox;

// Wait for every in-sync replica and let the client de-duplicate retries.
static const std::map<std::string, std::string> kProducerConfig = {
    {"bootstrap.servers", "kafka:9092"},
    {"acks", "all"},
    {"enable.idempotence", "true"},
};

static std::string Canonical(const std::map<std::string, std::string>& fields) {
  std::string out = "{";
  bool first = true;
  for (const auto& [name, value] : fields) {
    if (!first) out += ",";
    out += "\\"" + name + "\\":\\"" + value + "\\"";
    first = false;
  }
  return out + "}";
}

static std::string Sha256Hex(const std::string& value) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(value.data()), value.size(), digest);
  static const char* digits = "0123456789abcdef";
  std::string hex;
  hex.reserve(SHA256_DIGEST_LENGTH * 2);
  for (const unsigned char byte : digest) {
    hex += digits[byte >> 4];
    hex += digits[byte & 0x0f];
  }
  return hex;
}

static std::string EventPayload(const std::map<std::string, std::string>& fields) {
  std::string names = "[";
  bool first = true;
  for (const auto& [name, _] : fields) {
    if (!first) names += ",";
    names += "\\"" + name + "\\"";
    first = false;
  }
  names += "]";
  return "{\\"field_names\\":" + names + ",\\"value_hash\\":\\"" + Sha256Hex(Canonical(fields)) + "\\"}";
}

void RegisterRoutes(httplib::Server& svr, RdKafka::Producer& producer) {
  svr.Post("/v1/forms/([^/]+)/submissions", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string formId = req.matches[1];
    const std::string payload = EventPayload({{"name", "ada"}});
    RdKafka::Producer::MessageBuilder builder;
    // The key is the form id, so every event for one form lands on one partition in intake order.
    builder.topic("form.submission")->key(formId)->payload(payload);
    const RdKafka::ErrorCode error = producer.produce(builder, nullptr);
    if (error != RdKafka::ERR_NO_ERROR) {
      outbox.emplace_back("form.submission", formId, payload);
      res.status = 202;
      return;
    }
    res.status = 201;
  });
}
`,
    },
  },
  debrief: `Kafka orders per partition, and a topic keeps data for a long time; both facts shape the fix. Key by the form id and every event for that form lands on one partition in intake order, while a submitter key lets a consumer see submission 2 before submission 1. The payload is a privacy decision: a retained topic is replicated and read by every consumer, so field names and a value hash prove what was submitted without copying an email address into the log. A rejected produce goes into an outbox row written with the submission, and a relay publishes it later. What this step did not do: a schema registry enforcing the event shape, and a relay with backoff and a dead-letter topic.`,
};
