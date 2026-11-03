import type {Step} from '@/lib/types';

// ---- 4. Feedback events to Kafka and the quality consumer ------------------------------------------
export const feedbackEventsStep: Step = {
  id: 'feedback-events',
  title: 'One feedback event per request, counted once',
  concept: 'kafka',
  file: 'feedback',
  focus: ['router', 'kafka', 'quality', 'redis'],
  task: `## Task

**Starting point.** The starter is the feedback pipeline. \`build_event(routed)\` turns a rated
request (\`id\`, \`tenant\`, \`policy\`, \`model\`, \`prompt\`, \`outcome\` of \`good\` or \`bad\`,
\`latency_ms\`) into the event; \`emit_feedback(event)\` produces it to \`route.feedback\` keyed by
the request id, writes it to the provided outbox (\`insert(event, reason)\`, the Redis list
\`outbox:feedback\`) when the produce call itself fails, and logs a line; \`run_quality()\` consumes
as group \`quality\` with auto-commit off, commits, then runs
\`HINCRBY quality:{tenant}:{model} <outcome> 1\`. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** A tenant's events spread over every partition, a lost
acknowledgement that writes an event twice, a prompt in a topic retained for days, a refused
delivery the outbox never sees, and a consumer crash between commit and increment that loses a
verdict.

- The record key is the **tenant**; the event id stays the request id.
- The producer is **idempotent** with \`acks=all\` (kafka-go has no idempotent mode: \`RequireAll\`
  is what it can promise).
- The event is \`{id, tenant, policy, model, outcome, latency_ms}\`; the prompt is in neither the
  event nor a log line.
- A refusal arrives in the **delivery callback**, and that is where the outbox write belongs; the
  request path does not wait for the broker.
- \`run_quality\` increments **before** it commits.`,
  sequence: {
    participants: ['routerd', 'route.feedback', 'quality', 'Redis'],
    messages: [
      {from: 'routerd', to: 'routerd', label: 'answer rated · build_event', kind: 'sync'},
      {from: 'routerd', to: 'route.feedback', label: 'produce key=acme · acks=all · idempotent', kind: 'async'},
      {from: 'route.feedback', to: 'routerd', label: 'delivery report: error → outbox:feedback', kind: 'reply'},
      {from: 'route.feedback', to: 'quality', label: 'consume', kind: 'async'},
      {from: 'quality', to: 'Redis', label: 'HINCRBY quality:acme:gpt-4o-mini good 1', kind: 'sync'},
      {from: 'quality', to: 'route.feedback', label: 'commit offset (after the increment)', kind: 'sync'},
    ],
  },
  hints: [
    "The quality dashboard counts one verdict twice on the day the broker hiccuped and misses another after the consumer restarted; a customer's prompt turns up in the topic; the outbox stays empty through a broker outage.",
    'A key of request id spreads a tenant over the partitions; a producer without idempotence rewrites a record whose ack was lost; `produce` raising only covers the local queue, the broker refuses later; commit before increment loses the increment on a crash.',
    'Key by `event["tenant"]`; set `enable.idempotence` and `acks=all`; drop `prompt` from the event and the log; pass `on_delivery` that calls `outbox.insert(event, reason)` on error and serve it with `poll(0)`; `HINCRBY`, then commit.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Produces with the tenant as the key',
      detail:
        "The record key is the tenant, so one tenant's feedback lands on one partition in order; keyed by request id a tenant is spread across all of them.",
      match: {
        python: {all: [/\.produce\([^)]*key\s*=\s*event\[["']tenant["']\]/]},
        typescript: {all: [/key:\s*event\.tenant/]},
        go: {all: [/Key:\s*\[\]byte\(\s*event\.Tenant\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"route\.feedback")\s*,\s*event\.tenant/]},
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
      id: 'no-prompt',
      title: 'No prompt in the event or the logs',
      detail:
        'The event is ids, the model, the outcome and the latency; the prompt is neither serialised into the record nor logged. The topic is retained for days and read by every consumer group.',
      match: {
        python: {none: [/["']prompt["']\s*:/, /logg?(er|ing)\.[a-z]+\([^\n]*prompt/i, /print\([^\n]*prompt/i]},
        typescript: {none: [/\bprompt:\s*routed\.prompt/, /console\.(log|info|debug|warn)\([^\n]*prompt/i]},
        go: {none: [/Prompt:\s*routed\.Prompt/, /(log|fmt)\.Print[a-z]*\([^\n]*Prompt/]},
        scala: {none: [/"prompt"\s*->/, /println\([^\n]*prompt/i]},
        cpp: {none: [/\["prompt"\]\s*=/, /std::c(out|err)[^\n]*prompt/i]},
      },
    },
    {
      id: 'outbox',
      title: 'A refused delivery goes to the outbox',
      detail:
        "The broker's refusal arrives in the delivery callback (`on_delivery`, the send promise's rejection, `Completion`, the `Callback`, `dr_cb`), and that is where `outbox.insert(event, reason)` runs; an exception from the produce call covers only the local queue.",
      match: {
        python: {all: [/outbox\.insert\(/, /on_delivery\s*=|callback\s*=/], none: [/except KafkaException/]},
        typescript: {all: [/outbox\.insert\(/, /\.catch\(/]},
        go: {all: [/outbox\.Insert\(/, /Completion:/]},
        scala: {all: [/Outbox\.insert\(/, /Callback/]},
        cpp: {all: [/outbox::insert\(/, /dr_cb/]},
      },
    },
    {
      id: 'commit-after-increment',
      title: 'HINCRBY before the offset commit',
      detail:
        'The consumer increments `quality:{tenant}:{model}` and only then commits; a crash between a commit and the increment loses the verdict.',
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

import redis
from confluent_kafka import Consumer, KafkaException, Producer

from routerd import outbox

TOPIC = "route.feedback"
logger = logging.getLogger("feedback")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


# TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
def build_event(routed: dict) -> dict:
    """The feedback event of one routed request and the user's verdict on its answer."""
    return {
        "id": routed["id"],
        "tenant": routed["tenant"],
        "policy": routed["policy"],
        "model": routed["model"],
        "prompt": routed["prompt"],
        "outcome": routed["outcome"],
        "latency_ms": routed["latency_ms"],
    }


def emit_feedback(event: dict) -> None:
    """Called once the user has rated the answer; must not fail or delay the request."""
    try:
        producer.produce(TOPIC, key=event["id"], value=json.dumps(event))
    except KafkaException as exc:
        outbox.insert(event, str(exc))
    logger.info("feedback %s prompt=%s", event["id"], event["prompt"])
    producer.poll(0)


def run_quality() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "quality", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        consumer.commit(record, asynchronous=False)
        event = json.loads(record.value())
        r.hincrby(f"quality:{event['tenant']}:{event['model']}", event["outcome"], 1)
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from routerd import outbox

TOPIC = "route.feedback"
logger = logging.getLogger("feedback")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def build_event(routed: dict) -> dict:
    """The feedback event of one routed request and the user's verdict on its answer."""
    return {
        "id": routed["id"],
        "tenant": routed["tenant"],
        "policy": routed["policy"],
        "model": routed["model"],
        "outcome": routed["outcome"],
        "latency_ms": routed["latency_ms"],
    }


def on_delivery(err, msg) -> None:
    if err is not None:
        outbox.insert(json.loads(msg.value()), str(err))  # the broker refused it: a relay produces it later


def emit_feedback(event: dict) -> None:
    """Called once the user has rated the answer; must not fail or delay the request."""
    try:
        producer.produce(TOPIC, key=event["tenant"], value=json.dumps(event), on_delivery=on_delivery)
    except BufferError:
        outbox.insert(event, "producer queue full")
    logger.info("feedback %s model=%s outcome=%s", event["id"], event["model"], event["outcome"])
    producer.poll(0)  # serve delivery reports; returns at once


def run_quality() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "quality", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        event = json.loads(record.value())
        r.hincrby(f"quality:{event['tenant']}:{event['model']}", event["outcome"], 1)
        consumer.commit(record, asynchronous=False)  # after the increment: a crash before this point redelivers
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';
import * as outbox from 'routerd/outbox';

export const TOPIC = 'route.feedback';

const kafka = new Kafka({clientId: 'routerd', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

/** What routerd knows once the user has rated an answer. */
export interface RoutedRequest {
  id: string;
  tenant: string;
  policy: string;
  model: string;
  prompt: string;
  outcome: 'good' | 'bad';
  latency_ms: number;
}
export interface FeedbackEvent {
  id: string;
  tenant: string;
  policy: string;
  model: string;
  outcome: 'good' | 'bad';
  latency_ms: number;
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
/** The feedback event of one routed request and the user's verdict on its answer. */
export function buildEvent(routed: RoutedRequest): FeedbackEvent {
  return {
    id: routed.id,
    tenant: routed.tenant,
    policy: routed.policy,
    model: routed.model,
    prompt: routed.prompt,
    outcome: routed.outcome,
    latency_ms: routed.latency_ms,
  } as FeedbackEvent;
}

/** Called once the user has rated the answer; must not fail or delay the request. */
export function emitFeedback(event: FeedbackEvent): void {
  try {
    void producer.send({topic: TOPIC, messages: [{key: event.id, value: JSON.stringify(event)}]});
  } catch (err) {
    void outbox.insert(event as unknown as Record<string, unknown>, String(err));
  }
  console.log('feedback', event.id, 'prompt=', (event as unknown as {prompt: string}).prompt);
}

export async function runQuality(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'quality'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as FeedbackEvent;
      await redis.hincrby(\`quality:\${event.tenant}:\${event.model}\`, event.outcome, 1);
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';
import * as outbox from 'routerd/outbox';

export const TOPIC = 'route.feedback';

const kafka = new Kafka({clientId: 'routerd', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true}); // idempotent implies acks: -1 (all)
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

/** What routerd knows once the user has rated an answer. */
export interface RoutedRequest {
  id: string;
  tenant: string;
  policy: string;
  model: string;
  prompt: string;
  outcome: 'good' | 'bad';
  latency_ms: number;
}
export interface FeedbackEvent {
  id: string;
  tenant: string;
  policy: string;
  model: string;
  outcome: 'good' | 'bad';
  latency_ms: number;
}

/** The feedback event of one routed request and the user's verdict on its answer. */
export function buildEvent(routed: RoutedRequest): FeedbackEvent {
  return {
    id: routed.id,
    tenant: routed.tenant,
    policy: routed.policy,
    model: routed.model,
    outcome: routed.outcome,
    latency_ms: routed.latency_ms,
  };
}

/** Called once the user has rated the answer; must not fail or delay the request. */
export function emitFeedback(event: FeedbackEvent): void {
  // Not awaited: the request is already answered. A refused delivery goes to the outbox for a relay.
  producer
    .send({topic: TOPIC, messages: [{key: event.tenant, value: JSON.stringify(event)}], acks: -1})
    .catch((err: Error) => outbox.insert(event as unknown as Record<string, unknown>, err.message));
  console.log('feedback', event.id, event.model, event.outcome);
}

export async function runQuality(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'quality'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as FeedbackEvent;
      await redis.hincrby(\`quality:\${event.tenant}:\${event.model}\`, event.outcome, 1);
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"routerd/outbox"
)

const topic = "route.feedback"

// Async: WriteMessages hands the record over and returns.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	Async:        true,
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// routedRequest is what routerd knows once the user has rated an answer.
type routedRequest struct {
	ID        string  \`json:"id"\`
	Tenant    string  \`json:"tenant"\`
	Policy    string  \`json:"policy"\`
	Model     string  \`json:"model"\`
	Prompt    string  \`json:"prompt"\`
	Outcome   string  \`json:"outcome"\`
	LatencyMs float64 \`json:"latency_ms"\`
}

type feedbackEvent struct {
	ID        string  \`json:"id"\`
	Tenant    string  \`json:"tenant"\`
	Policy    string  \`json:"policy"\`
	Model     string  \`json:"model"\`
	Prompt    string  \`json:"prompt,omitempty"\`
	Outcome   string  \`json:"outcome"\`
	LatencyMs float64 \`json:"latency_ms"\`
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// buildEvent is the feedback event of one routed request and the user's verdict on its answer.
func buildEvent(routed routedRequest) feedbackEvent {
	return feedbackEvent{
		ID:        routed.ID,
		Tenant:    routed.Tenant,
		Policy:    routed.Policy,
		Model:     routed.Model,
		Prompt:    routed.Prompt,
		Outcome:   routed.Outcome,
		LatencyMs: routed.LatencyMs,
	}
}

// emitFeedback is called once the user has rated the answer; it must not fail or delay the request.
func emitFeedback(ctx context.Context, event feedbackEvent) {
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.ID), Value: value}); err != nil {
		outbox.Insert(ctx, value, err.Error())
	}
	log.Printf("feedback %s prompt=%q", event.ID, event.Prompt)
}

func runQuality(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "quality", Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event feedbackEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			continue
		}
		if err := rdb.HIncrBy(ctx, "quality:"+event.Tenant+":"+event.Model, event.Outcome, 1).Err(); err != nil {
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"routerd/outbox"
)

const topic = "route.feedback"

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

// routedRequest is what routerd knows once the user has rated an answer.
type routedRequest struct {
	ID        string  \`json:"id"\`
	Tenant    string  \`json:"tenant"\`
	Policy    string  \`json:"policy"\`
	Model     string  \`json:"model"\`
	Prompt    string  \`json:"prompt"\`
	Outcome   string  \`json:"outcome"\`
	LatencyMs float64 \`json:"latency_ms"\`
}

type feedbackEvent struct {
	ID        string  \`json:"id"\`
	Tenant    string  \`json:"tenant"\`
	Policy    string  \`json:"policy"\`
	Model     string  \`json:"model"\`
	Outcome   string  \`json:"outcome"\`
	LatencyMs float64 \`json:"latency_ms"\`
}

// buildEvent is the feedback event of one routed request and the user's verdict on its answer.
func buildEvent(routed routedRequest) feedbackEvent {
	return feedbackEvent{
		ID:        routed.ID,
		Tenant:    routed.Tenant,
		Policy:    routed.Policy,
		Model:     routed.Model,
		Outcome:   routed.Outcome,
		LatencyMs: routed.LatencyMs,
	}
}

// emitFeedback is called once the user has rated the answer; it must not fail or delay the request.
func emitFeedback(ctx context.Context, event feedbackEvent) {
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.Tenant), Value: value}); err != nil {
		outbox.Insert(ctx, value, err.Error()) // refused before it was even queued
	}
	log.Printf("feedback %s model=%s outcome=%s", event.ID, event.Model, event.Outcome)
}

func runQuality(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "quality", Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event feedbackEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		if err := rdb.HIncrBy(ctx, "quality:"+event.Tenant+":"+event.Model, event.Outcome, 1).Err(); err != nil {
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
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import routerd.Outbox

import scala.jdk.CollectionConverters._

object Feedback {
  val Topic = "route.feedback"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)

  /** What routerd knows once the user has rated an answer. */
  case class RoutedRequest(id: String, tenant: String, policy: String, model: String, prompt: String, outcome: String, latencyMs: Double)
  case class FeedbackEvent(json: ujson.Obj) {
    def id: String = json("id").str
    def tenant: String = json("tenant").str
  }

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  /** The feedback event of one routed request and the user's verdict on its answer. */
  def buildEvent(routed: RoutedRequest): FeedbackEvent = FeedbackEvent(
    ujson.Obj(
      "id" -> routed.id,
      "tenant" -> routed.tenant,
      "policy" -> routed.policy,
      "model" -> routed.model,
      "prompt" -> routed.prompt,
      "outcome" -> routed.outcome,
      "latency_ms" -> routed.latencyMs,
    )
  )

  /** Called once the user has rated the answer; must not fail or delay the request. */
  def emitFeedback(event: FeedbackEvent): Unit = {
    val value = ujson.write(event.json)
    try producer.send(new ProducerRecord[String, String](Topic, event.id, value))
    catch {
      case e: KafkaException => Outbox.insert(value, e.getMessage)
    }
    println(s"feedback \${event.id} prompt=\${event.json("prompt")}")
  }

  def runQuality(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "quality")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync()
        val event = ujson.read(record.value())
        jedis.hincrBy(s"quality:\${event("tenant").str}:\${event("model").str}", event("outcome").str, 1)
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
import redis.clients.jedis.JedisPooled
import routerd.Outbox

import scala.jdk.CollectionConverters._

object Feedback {
  val Topic = "route.feedback"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)

  /** What routerd knows once the user has rated an answer. */
  case class RoutedRequest(id: String, tenant: String, policy: String, model: String, prompt: String, outcome: String, latencyMs: Double)
  case class FeedbackEvent(json: ujson.Obj) {
    def id: String = json("id").str
    def tenant: String = json("tenant").str
  }

  /** The feedback event of one routed request and the user's verdict on its answer. */
  def buildEvent(routed: RoutedRequest): FeedbackEvent = FeedbackEvent(
    ujson.Obj(
      "id" -> routed.id,
      "tenant" -> routed.tenant,
      "policy" -> routed.policy,
      "model" -> routed.model,
      "outcome" -> routed.outcome,
      "latency_ms" -> routed.latencyMs,
    )
  )

  /** Called once the user has rated the answer; must not fail or delay the request. */
  def emitFeedback(event: FeedbackEvent): Unit = {
    val value = ujson.write(event.json)
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) Outbox.insert(value, exception.getMessage) // the broker refused it: a relay produces it later
    }
    producer.send(new ProducerRecord[String, String](Topic, event.tenant, value), onDelivery) // not awaited
    println(s"feedback \${event.id} \${event.json("model").str} \${event.json("outcome").str}")
  }

  def runQuality(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "quality")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = ujson.read(record.value())
        jedis.hincrBy(s"quality:\${event("tenant").str}:\${event("model").str}", event("outcome").str, 1)
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

#include <iostream>
#include <memory>
#include <string>

#include "routerd/outbox.h"

const std::string kTopic = "route.feedback";

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// The feedback event of one routed request (id, tenant, policy, model, prompt, outcome, latency_ms).
nlohmann::json build_event(const nlohmann::json& routed) {
  nlohmann::json event;
  event["id"] = routed["id"];
  event["tenant"] = routed["tenant"];
  event["policy"] = routed["policy"];
  event["model"] = routed["model"];
  event["prompt"] = routed["prompt"];
  event["outcome"] = routed["outcome"];
  event["latency_ms"] = routed["latency_ms"];
  return event;
}

// Called once the user has rated the answer; must not fail or delay the request.
void emit_feedback(const nlohmann::json& event) {
  const std::string value = event.dump();
  const std::string id = event["id"];
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), id.c_str(), id.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) routerd::outbox::insert(value, RdKafka::err2str(err));
  std::cout << "feedback " << id << " prompt=" << event["prompt"].dump() << "\\n";
  producer->poll(0);
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "quality", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

void run_quality() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) continue;
    redis.hincrby("quality:" + event["tenant"].get<std::string>() + ":" + event["model"].get<std::string>(),
                  event["outcome"].get<std::string>(), 1);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>

#include "routerd/outbox.h"

const std::string kTopic = "route.feedback";

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report: a refused record goes to the outbox for a relay to produce later.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    routerd::outbox::insert(std::string(static_cast<const char*>(message.payload()), message.len()), message.errstr());
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

// The feedback event of one routed request (id, tenant, policy, model, prompt, outcome, latency_ms).
nlohmann::json build_event(const nlohmann::json& routed) {
  nlohmann::json event;
  event["id"] = routed["id"];
  event["tenant"] = routed["tenant"];
  event["policy"] = routed["policy"];
  event["model"] = routed["model"];
  event["outcome"] = routed["outcome"];
  event["latency_ms"] = routed["latency_ms"];
  return event;
}

// Called once the user has rated the answer; must not fail or delay the request.
void emit_feedback(const nlohmann::json& event) {
  const std::string value = event.dump();
  const std::string tenant = event["tenant"];
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), tenant.c_str(), tenant.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) routerd::outbox::insert(value, RdKafka::err2str(err));  // refused before it was queued
  std::cout << "feedback " << event["id"].get<std::string>() << " " << event["model"].get<std::string>() << " "
            << event["outcome"].get<std::string>() << "\\n";
  producer->poll(0);  // serve delivery reports; returns at once
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "quality", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

void run_quality() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) {
      consumer->commitSync(msg.get());  // malformed: skip it, do not replay it forever
      continue;
    }
    redis.hincrby("quality:" + event["tenant"].get<std::string>() + ":" + event["model"].get<std::string>(),
                  event["outcome"].get<std::string>(), 1);
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

CANARY = "CANARY-7731 my card number is 4111"
QUALITY = "quality:acme:gpt-4o-mini"


def _routed(request_id="r-1", tenant="acme", prompt="Summarise this ticket.", outcome="good"):
    return {"id": request_id, "tenant": tenant, "policy": "auto", "model": "gpt-4o-mini", "prompt": prompt, "outcome": outcome, "latency_ms": 812.5}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox:feedback", 0, -1)]


def _ids(ctx):
    return [json.loads(r.value)["id"] for r in ctx.kafka.records("route.feedback")]


def check_tenant_key(ctx):
    m = ctx.load("feedback")
    m.emit_feedback(m.build_event(_routed("r-1", "acme")))
    m.emit_feedback(m.build_event(_routed("r-2", "beta", outcome="bad")))
    m.emit_feedback(m.build_event(_routed("r-3", "acme")))
    records = ctx.kafka.records("route.feedback")
    assert len(records) == 3, f"three emit_feedback calls produced {len(records)} records on route.feedback (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"acme", b"beta", b"acme"], f"records must be keyed by the tenant, got {keys}"
    assert records[0].partition == records[2].partition, "one tenant's events must land on one partition so they stay in order"
    event = json.loads(records[0].value)
    assert event.get("id") == "r-1" and event.get("tenant") == "acme", f"the event id stays the request id and carries the tenant: {event}"
    for field in ("policy", "model", "outcome", "latency_ms"):
        assert field in event, f"the event is missing {field}: {event}"


def check_idempotent_acks(ctx):
    m = ctx.load("feedback")
    ctx.kafka.lose_acks("route.feedback", 1)
    m.emit_feedback(m.build_event(_routed("r-1")))
    m.producer.poll(0)
    assert _ids(ctx) == ["r-1"], f"after one produce whose acknowledgement was lost the topic holds {_ids(ctx)}: the producer's retry wrote the record again. Enable idempotence so the broker recognises the retry"
    m.emit_feedback(m.build_event(_routed("r-2")))
    m.producer.poll(0)
    ctx.kafka.failover("route.feedback")
    assert "r-2" in _ids(ctx), "a leader failover right after the acknowledgement lost the record: wait for all in-sync replicas (acks=all)"


def check_no_prompt(ctx):
    m = ctx.load("feedback")
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    root = logging.getLogger()
    level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            m.emit_feedback(m.build_event(_routed("r-1", prompt=CANARY)))
            m.producer.poll(0)
    finally:
        root.removeHandler(handler)
        root.setLevel(level)
    records = ctx.kafka.records("route.feedback")
    assert len(records) == 1, f"one emit_feedback call produced {len(records)} records"
    value = records[0].value.decode()
    assert "CANARY-7731" not in value, f"the feedback event carries the prompt: {value}"
    assert "prompt" not in json.loads(value), f"the feedback event has a prompt field: {value}"
    assert "CANARY-7731" not in captured.getvalue(), f"the prompt was printed or logged: {captured.getvalue().strip()!r}"


def check_outbox(ctx):
    m = ctx.load("feedback")
    ctx.kafka.fail_next("route.feedback", 1)
    event = m.build_event(_routed("r-9"))
    try:
        m.emit_feedback(event)
    except Exception as exc:  # noqa: BLE001 - whatever it raised is the verdict
        raise AssertionError(f"emit_feedback failed the request when the broker refused the record: {exc!r}. Write the event to the outbox instead") from None
    m.producer.poll(0)
    rows = _outbox(ctx)
    assert rows, "the broker refused the record and nothing reached outbox:feedback: the refusal arrives in the delivery report (on_delivery), and that is where outbox.insert(event, reason) belongs"
    assert rows[0].get("event", {}).get("id") == "r-9", f"the outbox row must carry the event: {rows[0]}"
    assert ctx.kafka.flushes == 0, "emit_feedback must not flush: the request would wait for the broker"
    m.emit_feedback(m.build_event(_routed("r-10")))
    m.producer.poll(0)
    assert _ids(ctx) == ["r-10"], "once the broker accepts records again they flow to the topic"
    assert len(_outbox(ctx)) == 1, "a delivered record must not be written to the outbox"


def check_commit_after_increment(ctx):
    for request_id, outcome in (("r-1", "good"), ("r-2", "good"), ("r-3", "bad")):
        event = {k: v for k, v in _routed(request_id, outcome=outcome).items() if k != "prompt"}
        ctx.kafka.seed("route.feedback", key="acme", value=json.dumps(event))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(sum(int(v) for v in ctx.redis.hgetall(QUALITY).values())))
    m = ctx.load("feedback")
    ctx.drain(m.run_quality)
    assert at_commit, "the consumer never committed an offset"
    assert at_commit[0] >= 1, f"at the first commit {QUALITY} counted {at_commit[0]} verdicts: the increment must come before the commit, or a crash in between loses the verdict"
    counts = ctx.redis.hgetall(QUALITY)
    assert counts == {"good": "2", "bad": "1"}, f"{QUALITY} is {counts}, expected good 2 and bad 1"
    assert ctx.kafka.lag("quality", "route.feedback") == 0, "every processed record must be committed"
`,
    typescript: `const CANARY = 'CANARY-7731 my card number is 4111';
const QUALITY = 'quality:acme:gpt-4o-mini';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const routed = (id = 'r-1', tenant = 'acme', prompt = 'Summarise this ticket.', outcome = 'good') => ({
  id,
  tenant,
  policy: 'auto',
  model: 'gpt-4o-mini',
  prompt,
  outcome,
  latency_ms: 812.5,
});
const outbox = (ctx): Record<string, any>[] => ctx.redis.lrange('outbox:feedback', 0, -1).map((row: string) => JSON.parse(row));
const ids = (ctx): string[] => ctx.kafka.records('route.feedback').map(r => JSON.parse(r.value.toString()).id);

export async function check_tenant_key(ctx) {
  const m = ctx.load('feedback');
  m.emitFeedback(m.buildEvent(routed('r-1', 'acme')));
  m.emitFeedback(m.buildEvent(routed('r-2', 'beta', 'hi', 'bad')));
  m.emitFeedback(m.buildEvent(routed('r-3', 'acme')));
  await settle();
  const records = ctx.kafka.records('route.feedback');
  assert.equal(records.length, 3, \`three emitFeedback calls produced \${records.length} records on route.feedback\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['acme', 'beta', 'acme'], \`records must be keyed by the tenant, got \${JSON.stringify(keys)}\`);
  assert.equal(records[0].partition, records[2].partition, "one tenant's events must land on one partition so they stay in order");
  const event = JSON.parse(records[0].value.toString());
  assert(event.id === 'r-1' && event.tenant === 'acme', \`the event id stays the request id and carries the tenant: \${records[0].value}\`);
  for (const field of ['policy', 'model', 'outcome', 'latency_ms']) assert(field in event, \`the event is missing \${field}: \${records[0].value}\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('feedback');
  ctx.kafka.loseAcks('route.feedback', 1);
  m.emitFeedback(m.buildEvent(routed('r-1')));
  await settle();
  assert.deepStrictEqual(ids(ctx), ['r-1'], \`after one produce whose acknowledgement was lost the topic holds \${JSON.stringify(ids(ctx))}: the producer's retry wrote the record again. Enable idempotence so the broker recognises the retry\`);
  m.emitFeedback(m.buildEvent(routed('r-2')));
  await settle();
  ctx.kafka.failover('route.feedback');
  assert(ids(ctx).includes('r-2'), 'a leader failover right after the acknowledgement lost the record: wait for all in-sync replicas (acks: -1)');
}

export async function check_no_prompt(ctx) {
  const m = ctx.load('feedback');
  const logged: string[] = [];
  const prior = {log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  try {
    m.emitFeedback(m.buildEvent(routed('r-1', 'acme', CANARY)));
    await settle();
  } finally {
    Object.assign(console, prior);
  }
  const records = ctx.kafka.records('route.feedback');
  assert.equal(records.length, 1, \`one emitFeedback call produced \${records.length} records\`);
  const value = records[0].value.toString();
  assert(!value.includes('CANARY-7731'), \`the feedback event carries the prompt: \${value}\`);
  assert(!('prompt' in JSON.parse(value)), \`the feedback event has a prompt field: \${value}\`);
  const leak = logged.find(l => l.includes('CANARY-7731'));
  assert(leak === undefined, \`the prompt was printed or logged: \${JSON.stringify(leak)}\`);
}

export async function check_outbox(ctx) {
  const m = ctx.load('feedback');
  ctx.kafka.failNext('route.feedback', 1);
  try {
    await m.emitFeedback(m.buildEvent(routed('r-9')));
  } catch (e) {
    assert.fail(\`emitFeedback failed the request when the broker refused the record: \${e}. Write the event to the outbox instead\`);
  }
  await settle();
  const rows = outbox(ctx);
  assert(rows.length > 0, "the broker refused the record and nothing reached outbox:feedback: the refusal is the send promise's rejection, and its .catch is where outbox.insert(event, reason) belongs");
  assert.equal(rows[0].event?.id, 'r-9', \`the outbox row must carry the event: \${JSON.stringify(rows[0])}\`);
  m.emitFeedback(m.buildEvent(routed('r-10')));
  await settle();
  assert.deepStrictEqual(ids(ctx), ['r-10'], 'once the broker accepts records again they flow to the topic');
  assert.equal(outbox(ctx).length, 1, 'a delivered record must not be written to the outbox');
}

export async function check_commit_after_increment(ctx) {
  for (const [id, outcome] of [['r-1', 'good'], ['r-2', 'good'], ['r-3', 'bad']]) {
    const {prompt: _prompt, ...event} = routed(id, 'acme', '', outcome);
    ctx.kafka.seed('route.feedback', {key: 'acme', value: JSON.stringify(event)});
  }
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(Object.values(ctx.redis.hgetall(QUALITY) as Record<string, string>).reduce((n, v) => n + Number(v), 0)));
  const m = ctx.load('feedback');
  await ctx.drain(m.runQuality());
  assert(atCommit.length > 0, 'the consumer never committed an offset');
  assert(atCommit[0] >= 1, \`at the first commit \${QUALITY} counted \${atCommit[0]} verdicts: the increment must come before the commit, or a crash in between loses the verdict\`);
  assert.deepStrictEqual(ctx.redis.hgetall(QUALITY), {good: '2', bad: '1'}, \`\${QUALITY} is \${JSON.stringify(ctx.redis.hgetall(QUALITY))}, expected good 2 and bad 1\`);
  assert.equal(ctx.kafka.lag('quality', 'route.feedback'), 0, 'every processed record must be committed');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"sort"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const (
	feedbackCanary  = "CANARY-7731 my card number is 4111"
	feedbackQuality = "quality:acme:gpt-4o-mini"
)

func feedbackRouted(id, tenant, prompt, outcome string) routedRequest {
	return routedRequest{ID: id, Tenant: tenant, Policy: "auto", Model: "gpt-4o-mini", Prompt: prompt, Outcome: outcome, LatencyMs: 812.5}
}

func feedbackIDs(ctx *harness.Ctx) []string {
	ids := []string{}
	for _, r := range ctx.Kafka.Records("route.feedback") {
		var v map[string]any
		json.Unmarshal(r.Value, &v)
		id, _ := v["id"].(string)
		ids = append(ids, id)
	}
	return ids
}

func feedbackOutbox(ctx *harness.Ctx) []map[string]any {
	var rows []map[string]any
	for _, row := range ctx.Redis.LRange("outbox:feedback", 0, -1) {
		var v map[string]any
		json.Unmarshal([]byte(row), &v)
		rows = append(rows, v)
	}
	return rows
}

func qualityTotal(ctx *harness.Ctx) int {
	total := 0
	for _, v := range ctx.Redis.HGetAll(feedbackQuality) {
		n, _ := strconv.Atoi(v)
		total += n
	}
	return total
}

func CheckTenantKey(ctx *harness.Ctx) {
	emitFeedback(context.Background(), buildEvent(feedbackRouted("r-1", "acme", "hi", "good")))
	emitFeedback(context.Background(), buildEvent(feedbackRouted("r-2", "beta", "hi", "bad")))
	emitFeedback(context.Background(), buildEvent(feedbackRouted("r-3", "acme", "hi", "good")))
	ctx.Settle()
	records := ctx.Kafka.Records("route.feedback")
	ctx.Equal(len(records), 3, "three emitFeedback calls must produce three records on route.feedback; the records")
	keys := ctx.Kafka.Keys("route.feedback")
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
	for _, field := range []string{"policy", "model", "outcome", "latency_ms"} {
		_, ok := first[field]
		ctx.Assert(ok, "the event is missing %s: %v", field, first)
	}
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	emitFeedback(context.Background(), buildEvent(feedbackRouted("r-2", "acme", "hi", "good")))
	ctx.Settle()
	ctx.Equal(feedbackIDs(ctx), []string{"r-2"}, "one emitFeedback call; the records on route.feedback")
	ctx.Kafka.Failover("route.feedback")
	ctx.Equal(feedbackIDs(ctx), []string{"r-2"}, "a leader failover right after the acknowledgement must keep the record: wait for all in-sync replicas (RequireAll); the records")
}

func CheckNoPrompt(ctx *harness.Ctx) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	emitFeedback(context.Background(), buildEvent(feedbackRouted("r-1", "acme", feedbackCanary, "good")))
	ctx.Settle()
	records := ctx.Kafka.Records("route.feedback")
	ctx.Equal(len(records), 1, "one emitFeedback call; the records")
	value := string(records[0].Value)
	ctx.Assert(!strings.Contains(value, "CANARY-7731"), "the feedback event carries the prompt: %s", value)
	var event map[string]any
	json.Unmarshal(records[0].Value, &event)
	_, hasPrompt := event["prompt"]
	ctx.Assert(!hasPrompt, "the feedback event has a prompt field: %s", value)
	ctx.Assert(!strings.Contains(logged.String(), "CANARY-7731"), "the prompt was printed or logged: %q", strings.TrimSpace(logged.String()))
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext("route.feedback", 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("emitFeedback failed the request when the broker refused the record: %v. Write the event to the outbox instead", e)
			}
		}()
		emitFeedback(context.Background(), buildEvent(feedbackRouted("r-9", "acme", "hi", "good")))
	}()
	ctx.Settle()
	rows := feedbackOutbox(ctx)
	ctx.Assert(len(rows) > 0, "the broker refused the record and nothing reached outbox:feedback: an async writer reports the refusal to Completion, and that is where outbox.Insert belongs")
	event, _ := rows[0]["event"].(map[string]any)
	ctx.Equal(event["id"], "r-9", "the outbox row must carry the event; the row %v; its id", rows[0])
	emitFeedback(context.Background(), buildEvent(feedbackRouted("r-10", "acme", "hi", "good")))
	ctx.Settle()
	ctx.Equal(feedbackIDs(ctx), []string{"r-10"}, "once the broker accepts records again they flow to the topic; the records")
	ctx.Equal(len(feedbackOutbox(ctx)), 1, "a delivered record must not be written to the outbox; the rows")
}

func CheckCommitAfterIncrement(ctx *harness.Ctx) {
	for _, r := range []struct{ id, outcome string }{{"r-1", "good"}, {"r-2", "good"}, {"r-3", "bad"}} {
		value, _ := json.Marshal(map[string]any{"id": r.id, "tenant": "acme", "policy": "auto", "model": "gpt-4o-mini", "outcome": r.outcome, "latency_ms": 812.5})
		ctx.Kafka.Seed("route.feedback", "acme", string(value))
	}
	var atCommit []int
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, qualityTotal(ctx)) })
	ctx.Drain(func() { runQuality(context.Background()) })
	ctx.Assert(len(atCommit) > 0, "the consumer never committed an offset")
	ctx.Assert(atCommit[0] >= 1, "at the first commit %s counted %d verdicts: the increment must come before the commit, or a crash in between loses the verdict", feedbackQuality, atCommit[0])
	ctx.Equal(ctx.Redis.HGetAll(feedbackQuality), map[string]string{"good": "2", "bad": "1"}, "%s (good 2, bad 1)", feedbackQuality)
	ctx.Equal(ctx.Kafka.Lag("quality", "route.feedback"), 0, "every processed record must be committed; the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {

const std::string kFeedbackCanary = "CANARY-7731 my card number is 4111";
const std::string kFeedbackQuality = "quality:acme:gpt-4o-mini";

nlohmann::json feedbackRouted(const std::string& id, const std::string& tenant, const std::string& prompt = "hi",
                              const std::string& outcome = "good") {
  return {{"id", id}, {"tenant", tenant}, {"policy", "auto"}, {"model", "gpt-4o-mini"},
          {"prompt", prompt}, {"outcome", outcome}, {"latency_ms", 812.5}};
}

std::vector<std::string> feedbackIDs(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (const auto& r : ctx.Kafka.Records("route.feedback")) {
    const auto v = nlohmann::json::parse(r.Value.value_or(""), nullptr, false);
    ids.push_back(v.is_object() ? v.value("id", "") : "");
  }
  return ids;
}

std::vector<nlohmann::json> feedbackOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& row : ctx.Redis.LRange("outbox:feedback", 0, -1)) rows.push_back(nlohmann::json::parse(row, nullptr, false));
  return rows;
}

long long qualityTotal(harness::Ctx& ctx) {
  long long total = 0;
  for (const auto& [field, value] : ctx.Redis.HGetAll(kFeedbackQuality)) total += std::atoll(value.c_str());
  return total;
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  emit_feedback(build_event(feedbackRouted("r-1", "acme")));
  emit_feedback(build_event(feedbackRouted("r-2", "beta", "hi", "bad")));
  emit_feedback(build_event(feedbackRouted("r-3", "acme")));
  ctx.Settle();
  const auto records = ctx.Kafka.Records("route.feedback");
  ctx.Equal(records.size(), 3, "three emit_feedback calls must produce three records on route.feedback; the records");
  ctx.Equal(ctx.Kafka.Keys("route.feedback"), {"acme", "beta", "acme"}, "records must be keyed by the tenant");
  ctx.Equal(records[0].Partition, records[2].Partition, "one tenant's events must land on one partition so they stay in order; acme's partitions");
  const auto event = nlohmann::json::parse(records[0].Value.value_or(""), nullptr, false);
  ctx.Assert(event.is_object() && event.value("id", "") == "r-1" && event.value("tenant", "") == "acme",
             "the event id stays the request id and carries the tenant: %s", records[0].Value.value_or(""));
  for (const std::string field : {"policy", "model", "outcome", "latency_ms"}) {
    ctx.Assert(event.contains(field), "the event is missing %s: %s", field, records[0].Value.value_or(""));
  }
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks("route.feedback", 1);
  emit_feedback(build_event(feedbackRouted("r-1", "acme")));
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(feedbackIDs(ctx), {"r-1"},
            "after one produce whose acknowledgement was lost the topic must hold the record once (the producer's retry wrote it again: enable idempotence so the broker recognises the retry); the records");
  emit_feedback(build_event(feedbackRouted("r-2", "acme")));
  producer->poll(0);
  ctx.Settle();
  ctx.Kafka.Failover("route.feedback");
  const auto ids = feedbackIDs(ctx);
  ctx.Assert(std::find(ids.begin(), ids.end(), "r-2") != ids.end(), "a leader failover right after the acknowledgement lost the record: wait for all in-sync replicas (acks=all)");
}

void CheckNoPrompt(harness::Ctx& ctx) {
  std::ostringstream logged;
  auto* out = std::cout.rdbuf(logged.rdbuf());
  auto* err = std::cerr.rdbuf(logged.rdbuf());
  emit_feedback(build_event(feedbackRouted("r-1", "acme", kFeedbackCanary)));
  producer->poll(0);
  std::cout.rdbuf(out);
  std::cerr.rdbuf(err);
  ctx.Settle();
  const auto records = ctx.Kafka.Records("route.feedback");
  ctx.Equal(records.size(), 1, "one emit_feedback call; the records");
  const std::string value = records[0].Value.value_or("");
  ctx.Assert(value.find("CANARY-7731") == std::string::npos, "the feedback event carries the prompt: %s", value);
  const auto event = nlohmann::json::parse(value, nullptr, false);
  ctx.Assert(event.is_object() && !event.contains("prompt"), "the feedback event has a prompt field: %s", value);
  ctx.Assert(logged.str().find("CANARY-7731") == std::string::npos, "the prompt was printed or logged: %q", logged.str());
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext("route.feedback", 1);
  try {
    emit_feedback(build_event(feedbackRouted("r-9", "acme")));
  } catch (const std::exception& e) {
    ctx.Fatalf("emit_feedback failed the request when the broker refused the record: %s. Write the event to the outbox instead", e.what());
  }
  producer->poll(0);
  ctx.Settle();
  const auto rows = feedbackOutbox(ctx);
  ctx.Assert(!rows.empty(), "the broker refused the record and nothing reached outbox:feedback: the refusal arrives in the delivery report (dr_cb), and that is where routerd::outbox::insert belongs");
  ctx.Assert(rows[0].is_object() && rows[0].contains("event") && rows[0]["event"].value("id", "") == "r-9", "the outbox row must carry the event: %s", rows[0].dump());
  ctx.Equal(ctx.Kafka.Flushes(), 0, "emit_feedback must not flush (the request would wait for the broker); the flushes");
  emit_feedback(build_event(feedbackRouted("r-10", "acme")));
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(feedbackIDs(ctx), {"r-10"}, "once the broker accepts records again they flow to the topic; the records");
  ctx.Equal(feedbackOutbox(ctx).size(), 1, "a delivered record must not be written to the outbox; the rows");
}

void CheckCommitAfterIncrement(harness::Ctx& ctx) {
  for (const auto& [id, outcome] : std::vector<std::pair<std::string, std::string>>{{"r-1", "good"}, {"r-2", "good"}, {"r-3", "bad"}}) {
    auto event = feedbackRouted(id, "acme", "", outcome);
    event.erase("prompt");
    ctx.Kafka.Seed("route.feedback", "acme", event.dump());
  }
  std::vector<long long> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(qualityTotal(ctx)); });
  ctx.Drain([] { run_quality(); });
  ctx.Assert(!atCommit.empty(), "the consumer never committed an offset");
  ctx.Assert(atCommit[0] >= 1, "at the first commit %s counted %d verdicts: the increment must come before the commit, or a crash in between loses the verdict", kFeedbackQuality, atCommit[0]);
  ctx.Assert(ctx.Redis.HGetAll(kFeedbackQuality) == std::map<std::string, std::string>{{"good", "2"}, {"bad", "1"}}, "%s is %v, expected good 2 and bad 1", kFeedbackQuality, ctx.Redis.HGetAll(kFeedbackQuality));
  ctx.Equal(ctx.Kafka.Lag("quality", "route.feedback"), 0, "every processed record must be committed; the lag");
}
`,
  },
  debrief: `Each flaw is a guarantee that holds on a quiet day and breaks on a loud one. The key is an ordering decision: a partition is the only place Kafka orders anything, so a tenant's verdicts need one. Idempotence plus \`acks=all\` is a durability decision: the retry after a lost acknowledgement is recognised by sequence number, and a leader failover keeps what every replica has. The outbox write sits in the delivery callback because that is where the broker's refusal arrives; the produce call only reports a full local queue. Increment-then-commit makes a crash cost a double count instead of a lost verdict. Production pipelines also make the consumer idempotent (a seen-set keyed by event id) so the redelivered record is not counted twice.`,
};
