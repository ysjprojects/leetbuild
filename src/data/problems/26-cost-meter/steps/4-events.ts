import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Usage events for billing, keyed by tenant',
  concept: 'kafka',
  file: 'events',
  focus: ['meter', 'kafka', 'consumer', 'db'],
  task: `## Task

The starter is a plausible model-generated draft: it publishes the usage and the consumer moves the
ledger, so finance sees rows appear. Four production contracts are broken. Find them, fix them, and
prove the fix.

\`publish_usage\` is how the meter hands a metered request to billing; the ledger consumes
\`billing.usage\` and writes one charge per event.

- Publish exactly one \`billing.usage\` event per report with the **tenant id as the message key**.
  Partitioning by tenant is what keeps one tenant's ledger ordered and lets a downstream consumer
  replay a tenant's events without interleaving another's. The draft keys by **model**, so one
  tenant's charges are spread across partitions and their order is whatever the broker chose.
- The event **carries the \`Idempotency-Key\`** it was metered under, alongside \`usage_id\`,
  \`tenant_id\`, \`model\`, \`input_tokens\`, \`output_tokens\` and \`cost_micros\`. Downstream billing
  dedupes on that key: without it, a producer retry — which an idempotent producer is allowed to
  make — becomes a second charge for the same tokens.
- **Never** put the prompt or the completion text in the event, and never log it. The topic is
  retained and replicated; text written there outlives the request, the tenant and the retention
  policy. Counts and ids are all billing needs.
- The producer must be **idempotent with \`acks=all\`** — \`enable.idempotence\` plus \`acks\` in the
  Python/Java/C++ clients, \`idempotent: true\` with \`acks: -1\` in KafkaJS, required acks \`all\`
  with the hash balancer in Go.
- When the broker rejects the produce, write the event to the **outbox** instead of dropping it or
  failing the request: a relay republishes outbox rows when the broker recovers, so an outage costs
  latency, not revenue. The draft ignores the produce result and reports success either way.

**Failure mode the checks target.** Keying by model scatters one tenant's ledger for no reason;
omitting the idempotency key makes every produce retry a potential double charge; the completion
text is a data leak with a long tail; and silently dropping a rejected produce means the meter
reports spend that no invoice will ever contain — the failure is invisible until the reconciliation
runs, weeks later.`,
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
        'The message key is the tenant id, so a tenant’s events share a partition and arrive in order. The draft keys by model, which scatters a tenant’s charges across partitions and gives up the ordering the ledger reconciles against.',
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
        'The payload carries the `Idempotency-Key` the usage was metered under, so downstream billing dedupes a retried produce into one charge. The draft takes the header and drops it, so a retry bills the same tokens twice.',
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
        'A rejected produce inserts an outbox row for a relay to republish instead of dropping the event. The draft ignores the produce result — and the broker error with it — so the charge is simply gone.',
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
        'The event carries ids, counts and cost — never the completion or prompt text, and never a log line with it either. The draft logs and publishes `output_text`, putting tenant content into a topic that is retained and replicated.',
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
    # TODO: key the event by the tenant instead of the model, embed the Idempotency-Key so
    # downstream billing can dedupe, configure the idempotent producer with acks=all, keep the
    # completion text out of the event and the logs, and write an outbox row when the broker
    # rejects the produce.
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
      starter: `/** publish_usage: a model-generated draft that keys by model and drops failures. */
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
  // TODO: key the event by the tenant instead of the model, embed the Idempotency-Key so
  // downstream billing can dedupe, configure the idempotent producer with acks=all, keep the
  // completion text out of the event and the logs, and write an outbox row when the broker
  // rejects the produce.
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
	// TODO: key the event by the tenant instead of the model, embed the Idempotency-Key so
	// downstream billing can dedupe, configure the idempotent producer with acks=all, keep the
	// completion text out of the event and the logs, and write an outbox row when the broker
	// rejects the produce.
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
    // TODO: key the event by the tenant instead of the model, embed the Idempotency-Key so
    // downstream billing can dedupe, configure the idempotent producer with acks=all, keep the
    // completion text out of the event and the logs, and write an outbox row when the broker
    // rejects the produce.
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
  // TODO: key the event by the tenant instead of the model, embed the Idempotency-Key so
  // downstream billing can dedupe, configure the idempotent producer with acks=all, keep the
  // completion text out of the event and the logs, and write an outbox row when the broker
  // rejects the produce.
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
    'The message key is the partition key, so it belongs to the ledger that has to stay ordered: the tenant. `key=tenant`, `key: tenant`, `Key: []byte(tenant)`, `ProducerRecord("billing.usage", tenant, …)`. A model key means two tenants that share a model also share a partition.',
    'Idempotence is configuration, and it holds per key: `enable.idempotence` + `acks=all`, KafkaJS’s `idempotent: true` + `acks: -1`, required acks `all` with the hash balancer. Combine it with the embedded `idempotency_key` and a producer retry becomes one charge downstream.',
    'Wrap the produce: on rejection write the event to the outbox (same tenant key), and let the request succeed. A dropped produce is revenue that never appears on an invoice, and nothing in the happy path will tell you.',
  ],
  debrief: `The interviewer is testing whether you can hand work to the billing path without losing or duplicating it. Four contracts are in play: the key decides ordering and therefore what the ledger can reconcile; the embedded idempotency key decides whether a retry is one charge or two; the producer configuration decides whether duplicates can exist at all; and the outbox decides whether a broker outage is latency or missing revenue. The content rule is the one that outlives the course: a usage event needs ids, counts and cost — the completion text on a retained, replicated topic is a data-protection incident waiting for a subpoena. Real meters add a schema registry so a future producer cannot smuggle a field in, a partition count chosen for the tenant distribution, and a relay that drains outbox rows with the same idempotency key.`,
};
