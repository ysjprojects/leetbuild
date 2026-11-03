import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Usage events for billing, keyed by tenant',
  concept: 'kafka',
  file: 'events',
  focus: ['meter', 'kafka', 'consumer', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/usage/events\`, which hands a metered request to
billing: it reads \`X-Tenant-Id\` and \`Idempotency-Key\`, logs the completion text, builds an event
with id, model, \`output_text\` and \`cost_micros\`, produces it to \`billing.usage\` keyed by model
from a default producer, flushes and answers accepted. The ledger writes one charge per event. It
compiles, serves the demo and hides five flaws.

**Failure mode the checks target.** One tenant's charges are spread across partitions in whatever
order the broker chose. A producer retry becomes a second charge, because the ledger has no key to
dedupe on and the producer is not idempotent. Tenant text sits in a retained, replicated topic and
in the logs. During a broker outage the handler still reports success, and the spend it accepted
appears on no invoice.

- Publish one \`billing.usage\` event per report with the **tenant id as the message key**.
- The event carries the \`idempotency_key\` it was metered under, alongside \`usage_id\`,
  \`tenant_id\`, \`model\`, \`input_tokens\`, \`output_tokens\` and \`cost_micros\`.
- No prompt or completion text in the event or the logs.
- The producer is idempotent with \`acks=all\` (\`enable.idempotence\` plus \`acks\`;
  \`idempotent: true\` with \`acks: -1\` in KafkaJS; required acks \`all\` with the hash balancer in
  Go).
- When the broker rejects the produce, write the event to the outbox (\`insert_outbox\`) instead of
  dropping it; a relay republishes outbox rows when the broker recovers.`,
  sequence: {
    participants: ['Cost Meter', 'billing.usage', 'Billing ledger', 'outbox'],
    messages: [
      {from: 'Cost Meter', to: 'billing.usage', label: 'produce · key = tenant · acks = all', kind: 'sync'},
      {from: 'billing.usage', to: 'Cost Meter', label: 'ack / broker error', kind: 'reply'},
      {from: 'Cost Meter', to: 'outbox', label: 'insertOutbox(tenant, event) on rejection', kind: 'async'},
      {from: 'billing.usage', to: 'Billing ledger', label: 'consume · group billing-ledger', kind: 'async'},
      {from: 'Billing ledger', to: 'Billing ledger', label: 'dedupe on idempotency_key → one charge', kind: 'sync'},
      {from: 'outbox', to: 'billing.usage', label: 'relay republishes after the outage', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant so one ledger stays ordered',
      detail:
        'The message key is the tenant id, so a tenant’s events share a partition and arrive in order. The starter keys by model, which scatters a tenant’s charges across partitions and gives up the ordering the ledger reconciles against.',
      match: {
        python: {all: [/billing\.usage/, /key=tenant/]},
        typescript: {all: [/billing\.usage/, /key:\s*tenant/]},
        go: {all: [/billing\.usage/, /Key:\s*\[\]byte\(tenant\)/]},
        scala: {all: [/billing\.usage/, /"billing\.usage",\s*tenant/]},
        cpp: {all: [/billing\.usage/, /tenant\.c_str\(\)/]},
      },
    },
    {
      id: 'idempotency-embedded',
      title: 'Embeds the Idempotency-Key in the event',
      detail:
        'The payload carries the `Idempotency-Key` the usage was metered under, so downstream billing dedupes a retried produce into one charge. The starter takes the header and drops it, so a retry bills the same tokens twice.',
      match: {
        python: {all: [/billing\.usage/, /idempotency_key/]},
        typescript: {all: [/billing\.usage/, /idempotency_key/]},
        go: {all: [/billing\.usage/, /idempotency_key/]},
        scala: {all: [/billing\.usage/, /idempotency_key/]},
        cpp: {all: [/billing\.usage/, /idempotency_key/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true` + `acks: -1`, or required acks `all` with the hash balancer. A default producer may duplicate a retried produce, and the ledger has nothing to dedupe it with.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A rejected produce inserts an outbox row for a relay to republish instead of dropping the event. The starter ignores the produce result — and the broker error with it — so the charge is simply gone.',
      match: {
        python: {all: [/insert_outbox\(/, /except KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\{/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /RD_KAFKA_RESP_ERR_NO_ERROR/]},
      },
    },
    {
      id: 'no-content',
      title: 'No prompt or completion text in the event or the logs',
      detail:
        'The event carries ids, counts and cost — never the completion or prompt text, and never a log line with it either. The starter logs and publishes `output_text`, putting tenant content into a topic that is retained and replicated.',
      match: {
        python: {all: [/billing\.usage/], none: [/output_text|OutputText/]},
        typescript: {all: [/billing\.usage/], none: [/output_text|OutputText/]},
        go: {all: [/billing\.usage/], none: [/output_text|OutputText/]},
        scala: {all: [/billing\.usage/], none: [/output_text|OutputText/]},
        cpp: {all: [/billing\.usage/], none: [/output_text|OutputText/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("meter")

producer = Producer({"bootstrap.servers": "kafka:9092"})


class UsageEvent(BaseModel):
    usage_id: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_micros: int
    output_text: str


class OutboxStore:
    def insert_outbox(self, tenant: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/usage/events")
def publish_usage(
    body: UsageEvent,
    tenant: str = Header(alias="X-Tenant-Id"),
    idem_key: str = Header(alias="Idempotency-Key"),
) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    logger.info("usage topic tenant=%s output=%r", tenant, body.output_text)
    event = {
        "id": body.usage_id,
        "model": body.model,
        "output_text": body.output_text,
        "cost_micros": body.cost_micros,
    }
    producer.produce("billing.usage", key=body.model, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}
`,
      solution: `import json

from confluent_kafka import KafkaException, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class UsageEvent(BaseModel):
    usage_id: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_micros: int


class OutboxStore:
    def insert_outbox(self, tenant: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/usage/events")
def publish_usage(
    body: UsageEvent,
    tenant: str = Header(alias="X-Tenant-Id"),
    idem_key: str = Header(alias="Idempotency-Key"),
) -> dict:
    event = {
        "id": body.usage_id,
        "tenant_id": tenant,
        "idempotency_key": idem_key,
        "model": body.model,
        "input_tokens": body.input_tokens,
        "output_tokens": body.output_tokens,
        "cost_micros": body.cost_micros,
    }
    try:
        producer.produce("billing.usage", key=tenant, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(tenant, event)
    return {"accepted": True}
`,
    },
    typescript: {
      starter: `/** publish_usage. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'cost-meter', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface UsageEvent {
  usage_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  output_text: string;
}

app.post('/v1/usage/events', async (request, reply) => {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const body = request.body as UsageEvent;
  const tenant = request.headers['x-tenant-id'] as string;
  request.log.info({tenant, output: body.output_text}, 'usage metered');
  const event = {
    id: body.usage_id,
    model: body.model,
    output_text: body.output_text,
    cost_micros: body.cost_micros,
  };
  await producer.send({topic: 'billing.usage', messages: [{key: body.model, value: JSON.stringify(event)}]});
  return reply.code(202).send({accepted: true});
});
`,
      solution: `/** publish_usage: tenant-keyed events, idempotent produces, an outbox behind failures. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'cost-meter', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, acks: -1});
void producer.connect();

interface UsageEvent {
  usage_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
}

app.post('/v1/usage/events', async (request, reply) => {
  const body = request.body as UsageEvent;
  const tenant = request.headers['x-tenant-id'] as string;
  const idemKey = request.headers['idempotency-key'] as string;
  const event = {
    id: body.usage_id,
    tenant_id: tenant,
    idempotency_key: idemKey,
    model: body.model,
    input_tokens: body.input_tokens,
    output_tokens: body.output_tokens,
    cost_micros: body.cost_micros,
  };
  try {
    await producer.send({topic: 'billing.usage', messages: [{key: tenant, value: JSON.stringify(event)}]});
  } catch {
    await store.insertOutbox(tenant, event);
  }
  return reply.code(202).send({accepted: true});
});
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

type UsageEvent struct {
	UsageID      string \`json:"usage_id"\`
	Model        string \`json:"model"\`
	InputTokens  int    \`json:"input_tokens"\`
	OutputTokens int    \`json:"output_tokens"\`
	CostMicros   int64  \`json:"cost_micros"\`
	OutputText   string \`json:"output_text"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, tenant string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "billing.usage"}

func publishUsage(ctx context.Context, tenant string, idemKey string, body UsageEvent) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	log.Printf("usage topic tenant=%s output=%q", tenant, body.OutputText)
	payload, _ := json.Marshal(map[string]any{
		"id":          body.UsageID,
		"model":       body.Model,
		"cost_micros": body.CostMicros,
		"output_text": body.OutputText,
	})
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(body.Model), Value: payload})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

type UsageEvent struct {
	UsageID      string \`json:"usage_id"\`
	Model        string \`json:"model"\`
	InputTokens  int    \`json:"input_tokens"\`
	OutputTokens int    \`json:"output_tokens"\`
	CostMicros   int64  \`json:"cost_micros"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, tenant string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "billing.usage",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

func publishUsage(ctx context.Context, tenant string, idemKey string, body UsageEvent) error {
	event := map[string]any{
		"id":              body.UsageID,
		"tenant_id":       tenant,
		"idempotency_key": idemKey,
		"model":           body.Model,
		"input_tokens":    body.InputTokens,
		"output_tokens":   body.OutputTokens,
		"cost_micros":     body.CostMicros,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: payload}); err != nil {
		if err := store.InsertOutbox(ctx, tenant, event); err != nil {
			return err
		}
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import spray.json._

final case class UsageEvent(
    usage_id: String,
    model: String,
    input_tokens: Int,
    output_tokens: Int,
    cost_micros: Long,
    output_text: String
)

object UsageEvents {
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  val store = OutboxStore.open()

  def publishUsage(tenant: String, idemKey: String, body: UsageEvent): Unit = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    println(s"usage topic tenant=$tenant output=\${body.output_text}")
    val event = s"""{"id":"\${body.usage_id}","model":"\${body.model}","cost_micros":\${body.cost_micros},"output_text":"\${body.output_text}"}"""
    producer.send(new ProducerRecord[String, String]("billing.usage", body.model, event))
    producer.flush()
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class UsageEvent(
    usage_id: String,
    model: String,
    input_tokens: Int,
    output_tokens: Int,
    cost_micros: Long
)

object UsageEvents {
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  val store = OutboxStore.open()

  def publishUsage(tenant: String, idemKey: String, body: UsageEvent): Unit = {
    val event =
      s"""{"id":"\${body.usage_id}","tenant_id":"$tenant","idempotency_key":"$idemKey","model":"\${body.model}","input_tokens":\${body.input_tokens},"output_tokens":\${body.output_tokens},"cost_micros":\${body.cost_micros}}"""
    try {
      producer.send(new ProducerRecord[String, String]("billing.usage", tenant, event)).get(2, TimeUnit.SECONDS)
    } catch {
      case _: Exception =>
        store.insertOutbox(tenant, event)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <string>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

std::string uuidString();

struct UsageEvent {
  std::string usage_id;
  std::string model;
  int input_tokens = 0;
  int output_tokens = 0;
  long long cost_micros = 0;
  std::string output_text;
};

struct OutboxStore {
  void insertOutbox(const std::string& tenant, const json& event);
};

OutboxStore store;

void publishUsage(const std::string& tenant, const std::string& idemKey, const UsageEvent& body) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  std::cerr << "usage topic tenant=" << tenant << " output=" << body.output_text << "\\n";
  const json event = {
      {"id", body.usage_id},
      {"model", body.model},
      {"cost_micros", body.cost_micros},
      {"output_text", body.output_text},
  };
  rd_kafka_producev(producer, RD_KAFKA_V_TOPIC("billing.usage"),
                    RD_KAFKA_V_KEY(body.model.c_str(), body.model.size()),
                    RD_KAFKA_V_VALUE(event.dump().c_str(), event.dump().size()), RD_KAFKA_V_END);
  rd_kafka_flush(producer, 2000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <string>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

struct UsageEvent {
  std::string usage_id;
  std::string model;
  int input_tokens = 0;
  int output_tokens = 0;
  long long cost_micros = 0;
};

struct OutboxStore {
  void insertOutbox(const std::string& tenant, const json& event);
};

OutboxStore store;

// The producer is idempotent and waits for the full ISR before it reports success: a retried
// produce must not duplicate a charge, and a broker that has not replicated the event must not ack.
rd_kafka_conf_t* conf = rd_kafka_conf_new();
rd_kafka_topic_conf_t* topic_conf = rd_kafka_topic_conf_new();
void configureProducer() {
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", nullptr, 0);
  rd_kafka_conf_set(conf, "enable.idempotence", "true", nullptr, 0);
  rd_kafka_topic_conf_set(topic_conf, "acks", "all", nullptr, 0);
}

void publishUsage(const std::string& tenant, const std::string& idemKey, const UsageEvent& body) {
  const json event = {
      {"id", body.usage_id},
      {"tenant_id", tenant},
      {"idempotency_key", idemKey},
      {"model", body.model},
      {"input_tokens", body.input_tokens},
      {"output_tokens", body.output_tokens},
      {"cost_micros", body.cost_micros},
  };
  const auto payload = event.dump();
  const auto err = rd_kafka_producev(producer, RD_KAFKA_V_TOPIC("billing.usage"),
                                     RD_KAFKA_V_KEY(tenant.c_str(), tenant.size()),
                                     RD_KAFKA_V_VALUE(payload.c_str(), payload.size()), RD_KAFKA_V_END);
  if (err != RD_KAFKA_RESP_ERR_NO_ERROR) {
    store.insertOutbox(tenant, event);
    return;
  }
  rd_kafka_flush(producer, 2000);
}
`,
    },
  },
  hints: [
    'Reconciliation finds a tenant charged twice for one request after a broker hiccup, and an hour of spend from the outage window missing from every invoice.',
    'A default producer retries without idempotence and the event has no `idempotency_key`, so the ledger cannot collapse the duplicate; the produce result is ignored, so a rejection is silently a success.',
    'Configure `enable.idempotence` with `acks=all`, produce with `key=tenant` and `idempotency_key` in the payload, drop `output_text` from the event and the log, and call `insert_outbox` on `KafkaException`.',
  ],
  debrief: `Each part of the fix answers one question about the billing path. The key decides ordering, and therefore what the ledger can reconcile per tenant. The embedded idempotency key decides whether a retry is one charge or two, and the producer configuration decides whether the broker can see duplicates at all. The outbox decides whether an outage costs latency or revenue. The content rule outlives this course: a usage event needs ids, counts and cost, and completion text on a retained, replicated topic is a data-protection incident waiting to happen. Production meters register the event schema so a future producer cannot smuggle a text field in, and run the outbox relay with the same tenant key so a replayed row lands in the same partition.`,
};
