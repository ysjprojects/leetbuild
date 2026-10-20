import type {Step} from '@/lib/types';

export const usageEventsStep: Step = {
  id: 'usage-events',
  title: 'Usage events: bill once, in tenant order',
  concept: 'kafka',
  file: 'usage',
  focus: ['gateway', 'usage', 'billing'],
  task: `## Task

The starter is a plausible model-generated draft: it produces a usage event on the happy path and
the billing consumer increments Redis, so the numbers look right in a demo. The review finds the
three bugs that only show up on a bad day. Find them, fix them, and prove the fix.

Implement the gateway’s usage pipeline:

- Produce exactly one \`usage\` event per request, keyed by **tenant** (not by request id), with
  **\`acks=all\`** and an **idempotent producer**. The event id is the request id so a duplicate
  delivery can be recognised downstream.
- The event carries \`model\`, \`input_tokens\`, \`output_tokens\`, \`latency_ms\`, and \`status\` — and
  **never** the message content or the prompt. Usage needs a number, not the customer’s text.
- If the broker is unavailable, write an **outbox** row instead of dropping the event or failing the
  request that was already answered. Losing usage loses money; failing the answered request loses
  the user.
- The billing consumer increments \`usage:{tenant}:{day}\` with \`HINCRBY\` **before** it commits the
  offset. Committing first means a crash between commit and increment silently under-bills.

The failure mode the checks target is a pipeline that is exactly wrong under rebalance or
redelivery: request-id keys scatter one tenant’s events across partitions, the commit-before-process
order loses a charge on every crash, and a logged prompt leaks data the usage event was supposed to
avoid.`,
  sequence: {
    participants: ['Gateway', 'usage', 'Billing', 'Redis'],
    messages: [
      {from: 'Gateway', to: 'Gateway', label: 'request answered · build usage event', kind: 'sync'},
      {from: 'Gateway', to: 'usage', label: 'produce key=tenant · acks=all · id=request id', kind: 'async'},
      {from: 'Gateway', to: 'Gateway', label: 'broker error → outbox row', kind: 'sync'},
      {from: 'usage', to: 'Billing', label: 'consume', kind: 'async'},
      {from: 'Billing', to: 'Redis', label: 'HINCRBY usage:{tenant}:{day}', kind: 'sync'},
      {from: 'Billing', to: 'Billing', label: 'commit offset after the increment', kind: 'sync'},
    ],
  },
  hints: [
    'The partition key is a routing decision, not an id: use the tenant so all of one tenant’s usage lands in one partition and is processed in order. The event id can still be the request id — it identifies the event, it does not choose the partition.',
    'The producer needs both halves of the delivery guarantee: `enable.idempotence` (or the stack’s equivalent) and `acks=all`. Then wrap the send so a synchronous error or an asynchronous delivery failure writes the same event to the outbox instead of being swallowed.',
    'In the consumer the order is the whole point: parse, `HINCRBY`, then commit the offset. If the process dies after the increment but before the commit, the event is redelivered and the counter double-counts; an idempotent store keyed by request id is what makes that safe in a real system.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Produces with the tenant as the key',
      detail:
        'The Kafka record key is the tenant, so one tenant’s usage is ordered within a partition. Keying by request id spreads a tenant’s events across partitions and destroys per-tenant ordering.',
      match: {
        python: {all: [/producer\.produce\(/, /key=event\[["']tenant["']\]/]},
        go: {all: [/writer\.WriteMessages\(/, /Key:\s*\[\]byte\(event\.Tenant\)/]},
        scala: {all: [/producer\.send\(/, /ProducerRecord\[String, String\]\(\s*"usage",\s*event\.tenant/]},
        cpp: {all: [/rd_kafka_producev\(/, /RD_KAFKA_V_KEY\(tenant/]},
        typescript: {all: [/producer\.send\(/, /key:\s*event\.tenant/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer enables idempotence and waits for all in-sync replicas (`acks=all`), so a retry does not silently create a second record and a leader failure does not lose an acknowledged one. (kafka-go exposes no idempotent mode: `RequireAll` plus the stable event id is what it can promise.)',
      match: {
        python: {all: [/enable\.idempotence/, /"acks":\s*"all"/, /producer\.produce\(/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/, /writer\.WriteMessages\(/]},
        scala: {all: [/ENABLE_IDEMPOTENCE_CONFIG/, /ACKS_CONFIG/, /"all"/, /producer\.send\(/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/, /rd_kafka_producev\(/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/, /producer\.send\(/]},
      },
    },
    {
      id: 'no-prompt-content',
      title: 'Never puts message content in the usage event or logs',
      detail:
        'The event fields are model, token counts, latency and status; the prompt and messages are neither serialised into the record nor logged.',
      match: {
        python: {none: [/["']messages["']\s*:/, /logger[^\n]*(messages|prompt)/i, /print\([^\n]*(messages|prompt)/i]},
        go: {none: [/["']messages["']\s*:/, /log\.(Printf|Println)\([^\n]*(Messages|messages|prompt)/]},
        scala: {none: [/["']messages["']\s*:/, /logger\.(info|debug)\([^\n]*(messages|prompt)/i]},
        cpp: {none: [/["']messages["']\s*:/, /std::cout[^\n]*(messages|prompt)/i, /spdlog[^\n]*(messages|prompt)/i]},
        typescript: {
          none: [
            /["']messages["']\s*:/,
            /\bmessages:\s*(?:request|body)\.messages/,
            /(?:logger|request\.log|console\.(?:log|info|debug))[^\n]*(?:messages|prompt)/i,
          ],
        },
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the broker fails',
      detail:
        'A synchronous produce error and an asynchronous delivery failure both persist the event to the outbox; the request path never drops usage and never throws after the user already has an answer.',
      match: {
        python: {
          all: [/outbox\.insert|outbox\.add/, /on_delivery|_delivered/, /BufferError|KafkaException|err is not None/],
        },
        go: {all: [/outbox\.Insert/, /WriteMessages/, /err != nil/]},
        scala: {all: [/outbox\.insert/, /producer\.send/, /exception/]},
        cpp: {
          all: [
            /outbox\.insert/,
            /rd_kafka_producev\(/,
            /delivery_report|message->err|err != RD_KAFKA_RESP_ERR_NO_ERROR/,
          ],
        },
        typescript: {all: [/outbox\.insert\(/, /producer\.send\(/, /catch/]},
      },
    },
    {
      id: 'commit-after-increment',
      title: 'HINCRBY happens before the offset commit',
      detail:
        'The consumer increments `usage:{tenant}:{day}` first and commits the offset only after the increment succeeds. Committing first loses the increment when the process dies between the two.',
      match: {
        python: {order: [/\bhincrby\(/, /consumer\.commit\(/]},
        go: {order: [/HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/hincrBy\(/, /commitSync\(/]},
        cpp: {order: [/\.hincrby\(/, /rd_kafka_commit\(/]},
        typescript: {order: [/hincrby\(/, /commitOffsets\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
from datetime import datetime, timezone

import redis
from confluent_kafka import Consumer, Producer

logger = logging.getLogger(__name__)

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Outbox:
    def insert(self, event: dict, reason: str = "") -> None:
        raise NotImplementedError


outbox = Outbox()


def build_event(request: dict, usage: dict) -> dict:
    # TODO: key the record by tenant and remove messages from the event
    # TODO: never log the prompt
    return {
        "id": request["id"],
        "tenant": request["tenant"],
        "model": request["model"],
        "messages": request["messages"],
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "latency_ms": request["latency_ms"],
        "status": request["status"],
    }


def emit_usage(event: dict) -> None:
    # TODO: enable.idempotence + acks=all, and write to the outbox on failure
    payload = json.dumps(event)
    producer.produce("usage", key=event["id"], value=payload)
    logger.info("usage prompt=%s", event["messages"])


def run_billing() -> None:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "billing",
            "enable.auto.commit": False,
        }
    )
    consumer.subscribe(["usage"])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        # TODO: increment before committing, never commit first
        consumer.commit(record, asynchronous=False)
        event = json.loads(record.value())
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        r.hincrby(
            f"usage:{event['tenant']}:{day}",
            "tokens",
            event["input_tokens"] + event["output_tokens"],
        )
`,
      solution: `import json
from datetime import datetime, timezone

import redis
from confluent_kafka import Consumer, Producer

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Outbox:
    def insert(self, event: dict, reason: str = "") -> None:
        raise NotImplementedError


outbox = Outbox()


def build_event(request: dict, usage: dict) -> dict:
    return {
        "id": request["id"],
        "tenant": request["tenant"],
        "model": request["model"],
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "latency_ms": request["latency_ms"],
        "status": request["status"],
    }


def _delivered(err, msg) -> None:
    if err is not None:
        outbox.insert(json.loads(msg.value().decode()), str(err))


def emit_usage(event: dict) -> None:
    payload = json.dumps(event)
    try:
        producer.produce("usage", key=event["tenant"], value=payload, on_delivery=_delivered)
        producer.poll(0)
    except BufferError:
        outbox.insert(event, "producer queue full")


def run_billing() -> None:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "billing",
            "enable.auto.commit": False,
            "auto.offset.reset": "earliest",
        }
    )
    consumer.subscribe(["usage"])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        event = json.loads(record.value())
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        r.hincrby(
            f"usage:{event['tenant']}:{day}",
            "tokens",
            event["input_tokens"] + event["output_tokens"],
        )
        consumer.commit(record, asynchronous=False)
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

type usageEvent struct {
	ID           string   \`json:"id"\`
	Tenant       string   \`json:"tenant"\`
	Model        string   \`json:"model"\`
	Messages     []string \`json:"messages"\`
	InputTokens  int      \`json:"input_tokens"\`
	OutputTokens int      \`json:"output_tokens"\`
	LatencyMS    int      \`json:"latency_ms"\`
	Status       string   \`json:"status"\`
}

type outboxStore interface {
	Insert(ctx context.Context, event usageEvent, reason string) error
}

var (
	writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "usage"}
	outbox outboxStore
	rdb    *redis.Client
)

func emitUsage(ctx context.Context, event usageEvent) error {
	// TODO: key by tenant, enable idempotence with acks=all, write to the outbox on failure
	// TODO: never log Messages
	payload, _ := json.Marshal(event)
	log.Printf("usage id=%s messages=%v", event.ID, event.Messages)
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.ID), Value: payload})
}

func runBilling(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		GroupID: "billing",
		Topic:   "usage",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		// TODO: increment before committing
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event usageEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		day := time.Now().UTC().Format("20060102")
		key := "usage:" + event.Tenant + ":" + day
		rdb.HIncrBy(ctx, key, "tokens", int64(event.InputTokens+event.OutputTokens))
	}
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

type usageEvent struct {
	ID           string \`json:"id"\`
	Tenant       string \`json:"tenant"\`
	Model        string \`json:"model"\`
	InputTokens  int    \`json:"input_tokens"\`
	OutputTokens int    \`json:"output_tokens"\`
	LatencyMS    int    \`json:"latency_ms"\`
	Status       string \`json:"status"\`
}

type outboxStore interface {
	Insert(ctx context.Context, event usageEvent, reason string) error
}

var (
	writer = &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Topic:        "usage",
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
		Async:        false,
	}
	outbox outboxStore
	rdb    *redis.Client
)

func emitUsage(ctx context.Context, event usageEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	err = writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.Tenant), Value: payload})
	if err != nil {
		return outbox.Insert(ctx, event, err.Error())
	}
	return nil
}

func runBilling(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		GroupID: "billing",
		Topic:   "usage",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event usageEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		day := time.Now().UTC().Format("20060102")
		key := "usage:" + event.Tenant + ":" + day
		if err := rdb.HIncrBy(ctx, key, "tokens", int64(event.InputTokens+event.OutputTokens)).Err(); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}

func main() {}
`,
    },
    scala: {
      starter: `import java.util.{Collections, Properties}

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.slf4j.LoggerFactory
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class UsageEvent(
    id: String,
    tenant: String,
    model: String,
    messages: List[String],
    input_tokens: Int,
    output_tokens: Int,
    latency_ms: Int,
    status: String
)

object Usage {
  implicit val usageFormat: RootJsonFormat[UsageEvent] = jsonFormat8(UsageEvent)

  private val logger = LoggerFactory.getLogger(getClass)
  private val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  private val producer = new KafkaProducer[String, String](producerProps)
  private val jedis = new Jedis("redis", 6379)
  private val outbox = new Outbox()

  def emitUsage(event: UsageEvent): Unit = {
    // TODO: key by tenant, enable.idempotence=true and acks=all, write to the outbox on failure
    // TODO: never log messages
    val payload = event.toJson.compactPrint
    producer.send(new ProducerRecord[String, String]("usage", event.id, payload))
    logger.info("usage prompt=" + event.messages)
  }

  def runBilling(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "billing")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(Collections.singletonList("usage"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      records.forEach { record =>
        // TODO: increment before committing
        consumer.commitSync()
        val event = record.value().parseJson.convertTo[UsageEvent]
        val day = java.time.LocalDate.now(java.time.ZoneOffset.UTC).format(java.time.format.DateTimeFormatter.BASIC_ISO_DATE)
        jedis.hincrBy("usage:" + event.tenant + ":" + day, "tokens", (event.input_tokens + event.output_tokens).toLong)
      }
    }
  }
}
`,
      solution: `import java.util.{Collections, Properties}

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class UsageEvent(
    id: String,
    tenant: String,
    model: String,
    input_tokens: Int,
    output_tokens: Int,
    latency_ms: Int,
    status: String
)

object Usage {
  implicit val usageFormat: RootJsonFormat[UsageEvent] = jsonFormat7(UsageEvent)

  private val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  producerProps.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  producerProps.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](producerProps)
  private val jedis = new Jedis("redis", 6379)
  private val outbox = new Outbox()

  def emitUsage(event: UsageEvent): Unit = {
    val payload = event.toJson.compactPrint
    val record = new ProducerRecord[String, String]("usage", event.tenant, payload)
    try {
      producer.send(record, (_, exception) => {
        if (exception != null) outbox.insert(event, exception)
      })
    } catch {
      case e: Exception => outbox.insert(event, e)
    }
  }

  def runBilling(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "billing")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(Collections.singletonList("usage"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      records.forEach { record =>
        val event = record.value().parseJson.convertTo[UsageEvent]
        val day = java.time.LocalDate.now(java.time.ZoneOffset.UTC).format(java.time.format.DateTimeFormatter.BASIC_ISO_DATE)
        jedis.hincrBy("usage:" + event.tenant + ":" + day, "tokens", (event.input_tokens + event.output_tokens).toLong)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <chrono>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

#include <librdkafka/rdkafka.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

using json = nlohmann::json;

struct Outbox {
  void insert(const json& event, const std::string& reason) {}
};

static Outbox outbox;

static std::string utc_day() {
  const std::time_t now = std::time(nullptr);
  std::ostringstream out;
  out << std::put_time(std::gmtime(&now), "%Y%m%d");
  return out.str();
}

static rd_kafka_t* make_producer(char* errstr, std::size_t errlen) {
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, errlen);
  // TODO: enable.idempotence=true and acks=all
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, errlen);
}

static void emit_usage(rd_kafka_t* producer, const json& event) {
  // TODO: key by tenant; write to the outbox when producev fails or delivery fails
  // TODO: never log messages
  const std::string payload = event.dump();
  const std::string id = event["id"].get<std::string>();
  std::cout << "usage prompt=" << event["messages"] << std::endl;
  rd_kafka_producev(
      producer,
      RD_KAFKA_V_TOPIC("usage"),
      RD_KAFKA_V_MSGFLAGS(RD_KAFKA_MSG_F_COPY),
      RD_KAFKA_V_KEY(id.data(), id.size()),
      RD_KAFKA_V_VALUE(payload.data(), payload.size()),
      RD_KAFKA_V_END);
  rd_kafka_poll(producer, 0);
}

static void run_billing(rd_kafka_t* consumer, sw::redis::Redis& redis) {
  while (true) {
    rd_kafka_message_t* msg = rd_kafka_consumer_poll(consumer, 500);
    if (!msg) continue;
    if (msg->err) {
      rd_kafka_message_destroy(msg);
      continue;
    }
    // TODO: increment before committing
    rd_kafka_commit(consumer, nullptr, 0);
    const auto event = json::parse(std::string(static_cast<const char*>(msg->payload), msg->len));
    const std::string key = "usage:" + event["tenant"].get<std::string>() + ":" + utc_day();
    redis.hincrby(key, "tokens", event["input_tokens"].get<long long>() + event["output_tokens"].get<long long>());
    rd_kafka_message_destroy(msg);
  }
}
`,
      solution: `#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <string>

#include <librdkafka/rdkafka.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

using json = nlohmann::json;

struct Outbox {
  void insert(const json& event, const std::string& reason) {}
};

static Outbox outbox;

static std::string utc_day() {
  const std::time_t now = std::time(nullptr);
  std::ostringstream out;
  out << std::put_time(std::gmtime(&now), "%Y%m%d");
  return out.str();
}

static void delivery_report(rd_kafka_t*, const rd_kafka_message_t* message, void*) {
  if (message->err) {
    const std::string payload(static_cast<const char*>(message->payload), message->len);
    outbox.insert(json::parse(payload), rd_kafka_err2str(message->err));
  }
}

static rd_kafka_t* make_producer(char* errstr, std::size_t errlen) {
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, errlen);
  rd_kafka_conf_set(conf, "enable.idempotence", "true", errstr, errlen);
  rd_kafka_conf_set(conf, "acks", "all", errstr, errlen);
  rd_kafka_conf_set_dr_msg_cb(conf, delivery_report);
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, errlen);
}

static void emit_usage(rd_kafka_t* producer, const json& event) {
  const std::string payload = event.dump();
  const std::string tenant = event["tenant"].get<std::string>();
  const rd_kafka_resp_err_t err = rd_kafka_producev(
      producer,
      RD_KAFKA_V_TOPIC("usage"),
      RD_KAFKA_V_MSGFLAGS(RD_KAFKA_MSG_F_COPY),
      RD_KAFKA_V_KEY(tenant.data(), tenant.size()),
      RD_KAFKA_V_VALUE(payload.data(), payload.size()),
      RD_KAFKA_V_END);
  if (err != RD_KAFKA_RESP_ERR_NO_ERROR) {
    outbox.insert(event, rd_kafka_err2str(err));
  }
  rd_kafka_poll(producer, 0);
}

static void run_billing(rd_kafka_t* consumer, sw::redis::Redis& redis) {
  while (true) {
    rd_kafka_message_t* msg = rd_kafka_consumer_poll(consumer, 500);
    if (!msg) continue;
    if (msg->err) {
      rd_kafka_message_destroy(msg);
      continue;
    }
    const auto event = json::parse(std::string(static_cast<const char*>(msg->payload), msg->len));
    const std::string key = "usage:" + event["tenant"].get<std::string>() + ":" + utc_day();
    redis.hincrby(key, "tokens", event["input_tokens"].get<long long>() + event["output_tokens"].get<long long>());
    rd_kafka_commit(consumer, nullptr, 0);
    rd_kafka_message_destroy(msg);
  }
}
`,
    },
    typescript: {
      starter: `import {Kafka, type EachMessagePayload} from 'kafkajs';
import Redis from 'ioredis';

interface UsageRequest {
  id: string;
  tenant: string;
  model: string;
  messages: string[];
  latency_ms: number;
  status: string;
}
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}
interface UsageEvent {
  id: string;
  tenant: string;
  model: string;
  messages: string[];
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  status: string;
}

const kafka = new Kafka({clientId: 'gateway', brokers: ['kafka:9092']});
const producer = kafka.producer();
const consumer = kafka.consumer({groupId: 'billing'});
const redis = new Redis({host: 'redis', port: 6379});

class Outbox {
  async insert(event: UsageEvent, reason: string): Promise<void> {
    void event;
    void reason;
    throw new Error('outbox table is provided by the platform layer');
  }
}
const outbox = new Outbox();

export function buildEvent(request: UsageRequest, usage: TokenUsage): UsageEvent {
  // TODO: key the record by tenant and drop messages from the event
  return {
    id: request.id,
    tenant: request.tenant,
    model: request.model,
    messages: request.messages,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    latency_ms: request.latency_ms,
    status: request.status,
  };
}

export async function emitUsage(event: UsageEvent): Promise<void> {
  // TODO: enable.idempotence and acks=all, and write to the outbox on failure
  // TODO: never log the prompt
  console.log('usage', event.messages);
  await producer.send({
    topic: 'usage',
    messages: [{key: event.id, value: JSON.stringify(event)}],
  });
}

export async function runBilling(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'usage', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}: EachMessagePayload) => {
      // TODO: increment before committing, never commit first
      await consumer.commitOffsets([
        {topic, partition, offset: String(Number(message.offset) + 1)},
      ]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as UsageEvent;
      const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      await redis.hincrby(\`usage:\${event.tenant}:\${day}\`, 'tokens', event.input_tokens + event.output_tokens);
    },
  });
}
`,
      solution: `import {Kafka, type EachMessagePayload} from 'kafkajs';
import Redis from 'ioredis';

interface UsageRequest {
  id: string;
  tenant: string;
  model: string;
  latency_ms: number;
  status: string;
}
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}
interface UsageEvent {
  id: string;
  tenant: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  status: string;
}

const kafka = new Kafka({clientId: 'gateway', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
const consumer = kafka.consumer({groupId: 'billing'});
const redis = new Redis({host: 'redis', port: 6379});

class Outbox {
  async insert(event: UsageEvent, reason: string): Promise<void> {
    void event;
    void reason;
    throw new Error('outbox table is provided by the platform layer');
  }
}
const outbox = new Outbox();

export function buildEvent(request: UsageRequest, usage: TokenUsage): UsageEvent {
  return {
    id: request.id,
    tenant: request.tenant,
    model: request.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    latency_ms: request.latency_ms,
    status: request.status,
  };
}

export async function emitUsage(event: UsageEvent): Promise<void> {
  try {
    await producer.send({
      topic: 'usage',
      acks: -1,
      messages: [{key: event.tenant, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await outbox.insert(event, String(error));
  }
}

export async function runBilling(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'usage', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}: EachMessagePayload) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as UsageEvent;
      const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      await redis.hincrby(\`usage:\${event.tenant}:\${day}\`, 'tokens', event.input_tokens + event.output_tokens);
      await consumer.commitOffsets([
        {topic, partition, offset: String(Number(message.offset) + 1)},
      ]);
    },
  });
}

export async function start(): Promise<void> {
  await producer.connect();
  await runBilling();
}
`,
    },
  },
  debrief: `The interview signal is **delivery semantics under failure**: can you say what is guaranteed by a key, by acks, by an idempotent producer, and by the order of the consumer’s write and commit? The draft passes the demo because no broker fails and no consumer restarts; the review is about the day one does. Keying by tenant is an ordering decision; \`acks=all\` plus idempotence is a durability decision; the outbox is an availability decision; and \`HINCRBY\` before commit is an at-least-once accounting decision. The remaining real-system gap is consumer idempotence: if the increment succeeds and the commit fails, the redelivered event increments again, so production billing stores the request id in a dedupe set or makes the counter update conditional on it.`,
};
