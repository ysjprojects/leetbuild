import type {Step} from '@/lib/types';

export const traceEventsStep: Step = {
  id: 'trace-events',
  title: 'assistant.trace: one event per call, keyed by conversation, never the text',
  concept: 'kafka',
  file: 'trace_events',
  focus: ['workflow', 'kafka', 'consumer', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of LLM observability: the
workflow calls \`emit\` after every model call, tool call and guardrail gate, an event lands on
Kafka, and a consumer turns events into counters, so the demo dashboard shows numbers moving. Five
production contracts are broken. Find them, fix them, and prove the fix.

Implement \`emit(span)\` and \`consume()\` for the \`assistant.trace\` topic:

- Publish **exactly one** event per LLM, tool or guardrail call with the **conversation** as the
  message key — partition by conversation keeps one conversation's spans ordered, which is what
  makes an iteration count or a latency timeline readable. The event carries tenant, conversation,
  **turn id**, iteration, kind (\`llm\` / \`tool\` / \`guardrail\`), the model or tool name,
  latency, input and output token counts and the guardrail verdicts.
- **Never** put the prompt, the answer or any message text in the event, and never log it: the
  topic is retained for days and replicated, so guest content written there outlives every
  retention policy the conversation store has.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks
  \`all\` plus hashed, stable keys), so a retried produce cannot duplicate a span and double-count
  tokens.
- When the broker rejects the produce, write the event to the **outbox** instead of dropping it or
  failing the turn; a relay republishes outbox rows when the broker recovers.
- The consumer (group \`insights\`) updates the Redis metrics
  (\`HINCRBY metrics:{tenant}:{kind}:{name}\` — \`calls\`, \`latency_ms\`, \`input_tokens\`,
  \`output_tokens\`, \`blocked\`) and **only then** commits the offset. Commit first and one crash
  loses that span's tokens from every dashboard forever.

**Failure mode the checks target.** Keying by turn id scatters one conversation's spans across
partitions; an unconfigured producer duplicates spans on retry and inflates the token bill; the
retained text is a data leak with a long tail; a failed produce silently loses the span that would
have explained the expensive turn; and commit-before-process trades correctness for exactly-once
*looking* code.`,
  sequence: {
    participants: ['CoT workflow', 'assistant.trace', 'Trace consumer', 'Redis'],
    messages: [
      {from: 'CoT workflow', to: 'assistant.trace', label: 'produce · key = conversation · acks = all', kind: 'sync'},
      {from: 'assistant.trace', to: 'CoT workflow', label: 'ack / broker error', kind: 'reply'},
      {from: 'CoT workflow', to: 'CoT workflow', label: 'insertOutbox(conversation, event) on failure', kind: 'sync'},
      {from: 'assistant.trace', to: 'Trace consumer', label: 'consume · group insights', kind: 'async'},
      {from: 'Trace consumer', to: 'Redis', label: 'HINCRBY metrics:{tenant}:{kind}:{name}', kind: 'sync'},
      {from: 'Redis', to: 'Trace consumer', label: 'new counter values', kind: 'reply'},
      {from: 'Trace consumer', to: 'assistant.trace', label: 'commit offset after the write', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=span.conversation` (or `Key: []byte(span.Conversation)`, `key: span.conversation`, `ProducerRecord(topic, span.conversation, …)`). Keyed by the turn id, one conversation’s spans land in different partitions and their order is no longer guaranteed.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true`, or required acks `all` with hashed routing. Delete the prompt and answer fields from the span entirely — a field that does not exist cannot be logged by accident.',
    'The outbox is the durability half: wrap the produce and, when the broker rejects it, insert the event into the outbox. In the consumer, run every `HINCRBY` first and `commit` second — a crash between the two then replays the span instead of losing it.',
  ],
  checks: [
    {
      id: 'conversation-key',
      title: 'Keyed by conversation, carries the turn id',
      detail:
        'The message key is the conversation (partition by conversation) and the event carries the turn id. The draft keys by the turn id, so one conversation’s spans scatter across partitions and lose order.',
      match: {
        python: {all: [/key=span\.conversation/, /turn_id/]},
        typescript: {all: [/key:\s*span\.conversation/, /turn_id/]},
        go: {all: [/Key:\s*\[\]byte\(span\.Conversation\)/, /TurnID/]},
        scala: {all: [/ProducerRecord\("assistant.trace",\s*span\.conversation/, /turnId/]},
        cpp: {all: [/produce\([^;]*span\.conversation\.data\(\)/, /turnId/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. A retried produce must not duplicate the span.',
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
      title: 'No prompt, answer or message text in the event or logs',
      detail:
        'Neither the event payload nor any log line carries the prompt, the answer or message text. The draft logs both and copies them into the event — a leak that is retained and replicated with the topic.',
      match: {
        python: {none: [/\b(prompt|answer|text)\b/i]},
        typescript: {none: [/\b(prompt|answer|text)\b/i]},
        go: {none: [/\b(prompt|answer|text)\b/i]},
        scala: {none: [/\b(prompt|answer|text)\b/i]},
        cpp: {none: [/\b(prompt|answer|text)\b/i]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insertOutbox`/`InsertOutbox`) inside the error branch instead of dropping the span. The draft ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*(\(|\{)/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'metrics-before-commit',
      title: 'Updates the metrics before committing the offset',
      detail:
        'The consumer runs `HINCRBY` on `metrics:{tenant}:{kind}:{name}` before committing the offset; committing first makes a crash lose the span forever. The draft commits first.',
      match: {
        python: {all: [/metrics:\{/], order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {all: [/metrics:\$\{/], order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {all: [/"metrics:"/], order: [/\.HIncrBy\(/, /CommitMessages\(/]},
        scala: {all: [/metrics:\$\{/], order: [/\.hincrBy\(/, /commitSync\(/]},
        cpp: {all: [/"metrics:"/], order: [/->hincrby\(|\.hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
from dataclasses import asdict, dataclass, field

import redis
from confluent_kafka import Consumer, Producer

logger = logging.getLogger("trace")
producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@dataclass
class Span:
    tenant: str
    conversation: str
    turn_id: str
    iteration: int
    kind: str
    name: str
    latency_ms: int
    input_tokens: int = 0
    output_tokens: int = 0
    prompt: str = ""
    answer: str = ""
    verdicts: dict[str, str] = field(default_factory=dict)


def emit(span: Span) -> None:
    # TODO: key by conversation instead of the turn id, configure the idempotent producer with
    # acks=all, keep the prompt and answer out of the event and the logs, and write an outbox
    # row when the broker rejects the produce.
    logger.info("trace turn=%s prompt=%r answer=%r", span.turn_id, span.prompt, span.answer)
    producer.produce("assistant.trace", key=span.turn_id, value=json.dumps(asdict(span)))
    producer.flush()


def consume() -> None:
    # TODO: update the metrics before committing the offset.
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "insights"})
    consumer.subscribe(["assistant.trace"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        r.hincrby(f"calls:{event['tenant']}", event["name"], 1)
`,
      solution: `import json
from dataclasses import asdict, dataclass, field

import redis
from confluent_kafka import Consumer, KafkaException, Producer

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@dataclass
class Span:
    tenant: str
    conversation: str
    turn_id: str
    iteration: int
    kind: str
    name: str
    latency_ms: int
    input_tokens: int = 0
    output_tokens: int = 0
    verdicts: dict[str, str] = field(default_factory=dict)


class OutboxStore:
    def insert_outbox(self, conversation: str, event: dict) -> None:
        raise NotImplementedError


store = OutboxStore()


def emit(span: Span) -> None:
    event = asdict(span)
    try:
        producer.produce("assistant.trace", key=span.conversation, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(span.conversation, event)


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "insights", "enable.auto.commit": False}
    )
    consumer.subscribe(["assistant.trace"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        metrics = f"metrics:{event['tenant']}:{event['kind']}:{event['name']}"
        r.hincrby(metrics, "calls", 1)
        r.hincrby(metrics, "latency_ms", event["latency_ms"])
        r.hincrby(metrics, "input_tokens", event["input_tokens"])
        r.hincrby(metrics, "output_tokens", event["output_tokens"])
        if any(verdict != "PASS" for verdict in event["verdicts"].values()):
            r.hincrby(metrics, "blocked", 1)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** assistant.trace: a model-generated draft that keys by turn id and commits too early. */
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

const kafka = new Kafka({clientId: 'apv2', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

export interface Span {
  tenant: string;
  conversation: string;
  turn_id: string;
  iteration: number;
  kind: 'llm' | 'tool' | 'guardrail';
  name: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  prompt: string;
  answer: string;
  verdicts: Record<string, string>;
}

export async function emit(span: Span): Promise<void> {
  // TODO: key by conversation instead of the turn id, configure the idempotent producer with
  // acks=all, keep the prompt and answer out of the event and the logs, and write an outbox
  // row when the broker rejects the produce.
  console.info(\`trace turn=\${span.turn_id} prompt=\${span.prompt} answer=\${span.answer}\`);
  await producer.send({
    topic: 'assistant.trace',
    messages: [{key: span.turn_id, value: JSON.stringify(span)}],
  });
}

export async function consume(): Promise<void> {
  // TODO: update the metrics before committing the offset.
  const consumer = kafka.consumer({groupId: 'insights'});
  await consumer.connect();
  await consumer.subscribe({topic: 'assistant.trace'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as Span;
      await r.hincrby(\`calls:\${event.tenant}\`, event.name, 1);
    },
  });
}
`,
      solution: `/** assistant.trace: one idempotent, conversation-keyed span per call; metrics before the commit. */
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

import {store} from './store';

const kafka = new Kafka({clientId: 'apv2', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

export interface Span {
  tenant: string;
  conversation: string;
  turn_id: string;
  iteration: number;
  kind: 'llm' | 'tool' | 'guardrail';
  name: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  verdicts: Record<string, string>;
}

export async function emit(span: Span): Promise<void> {
  try {
    await producer.send({
      topic: 'assistant.trace',
      acks: -1,
      messages: [{key: span.conversation, value: JSON.stringify(span)}],
    });
  } catch {
    await store.insertOutbox(span.conversation, span);
  }
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'insights'});
  await consumer.connect();
  await consumer.subscribe({topic: 'assistant.trace'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as Span;
      const metrics = \`metrics:\${event.tenant}:\${event.kind}:\${event.name}\`;
      await r.hincrby(metrics, 'calls', 1);
      await r.hincrby(metrics, 'latency_ms', event.latency_ms);
      await r.hincrby(metrics, 'input_tokens', event.input_tokens);
      await r.hincrby(metrics, 'output_tokens', event.output_tokens);
      if (Object.values(event.verdicts).some(verdict => verdict !== 'PASS')) await r.hincrby(metrics, 'blocked', 1);
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
	"log"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var (
	traceWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "assistant.trace"}
	rdb         *redis.Client
)

type Span struct {
	Tenant       string            \`json:"tenant"\`
	Conversation string            \`json:"conversation"\`
	TurnID       string            \`json:"turn_id"\`
	Iteration    int               \`json:"iteration"\`
	Kind         string            \`json:"kind"\`
	Name         string            \`json:"name"\`
	LatencyMS    int64             \`json:"latency_ms"\`
	InputTokens  int64             \`json:"input_tokens"\`
	OutputTokens int64             \`json:"output_tokens"\`
	Prompt       string            \`json:"prompt"\`
	Answer       string            \`json:"answer"\`
	Verdicts     map[string]string \`json:"verdicts"\`
}

// TODO: key by conversation instead of the turn id, configure acks=all / idempotence, keep the
// prompt and answer out of the event and the logs, and write an outbox row when the broker
// rejects the produce.
func Emit(ctx context.Context, span Span) {
	log.Printf("trace turn=%s prompt=%q answer=%q", span.TurnID, span.Prompt, span.Answer)
	payload, _ := json.Marshal(span)
	_ = traceWriter.WriteMessages(ctx, kafka.Message{Key: []byte(span.TurnID), Value: payload})
}

// TODO: update the metrics before committing the offset.
func Consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "assistant.trace",
		GroupID: "insights",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event Span
		_ = json.Unmarshal(msg.Value, &event)
		rdb.HIncrBy(ctx, "calls:"+event.Tenant, event.Name, 1)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var traceWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "assistant.trace",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var rdb *redis.Client

type Span struct {
	Tenant       string            \`json:"tenant"\`
	Conversation string            \`json:"conversation"\`
	TurnID       string            \`json:"turn_id"\`
	Iteration    int               \`json:"iteration"\`
	Kind         string            \`json:"kind"\`
	Name         string            \`json:"name"\`
	LatencyMS    int64             \`json:"latency_ms"\`
	InputTokens  int64             \`json:"input_tokens"\`
	OutputTokens int64             \`json:"output_tokens"\`
	Verdicts     map[string]string \`json:"verdicts"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, conversation string, span Span) error {
	return nil
}

var store = &OutboxStore{}

func Emit(ctx context.Context, span Span) {
	payload, err := json.Marshal(span)
	if err != nil {
		return
	}
	if err := traceWriter.WriteMessages(ctx, kafka.Message{Key: []byte(span.Conversation), Value: payload}); err != nil {
		_ = store.InsertOutbox(ctx, span.Conversation, span)
	}
}

func Consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "assistant.trace",
		GroupID: "insights",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event Span
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			_ = reader.CommitMessages(ctx, msg)
			continue
		}
		metrics := "metrics:" + event.Tenant + ":" + event.Kind + ":" + event.Name
		rdb.HIncrBy(ctx, metrics, "calls", 1)
		rdb.HIncrBy(ctx, metrics, "latency_ms", event.LatencyMS)
		rdb.HIncrBy(ctx, metrics, "input_tokens", event.InputTokens)
		rdb.HIncrBy(ctx, metrics, "output_tokens", event.OutputTokens)
		for _, verdict := range event.Verdicts {
			if verdict != "PASS" {
				rdb.HIncrBy(ctx, metrics, "blocked", 1)
				break
			}
		}
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
import spray.json.DefaultJsonProtocol._

final case class Span(
  tenant: String,
  conversation: String,
  turnId: String,
  iteration: Int,
  kind: String,
  name: String,
  latencyMs: Long,
  inputTokens: Long,
  outputTokens: Long,
  prompt: String,
  answer: String,
  verdicts: Map[String, String]
)

object TraceEvents {
  private val log = Logger.getLogger("trace")
  implicit val spanFormat: RootJsonFormat[Span] = jsonFormat12(Span)

  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: key by conversation instead of the turn id, configure the idempotent producer with
  // acks=all, keep the prompt and answer out of the event and the logs, and write an outbox row
  // when the broker rejects the produce.
  def emit(span: Span): Unit = {
    log.info(s"trace turn=\${span.turnId} prompt=\${span.prompt} answer=\${span.answer}")
    producer.send(new ProducerRecord("assistant.trace", span.turnId, span.toJson.compactPrint))
  }

  // TODO: update the metrics before committing the offset.
  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of("assistant.trace"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.convertTo[Span]
        jedis.hincrBy(s"calls:\${event.tenant}", event.name, 1L)
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
import spray.json.DefaultJsonProtocol._

final case class Span(
  tenant: String,
  conversation: String,
  turnId: String,
  iteration: Int,
  kind: String,
  name: String,
  latencyMs: Long,
  inputTokens: Long,
  outputTokens: Long,
  verdicts: Map[String, String]
)

object TraceEvents {
  implicit val spanFormat: RootJsonFormat[Span] = jsonFormat10(Span)

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def emit(span: Span): Unit = {
    val payload = span.toJson.compactPrint
    try {
      producer.send(new ProducerRecord("assistant.trace", span.conversation, payload)).get()
    } catch {
      case _: Exception =>
        OutboxStore.insertOutbox(span.conversation, payload)
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "insights")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("assistant.trace"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.convertTo[Span]
        val metrics = s"metrics:\${event.tenant}:\${event.kind}:\${event.name}"
        jedis.hincrBy(metrics, "calls", 1L)
        jedis.hincrBy(metrics, "latency_ms", event.latencyMs)
        jedis.hincrBy(metrics, "input_tokens", event.inputTokens)
        jedis.hincrBy(metrics, "output_tokens", event.outputTokens)
        if (event.verdicts.values.exists(_ != "PASS")) jedis.hincrBy(metrics, "blocked", 1L)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kTraceTopic = "assistant.trace";

struct Span {
  std::string tenant;
  std::string conversation;
  std::string turnId;
  int iteration;
  std::string kind;
  std::string name;
  long long latencyMs;
  long long inputTokens;
  long long outputTokens;
  std::string prompt;
  std::string answer;
  std::map<std::string, std::string> verdicts;
};

std::unique_ptr<RdKafka::Producer> producer;
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

// TODO: key by conversation instead of the turn id, configure the idempotent producer with
// acks=all, keep the prompt and answer out of the event and the logs, and write an outbox row
// when the broker rejects the produce.
void emit(const Span& span) {
  std::cerr << "trace turn=" << span.turnId << " prompt=" << span.prompt << " answer=" << span.answer << "\\n";
  const json event = {
      {"tenant", span.tenant},
      {"conversation", span.conversation},
      {"turn_id", span.turnId},
      {"iteration", span.iteration},
      {"kind", span.kind},
      {"name", span.name},
      {"latency_ms", span.latencyMs},
      {"input_tokens", span.inputTokens},
      {"output_tokens", span.outputTokens},
      {"prompt", span.prompt},
      {"answer", span.answer},
      {"verdicts", span.verdicts},
  };
  const auto payload = event.dump();
  producer->produce(
      kTraceTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      span.turnId.data(),
      span.turnId.size(),
      0,
      nullptr);
  producer->flush(2000);
}

// TODO: update the metrics before committing the offset.
void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "insights", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTraceTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync();
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    redis->hincrby("calls:" + event["tenant"].get<std::string>(), event["name"].get<std::string>(), 1);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kTraceTopic = "assistant.trace";

struct Span {
  std::string tenant;
  std::string conversation;
  std::string turnId;
  int iteration;
  std::string kind;
  std::string name;
  long long latencyMs;
  long long inputTokens;
  long long outputTokens;
  std::map<std::string, std::string> verdicts;
};

struct OutboxStore {
  void insertOutbox(const std::string& conversation, const json& event);
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

void emit(const Span& span) {
  const json event = {
      {"tenant", span.tenant},
      {"conversation", span.conversation},
      {"turn_id", span.turnId},
      {"iteration", span.iteration},
      {"kind", span.kind},
      {"name", span.name},
      {"latency_ms", span.latencyMs},
      {"input_tokens", span.inputTokens},
      {"output_tokens", span.outputTokens},
      {"verdicts", span.verdicts},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(kTraceTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), span.conversation.data(), span.conversation.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(span.conversation, event);
  }
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "insights", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTraceTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    const std::string metrics = "metrics:" + event["tenant"].get<std::string>() + ":" + event["kind"].get<std::string>() + ":" + event["name"].get<std::string>();
    redis->hincrby(metrics, "calls", 1);
    redis->hincrby(metrics, "latency_ms", event["latency_ms"].get<long long>());
    redis->hincrby(metrics, "input_tokens", event["input_tokens"].get<long long>());
    redis->hincrby(metrics, "output_tokens", event["output_tokens"].get<long long>());
    bool blocked = false;
    for (const auto& [name, verdict] : event["verdicts"].items()) {
      if (verdict.get<std::string>() != "PASS") blocked = true;
    }
    if (blocked) redis->hincrby(metrics, "blocked", 1);
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking three things a generated Kafka snippet almost always gets wrong, in the setting the post calls LLM-oriented observability: detailed insight into each LLM interaction, its latency and its token usage. First, the message key is an ordering contract: partition by conversation and a turn's spans — reason, tool, reason, guardrail — arrive in the order they happened; key by turn id and the timeline a debugger reads is shuffled. Second, exactly-once *looking* code is not exactly-once: the producer needs idempotence and acks=all so a retry cannot double-count tokens, and the consumer must apply its counters before the offset commit, or a crash between them loses the span permanently. Third, a broker is not a database: when the produce fails, the durable path is an outbox row that a relay republishes. The text leak is the quiet one: a trace topic is retained and replicated precisely because it is useful later, which is precisely why guest messages must never be in it — ids, counts and verdicts tell the whole story. Real platforms add a schema registry for the span, per-tenant cost rollups from the token counters, a sampled full-fidelity trace in a store with its own retention and access control, and an alert on the blocked-rate per guardrail.`,
};
