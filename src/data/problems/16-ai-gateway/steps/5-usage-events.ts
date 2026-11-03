import type {Step} from '@/lib/types';

// ---- 5. Usage events to Kafka and the billing consumer ----------------------------------------------
export const usageEventsStep: Step = {
  id: 'usage-events',
  title: 'One usage event per request, billed once',
  concept: 'kafka',
  file: 'usage_events',
  focus: ['gateway', 'usage', 'billing'],
  task: `## Task

**Starting point.** The starter is the usage pipeline. \`build_event(request, usage)\` turns an
answered request (\`id\`, \`tenant\`, \`model\`, \`messages\`, \`latency_ms\`, \`status\`) and the
provider's usage into the event; \`emit_usage(event)\` produces it to the \`usage\` topic keyed by
the request id and logs a line; \`run_billing()\` consumes the topic as group \`billing\` with
auto-commit off, commits the offset, then adds the tokens to \`usage:{tenant}:{yyyymmdd}\` with
\`HINCRBY\`. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** A tenant's events scattered over every partition, a lost
acknowledgement that writes the same event twice, a prompt inside a billing record, an event
dropped when the broker refuses it, and a consumer crash between commit and increment that
under-bills.

- The record key is the **tenant**; the event id stays the request id.
- The producer is **idempotent** with \`acks=all\` (kafka-go has no idempotent mode: \`RequireAll\`
  is what it can promise).
- The event carries \`id\`, \`tenant\`, \`model\`, \`input_tokens\`, \`output_tokens\`, \`latency_ms\`,
  \`status\`; the messages are not in the event and not in a log line.
- A delivery failure, reported through the **delivery callback**, writes the event to the provided
  \`outbox\` (\`gateway/outbox\`: \`insert(event, reason)\`, the Redis list \`outbox:usage\`); the request
  path does not wait for the broker.
- \`run_billing\` increments **before** it commits.`,
  sequence: {
    participants: ['gateway', 'usage', 'billing', 'Redis'],
    messages: [
      {from: 'gateway', to: 'gateway', label: 'request answered · build_event', kind: 'sync'},
      {from: 'gateway', to: 'usage', label: 'produce key=acme · acks=all · idempotent', kind: 'async'},
      {from: 'usage', to: 'gateway', label: 'delivery report: error → outbox:usage', kind: 'reply'},
      {from: 'usage', to: 'billing', label: 'consume', kind: 'async'},
      {from: 'billing', to: 'Redis', label: 'HINCRBY usage:acme:20261102 tokens 165', kind: 'sync'},
      {from: 'billing', to: 'usage', label: 'commit offset (after the increment)', kind: 'sync'},
    ],
  },
  hints: [
    'Finance finds a tenant billed twice for one request on the day the broker hiccuped, another tenant missing a charge after the consumer restarted, and a customer prompt in the billing log.',
    'A key of request id spreads a tenant over the partitions; a producer without idempotence rewrites a record whose ack was lost; a produce error nobody reads is a dropped event; commit before increment loses the increment on a crash.',
    'Key by `event["tenant"]`; set `enable.idempotence` and `acks=all`; pass a delivery callback that calls `outbox.insert(event, reason)` on error and serve it with `poll(0)`; drop `messages` and the log line; `HINCRBY`, then commit.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Produces with the tenant as the key',
      detail:
        "The record key is the tenant, so one tenant's usage lands on one partition in order; keyed by request id a tenant is spread across all of them.",
      match: {
        python: {all: [/\.produce\([\s\S]{0,300}?key\s*=\s*event\[["']tenant["']\]/]},
        typescript: {all: [/key:\s*event\.tenant/]},
        go: {all: [/Key:\s*\[\]byte\(\s*event\.Tenant\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"usage")\s*,\s*event\.tenant/]},
        cpp: {all: [/produce\([\s\S]{0,400}?tenant\.c_str\(\)\s*,\s*tenant\.(size|length)\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer enables idempotence and waits for every in-sync replica, so a retried write lands once and a leader failover keeps what was acknowledged. (kafka-go exposes no idempotent mode: `RequireAll` is what it can promise.)',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*(["']all["']|-1)/]},
        typescript: {all: [/idempotent:\s*true/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/ENABLE_IDEMPOTENCE_CONFIG|"enable\.idempotence"/, /ACKS_CONFIG|"acks"/, /"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'no-prompt-content',
      title: 'No message content in the event or the logs',
      detail:
        'The event is ids, counts, latency and status; the messages are neither serialised into the record nor logged.',
      match: {
        python: {
          none: [
            /["']messages["']\s*:/,
            /logg?(er|ing)\.[a-z]+\([^\n]*(messages|prompt|content)/i,
            /print\([^\n]*(messages|prompt|content)/i,
          ],
        },
        typescript: {
          none: [
            /\bmessages:\s*(request|event)\.messages/,
            /console\.(log|info|debug|warn)\([^\n]*(messages|prompt|content)/i,
          ],
        },
        go: {none: [/Messages:\s*request\.Messages/, /(log|fmt)\.Print[a-z]*\([^\n]*(Messages|prompt|Content)/i]},
        scala: {none: [/"messages"\s*->/, /println\([^\n]*(messages|prompt|content)/i]},
        cpp: {none: [/\["messages"\]\s*=/, /std::c(out|err)[^\n]*(messages|prompt|content)/i]},
      },
    },
    {
      id: 'outbox',
      title: 'A failed delivery goes to the outbox',
      detail:
        "A delivery error, served through the delivery callback (`on_delivery`, the send promise's rejection, `Completion`, the `Callback`, `dr_cb`), writes the event to `outbox.insert(event, reason)`; the request path neither waits for the broker nor drops the event.",
      match: {
        python: {all: [/outbox\.insert\(/, /on_delivery\s*=|callback\s*=/], none: [/except KafkaException/]},
        typescript: {all: [/outbox\.insert\(/, /\.catch\(|catch\s*\(/]},
        go: {all: [/outbox\.Insert\(/, /Completion:|err != nil/]},
        scala: {all: [/Outbox\.insert\(/, /Callback/]},
        cpp: {all: [/outbox::insert\(/, /dr_cb/]},
      },
    },
    {
      id: 'commit-after-increment',
      title: 'HINCRBY before the offset commit',
      detail:
        'The consumer increments `usage:{tenant}:{day}` and only then commits; a crash between a commit and the increment loses the charge.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /\.CommitMessages\(/]},
        scala: {order: [/\.hincrBy\(/, /\.commitSync\(/]},
        cpp: {order: [/\.hincrby\(/, /->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

import redis
from confluent_kafka import Consumer, Producer

from gateway import outbox

TOPIC = "usage"
logger = logging.getLogger("usage")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


# TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
def build_event(request: dict, usage: dict) -> dict:
    """The usage event of one answered request."""
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
    """Called once the request has been answered; must not fail or delay it."""
    producer.produce(TOPIC, key=event["id"], value=json.dumps(event))
    logger.info("usage %s prompt=%s", event["id"], event["messages"])
    producer.poll(0)


def run_billing() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "billing", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        consumer.commit(record, asynchronous=False)
        event = json.loads(record.value())
        day = time.strftime("%Y%m%d", time.gmtime(time.time()))
        r.hincrby(f"usage:{event['tenant']}:{day}", "tokens", event["input_tokens"] + event["output_tokens"])
`,
      solution: `import json
import logging
import time

import redis
from confluent_kafka import Consumer, Producer

from gateway import outbox

TOPIC = "usage"
logger = logging.getLogger("usage")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def build_event(request: dict, usage: dict) -> dict:
    """The usage event of one answered request."""
    return {
        "id": request["id"],
        "tenant": request["tenant"],
        "model": request["model"],
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "latency_ms": request["latency_ms"],
        "status": request["status"],
    }


def on_delivery(err, msg) -> None:
    if err is not None:
        outbox.insert(json.loads(msg.value()), str(err))  # the broker refused it: a relay produces it later


def emit_usage(event: dict) -> None:
    """Called once the request has been answered; must not fail or delay it."""
    try:
        producer.produce(TOPIC, key=event["tenant"], value=json.dumps(event), on_delivery=on_delivery)
    except BufferError:
        outbox.insert(event, "producer queue full")
    producer.poll(0)  # serve delivery reports; returns at once


def run_billing() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "billing", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        event = json.loads(record.value())
        day = time.strftime("%Y%m%d", time.gmtime(time.time()))
        r.hincrby(f"usage:{event['tenant']}:{day}", "tokens", event["input_tokens"] + event["output_tokens"])
        consumer.commit(record, asynchronous=False)  # after the increment: a crash before this point redelivers
`,
    },
    typescript: {
      starter: `import * as outbox from 'gateway/outbox';
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const TOPIC = 'usage';

const kafka = new Kafka({clientId: 'gateway', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

export interface AnsweredRequest {
  id: string;
  tenant: string;
  model: string;
  messages: {role: string; content: string}[];
  latency_ms: number;
  status: number;
}
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
export interface UsageEvent {
  id: string;
  tenant: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  status: number;
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
/** The usage event of one answered request. */
export function buildEvent(request: AnsweredRequest, usage: Usage): UsageEvent {
  return {
    id: request.id,
    tenant: request.tenant,
    model: request.model,
    messages: request.messages,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    latency_ms: request.latency_ms,
    status: request.status,
  } as UsageEvent;
}

/** Called once the request has been answered; must not fail or delay it. */
export async function emitUsage(event: UsageEvent): Promise<void> {
  await producer.send({topic: TOPIC, messages: [{key: event.id, value: JSON.stringify(event)}]});
  console.log('usage', event.id, 'prompt=', (event as unknown as {messages: unknown}).messages);
}

export async function runBilling(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'billing'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as UsageEvent;
      const day = new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
      await redis.hincrby(\`usage:\${event.tenant}:\${day}\`, 'tokens', event.input_tokens + event.output_tokens);
    },
  });
}
`,
      solution: `import * as outbox from 'gateway/outbox';
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const TOPIC = 'usage';

const kafka = new Kafka({clientId: 'gateway', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true}); // idempotent implies acks: -1 (all)
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

export interface AnsweredRequest {
  id: string;
  tenant: string;
  model: string;
  messages: {role: string; content: string}[];
  latency_ms: number;
  status: number;
}
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
export interface UsageEvent {
  id: string;
  tenant: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  status: number;
}

/** The usage event of one answered request. */
export function buildEvent(request: AnsweredRequest, usage: Usage): UsageEvent {
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

/** Called once the request has been answered; must not fail or delay it. */
export function emitUsage(event: UsageEvent): void {
  // Not awaited: the request is already answered. A refused delivery goes to the outbox for a relay.
  producer
    .send({topic: TOPIC, messages: [{key: event.tenant, value: JSON.stringify(event)}], acks: -1})
    .catch((err: Error) => outbox.insert(event as unknown as Record<string, unknown>, err.message));
}

export async function runBilling(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'billing'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as UsageEvent;
      const day = new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
      await redis.hincrby(\`usage:\${event.tenant}:\${day}\`, 'tokens', event.input_tokens + event.output_tokens);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]); // after the increment
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
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"gateway/outbox"
)

const topic = "usage"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type chatMessage struct {
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
}

// AnsweredRequest is what the gateway knows once a request has been answered.
type AnsweredRequest struct {
	ID        string        \`json:"id"\`
	Tenant    string        \`json:"tenant"\`
	Model     string        \`json:"model"\`
	Messages  []chatMessage \`json:"messages"\`
	LatencyMs float64       \`json:"latency_ms"\`
	Status    int           \`json:"status"\`
}

type Usage struct {
	InputTokens  int \`json:"input_tokens"\`
	OutputTokens int \`json:"output_tokens"\`
}

type UsageEvent struct {
	ID           string        \`json:"id"\`
	Tenant       string        \`json:"tenant"\`
	Model        string        \`json:"model"\`
	Messages     []chatMessage \`json:"messages,omitempty"\`
	InputTokens  int           \`json:"input_tokens"\`
	OutputTokens int           \`json:"output_tokens"\`
	LatencyMs    float64       \`json:"latency_ms"\`
	Status       int           \`json:"status"\`
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// buildEvent is the usage event of one answered request.
func buildEvent(request AnsweredRequest, usage Usage) UsageEvent {
	return UsageEvent{
		ID:           request.ID,
		Tenant:       request.Tenant,
		Model:        request.Model,
		Messages:     request.Messages,
		InputTokens:  usage.InputTokens,
		OutputTokens: usage.OutputTokens,
		LatencyMs:    request.LatencyMs,
		Status:       request.Status,
	}
}

// emitUsage is called once the request has been answered; it must not fail or delay it.
func emitUsage(ctx context.Context, event UsageEvent) {
	value, _ := json.Marshal(event)
	writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.ID), Value: value})
	log.Printf("usage %s prompt=%v", event.ID, event.Messages)
}

func runBilling(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "billing", Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event UsageEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			continue
		}
		day := time.Now().UTC().Format("20060102")
		if err := rdb.HIncrBy(ctx, "usage:"+event.Tenant+":"+day, "tokens", int64(event.InputTokens+event.OutputTokens)).Err(); err != nil {
			return err
		}
	}
}

var _ = outbox.Insert
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"gateway/outbox"
)

const topic = "usage"

// Async: WriteMessages hands the record over and returns; the broker's answer reaches Completion.
// kafka-go has no idempotent mode: RequireAll is what it can promise.
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
			outbox.Insert(context.Background(), m.Value, err.Error()) // the broker refused it: a relay produces it later
		}
	},
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type chatMessage struct {
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
}

// AnsweredRequest is what the gateway knows once a request has been answered.
type AnsweredRequest struct {
	ID        string        \`json:"id"\`
	Tenant    string        \`json:"tenant"\`
	Model     string        \`json:"model"\`
	Messages  []chatMessage \`json:"messages"\`
	LatencyMs float64       \`json:"latency_ms"\`
	Status    int           \`json:"status"\`
}

type Usage struct {
	InputTokens  int \`json:"input_tokens"\`
	OutputTokens int \`json:"output_tokens"\`
}

type UsageEvent struct {
	ID           string  \`json:"id"\`
	Tenant       string  \`json:"tenant"\`
	Model        string  \`json:"model"\`
	InputTokens  int     \`json:"input_tokens"\`
	OutputTokens int     \`json:"output_tokens"\`
	LatencyMs    float64 \`json:"latency_ms"\`
	Status       int     \`json:"status"\`
}

// buildEvent is the usage event of one answered request.
func buildEvent(request AnsweredRequest, usage Usage) UsageEvent {
	return UsageEvent{
		ID:           request.ID,
		Tenant:       request.Tenant,
		Model:        request.Model,
		InputTokens:  usage.InputTokens,
		OutputTokens: usage.OutputTokens,
		LatencyMs:    request.LatencyMs,
		Status:       request.Status,
	}
}

// emitUsage is called once the request has been answered; it must not fail or delay it.
func emitUsage(ctx context.Context, event UsageEvent) {
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.Tenant), Value: value}); err != nil {
		outbox.Insert(ctx, value, err.Error()) // refused before it was even queued
	}
}

func runBilling(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "billing", Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event UsageEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		day := time.Now().UTC().Format("20060102")
		if err := rdb.HIncrBy(ctx, "usage:"+event.Tenant+":"+day, "tokens", int64(event.InputTokens+event.OutputTokens)).Err(); err != nil {
			return err // not committed: the record is redelivered
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.format.DateTimeFormatter
import java.time.{Duration, Instant, ZoneOffset}
import java.util.Properties

import gateway.Outbox
import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object UsageEvents {
  val Topic = "usage"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)
  private val Day = DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneOffset.UTC)

  case class ChatMessage(role: String, content: String)
  /** What the gateway knows once a request has been answered. */
  case class AnsweredRequest(id: String, tenant: String, model: String, messages: Seq[ChatMessage], latencyMs: Double, status: Int)
  case class Usage(inputTokens: Int, outputTokens: Int)
  case class UsageEvent(json: ujson.Obj) {
    def id: String = json("id").str
    def tenant: String = json("tenant").str
  }

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  /** The usage event of one answered request. */
  def buildEvent(request: AnsweredRequest, usage: Usage): UsageEvent = UsageEvent(
    ujson.Obj(
      "id" -> request.id,
      "tenant" -> request.tenant,
      "model" -> request.model,
      "messages" -> request.messages.map(m => ujson.Obj("role" -> m.role, "content" -> m.content)),
      "input_tokens" -> usage.inputTokens,
      "output_tokens" -> usage.outputTokens,
      "latency_ms" -> request.latencyMs,
      "status" -> request.status,
    )
  )

  /** Called once the request has been answered; must not fail or delay it. */
  def emitUsage(event: UsageEvent): Unit = {
    producer.send(new ProducerRecord[String, String](Topic, event.id, ujson.write(event.json)))
    println(s"usage \${event.id} prompt=\${event.json("messages")}")
  }

  def runBilling(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "billing")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync()
        val event = ujson.read(record.value())
        val day = Day.format(Instant.now())
        jedis.hincrBy(s"usage:\${event("tenant").str}:$day", "tokens", event("input_tokens").num.toLong + event("output_tokens").num.toLong)
      }
    }
  }
}
`,
      solution: `import java.time.format.DateTimeFormatter
import java.time.{Duration, Instant, ZoneOffset}
import java.util.Properties

import gateway.Outbox
import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerConfig, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object UsageEvents {
  val Topic = "usage"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)
  private val Day = DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneOffset.UTC)

  case class ChatMessage(role: String, content: String)
  /** What the gateway knows once a request has been answered. */
  case class AnsweredRequest(id: String, tenant: String, model: String, messages: Seq[ChatMessage], latencyMs: Double, status: Int)
  case class Usage(inputTokens: Int, outputTokens: Int)
  case class UsageEvent(json: ujson.Obj) {
    def id: String = json("id").str
    def tenant: String = json("tenant").str
  }

  /** The usage event of one answered request. */
  def buildEvent(request: AnsweredRequest, usage: Usage): UsageEvent = UsageEvent(
    ujson.Obj(
      "id" -> request.id,
      "tenant" -> request.tenant,
      "model" -> request.model,
      "input_tokens" -> usage.inputTokens,
      "output_tokens" -> usage.outputTokens,
      "latency_ms" -> request.latencyMs,
      "status" -> request.status,
    )
  )

  /** Called once the request has been answered; must not fail or delay it. */
  def emitUsage(event: UsageEvent): Unit = {
    val value = ujson.write(event.json)
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) Outbox.insert(value, exception.getMessage) // the broker refused it: a relay produces it later
    }
    producer.send(new ProducerRecord[String, String](Topic, event.tenant, value), onDelivery) // not awaited
  }

  def runBilling(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "billing")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = ujson.read(record.value())
        val day = Day.format(Instant.now())
        jedis.hincrBy(s"usage:\${event("tenant").str}:$day", "tokens", event("input_tokens").num.toLong + event("output_tokens").num.toLong)
        consumer.commitSync() // after the increment: a crash before this point redelivers
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <iostream>
#include <memory>
#include <string>

#include "gateway/outbox.h"

const std::string kTopic = "usage";

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// The usage event of one answered request (request: id, tenant, model, messages, latency_ms, status).
nlohmann::json build_event(const nlohmann::json& request, const nlohmann::json& usage) {
  nlohmann::json event;
  event["id"] = request["id"];
  event["tenant"] = request["tenant"];
  event["model"] = request["model"];
  event["messages"] = request["messages"];
  event["input_tokens"] = usage["input_tokens"];
  event["output_tokens"] = usage["output_tokens"];
  event["latency_ms"] = request["latency_ms"];
  event["status"] = request["status"];
  return event;
}

// Called once the request has been answered; must not fail or delay it.
void emit_usage(const nlohmann::json& event) {
  const std::string value = event.dump();
  const std::string id = event["id"];
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), id.c_str(), id.size(), 0, nullptr);
  std::cout << "usage " << id << " prompt=" << event["messages"].dump() << "\\n";
  producer->poll(0);
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "billing", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

std::string today() {
  const std::time_t now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  char day[9];
  std::strftime(day, sizeof day, "%Y%m%d", std::gmtime(&now));
  return day;
}

void run_billing() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) continue;
    redis.hincrby("usage:" + event["tenant"].get<std::string>() + ":" + today(), "tokens",
                  event["input_tokens"].get<long long>() + event["output_tokens"].get<long long>());
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <memory>
#include <string>

#include "gateway/outbox.h"

const std::string kTopic = "usage";

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report: a refused record goes to the outbox for a relay to produce later.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    gateway::outbox::insert(std::string(static_cast<const char*>(message.payload()), message.len()), message.errstr());
  }
};

ToOutbox delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// The usage event of one answered request (request: id, tenant, model, messages, latency_ms, status).
nlohmann::json build_event(const nlohmann::json& request, const nlohmann::json& usage) {
  nlohmann::json event;
  event["id"] = request["id"];
  event["tenant"] = request["tenant"];
  event["model"] = request["model"];
  event["input_tokens"] = usage["input_tokens"];
  event["output_tokens"] = usage["output_tokens"];
  event["latency_ms"] = request["latency_ms"];
  event["status"] = request["status"];
  return event;
}

// Called once the request has been answered; must not fail or delay it.
void emit_usage(const nlohmann::json& event) {
  const std::string value = event.dump();
  const std::string tenant = event["tenant"];
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), tenant.c_str(), tenant.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) gateway::outbox::insert(value, RdKafka::err2str(err));  // refused before it was queued
  producer->poll(0);  // serve delivery reports; returns at once
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "billing", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

std::string today() {
  const std::time_t now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  char day[9];
  std::strftime(day, sizeof day, "%Y%m%d", std::gmtime(&now));
  return day;
}

void run_billing() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) {
      consumer->commitSync(msg.get());  // malformed: skip it, do not replay it forever
      continue;
    }
    redis.hincrby("usage:" + event["tenant"].get<std::string>() + ":" + today(), "tokens",
                  event["input_tokens"].get<long long>() + event["output_tokens"].get<long long>());
    consumer->commitSync(msg.get());  // after the increment: a crash before this point redelivers
  }
}
`,
    },
  },
  harness: {
    python: `import contextlib
import io
import json
import logging
import time

CANARY = "CANARY-7731 my account number is 4111"


def _request(request_id="r-1", tenant="acme", content="What is the capital of France?"):
    return {"id": request_id, "tenant": tenant, "model": "gpt-4o-mini", "messages": [{"role": "user", "content": content}], "latency_ms": 812.5, "status": 200}


def _usage(input_tokens=100, output_tokens=50):
    return {"input_tokens": input_tokens, "output_tokens": output_tokens}


def _day(ctx):
    return time.strftime("%Y%m%d", time.gmtime(ctx.clock.time()))


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox:usage", 0, -1)]


def check_tenant_key(ctx):
    m = ctx.load("usage_events")
    m.emit_usage(m.build_event(_request("r-1", "acme"), _usage()))
    m.emit_usage(m.build_event(_request("r-2", "beta"), _usage(7, 3)))
    m.emit_usage(m.build_event(_request("r-3", "acme"), _usage(10, 5)))
    records = ctx.kafka.records("usage")
    assert len(records) == 3, f"three emit_usage calls produced {len(records)} records on usage (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"acme", b"beta", b"acme"], f"records must be keyed by the tenant, got {keys}"
    assert records[0].partition == records[2].partition, "one tenant's events must land on one partition so they stay in order"
    event = json.loads(records[0].value)
    assert event.get("id") == "r-1" and event.get("tenant") == "acme", f"the event id stays the request id and carries the tenant: {event}"
    for field in ("model", "input_tokens", "output_tokens", "latency_ms", "status"):
        assert field in event, f"the event is missing {field}: {event}"


def check_idempotent_acks(ctx):
    m = ctx.load("usage_events")
    ctx.kafka.lose_acks("usage", 1)
    m.emit_usage(m.build_event(_request("r-1"), _usage()))
    m.producer.poll(0)
    ids = [json.loads(r.value)["id"] for r in ctx.kafka.records("usage")]
    assert ids == ["r-1"], f"after one produce whose acknowledgement was lost the topic holds {ids}: the producer's retry wrote the record again. Enable idempotence so the broker recognises the retry"
    m.emit_usage(m.build_event(_request("r-2"), _usage()))
    m.producer.poll(0)
    ctx.kafka.failover("usage")
    ids = [json.loads(r.value)["id"] for r in ctx.kafka.records("usage")]
    assert "r-2" in ids, "a leader failover right after the acknowledgement lost the record: wait for all in-sync replicas (acks=all)"


def check_no_prompt_content(ctx):
    m = ctx.load("usage_events")
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.DEBUG)
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            m.emit_usage(m.build_event(_request("r-1", content=CANARY), _usage()))
            m.producer.poll(0)
    finally:
        logging.getLogger().removeHandler(handler)
    records = ctx.kafka.records("usage")
    assert len(records) == 1, f"one emit_usage call produced {len(records)} records"
    value = records[0].value.decode()
    assert "CANARY-7731" not in value, f"the usage event carries the prompt: {value}"
    assert "messages" not in json.loads(value), f"the usage event carries the messages: {value}"
    assert "CANARY-7731" not in captured.getvalue(), f"the prompt was printed or logged: {captured.getvalue().strip()!r}"


def check_outbox(ctx):
    m = ctx.load("usage_events")
    ctx.kafka.fail_next("usage", 1)
    event = m.build_event(_request("r-9"), _usage())
    try:
        m.emit_usage(event)
    except Exception as exc:  # noqa: BLE001 - whatever it raised is the verdict
        raise AssertionError(f"emit_usage failed the request when the broker refused the record: {exc!r}. Write the event to the outbox instead") from None
    m.producer.poll(0)
    rows = _outbox(ctx)
    assert rows, "the broker refused the record and nothing reached outbox:usage: handle the delivery report (on_delivery) and call outbox.insert(event, reason)"
    assert rows[0].get("event", {}).get("id") == "r-9", f"the outbox row must carry the event: {rows[0]}"
    assert ctx.kafka.flushes == 0, "emit_usage must not flush: the answered request would wait for the broker"
    m.emit_usage(m.build_event(_request("r-10"), _usage()))
    m.producer.poll(0)
    assert [json.loads(r.value)["id"] for r in ctx.kafka.records("usage")] == ["r-10"], "once the broker accepts records again they flow to the topic"
    assert len(_outbox(ctx)) == 1, "a delivered record must not be written to the outbox"


def check_commit_after_increment(ctx):
    day = _day(ctx)
    for request_id, tenant, usage in (("r-1", "acme", _usage(100, 50)), ("r-2", "acme", _usage(10, 5)), ("r-3", "acme", _usage(7, 3))):
        ctx.kafka.seed("usage", key=tenant, value=json.dumps({**_request(request_id, tenant), **usage, "messages": None}))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(ctx.redis.hget(f"usage:acme:{day}", "tokens")))
    m = ctx.load("usage_events")
    ctx.drain(m.run_billing)
    assert at_commit, "the consumer never committed an offset"
    assert at_commit[0] is not None and int(at_commit[0]) >= 150, f"at the first commit usage:acme:{day} held {at_commit[0]!r}: the increment must come before the commit, or a crash in between loses the charge"
    assert ctx.redis.hget(f"usage:acme:{day}", "tokens") == "175", f"usage:acme:{day} tokens is {ctx.redis.hget(f'usage:acme:{day}', 'tokens')!r}, expected 175 (150 + 15 + 10)"
    assert ctx.kafka.lag("billing", "usage") == 0, "every processed record must be committed"
`,
    typescript: `const CANARY = 'CANARY-7731 my account number is 4111';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const request = (id = 'r-1', tenant = 'acme', content = 'What is the capital of France?') => ({
  id,
  tenant,
  model: 'gpt-4o-mini',
  messages: [{role: 'user', content}],
  latency_ms: 812.5,
  status: 200,
});
const usage = (input_tokens = 100, output_tokens = 50) => ({input_tokens, output_tokens});
const day = (ctx): string => new Date(ctx.clock.now()).toISOString().slice(0, 10).replace(/-/g, '');
const outbox = (ctx): Record<string, any>[] => ctx.redis.lrange('outbox:usage', 0, -1).map((row: string) => JSON.parse(row));
const ids = (ctx): string[] => ctx.kafka.records('usage').map(r => JSON.parse(r.value.toString()).id);

export async function check_tenant_key(ctx) {
  const m = ctx.load('usage_events');
  await m.emitUsage(m.buildEvent(request('r-1', 'acme'), usage()));
  await m.emitUsage(m.buildEvent(request('r-2', 'beta'), usage(7, 3)));
  await m.emitUsage(m.buildEvent(request('r-3', 'acme'), usage(10, 5)));
  await settle();
  const records = ctx.kafka.records('usage');
  assert.equal(records.length, 3, \`three emitUsage calls produced \${records.length} records on usage\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['acme', 'beta', 'acme'], \`records must be keyed by the tenant, got \${JSON.stringify(keys)}\`);
  assert.equal(records[0].partition, records[2].partition, "one tenant's events must land on one partition so they stay in order");
  const event = JSON.parse(records[0].value.toString());
  assert(event.id === 'r-1' && event.tenant === 'acme', \`the event id stays the request id and carries the tenant: \${records[0].value}\`);
  for (const field of ['model', 'input_tokens', 'output_tokens', 'latency_ms', 'status']) assert(field in event, \`the event is missing \${field}: \${records[0].value}\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('usage_events');
  ctx.kafka.loseAcks('usage', 1);
  await m.emitUsage(m.buildEvent(request('r-1'), usage()));
  await settle();
  assert.deepStrictEqual(ids(ctx), ['r-1'], \`after one produce whose acknowledgement was lost the topic holds \${JSON.stringify(ids(ctx))}: the producer's retry wrote the record again. Enable idempotence so the broker recognises the retry\`);
  await m.emitUsage(m.buildEvent(request('r-2'), usage()));
  await settle();
  ctx.kafka.failover('usage');
  assert(ids(ctx).includes('r-2'), 'a leader failover right after the acknowledgement lost the record: wait for all in-sync replicas (acks: -1)');
}

export async function check_no_prompt_content(ctx) {
  const m = ctx.load('usage_events');
  const logged: string[] = [];
  const prior = {log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  try {
    await m.emitUsage(m.buildEvent(request('r-1', 'acme', CANARY), usage()));
    await settle();
  } finally {
    Object.assign(console, prior);
  }
  const records = ctx.kafka.records('usage');
  assert.equal(records.length, 1, \`one emitUsage call produced \${records.length} records\`);
  const value = records[0].value.toString();
  assert(!value.includes('CANARY-7731'), \`the usage event carries the prompt: \${value}\`);
  assert(!('messages' in JSON.parse(value)), \`the usage event carries the messages: \${value}\`);
  const leak = logged.find(l => l.includes('CANARY-7731'));
  assert(leak === undefined, \`the prompt was printed or logged: \${JSON.stringify(leak)}\`);
}

export async function check_outbox(ctx) {
  const m = ctx.load('usage_events');
  ctx.kafka.failNext('usage', 1);
  try {
    await m.emitUsage(m.buildEvent(request('r-9'), usage()));
  } catch (e) {
    assert.fail(\`emitUsage failed the request when the broker refused the record: \${e}. Write the event to the outbox instead\`);
  }
  await settle();
  const rows = outbox(ctx);
  assert(rows.length > 0, 'the broker refused the record and nothing reached outbox:usage: catch the rejected send and call outbox.insert(event, reason)');
  assert.equal(rows[0].event?.id, 'r-9', \`the outbox row must carry the event: \${JSON.stringify(rows[0])}\`);
  await m.emitUsage(m.buildEvent(request('r-10'), usage()));
  await settle();
  assert.deepStrictEqual(ids(ctx), ['r-10'], 'once the broker accepts records again they flow to the topic');
  assert.equal(outbox(ctx).length, 1, 'a delivered record must not be written to the outbox');
}

export async function check_commit_after_increment(ctx) {
  const today = day(ctx);
  for (const [id, tenant, u] of [['r-1', 'acme', usage(100, 50)], ['r-2', 'acme', usage(10, 5)], ['r-3', 'acme', usage(7, 3)]] as const) {
    ctx.kafka.seed('usage', {key: tenant, value: JSON.stringify({...request(id, tenant), ...u, messages: null})});
  }
  const atCommit: (string | null)[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.hget(\`usage:acme:\${today}\`, 'tokens')));
  const m = ctx.load('usage_events');
  await ctx.drain(m.runBilling());
  assert(atCommit.length > 0, 'the consumer never committed an offset');
  assert(atCommit[0] !== null && Number(atCommit[0]) >= 150, \`at the first commit usage:acme:\${today} held \${JSON.stringify(atCommit[0])}: the increment must come before the commit, or a crash in between loses the charge\`);
  assert.equal(ctx.redis.hget(\`usage:acme:\${today}\`, 'tokens'), '175', \`usage:acme:\${today} tokens is \${JSON.stringify(ctx.redis.hget(\`usage:acme:\${today}\`, 'tokens'))}, expected 175 (150 + 15 + 10)\`);
  assert.equal(ctx.kafka.lag('billing', 'usage'), 0, 'every processed record must be committed');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"sort"
	"strings"
	"time"

	"leetbuild/harness"
)

const usageCanary = "CANARY-7731 my account number is 4111"

func usageRequest(id, tenant, content string) AnsweredRequest {
	return AnsweredRequest{ID: id, Tenant: tenant, Model: "gpt-4o-mini", Messages: []chatMessage{{Role: "user", Content: content}}, LatencyMs: 812.5, Status: 200}
}

func usageDay(ctx *harness.Ctx) string {
	return time.UnixMilli(ctx.Clock.Now()).UTC().Format("20060102")
}

func usageIDs(ctx *harness.Ctx) []string {
	ids := []string{}
	for _, r := range ctx.Kafka.Records("usage") {
		var v map[string]any
		json.Unmarshal(r.Value, &v)
		id, _ := v["id"].(string)
		ids = append(ids, id)
	}
	return ids
}

func usageOutbox(ctx *harness.Ctx) []map[string]any {
	var rows []map[string]any
	for _, row := range ctx.Redis.LRange("outbox:usage", 0, -1) {
		var v map[string]any
		json.Unmarshal([]byte(row), &v)
		rows = append(rows, v)
	}
	return rows
}

func CheckTenantKey(ctx *harness.Ctx) {
	emitUsage(context.Background(), buildEvent(usageRequest("r-1", "acme", "hi"), Usage{100, 50}))
	emitUsage(context.Background(), buildEvent(usageRequest("r-2", "beta", "hi"), Usage{7, 3}))
	emitUsage(context.Background(), buildEvent(usageRequest("r-3", "acme", "hi"), Usage{10, 5}))
	ctx.Settle()
	records := ctx.Kafka.Records("usage")
	ctx.Equal(len(records), 3, "three emitUsage calls must produce three records on usage; the records")
	keys := ctx.Kafka.Keys("usage")
	sort.Strings(keys)
	ctx.Equal(keys, []string{"acme", "acme", "beta"}, "records must be keyed by the tenant (an async writer batches per partition, so the order across tenants is free)")
	var acme []int
	var first map[string]any
	for _, r := range records {
		var event map[string]any
		ctx.NoError(json.Unmarshal(r.Value, &event), "the event must be JSON: %s", r.Value)
		if string(r.Key) == "acme" {
			acme = append(acme, r.Partition)
		}
		if event["id"] == "r-1" {
			first = event
		}
	}
	ctx.Assert(len(acme) == 2 && acme[0] == acme[1], "one tenant's events must land on one partition so they stay in order; acme's partitions %v", acme)
	ctx.Assert(first != nil && first["tenant"] == "acme", "the event id stays the request id and carries the tenant: %v", first)
	event := first
	for _, field := range []string{"model", "input_tokens", "output_tokens", "latency_ms", "status"} {
		_, ok := event[field]
		ctx.Assert(ok, "the event is missing %s: %s", field, records[0].Value)
	}
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	emitUsage(context.Background(), buildEvent(usageRequest("r-2", "acme", "hi"), Usage{100, 50}))
	ctx.Settle()
	ctx.Equal(usageIDs(ctx), []string{"r-2"}, "one emitUsage call; the records on usage")
	ctx.Kafka.Failover("usage")
	ctx.Equal(usageIDs(ctx), []string{"r-2"}, "a leader failover right after the acknowledgement must keep the record: wait for all in-sync replicas (RequireAll); the records")
}

func CheckNoPromptContent(ctx *harness.Ctx) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	emitUsage(context.Background(), buildEvent(usageRequest("r-1", "acme", usageCanary), Usage{100, 50}))
	ctx.Settle()
	records := ctx.Kafka.Records("usage")
	ctx.Equal(len(records), 1, "one emitUsage call; the records")
	value := string(records[0].Value)
	ctx.Assert(!strings.Contains(value, "CANARY-7731"), "the usage event carries the prompt: %s", value)
	var event map[string]any
	json.Unmarshal(records[0].Value, &event)
	_, hasMessages := event["messages"]
	ctx.Assert(!hasMessages, "the usage event carries the messages: %s", value)
	ctx.Assert(!strings.Contains(logged.String(), "CANARY-7731"), "the prompt was printed or logged: %q", strings.TrimSpace(logged.String()))
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext("usage", 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("emitUsage failed the request when the broker refused the record: %v. Write the event to the outbox instead", e)
			}
		}()
		emitUsage(context.Background(), buildEvent(usageRequest("r-9", "acme", "hi"), Usage{100, 50}))
	}()
	ctx.Settle()
	rows := usageOutbox(ctx)
	ctx.Assert(len(rows) > 0, "the broker refused the record and nothing reached outbox:usage: handle the failed write (Completion, or WriteMessages' error) with outbox.Insert")
	event, _ := rows[0]["event"].(map[string]any)
	ctx.Equal(event["id"], "r-9", "the outbox row must carry the event; the row %v; its id", rows[0])
	emitUsage(context.Background(), buildEvent(usageRequest("r-10", "acme", "hi"), Usage{100, 50}))
	ctx.Settle()
	ctx.Equal(usageIDs(ctx), []string{"r-10"}, "once the broker accepts records again they flow to the topic; the records")
	ctx.Equal(len(usageOutbox(ctx)), 1, "a delivered record must not be written to the outbox; the rows")
}

func CheckCommitAfterIncrement(ctx *harness.Ctx) {
	day := usageDay(ctx)
	for _, r := range []struct {
		id, tenant string
		in, out    int
	}{{"r-1", "acme", 100, 50}, {"r-2", "acme", 10, 5}, {"r-3", "acme", 7, 3}} {
		value, _ := json.Marshal(map[string]any{"id": r.id, "tenant": r.tenant, "model": "gpt-4o-mini", "input_tokens": r.in, "output_tokens": r.out, "latency_ms": 812.5, "status": 200})
		ctx.Kafka.Seed("usage", r.tenant, string(value))
	}
	var atCommit []string
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		v, _ := ctx.Redis.HGet("usage:acme:"+day, "tokens")
		atCommit = append(atCommit, v)
	})
	ctx.Drain(func() { runBilling(context.Background()) })
	ctx.Assert(len(atCommit) > 0, "the consumer never committed an offset")
	ctx.Assert(atCommit[0] == "150" || atCommit[0] == "165" || atCommit[0] == "175", "at the first commit usage:acme:%s held %q: the increment must come before the commit, or a crash in between loses the charge", day, atCommit[0])
	acme, _ := ctx.Redis.HGet("usage:acme:"+day, "tokens")
	ctx.Equal(acme, "175", "usage:acme:%s tokens (150 + 15 + 10)", day)
	ctx.Equal(ctx.Kafka.Lag("billing", "usage"), 0, "every processed record must be committed; the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <ctime>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

const std::string kUsageCanary = "CANARY-7731 my account number is 4111";

nlohmann::json usageRequest(const std::string& id, const std::string& tenant, const std::string& content) {
  nlohmann::json r;
  r["id"] = id;
  r["tenant"] = tenant;
  r["model"] = "gpt-4o-mini";
  r["messages"] = nlohmann::json::array({{{"role", "user"}, {"content", content}}});
  r["latency_ms"] = 812.5;
  r["status"] = 200;
  return r;
}

nlohmann::json usageOf(int in, int out) { return {{"input_tokens", in}, {"output_tokens", out}}; }

std::string usageDay(harness::Ctx& ctx) {
  const std::time_t t = ctx.Clock.Now() / 1000;
  char day[9];
  std::strftime(day, sizeof day, "%Y%m%d", std::gmtime(&t));
  return day;
}

std::vector<std::string> usageIDs(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (const auto& r : ctx.Kafka.Records("usage")) {
    const auto v = nlohmann::json::parse(r.Value.value_or(""), nullptr, false);
    ids.push_back(v.is_object() ? v.value("id", "") : "");
  }
  return ids;
}

std::vector<nlohmann::json> usageOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& row : ctx.Redis.LRange("outbox:usage", 0, -1)) rows.push_back(nlohmann::json::parse(row, nullptr, false));
  return rows;
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  emit_usage(build_event(usageRequest("r-1", "acme", "hi"), usageOf(100, 50)));
  emit_usage(build_event(usageRequest("r-2", "beta", "hi"), usageOf(7, 3)));
  emit_usage(build_event(usageRequest("r-3", "acme", "hi"), usageOf(10, 5)));
  ctx.Settle();
  const auto records = ctx.Kafka.Records("usage");
  ctx.Equal(records.size(), 3, "three emit_usage calls must produce three records on usage; the records");
  ctx.Equal(ctx.Kafka.Keys("usage"), {"acme", "beta", "acme"}, "records must be keyed by the tenant");
  ctx.Equal(records[0].Partition, records[2].Partition, "one tenant's events must land on one partition so they stay in order; acme's partitions");
  const auto event = nlohmann::json::parse(records[0].Value.value_or(""), nullptr, false);
  ctx.Assert(event.is_object() && event.value("id", "") == "r-1" && event.value("tenant", "") == "acme",
             "the event id stays the request id and carries the tenant: %s", records[0].Value.value_or(""));
  for (const std::string field : {"model", "input_tokens", "output_tokens", "latency_ms", "status"}) {
    ctx.Assert(event.contains(field), "the event is missing %s: %s", field, records[0].Value.value_or(""));
  }
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks("usage", 1);
  emit_usage(build_event(usageRequest("r-1", "acme", "hi"), usageOf(100, 50)));
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(usageIDs(ctx), {"r-1"},
            "after one produce whose acknowledgement was lost the topic must hold the record once (the producer's retry wrote it again: enable idempotence so the broker recognises the retry); the records");
  emit_usage(build_event(usageRequest("r-2", "acme", "hi"), usageOf(100, 50)));
  producer->poll(0);
  ctx.Settle();
  ctx.Kafka.Failover("usage");
  const auto ids = usageIDs(ctx);
  ctx.Assert(std::find(ids.begin(), ids.end(), "r-2") != ids.end(), "a leader failover right after the acknowledgement lost the record: wait for all in-sync replicas (acks=all)");
}

void CheckNoPromptContent(harness::Ctx& ctx) {
  std::ostringstream logged;
  auto* out = std::cout.rdbuf(logged.rdbuf());
  auto* err = std::cerr.rdbuf(logged.rdbuf());
  emit_usage(build_event(usageRequest("r-1", "acme", kUsageCanary), usageOf(100, 50)));
  producer->poll(0);
  std::cout.rdbuf(out);
  std::cerr.rdbuf(err);
  ctx.Settle();
  const auto records = ctx.Kafka.Records("usage");
  ctx.Equal(records.size(), 1, "one emit_usage call; the records");
  const std::string value = records[0].Value.value_or("");
  ctx.Assert(value.find("CANARY-7731") == std::string::npos, "the usage event carries the prompt: %s", value);
  const auto event = nlohmann::json::parse(value, nullptr, false);
  ctx.Assert(event.is_object() && !event.contains("messages"), "the usage event carries the messages: %s", value);
  ctx.Assert(logged.str().find("CANARY-7731") == std::string::npos, "the prompt was printed or logged: %q", logged.str());
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext("usage", 1);
  try {
    emit_usage(build_event(usageRequest("r-9", "acme", "hi"), usageOf(100, 50)));
  } catch (const std::exception& e) {
    ctx.Fatalf("emit_usage failed the request when the broker refused the record: %s. Write the event to the outbox instead", e.what());
  }
  producer->poll(0);
  ctx.Settle();
  const auto rows = usageOutbox(ctx);
  ctx.Assert(!rows.empty(), "the broker refused the record and nothing reached outbox:usage: handle the delivery report (dr_cb) with gateway::outbox::insert");
  ctx.Assert(rows[0].is_object() && rows[0].contains("event") && rows[0]["event"].value("id", "") == "r-9", "the outbox row must carry the event: %s", rows[0].dump());
  ctx.Equal(ctx.Kafka.Flushes(), 0, "emit_usage must not flush (the answered request would wait for the broker); the flushes");
  emit_usage(build_event(usageRequest("r-10", "acme", "hi"), usageOf(100, 50)));
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(usageIDs(ctx), {"r-10"}, "once the broker accepts records again they flow to the topic; the records");
  ctx.Equal(usageOutbox(ctx).size(), 1, "a delivered record must not be written to the outbox; the rows");
}

void CheckCommitAfterIncrement(harness::Ctx& ctx) {
  const std::string day = usageDay(ctx);
  struct Seed {
    const char* id;
    const char* tenant;
    int in, out;
  };
  for (const Seed s : {Seed{"r-1", "acme", 100, 50}, Seed{"r-2", "acme", 10, 5}, Seed{"r-3", "acme", 7, 3}}) {
    nlohmann::json v = {{"id", s.id}, {"tenant", s.tenant}, {"model", "gpt-4o-mini"}, {"input_tokens", s.in}, {"output_tokens", s.out}, {"latency_ms", 812.5}, {"status", 200}};
    ctx.Kafka.Seed("usage", s.tenant, v.dump());
  }
  std::vector<std::optional<std::string>> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(ctx.Redis.HGet("usage:acme:" + day, "tokens")); });
  ctx.Drain([] { run_billing(); });
  ctx.Assert(!atCommit.empty(), "the consumer never committed an offset");
  ctx.Assert(atCommit[0] && (*atCommit[0] == "150" || *atCommit[0] == "165" || *atCommit[0] == "175"), "at the first commit usage:acme:%s held %v: the increment must come before the commit, or a crash in between loses the charge", day, atCommit[0]);
  ctx.Equal(ctx.Redis.HGet("usage:acme:" + day, "tokens"), "175", "usage:acme:%s tokens (150 + 15 + 10)", day);
  ctx.Equal(ctx.Kafka.Lag("billing", "usage"), 0, "every processed record must be committed; the lag");
}
`,
  },
  debrief: `Each flaw here is a guarantee that holds on a quiet day and breaks on a loud one. The key is an ordering decision: a partition is the only place Kafka orders anything, so a tenant's events need one. Idempotence plus \`acks=all\` is a durability decision: the retry after a lost acknowledgement is recognised by sequence number, and a leader failover keeps what every replica has. The outbox is an availability decision made in the delivery callback, where the broker's refusal actually arrives; the request itself was answered long before. Increment-then-commit makes a crash cost a duplicate rather than a loss, which is the right side to err on for billing. Production pipelines make the consumer idempotent too (a seen-set keyed by event id), relay the outbox on a timer, and reconcile Redis against the warehouse nightly.`,
};
