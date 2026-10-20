import type {Step} from '@/lib/types';

export const feedbackEventsStep: Step = {
  id: 'feedback-events',
  title: 'route.feedback: tenant key, outbox, counters before commit',
  concept: 'kafka',
  file: 'feedback',
  focus: ['router', 'kafka', 'consumer', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: it produces an event on the happy path and the
consumer updates counters, so the demo shows numbers moving. Three production contracts are broken.
Find them, fix them, and prove the fix.

\`POST /v1/feedback\` is how the router reports the outcome of a routed request, and the consumer
turns those events into per-tenant quality counters.

- Publish **exactly one** \`route.feedback\` event per request with the **tenant** as the message
  key — partition by tenant keeps each tenant's events ordered. The event **id is the request id**;
  the payload carries ids, model, outcome and latency.
- **Never** put the prompt or message text in the event, and never log it: the topic is retained
  for days and replicated, so tenant content written there outlives every retention policy the
  request pipeline has.
- The producer must be **idempotent with \`acks=all\`** (or the stack's equivalent: required acks
  \`all\` plus hashed, stable keys), so a retry of a produce cannot duplicate a record.
- When the broker rejects the produce, write the event to the **outbox** instead of dropping it or
  failing the caller; a relay republishes outbox rows when the broker recovers.
- The consumer updates the Redis counters (\`HINCRBY quality:{tenant}:{model}\`) and **only then**
  commits the offset. Commit first and one crash loses the counter update forever, because the
  offset already moved past the unprocessed record.

**Failure mode the checks target.** Keying by request id scatters one tenant's events across
partitions; an unconfigured producer can duplicate on retry; the retained prompt is a data leak
with a long tail; a failed produce silently loses the event; and commit-before-process trades
correctness for exactly-once *looking* code.`,
  sequence: {
    participants: ['Model Router', 'route.feedback', 'Feedback consumer', 'Redis'],
    messages: [
      {from: 'Model Router', to: 'route.feedback', label: 'produce · key = tenant · acks = all', kind: 'sync'},
      {from: 'route.feedback', to: 'Model Router', label: 'ack / broker error', kind: 'reply'},
      {from: 'Model Router', to: 'Model Router', label: 'insertOutbox(tenant, event) on failure', kind: 'sync'},
      {from: 'route.feedback', to: 'Feedback consumer', label: 'consume · group quality', kind: 'async'},
      {from: 'Feedback consumer', to: 'Redis', label: 'HINCRBY quality:{tenant}:{model}', kind: 'sync'},
      {from: 'Redis', to: 'Feedback consumer', label: 'new counter value', kind: 'reply'},
      {from: 'Feedback consumer', to: 'route.feedback', label: 'commit offset after processing', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=tenant` (or `Key: []byte(tenant)`, `key: tenant`, `ProducerRecord(topic, tenant, …)`). Keyed by the request id, one tenant’s events land in different partitions and their order is no longer guaranteed.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true`, or required acks `all` with hashed routing. It needs the same message key on every retry, which is the same fix as the tenant key.',
    'The outbox is the durability half: wrap the produce and, when the broker rejects it, insert the event into the outbox row. In the consumer, do `HINCRBY` first and `commit` second — a crash between the two then replays the record instead of losing it.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant, id is the request id',
      detail:
        'The message key is the tenant (partition by tenant), and the event carries the request id as its id. The draft keys by the request id, so one tenant’s events scatter across partitions and lose order.',
      match: {
        python: {all: [/key=tenant/, /request_id/]},
        typescript: {all: [/key:\s*tenant\b/, /request_id|requestId/]},
        go: {all: [/Key:\s*\[\]byte\(tenant\)/, /RequestID/]},
        scala: {all: [/ProducerRecord\("route.feedback",\s*tenant/, /requestId/]},
        cpp: {all: [/produce\([^;\n]*tenant/, /requestId/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. A retry of a produce must not duplicate the record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-text',
      title: 'No prompt or message text in the event or logs',
      detail:
        'Neither the event payload nor any log line carries the prompt or message text. The draft logs the prompt and copies it into the event — a leak that is retained and replicated with the topic.',
      match: {
        python: {none: [/\bprompt\b/i]},
        typescript: {none: [/\bprompt\b/i]},
        go: {none: [/\bprompt\b/i]},
        scala: {none: [/\bprompt\b/i]},
        cpp: {none: [/\bprompt\b/i]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insertOutbox`/`InsertOutbox`) inside the error branch instead of dropping the event. The draft ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Updates counters before committing the offset',
      detail:
        'The consumer runs `HINCRBY` on the quality counters before committing the offset; committing first makes a crash lose the counter update forever. The draft commits first.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/\.hincrBy\(/, /commitSync\(/]},
        cpp: {order: [/\.hincrby\(|->hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("feedback")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class FeedbackRequest(BaseModel):
    request_id: str
    prompt: str
    model: str
    outcome: str


class OutboxStore:
    def insert_outbox(self, tenant: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/feedback")
def feedback(body: FeedbackRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: key by tenant instead of the request id, configure the idempotent producer with
    # acks=all, keep the prompt and message text out of the event and the logs, and write an
    # outbox row when the broker rejects the produce.
    logger.info("feedback tenant=%s prompt=%r", tenant, body.prompt)
    event = {"id": body.request_id, "tenant": tenant, "prompt": body.prompt}
    producer.produce("route.feedback", key=body.request_id, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "quality"})
    consumer.subscribe(["route.feedback"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        r.hincrby(f"quality:{event['tenant']}", event["outcome"], 1)
`,
      solution: `import json

import redis
from confluent_kafka import Consumer, KafkaException, Producer
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
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class FeedbackRequest(BaseModel):
    request_id: str
    model: str
    outcome: str
    latency_ms: int = 0


class OutboxStore:
    def insert_outbox(self, tenant: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/feedback")
def feedback(body: FeedbackRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    event = {
        "id": body.request_id,
        "tenant": tenant,
        "model": body.model,
        "outcome": body.outcome,
        "latency_ms": body.latency_ms,
    }
    try:
        producer.produce("route.feedback", key=tenant, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(tenant, event)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "quality", "enable.auto.commit": False}
    )
    consumer.subscribe(["route.feedback"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        counter = f"quality:{event['tenant']}:{event['model']}"
        r.hincrby(counter, event["outcome"], 1)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** route.feedback: a model-generated draft that keys by request id and commits too early. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'model-router', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

interface FeedbackBody {
  request_id: string;
  prompt: string;
  model: string;
  outcome: string;
}

app.post('/v1/feedback', async (request, reply) => {
  // TODO: key by tenant instead of the request id, configure the idempotent producer with
  // acks=all, keep the prompt and message text out of the event and the logs, and write an
  // outbox row when the broker rejects the produce.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as FeedbackBody;
  request.log.info({tenant, prompt: body.prompt}, 'feedback');
  const event = {id: body.request_id, tenant, prompt: body.prompt};
  await producer.send({
    topic: 'route.feedback',
    messages: [{key: body.request_id, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'quality'});
  await consumer.connect();
  await consumer.subscribe({topic: 'route.feedback'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {tenant: string; outcome: string};
      await r.hincrby(\`quality:\${event.tenant}\`, event.outcome, 1);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** route.feedback: one idempotent, tenant-keyed event per request; counters before the commit. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'model-router', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

interface FeedbackBody {
  request_id: string;
  model: string;
  outcome: string;
  latency_ms?: number;
}

app.post('/v1/feedback', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as FeedbackBody;
  const event = {
    id: body.request_id,
    tenant,
    model: body.model,
    outcome: body.outcome,
    latency_ms: body.latency_ms ?? 0,
  };
  try {
    await producer.send({
      topic: 'route.feedback',
      acks: -1,
      messages: [{key: tenant, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(tenant, event);
  }
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'quality'});
  await consumer.connect();
  await consumer.subscribe({topic: 'route.feedback'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        tenant: string;
        model: string;
        outcome: string;
      };
      await r.hincrby(\`quality:\${event.tenant}:\${event.model}\`, event.outcome, 1);
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var (
	feedbackWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "route.feedback"}
	rdb            *redis.Client
)

type FeedbackRequest struct {
	RequestID string \`json:"request_id"\`
	Prompt    string \`json:"prompt"\`
	Model     string \`json:"model"\`
	Outcome   string \`json:"outcome"\`
}

func feedback(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	body := FeedbackRequest{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: key by tenant instead of the request id, configure acks=all / idempotence, keep the
	// prompt and message text out of the event and the logs, and write an outbox row when the
	// broker rejects the produce.
	log.Printf("feedback tenant=%s prompt=%q", tenant, body.Prompt)
	event := map[string]any{"id": body.RequestID, "tenant": tenant, "prompt": body.Prompt}
	payload, _ := json.Marshal(event)
	_ = feedbackWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.RequestID), Value: payload})
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "route.feedback",
		GroupID: "quality",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event struct {
			Tenant  string \`json:"tenant"\`
			Outcome string \`json:"outcome"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.HIncrBy(ctx, "quality:"+event.Tenant, event.Outcome, 1)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var feedbackWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "route.feedback",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var rdb *redis.Client

type FeedbackRequest struct {
	RequestID string \`json:"request_id"\`
	Model     string \`json:"model"\`
	Outcome   string \`json:"outcome"\`
	LatencyMS int    \`json:"latency_ms"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, tenant string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

func feedback(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	body := FeedbackRequest{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	event := map[string]any{
		"id":         body.RequestID,
		"tenant":     tenant,
		"model":      body.Model,
		"outcome":    body.Outcome,
		"latency_ms": body.LatencyMS,
	}
	payload, _ := json.Marshal(event)
	if err := feedbackWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(tenant), Value: payload}); err != nil {
		_ = store.InsertOutbox(r.Context(), tenant, event)
	}
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "route.feedback",
		GroupID: "quality",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			Tenant  string \`json:"tenant"\`
			Model   string \`json:"model"\`
			Outcome string \`json:"outcome"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.HIncrBy(ctx, "quality:"+event.Tenant+":"+event.Model, event.Outcome, 1)
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
import redis.clients.jedis.Jedis
import spray.json._

object FeedbackApi {
  private val log = Logger.getLogger("feedback")
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: key by tenant instead of the request id, configure the idempotent producer with
  // acks=all, keep the prompt and message text out of the event and the logs, and write an outbox
  // row when the broker rejects the produce.
  def publish(tenant: String, requestId: String, prompt: String, model: String, outcome: String): Unit = {
    log.info(s"feedback tenant=$tenant prompt=$prompt")
    val payload = Map("id" -> requestId, "tenant" -> tenant, "prompt" -> prompt).toJson.compactPrint
    producer.send(new ProducerRecord("route.feedback", requestId, payload))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of("route.feedback"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        jedis.hincrBy(s"quality:\${event("tenant").convertTo[String]}", event("outcome").convertTo[String], 1L)
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object FeedbackApi {
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def publish(tenant: String, requestId: String, model: String, outcome: String): Unit = {
    val event = Map("id" -> requestId, "tenant" -> tenant, "model" -> model, "outcome" -> outcome)
    val payload = event.toJson.compactPrint
    try {
      producer.send(new ProducerRecord("route.feedback", tenant, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        FeedbackStore.insertOutbox(tenant, payload)
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "quality")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("route.feedback"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val counter =
          s"quality:\${event("tenant").convertTo[String]}:\${event("model").convertTo[String]}"
        jedis.hincrBy(counter, event("outcome").convertTo[String], 1L)
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

const std::string kFeedbackTopic = "route.feedback";

std::unique_ptr<RdKafka::Producer> producer;

// TODO: key by tenant instead of the request id, configure the idempotent producer with acks=all,
// keep the prompt and message text out of the event and the logs, and write an outbox row when the
// broker rejects the produce.
void publish(const std::string& tenant, const std::string& requestId, const std::string& prompt) {
  std::cerr << "feedback tenant=" << tenant << " prompt=" << prompt << "\\n";
  const json event = {{"id", requestId}, {"tenant", tenant}, {"prompt", prompt}};
  const auto payload = event.dump();
  producer->produce(
      kFeedbackTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      requestId.data(),
      requestId.size(),
      0,
      nullptr);
  producer->flush(2000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kFeedbackTopic = "route.feedback";

struct OutboxStore {
  void insertOutbox(const std::string& tenant, const json& event);
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

void publish(const std::string& tenant, const std::string& requestId, const std::string& model, const std::string& outcome) {
  const json event = {{"id", requestId}, {"tenant", tenant}, {"model", model}, {"outcome", outcome}};
  const auto payload = event.dump();
  const auto err = producer->produce(kFeedbackTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), tenant.data(), tenant.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(tenant, event);
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
  consumer->subscribe({"route.feedback"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    redis->hincrby("quality:" + event["tenant"].get<std::string>() + ":" + event["model"].get<std::string>(), event["outcome"].get<std::string>(), 1);
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking three things a generated Kafka snippet almost always gets wrong. First, the message key is an ordering contract: partition by tenant and one tenant’s events arrive in order; key by request id and they do not. Second, exactly-once *looking* code is not exactly-once: the producer needs idempotence and acks=all for retries, and the consumer must apply its state change before the offset commit, or a crash between them loses the update permanently. Third, a broker is not a database: when the produce fails, the durable path is an outbox row that a relay republishes, the same pattern the ingest path uses. The prompt leak is the quiet one: the topic retains and replicates whatever you write into it. Real platforms add schema registry validation, per-tenant partition quotas, and dead-letter topics for permanently unprocessable events.`,
};
