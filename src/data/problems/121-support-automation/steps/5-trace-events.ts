import type {Step} from '@/lib/types';

export const traceEventsStep: Step = {
  id: 'trace-events',
  title: 'assistant.trace: one span per call, keyed by conversation, without the text',
  concept: 'kafka',
  file: 'trace_events',
  focus: ['workflow', 'kafka', 'consumer', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter is LLM observability. The workflow calls \`emit(call)\` after every
model, tool and guardrail call with \`{tenant, conversation, turn_id, iteration, kind, name,
latency_ms, input_tokens, output_tokens, verdicts, prompt, answer}\`; \`emit\` produces it to
\`assistant.trace\` keyed by the turn id and logs a line. \`consume()\` reads the topic as group
\`insights\` (auto-commit off), commits each offset, then adds the span to the hash
\`metrics:{tenant}:{kind}:{name}\` (\`calls\`, \`latency_ms\`, \`input_tokens\`, \`output_tokens\`,
\`blocked\`). It serves the demo and hides 5 flaws.

**Failure mode the checks target.** A conversation's spans scattered over every partition, a lost
acknowledgement that counts one model call twice, a guest's message kept on a topic for its whole
retention, a span dropped when the broker refuses it, and a consumer crash between commit and
increment that loses a call from the metrics.

- The record key is the **conversation**; the span still carries the turn id.
- The producer is **idempotent** with \`acks=all\` (Go uses confluent-kafka-go for this).
- The span carries every field above except \`prompt\` and \`answer\`, which stay out of the logs too.
- A delivery failure, reported through the **delivery callback**, writes the span to the provided
  outbox (\`outbox.insert(span, reason)\`, the Redis list \`apv2:outbox\`); \`emit\` does not wait.
- \`consume\` increments the metrics **before** it commits.`,
  sequence: {
    participants: ['CoT workflow', 'assistant.trace', 'Trace consumer', 'Redis'],
    messages: [
      {
        from: 'CoT workflow',
        to: 'assistant.trace',
        label: 'produce span · key = conversation · idempotent · acks=all',
        kind: 'async',
      },
      {from: 'assistant.trace', to: 'CoT workflow', label: 'delivery report: error → apv2:outbox', kind: 'reply'},
      {from: 'assistant.trace', to: 'Trace consumer', label: 'consume · group insights', kind: 'async'},
      {from: 'Trace consumer', to: 'Redis', label: 'HINCRBY metrics:{tenant}:{kind}:{name}', kind: 'sync'},
      {from: 'Trace consumer', to: 'assistant.trace', label: 'commit offset (after the increment)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'conversation-key',
      title: 'Keyed by conversation, carries the turn id',
      detail:
        "Spans of conversations c-1, c-2, c-1 are keyed c-1, c-2, c-1, c-1's two land on one partition, and each span carries tenant, turn id, iteration, kind, name, latency and token counts. The starter keys by turn id, so one conversation's spans spread over the partitions.",
      match: {
        python: {all: [/key\s*=\s*\w+\[["']conversation["']\]/]},
        typescript: {all: [/key:\s*\w+\.conversation\b/]},
        go: {all: [/Key:\s*\[\]byte\(\s*\w+\.Conversation\s*\)/]},
        scala: {
          all: [/ProducerRecord[\s\S]{0,120}?\(\s*"conversation"\s*\)|ProducerRecord[\s\S]{0,120}?conversation\b/],
        },
        cpp: {all: [/conversation\.c_str\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'After a produce whose acknowledgement was lost the topic holds the span once, and a leader failover right after an acknowledgement keeps the span. The starter configures neither, so a retry counts one model call twice.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*(["']all["']|-1)/]},
        typescript: {all: [/idempotent:\s*true/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/ENABLE_IDEMPOTENCE_CONFIG|"enable\.idempotence"/, /ACKS_CONFIG|"acks"/, /"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'no-text',
      title: 'No prompt or answer in the span or the logs',
      detail:
        'A call whose prompt and answer carry a marker produces a span without `prompt` or `answer` and with no trace of the marker, and nothing printed or logged carries it either. The starter serialises the whole call and logs the prompt.',
      match: {
        python: {
          none: [
            /json\.dumps\(\s*call\s*\)/,
            /logg?(er|ing)\.\w+\([^\n]*(prompt|answer)/i,
            /print\([^\n]*(prompt|answer)/i,
          ],
        },
        typescript: {none: [/JSON\.stringify\(\s*call\s*\)/, /console\.\w+\([^\n]*(prompt|answer)/i]},
        go: {none: [/json\.Marshal\(\s*call\s*\)/, /(log|fmt)\.Print[a-z]*\([^\n]*(Prompt|Answer)/]},
        scala: {none: [/ujson\.write\(\s*call\s*\)/, /println\([^\n]*(prompt|answer)/i]},
        cpp: {none: [/call\.dump\(\)/, /std::c(out|err)[^\n]*(prompt|answer)/i]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'A failed delivery goes to the outbox',
      detail:
        "A span the broker refuses reaches `apv2:outbox` through the delivery callback (`on_delivery`, the send promise's rejection, `Events()`, the `Callback`, `dr_cb`), without a flush; the next span flows to the topic and stays out of the outbox. The starter ignores delivery reports, so a refused span is gone.",
      match: {
        python: {all: [/outbox\.insert\(/, /on_delivery\s*=|callback\s*=/], none: [/except KafkaException/]},
        typescript: {all: [/outbox\.insert\(/, /\.catch\(|catch\s*\(/]},
        go: {all: [/outbox\.Insert\(/, /\.Events\(\)|chan kafka\.Event/]},
        scala: {all: [/Outbox\.insert\(/, /Callback|onCompletion/]},
        cpp: {all: [/outbox::insert\(/, /dr_cb/]},
      },
    },
    {
      id: 'metrics-before-commit',
      title: 'Updates the metrics before committing the offset',
      detail:
        'At the first offset commit the metrics already count the first span, and after three spans `metrics:t1:llm:support-model` reads 2 calls, 2000 ms, 400 input and 70 output tokens, `metrics:t1:guardrail:gate` 1 blocked, with no lag. The starter commits first, so a crash in between loses the call from the metrics.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /\.CommitMessage\(/]},
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
from confluent_kafka import Consumer, Producer

from apv2 import outbox  # outbox.insert(span, reason) — provided
from apv2.config import TRACE_TOPIC, metrics_key

logger = logging.getLogger("apv2.trace")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


# TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
def emit(call: dict) -> None:
    """One span per LLM, tool or guardrail call. Runs on the turn's path: it must not fail or wait for the broker."""
    producer.produce(TRACE_TOPIC, key=call["turn_id"], value=json.dumps(call))
    logger.info("span turn=%s kind=%s name=%s prompt=%r", call["turn_id"], call["kind"], call["name"], call["prompt"])
    producer.poll(0)


def consume() -> None:
    """The insights consumer: per-call metrics in Redis."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "insights", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TRACE_TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        consumer.commit(record, asynchronous=False)
        span = json.loads(record.value())
        key = metrics_key(span["tenant"], span["kind"], span["name"])
        blocked = any(verdict != "PASS" for verdict in (span.get("verdicts") or {}).values())
        pipe = r.pipeline()
        pipe.hincrby(key, "calls", 1)
        pipe.hincrby(key, "latency_ms", span["latency_ms"])
        pipe.hincrby(key, "input_tokens", span["input_tokens"])
        pipe.hincrby(key, "output_tokens", span["output_tokens"])
        pipe.hincrby(key, "blocked", int(blocked))
        pipe.execute()
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from apv2 import outbox  # outbox.insert(span, reason) — provided
from apv2.config import TRACE_TOPIC, metrics_key

logger = logging.getLogger("apv2.trace")

SPAN_FIELDS = ("tenant", "conversation", "turn_id", "iteration", "kind", "name", "latency_ms", "input_tokens", "output_tokens", "verdicts")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def _on_delivery(err, msg) -> None:
    if err is not None:
        outbox.insert(json.loads(msg.value()), str(err))  # the broker refused it: a relay produces it later


def emit(call: dict) -> None:
    """One span per LLM, tool or guardrail call. Runs on the turn's path: it must not fail or wait for the broker."""
    span = {field: call[field] for field in SPAN_FIELDS}  # ids, counts, latency, verdicts: the text stays out
    try:
        producer.produce(TRACE_TOPIC, key=span["conversation"], value=json.dumps(span), on_delivery=_on_delivery)
    except BufferError:
        outbox.insert(span, "producer queue full")
    logger.info("span turn=%s kind=%s name=%s", span["turn_id"], span["kind"], span["name"])
    producer.poll(0)  # serve delivery reports; returns at once


def consume() -> None:
    """The insights consumer: per-call metrics in Redis."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "insights", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TRACE_TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        span = json.loads(record.value())
        key = metrics_key(span["tenant"], span["kind"], span["name"])
        blocked = any(verdict != "PASS" for verdict in (span.get("verdicts") or {}).values())
        pipe = r.pipeline()
        pipe.hincrby(key, "calls", 1)
        pipe.hincrby(key, "latency_ms", span["latency_ms"])
        pipe.hincrby(key, "input_tokens", span["input_tokens"])
        pipe.hincrby(key, "output_tokens", span["output_tokens"])
        pipe.hincrby(key, "blocked", int(blocked))
        pipe.execute()
        consumer.commit(record, asynchronous=False)  # after the increments: a crash before this point redelivers
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {TRACE_TOPIC, metricsKey} from 'apv2/config';
import * as outbox from 'apv2/outbox'; // outbox.insert(span, reason) — provided

const kafka = new Kafka({clientId: 'apv2', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

/** What the workflow knows about one LLM, tool or guardrail call. */
export interface Call {
  tenant: string;
  conversation: string;
  turn_id: string;
  iteration: number;
  kind: string;
  name: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  verdicts: Record<string, string>;
  prompt: string;
  answer: string;
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
/** One span per LLM, tool or guardrail call. Runs on the turn's path: it must not fail or wait for the broker. */
export async function emit(call: Call): Promise<void> {
  await producer.send({topic: TRACE_TOPIC, messages: [{key: call.turn_id, value: JSON.stringify(call)}]});
  console.log(\`span turn=\${call.turn_id} kind=\${call.kind} name=\${call.name} prompt=\${call.prompt}\`);
}

/** The insights consumer: per-call metrics in Redis. */
export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'insights'});
  await consumer.connect();
  await consumer.subscribe({topic: TRACE_TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const span = JSON.parse(message.value?.toString() ?? '{}') as Call;
      const key = metricsKey(span.tenant, span.kind, span.name);
      const blocked = Object.values(span.verdicts ?? {}).some(verdict => verdict !== 'PASS');
      await redis
        .pipeline()
        .hincrby(key, 'calls', 1)
        .hincrby(key, 'latency_ms', span.latency_ms)
        .hincrby(key, 'input_tokens', span.input_tokens)
        .hincrby(key, 'output_tokens', span.output_tokens)
        .hincrby(key, 'blocked', blocked ? 1 : 0)
        .exec();
    },
  });
}

void outbox;
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {TRACE_TOPIC, metricsKey} from 'apv2/config';
import * as outbox from 'apv2/outbox'; // outbox.insert(span, reason) — provided

const kafka = new Kafka({clientId: 'apv2', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true}); // idempotent implies acks: -1 (all)
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

/** What the workflow knows about one LLM, tool or guardrail call. */
export interface Call {
  tenant: string;
  conversation: string;
  turn_id: string;
  iteration: number;
  kind: string;
  name: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  verdicts: Record<string, string>;
  prompt: string;
  answer: string;
}

/** The span on the topic: ids, counts, latency, verdicts. The text stays out. */
export type Span = Omit<Call, 'prompt' | 'answer'>;

/** One span per LLM, tool or guardrail call. Runs on the turn's path: it must not fail or wait for the broker. */
export function emit(call: Call): void {
  const {prompt: _prompt, answer: _answer, ...span} = call;
  // Not awaited: the turn goes on. A refused delivery goes to the outbox for a relay.
  producer
    .send({topic: TRACE_TOPIC, messages: [{key: span.conversation, value: JSON.stringify(span)}], acks: -1})
    .catch((err: Error) => outbox.insert(span as unknown as Record<string, unknown>, err.message));
}

/** The insights consumer: per-call metrics in Redis. */
export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'insights'});
  await consumer.connect();
  await consumer.subscribe({topic: TRACE_TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const span = JSON.parse(message.value?.toString() ?? '{}') as Span;
      const key = metricsKey(span.tenant, span.kind, span.name);
      const blocked = Object.values(span.verdicts ?? {}).some(verdict => verdict !== 'PASS');
      await redis
        .pipeline()
        .hincrby(key, 'calls', 1)
        .hincrby(key, 'latency_ms', span.latency_ms)
        .hincrby(key, 'input_tokens', span.input_tokens)
        .hincrby(key, 'output_tokens', span.output_tokens)
        .hincrby(key, 'blocked', blocked ? 1 : 0)
        .exec();
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]); // after the increments
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"

	"apv2/config" // config.TraceTopic, config.MetricsKey — provided
	"apv2/outbox" // outbox.Insert(ctx, span, reason) — provided
)

var producer = newProducer()
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

// Call is what the workflow knows about one LLM, tool or guardrail call.
type Call struct {
	Tenant       string            \`json:"tenant"\`
	Conversation string            \`json:"conversation"\`
	TurnID       string            \`json:"turn_id"\`
	Iteration    int               \`json:"iteration"\`
	Kind         string            \`json:"kind"\`
	Name         string            \`json:"name"\`
	LatencyMs    int64             \`json:"latency_ms"\`
	InputTokens  int64             \`json:"input_tokens"\`
	OutputTokens int64             \`json:"output_tokens"\`
	Verdicts     map[string]string \`json:"verdicts"\`
	Prompt       string            \`json:"prompt"\`
	Answer       string            \`json:"answer"\`
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// emit produces one span per LLM, tool or guardrail call. It runs on the turn's path: it must not
// fail or wait for the broker.
func emit(ctx context.Context, call Call) {
	value, _ := json.Marshal(call)
	topic := config.TraceTopic
	producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(call.TurnID), Value: value}, nil)
	log.Printf("span turn=%s kind=%s name=%s prompt=%q", call.TurnID, call.Kind, call.Name, call.Prompt)
}

// consume is the insights consumer: per-call metrics in Redis.
func consume(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": "insights", "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		return err
	}
	if err := consumer.SubscribeTopics([]string{config.TraceTopic}, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
		var span Call
		if err := json.Unmarshal(msg.Value, &span); err != nil {
			continue
		}
		blocked := int64(0)
		for _, verdict := range span.Verdicts {
			if verdict != "PASS" {
				blocked = 1
			}
		}
		key := config.MetricsKey(span.Tenant, span.Kind, span.Name)
		if _, err := rdb.Pipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.HIncrBy(ctx, key, "calls", 1)
			pipe.HIncrBy(ctx, key, "latency_ms", span.LatencyMs)
			pipe.HIncrBy(ctx, key, "input_tokens", span.InputTokens)
			pipe.HIncrBy(ctx, key, "output_tokens", span.OutputTokens)
			pipe.HIncrBy(ctx, key, "blocked", blocked)
			return nil
		}); err != nil {
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"

	"apv2/config" // config.TraceTopic, config.MetricsKey — provided
	"apv2/outbox" // outbox.Insert(ctx, span, reason) — provided
)

var producer = newProducer()
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// newProducer is idempotent with acks=all (kafka-go has no idempotent producer; confluent-kafka-go
// does), and serves its delivery reports: a refused span goes to the outbox for a relay.
func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
		"acks":               "all", // every in-sync replica has the span before the broker answers
	})
	if err != nil {
		panic(err)
	}
	go func() {
		for e := range p.Events() {
			if m, ok := e.(*kafka.Message); ok && m.TopicPartition.Error != nil {
				outbox.Insert(context.Background(), m.Value, m.TopicPartition.Error.Error())
			}
		}
	}()
	return p
}

// Call is what the workflow knows about one LLM, tool or guardrail call.
type Call struct {
	Tenant       string            \`json:"tenant"\`
	Conversation string            \`json:"conversation"\`
	TurnID       string            \`json:"turn_id"\`
	Iteration    int               \`json:"iteration"\`
	Kind         string            \`json:"kind"\`
	Name         string            \`json:"name"\`
	LatencyMs    int64             \`json:"latency_ms"\`
	InputTokens  int64             \`json:"input_tokens"\`
	OutputTokens int64             \`json:"output_tokens"\`
	Verdicts     map[string]string \`json:"verdicts"\`
	Prompt       string            \`json:"prompt"\`
	Answer       string            \`json:"answer"\`
}

// Span is what goes on the topic: ids, counts, latency, verdicts. The text stays out.
type Span struct {
	Tenant       string            \`json:"tenant"\`
	Conversation string            \`json:"conversation"\`
	TurnID       string            \`json:"turn_id"\`
	Iteration    int               \`json:"iteration"\`
	Kind         string            \`json:"kind"\`
	Name         string            \`json:"name"\`
	LatencyMs    int64             \`json:"latency_ms"\`
	InputTokens  int64             \`json:"input_tokens"\`
	OutputTokens int64             \`json:"output_tokens"\`
	Verdicts     map[string]string \`json:"verdicts"\`
}

// emit produces one span per LLM, tool or guardrail call. It runs on the turn's path: it must not
// fail or wait for the broker.
func emit(ctx context.Context, call Call) {
	span := Span{
		Tenant: call.Tenant, Conversation: call.Conversation, TurnID: call.TurnID, Iteration: call.Iteration,
		Kind: call.Kind, Name: call.Name, LatencyMs: call.LatencyMs, InputTokens: call.InputTokens,
		OutputTokens: call.OutputTokens, Verdicts: call.Verdicts,
	}
	value, _ := json.Marshal(span)
	topic := config.TraceTopic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(span.Conversation), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		outbox.Insert(ctx, value, err.Error()) // refused before it was even queued
	}
	log.Printf("span turn=%s kind=%s name=%s", span.TurnID, span.Kind, span.Name)
}

// consume is the insights consumer: per-call metrics in Redis.
func consume(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": "insights", "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		return err
	}
	if err := consumer.SubscribeTopics([]string{config.TraceTopic}, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		var span Span
		if err := json.Unmarshal(msg.Value, &span); err != nil {
			consumer.CommitMessage(msg) // a malformed span is skipped, not retried forever
			continue
		}
		blocked := int64(0)
		for _, verdict := range span.Verdicts {
			if verdict != "PASS" {
				blocked = 1
			}
		}
		key := config.MetricsKey(span.Tenant, span.Kind, span.Name)
		if _, err := rdb.Pipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.HIncrBy(ctx, key, "calls", 1)
			pipe.HIncrBy(ctx, key, "latency_ms", span.LatencyMs)
			pipe.HIncrBy(ctx, key, "input_tokens", span.InputTokens)
			pipe.HIncrBy(ctx, key, "output_tokens", span.OutputTokens)
			pipe.HIncrBy(ctx, key, "blocked", blocked)
			return nil
		}); err != nil {
			return err // not committed: the span is redelivered
		}
		if _, err := consumer.CommitMessage(msg); err != nil { // after the increments
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import scala.jdk.CollectionConverters._

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import apv2.Config

object TraceEvents {
  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  /**
   * One span per LLM, tool or guardrail call: call holds tenant, conversation, turn_id, iteration, kind,
   * name, latency_ms, input_tokens, output_tokens, verdicts, prompt and answer. It runs on the turn's
   * path: it must not fail or wait for the broker.
   */
  def emit(call: ujson.Obj): Unit = {
    producer.send(new ProducerRecord[String, String](Config.TraceTopic, call("turn_id").str, ujson.write(call)))
    println(s"span turn=\${call("turn_id").str} kind=\${call("kind").str} prompt=\${call("prompt").str}")
  }

  /** The insights consumer: per-call metrics in Redis. */
  def consume(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "insights")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.TraceTopic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync()
        val span = ujson.read(record.value())
        val key = Config.metricsKey(span("tenant").str, span("kind").str, span("name").str)
        val blocked = span.obj.get("verdicts").exists(_.obj.values.exists(_.str != "PASS"))
        jedis.hincrBy(key, "calls", 1)
        jedis.hincrBy(key, "latency_ms", span("latency_ms").num.toLong)
        jedis.hincrBy(key, "input_tokens", span("input_tokens").num.toLong)
        jedis.hincrBy(key, "output_tokens", span("output_tokens").num.toLong)
        jedis.hincrBy(key, "blocked", if (blocked) 1L else 0L)
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import scala.jdk.CollectionConverters._

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerConfig, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import apv2.{Config, Outbox}

object TraceEvents {
  val SpanFields = Seq("tenant", "conversation", "turn_id", "iteration", "kind", "name", "latency_ms", "input_tokens", "output_tokens", "verdicts")

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)

  /**
   * One span per LLM, tool or guardrail call: call holds tenant, conversation, turn_id, iteration, kind,
   * name, latency_ms, input_tokens, output_tokens, verdicts, prompt and answer. It runs on the turn's
   * path: it must not fail or wait for the broker.
   */
  def emit(call: ujson.Obj): Unit = {
    val span = ujson.Obj.from(SpanFields.flatMap(field => call.value.get(field).map(field -> _))) // the text stays out
    val value = ujson.write(span)
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) Outbox.insert(value, exception.getMessage) // the broker refused it: a relay produces it later
    }
    producer.send(new ProducerRecord[String, String](Config.TraceTopic, span("conversation").str, value), onDelivery) // not awaited
  }

  /** The insights consumer: per-call metrics in Redis. */
  def consume(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "insights")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.TraceTopic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val span = ujson.read(record.value())
        val key = Config.metricsKey(span("tenant").str, span("kind").str, span("name").str)
        val blocked = span.obj.get("verdicts").exists(_.obj.values.exists(_.str != "PASS"))
        jedis.hincrBy(key, "calls", 1)
        jedis.hincrBy(key, "latency_ms", span("latency_ms").num.toLong)
        jedis.hincrBy(key, "input_tokens", span("input_tokens").num.toLong)
        jedis.hincrBy(key, "output_tokens", span("output_tokens").num.toLong)
        jedis.hincrBy(key, "blocked", if (blocked) 1L else 0L)
        consumer.commitSync() // after the increments: a crash before this point redelivers
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "apv2/config.h"  // config::kTraceTopic, config::metrics_key, config::redis() — provided
#include "apv2/outbox.h"  // outbox::insert(span_json, reason) — provided

using json = nlohmann::json;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// One span per LLM, tool or guardrail call: call holds tenant, conversation, turn_id, iteration, kind,
// name, latency_ms, input_tokens, output_tokens, verdicts, prompt and answer. It runs on the turn's
// path: it must not fail or wait for the broker.
void emit(const json& call) {
  const std::string value = call.dump();
  const std::string turn_id = call["turn_id"];
  producer->produce(config::kTraceTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    turn_id.c_str(), turn_id.size(), 0, nullptr);
  std::cout << "span turn=" << turn_id << " kind=" << call["kind"].get<std::string>() << " prompt=" << call["prompt"].get<std::string>() << "\\n";
  producer->poll(0);
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "insights", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTraceTopic});
  return consumer;
}

// The insights consumer: per-call metrics in Redis.
void consume() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const json span = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!span.is_object()) continue;
    const std::string key = config::metrics_key(span["tenant"], span["kind"], span["name"]);
    const json verdicts = span.value("verdicts", json::object());
    bool blocked = false;
    for (const auto& [_, verdict] : verdicts.items()) blocked = blocked || verdict != "PASS";
    config::redis().hincrby(key, "calls", 1);
    config::redis().hincrby(key, "latency_ms", span["latency_ms"].get<long long>());
    config::redis().hincrby(key, "input_tokens", span["input_tokens"].get<long long>());
    config::redis().hincrby(key, "output_tokens", span["output_tokens"].get<long long>());
    config::redis().hincrby(key, "blocked", blocked ? 1 : 0);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "apv2/config.h"  // config::kTraceTopic, config::metrics_key, config::redis() — provided
#include "apv2/outbox.h"  // outbox::insert(span_json, reason) — provided

using json = nlohmann::json;

const char* const kSpanFields[] = {"tenant", "conversation", "turn_id", "iteration", "kind", "name", "latency_ms", "input_tokens", "output_tokens", "verdicts"};

// The delivery report: a refused span goes to the outbox for a relay to produce later.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    outbox::insert(std::string(static_cast<const char*>(message.payload()), message.len()), message.errstr());
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

// One span per LLM, tool or guardrail call: call holds tenant, conversation, turn_id, iteration, kind,
// name, latency_ms, input_tokens, output_tokens, verdicts, prompt and answer. It runs on the turn's
// path: it must not fail or wait for the broker.
void emit(const json& call) {
  json span = json::object();
  for (const char* field : kSpanFields) span[field] = call.value(field, json());  // the text stays out
  const std::string value = span.dump();
  const std::string conversation = span["conversation"];
  const RdKafka::ErrorCode err = producer->produce(config::kTraceTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   const_cast<char*>(value.data()), value.size(), conversation.c_str(), conversation.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) outbox::insert(value, RdKafka::err2str(err));  // refused before it was queued
  std::cout << "span turn=" << span["turn_id"].get<std::string>() << " kind=" << span["kind"].get<std::string>() << "\\n";
  producer->poll(0);  // serve delivery reports; returns at once
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "insights", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTraceTopic});
  return consumer;
}

// The insights consumer: per-call metrics in Redis.
void consume() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json span = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!span.is_object()) {
      consumer->commitSync(msg.get());  // a malformed span is skipped, not retried forever
      continue;
    }
    const std::string key = config::metrics_key(span["tenant"], span["kind"], span["name"]);
    const json verdicts = span.value("verdicts", json::object());
    bool blocked = false;
    for (const auto& [_, verdict] : verdicts.items()) blocked = blocked || verdict != "PASS";
    config::redis().hincrby(key, "calls", 1);
    config::redis().hincrby(key, "latency_ms", span["latency_ms"].get<long long>());
    config::redis().hincrby(key, "input_tokens", span["input_tokens"].get<long long>());
    config::redis().hincrby(key, "output_tokens", span["output_tokens"].get<long long>());
    config::redis().hincrby(key, "blocked", blocked ? 1 : 0);
    consumer->commitSync(msg.get());  // after the increments: a crash before this point redelivers
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

TOPIC = "assistant.trace"
CANARY = "CANARY-5521 my email is ana@example.com"


def _call(turn_id="turn-1", conversation="c-1", kind="llm", name="support-model", latency_ms=800, input_tokens=100, output_tokens=50, verdicts=None, prompt="Where is my next reservation?", answer="Your next stay is in Lisbon."):
    return {"tenant": "t1", "conversation": conversation, "turn_id": turn_id, "iteration": 1, "kind": kind, "name": name, "latency_ms": latency_ms, "input_tokens": input_tokens, "output_tokens": output_tokens, "verdicts": verdicts or {}, "prompt": prompt, "answer": answer}


def _span(call):
    return {k: v for k, v in call.items() if k not in ("prompt", "answer")}


def _turn_ids(ctx):
    return [json.loads(r.value)["turn_id"] for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("apv2:outbox", 0, -1)]


def check_conversation_key(ctx):
    m = ctx.load("trace_events")
    m.emit(_call("turn-1", "c-1"))
    m.emit(_call("turn-2", "c-2", kind="tool", name="get_reservation", input_tokens=0, output_tokens=0))
    m.emit(_call("turn-3", "c-1", kind="guardrail", name="gate", verdicts={"relevance": "PASS"}))
    m.producer.poll(0)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three emit calls produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"c-1", b"c-2", b"c-1"], f"spans must be keyed by the conversation, got {keys}: keyed by turn id, one conversation's spans spread over the partitions and its timeline arrives out of order"
    assert records[0].partition == records[2].partition, "one conversation's spans must land on one partition"
    span = json.loads(records[0].value)
    assert span.get("turn_id") == "turn-1" and span.get("conversation") == "c-1", f"the span still carries its turn id: {span}"
    for field in ("tenant", "iteration", "kind", "name", "latency_ms", "input_tokens", "output_tokens", "verdicts"):
        assert field in span, f"the span is missing {field}: {span}"


def check_idempotent_acks(ctx):
    m = ctx.load("trace_events")
    ctx.kafka.lose_acks(TOPIC, 1)
    m.emit(_call("turn-1"))
    m.producer.poll(0)
    ids = _turn_ids(ctx)
    assert ids == ["turn-1"], f"after one produce whose acknowledgement was lost the topic holds {ids}: the retry wrote the span again and the model call is counted twice. Enable idempotence"
    m.emit(_call("turn-2"))
    m.producer.poll(0)
    ctx.kafka.failover(TOPIC)
    assert "turn-2" in _turn_ids(ctx), "a leader failover right after the acknowledgement lost the span: wait for all in-sync replicas (acks=all)"


def check_no_text(ctx):
    m = ctx.load("trace_events")
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.DEBUG)
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            m.emit(_call("turn-1", prompt=CANARY, answer="Answer to " + CANARY))
            m.producer.poll(0)
    finally:
        logging.getLogger().removeHandler(handler)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one emit call produced {len(records)} records"
    value = records[0].value.decode()
    assert "CANARY-5521" not in value, f"the span carries the guest's text: {value}"
    span = json.loads(value)
    assert "prompt" not in span and "answer" not in span, f"the span carries prompt or answer fields: {sorted(span)}"
    assert "CANARY-5521" not in captured.getvalue(), f"the guest's text was printed or logged: {captured.getvalue().strip()!r}"


def check_outbox_fallback(ctx):
    m = ctx.load("trace_events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.emit(_call("turn-9"))
    except Exception as exc:  # noqa: BLE001 - whatever it raised is the verdict
        raise AssertionError(f"emit failed the turn when the broker refused the span: {exc!r}. Write the span to the outbox instead") from None
    m.producer.poll(0)
    rows = _outbox(ctx)
    assert rows, "the broker refused the span and nothing reached apv2:outbox: handle the delivery report (on_delivery) and call outbox.insert(span, reason)"
    assert rows[0].get("span", {}).get("turn_id") == "turn-9", f"the outbox row must carry the span: {rows[0]}"
    assert ctx.kafka.flushes == 0, "emit must not flush: the turn would wait for the broker"
    m.emit(_call("turn-10"))
    m.producer.poll(0)
    assert _turn_ids(ctx) == ["turn-10"], "once the broker accepts records again spans flow to the topic"
    assert len(_outbox(ctx)) == 1, "a delivered span must not be written to the outbox"


def check_metrics_before_commit(ctx):
    llm = "metrics:t1:llm:support-model"
    for call in (_call("turn-1", latency_ms=800, input_tokens=100, output_tokens=50), _call("turn-1", latency_ms=1200, input_tokens=300, output_tokens=20), _call("turn-1", kind="guardrail", name="gate", latency_ms=40, input_tokens=0, output_tokens=0, verdicts={"relevance": "PASS", "groundedness": "FAIL"})):
        ctx.kafka.seed(TOPIC, key="c-1", value=json.dumps(_span(call)))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(ctx.redis.hget(llm, "calls")))
    m = ctx.load("trace_events")
    ctx.drain(m.consume)
    assert at_commit, "the consumer never committed an offset"
    assert at_commit[0] is not None and int(at_commit[0]) >= 1, f"at the first commit {llm} calls held {at_commit[0]!r}: increment before the commit, or a crash in between loses the call from the metrics"
    totals = {k: int(v) for k, v in ctx.redis.hgetall(llm).items()}
    assert totals == {"calls": 2, "latency_ms": 2000, "input_tokens": 400, "output_tokens": 70, "blocked": 0}, f"{llm} reads {totals}, expected 2 calls, 2000 ms, 400 and 70 tokens, 0 blocked"
    assert ctx.redis.hget("metrics:t1:guardrail:gate", "blocked") == "1", "a guardrail span with a FAIL verdict counts as blocked"
    assert ctx.kafka.lag("insights", TOPIC) == 0, "every processed span must be committed"
`,
    typescript: `const TOPIC = 'assistant.trace';
const CANARY = 'CANARY-5521 my email is ana@example.com';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const callOf = ({turn_id = 'turn-1', conversation = 'c-1', kind = 'llm', name = 'support-model', latency_ms = 800, input_tokens = 100, output_tokens = 50, verdicts = {} as Record<string, string>, prompt = 'Where is my next reservation?', answer = 'Your next stay is in Lisbon.'} = {}) => ({
  tenant: 't1',
  conversation,
  turn_id,
  iteration: 1,
  kind,
  name,
  latency_ms,
  input_tokens,
  output_tokens,
  verdicts,
  prompt,
  answer,
});
const spanOf = call => {
  const {prompt: _p, answer: _a, ...span} = call;
  return span;
};
const turnIds = (ctx): string[] => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()).turn_id);
const outboxRows = (ctx): Record<string, any>[] => ctx.redis.lrange('apv2:outbox', 0, -1).map((row: string) => JSON.parse(row));

export async function check_conversation_key(ctx) {
  const m = ctx.load('trace_events');
  await m.emit(callOf({turn_id: 'turn-1', conversation: 'c-1'}));
  await m.emit(callOf({turn_id: 'turn-2', conversation: 'c-2', kind: 'tool', name: 'get_reservation', input_tokens: 0, output_tokens: 0}));
  await m.emit(callOf({turn_id: 'turn-3', conversation: 'c-1', kind: 'guardrail', name: 'gate', verdicts: {relevance: 'PASS'}}));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three emit calls produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['c-1', 'c-2', 'c-1'], \`spans must be keyed by the conversation, got \${JSON.stringify(keys)}: keyed by turn id, one conversation's spans spread over the partitions and its timeline arrives out of order\`);
  assert.equal(records[0].partition, records[2].partition, "one conversation's spans must land on one partition");
  const span = JSON.parse(records[0].value.toString());
  assert(span.turn_id === 'turn-1' && span.conversation === 'c-1', \`the span still carries its turn id: \${records[0].value}\`);
  for (const field of ['tenant', 'iteration', 'kind', 'name', 'latency_ms', 'input_tokens', 'output_tokens', 'verdicts']) assert(field in span, \`the span is missing \${field}: \${records[0].value}\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('trace_events');
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.emit(callOf({turn_id: 'turn-1'}));
  await settle();
  assert.deepStrictEqual(turnIds(ctx), ['turn-1'], \`after one produce whose acknowledgement was lost the topic holds \${JSON.stringify(turnIds(ctx))}: the retry wrote the span again and the model call is counted twice. Enable idempotence\`);
  await m.emit(callOf({turn_id: 'turn-2'}));
  await settle();
  ctx.kafka.failover(TOPIC);
  assert(turnIds(ctx).includes('turn-2'), 'a leader failover right after the acknowledgement lost the span: wait for all in-sync replicas (acks: -1)');
}

export async function check_no_text(ctx) {
  const m = ctx.load('trace_events');
  const logged: string[] = [];
  const prior = {log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  try {
    await m.emit(callOf({turn_id: 'turn-1', prompt: CANARY, answer: 'Answer to ' + CANARY}));
    await settle();
  } finally {
    Object.assign(console, prior);
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one emit call produced \${records.length} records\`);
  const value = records[0].value.toString();
  assert(!value.includes('CANARY-5521'), \`the span carries the guest's text: \${value}\`);
  const span = JSON.parse(value);
  assert(!('prompt' in span) && !('answer' in span), \`the span carries prompt or answer fields: \${JSON.stringify(Object.keys(span).sort())}\`);
  const leak = logged.find(l => l.includes('CANARY-5521'));
  assert(leak === undefined, \`the guest's text was printed or logged: \${JSON.stringify(leak)}\`);
}

export async function check_outbox_fallback(ctx) {
  const m = ctx.load('trace_events');
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await m.emit(callOf({turn_id: 'turn-9'}));
  } catch (e) {
    assert.fail(\`emit failed the turn when the broker refused the span: \${e}. Write the span to the outbox instead\`);
  }
  await settle();
  const rows = outboxRows(ctx);
  assert(rows.length > 0, 'the broker refused the span and nothing reached apv2:outbox: catch the rejected send and call outbox.insert(span, reason)');
  assert.equal(rows[0].span?.turn_id, 'turn-9', \`the outbox row must carry the span: \${JSON.stringify(rows[0])}\`);
  await m.emit(callOf({turn_id: 'turn-10'}));
  await settle();
  assert.deepStrictEqual(turnIds(ctx), ['turn-10'], 'once the broker accepts records again spans flow to the topic');
  assert.equal(outboxRows(ctx).length, 1, 'a delivered span must not be written to the outbox');
}

export async function check_metrics_before_commit(ctx) {
  const llm = 'metrics:t1:llm:support-model';
  for (const call of [
    callOf({latency_ms: 800, input_tokens: 100, output_tokens: 50}),
    callOf({latency_ms: 1200, input_tokens: 300, output_tokens: 20}),
    callOf({kind: 'guardrail', name: 'gate', latency_ms: 40, input_tokens: 0, output_tokens: 0, verdicts: {relevance: 'PASS', groundedness: 'FAIL'}}),
  ]) {
    ctx.kafka.seed(TOPIC, {key: 'c-1', value: JSON.stringify(spanOf(call))});
  }
  const atCommit: (string | null)[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.hget(llm, 'calls')));
  const m = ctx.load('trace_events');
  await ctx.drain(m.consume());
  assert(atCommit.length > 0, 'the consumer never committed an offset');
  assert(atCommit[0] !== null && Number(atCommit[0]) >= 1, \`at the first commit \${llm} calls held \${JSON.stringify(atCommit[0])}: increment before the commit, or a crash in between loses the call from the metrics\`);
  const totals = Object.fromEntries(Object.entries(ctx.redis.hgetall(llm)).map(([k, v]) => [k, Number(v)]));
  assert.deepStrictEqual(totals, {calls: 2, latency_ms: 2000, input_tokens: 400, output_tokens: 70, blocked: 0}, \`\${llm} reads \${JSON.stringify(totals)}, expected 2 calls, 2000 ms, 400 and 70 tokens, 0 blocked\`);
  assert.equal(ctx.redis.hget('metrics:t1:guardrail:gate', 'blocked'), '1', 'a guardrail span with a FAIL verdict counts as blocked');
  assert.equal(ctx.kafka.lag('insights', TOPIC), 0, 'every processed span must be committed');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"strings"

	"leetbuild/harness"
)

const traceTopic = "assistant.trace"
const traceCanary = "CANARY-5521 my email is ana@example.com"

func traceCall(turnID, conversation, kind, name string, latency, in, out int64, verdicts map[string]string) Call {
	if verdicts == nil {
		verdicts = map[string]string{}
	}
	return Call{Tenant: "t1", Conversation: conversation, TurnID: turnID, Iteration: 1, Kind: kind, Name: name, LatencyMs: latency, InputTokens: in, OutputTokens: out, Verdicts: verdicts, Prompt: "Where is my next reservation?", Answer: "Your next stay is in Lisbon."}
}

func traceTurnIDs(ctx *harness.Ctx) []string {
	ids := []string{}
	for _, r := range ctx.Kafka.Records(traceTopic) {
		var v map[string]any
		json.Unmarshal(r.Value, &v)
		id, _ := v["turn_id"].(string)
		ids = append(ids, id)
	}
	return ids
}

func traceOutbox(ctx *harness.Ctx) []map[string]any {
	var rows []map[string]any
	for _, row := range ctx.Redis.LRange("apv2:outbox", 0, -1) {
		var v map[string]any
		json.Unmarshal([]byte(row), &v)
		rows = append(rows, v)
	}
	return rows
}

func CheckConversationKey(ctx *harness.Ctx) {
	emit(context.Background(), traceCall("turn-1", "c-1", "llm", "support-model", 800, 100, 50, nil))
	emit(context.Background(), traceCall("turn-2", "c-2", "tool", "get_reservation", 120, 0, 0, nil))
	emit(context.Background(), traceCall("turn-3", "c-1", "guardrail", "gate", 40, 0, 0, map[string]string{"relevance": "PASS"}))
	ctx.Settle()
	records := ctx.Kafka.Records(traceTopic)
	ctx.Equal(len(records), 3, "three emit calls must produce three records on assistant.trace; the records")
	ctx.Equal(ctx.Kafka.Keys(traceTopic), []string{"c-1", "c-2", "c-1"}, "spans must be keyed by the conversation (keyed by turn id, one conversation's spans spread over the partitions and its timeline arrives out of order); the keys")
	ctx.Equal(records[0].Partition, records[2].Partition, "one conversation's spans must land on one partition; c-1's partitions")
	var span map[string]any
	ctx.NoError(json.Unmarshal(records[0].Value, &span), "the span must be JSON: %s", records[0].Value)
	ctx.Assert(span["turn_id"] == "turn-1" && span["conversation"] == "c-1", "the span still carries its turn id: %s", records[0].Value)
	for _, field := range []string{"tenant", "iteration", "kind", "name", "latency_ms", "input_tokens", "output_tokens", "verdicts"} {
		_, ok := span[field]
		ctx.Assert(ok, "the span is missing %s: %s", field, records[0].Value)
	}
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(traceTopic, 1)
	emit(context.Background(), traceCall("turn-1", "c-1", "llm", "support-model", 800, 100, 50, nil))
	ctx.Settle()
	ctx.Equal(traceTurnIDs(ctx), []string{"turn-1"}, "after one produce whose acknowledgement was lost the retry must not write the span again (enable.idempotence); the spans")
	emit(context.Background(), traceCall("turn-2", "c-1", "llm", "support-model", 800, 100, 50, nil))
	ctx.Settle()
	ctx.Kafka.Failover(traceTopic)
	ctx.Assert(strings.Contains(strings.Join(traceTurnIDs(ctx), ","), "turn-2"), "a leader failover right after the acknowledgement lost the span: wait for all in-sync replicas (acks=all)")
}

func CheckNoText(ctx *harness.Ctx) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	call := traceCall("turn-1", "c-1", "llm", "support-model", 800, 100, 50, nil)
	call.Prompt = traceCanary
	call.Answer = "Answer to " + traceCanary
	emit(context.Background(), call)
	ctx.Settle()
	records := ctx.Kafka.Records(traceTopic)
	ctx.Equal(len(records), 1, "one emit call; the records")
	value := string(records[0].Value)
	ctx.Assert(!strings.Contains(value, "CANARY-5521"), "the span carries the guest's text: %s", value)
	var span map[string]any
	json.Unmarshal(records[0].Value, &span)
	_, hasPrompt := span["prompt"]
	_, hasAnswer := span["answer"]
	ctx.Assert(!hasPrompt && !hasAnswer, "the span carries prompt or answer fields: %s", value)
	ctx.Assert(!strings.Contains(logged.String(), "CANARY-5521"), "the guest's text was printed or logged: %q", strings.TrimSpace(logged.String()))
}

func CheckOutboxFallback(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(traceTopic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("emit failed the turn when the broker refused the span: %v. Write the span to the outbox instead", e)
			}
		}()
		emit(context.Background(), traceCall("turn-9", "c-1", "llm", "support-model", 800, 100, 50, nil))
	}()
	ctx.Settle()
	rows := traceOutbox(ctx)
	ctx.Assert(len(rows) > 0, "the broker refused the span and nothing reached apv2:outbox: read the producer's delivery reports (Events()) and call outbox.Insert")
	span, _ := rows[0]["span"].(map[string]any)
	ctx.Equal(span["turn_id"], "turn-9", "the outbox row must carry the span; the row %v; its turn id", rows[0])
	ctx.Equal(ctx.Kafka.Flushes(), 0, "emit must not flush (the turn would wait for the broker); the flushes")
	emit(context.Background(), traceCall("turn-10", "c-1", "llm", "support-model", 800, 100, 50, nil))
	ctx.Settle()
	ctx.Equal(traceTurnIDs(ctx), []string{"turn-10"}, "once the broker accepts records again spans flow to the topic; the spans")
	ctx.Equal(len(traceOutbox(ctx)), 1, "a delivered span must not be written to the outbox; the rows")
}

func CheckMetricsBeforeCommit(ctx *harness.Ctx) {
	llm := "metrics:t1:llm:support-model"
	for _, s := range []map[string]any{
		{"tenant": "t1", "conversation": "c-1", "turn_id": "turn-1", "iteration": 1, "kind": "llm", "name": "support-model", "latency_ms": 800, "input_tokens": 100, "output_tokens": 50, "verdicts": map[string]string{}},
		{"tenant": "t1", "conversation": "c-1", "turn_id": "turn-1", "iteration": 2, "kind": "llm", "name": "support-model", "latency_ms": 1200, "input_tokens": 300, "output_tokens": 20, "verdicts": map[string]string{}},
		{"tenant": "t1", "conversation": "c-1", "turn_id": "turn-1", "iteration": 2, "kind": "guardrail", "name": "gate", "latency_ms": 40, "input_tokens": 0, "output_tokens": 0, "verdicts": map[string]string{"relevance": "PASS", "groundedness": "FAIL"}},
	} {
		value, _ := json.Marshal(s)
		ctx.Kafka.Seed(traceTopic, "c-1", string(value))
	}
	var atCommit []string
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		v, _ := ctx.Redis.HGet(llm, "calls")
		atCommit = append(atCommit, v)
	})
	ctx.Drain(func() { consume(context.Background()) })
	ctx.Assert(len(atCommit) > 0, "the consumer never committed an offset")
	ctx.Assert(atCommit[0] != "" && atCommit[0] != "0", "at the first commit %s calls held %q: increment before the commit, or a crash in between loses the call from the metrics", llm, atCommit[0])
	ctx.Equal(ctx.Redis.HGetAll(llm), map[string]string{"calls": "2", "latency_ms": "2000", "input_tokens": "400", "output_tokens": "70", "blocked": "0"}, "%s (2 calls, 2000 ms, 400 and 70 tokens, 0 blocked)", llm)
	blocked, _ := ctx.Redis.HGet("metrics:t1:guardrail:gate", "blocked")
	ctx.Equal(blocked, "1", "a guardrail span with a FAIL verdict counts as blocked")
	ctx.Equal(ctx.Kafka.Lag("insights", traceTopic), 0, "every processed span must be committed; the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const std::string kTraceTopic = "assistant.trace";
const std::string kTraceCanary = "CANARY-5521 my email is ana@example.com";

json traceCall(const std::string& turn_id, const std::string& conversation = "c-1", const std::string& kind = "llm", const std::string& name = "support-model",
               long long latency = 800, long long in = 100, long long out = 50, const json& verdicts = json::object()) {
  return {{"tenant", "t1"}, {"conversation", conversation}, {"turn_id", turn_id}, {"iteration", 1}, {"kind", kind}, {"name", name}, {"latency_ms", latency},
          {"input_tokens", in}, {"output_tokens", out}, {"verdicts", verdicts}, {"prompt", "Where is my next reservation?"}, {"answer", "Your next stay is in Lisbon."}};
}

std::vector<std::string> traceTurnIds(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (const auto& r : ctx.Kafka.Records(kTraceTopic)) {
    const auto v = json::parse(r.Value.value_or(""), nullptr, false);
    ids.push_back(v.is_object() ? v.value("turn_id", "") : "");
  }
  return ids;
}

std::vector<json> traceOutbox(harness::Ctx& ctx) {
  std::vector<json> rows;
  for (const auto& row : ctx.Redis.LRange("apv2:outbox", 0, -1)) rows.push_back(json::parse(row, nullptr, false));
  return rows;
}

}  // namespace

void CheckConversationKey(harness::Ctx& ctx) {
  emit(traceCall("turn-1", "c-1"));
  emit(traceCall("turn-2", "c-2", "tool", "get_reservation", 120, 0, 0));
  emit(traceCall("turn-3", "c-1", "guardrail", "gate", 40, 0, 0, {{"relevance", "PASS"}}));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kTraceTopic);
  ctx.Equal(records.size(), 3, "three emit calls must produce three records on assistant.trace; the records");
  ctx.Equal(ctx.Kafka.Keys(kTraceTopic), {"c-1", "c-2", "c-1"},
            "spans must be keyed by the conversation (keyed by turn id, one conversation's spans spread over the partitions and its timeline arrives out of order); the keys");
  ctx.Equal(records[0].Partition, records[2].Partition, "one conversation's spans must land on one partition; c-1's partitions");
  const auto span = json::parse(records[0].Value.value_or(""), nullptr, false);
  ctx.Assert(span.is_object() && span.value("turn_id", "") == "turn-1" && span.value("conversation", "") == "c-1", "the span still carries its turn id: %s", records[0].Value.value_or(""));
  for (const std::string field : {"tenant", "iteration", "kind", "name", "latency_ms", "input_tokens", "output_tokens", "verdicts"}) {
    ctx.Assert(span.contains(field), "the span is missing %s: %s", field, records[0].Value.value_or(""));
  }
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTraceTopic, 1);
  emit(traceCall("turn-1"));
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(traceTurnIds(ctx), {"turn-1"}, "after one produce whose acknowledgement was lost the retry must not write the span again (enable.idempotence); the spans");
  emit(traceCall("turn-2"));
  producer->poll(0);
  ctx.Settle();
  ctx.Kafka.Failover(kTraceTopic);
  const auto ids = traceTurnIds(ctx);
  ctx.Assert(std::find(ids.begin(), ids.end(), "turn-2") != ids.end(), "a leader failover right after the acknowledgement lost the span: wait for all in-sync replicas (acks=all)");
}

void CheckNoText(harness::Ctx& ctx) {
  std::ostringstream logged;
  auto* out = std::cout.rdbuf(logged.rdbuf());
  auto* err = std::cerr.rdbuf(logged.rdbuf());
  json call = traceCall("turn-1");
  call["prompt"] = kTraceCanary;
  call["answer"] = "Answer to " + kTraceCanary;
  emit(call);
  producer->poll(0);
  std::cout.rdbuf(out);
  std::cerr.rdbuf(err);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kTraceTopic);
  ctx.Equal(records.size(), 1, "one emit call; the records");
  const std::string value = records[0].Value.value_or("");
  ctx.Assert(value.find("CANARY-5521") == std::string::npos, "the span carries the guest's text: %s", value);
  const auto span = json::parse(value, nullptr, false);
  ctx.Assert(span.is_object() && !span.contains("prompt") && !span.contains("answer"), "the span carries prompt or answer fields: %s", value);
  ctx.Assert(logged.str().find("CANARY-5521") == std::string::npos, "the guest's text was printed or logged: %q", logged.str());
}

void CheckOutboxFallback(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTraceTopic, 1);
  try {
    emit(traceCall("turn-9"));
  } catch (const std::exception& e) {
    ctx.Fatalf("emit failed the turn when the broker refused the span: %s. Write the span to the outbox instead", e.what());
  }
  producer->poll(0);
  ctx.Settle();
  const auto rows = traceOutbox(ctx);
  ctx.Assert(!rows.empty(), "the broker refused the span and nothing reached apv2:outbox: handle the delivery report (dr_cb) with outbox::insert");
  ctx.Assert(rows[0].is_object() && rows[0].contains("span") && rows[0]["span"].value("turn_id", "") == "turn-9", "the outbox row must carry the span: %s", rows[0].dump());
  ctx.Equal(ctx.Kafka.Flushes(), 0, "emit must not flush (the turn would wait for the broker); the flushes");
  emit(traceCall("turn-10"));
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(traceTurnIds(ctx), {"turn-10"}, "once the broker accepts records again spans flow to the topic; the spans");
  ctx.Equal(traceOutbox(ctx).size(), 1, "a delivered span must not be written to the outbox; the rows");
}

void CheckMetricsBeforeCommit(harness::Ctx& ctx) {
  const std::string llm = "metrics:t1:llm:support-model";
  for (json span : {traceCall("turn-1", "c-1", "llm", "support-model", 800, 100, 50), traceCall("turn-1", "c-1", "llm", "support-model", 1200, 300, 20),
                    traceCall("turn-1", "c-1", "guardrail", "gate", 40, 0, 0, {{"relevance", "PASS"}, {"groundedness", "FAIL"}})}) {
    span.erase("prompt");
    span.erase("answer");
    ctx.Kafka.Seed(kTraceTopic, "c-1", span.dump());
  }
  std::vector<std::optional<std::string>> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(ctx.Redis.HGet(llm, "calls")); });
  ctx.Drain([] { consume(); });
  ctx.Assert(!atCommit.empty(), "the consumer never committed an offset");
  ctx.Assert(atCommit[0] && *atCommit[0] != "0", "at the first commit %s calls held %v: increment before the commit, or a crash in between loses the call from the metrics", llm, atCommit[0]);
  ctx.Equal(ctx.Redis.HGetAll(llm), std::map<std::string, std::string>{{"calls", "2"}, {"latency_ms", "2000"}, {"input_tokens", "400"}, {"output_tokens", "70"}, {"blocked", "0"}},
            "%s (2 calls, 2000 ms, 400 and 70 tokens, 0 blocked)", llm);
  ctx.Equal(ctx.Redis.HGet("metrics:t1:guardrail:gate", "blocked"), "1", "a guardrail span with a FAIL verdict counts as blocked");
  ctx.Equal(ctx.Kafka.Lag("insights", kTraceTopic), 0, "every processed span must be committed; the lag");
}
`,
  },
  hints: [
    "Symptom: one conversation's timeline shows a tool result before the model call that asked for it, the token bill jumps after a broker hiccup, a guest's message turns up in a topic dump, and spans vanish on the day the broker refused writes.",
    'Mechanism: the key is the turn id, so a conversation spreads over partitions; without idempotence a retried write lands twice; the whole call (prompt and answer) is serialised and logged; nobody reads the delivery report; and the consumer commits before it increments.',
    'Change: build the span from the fields without `prompt`/`answer`; produce with `key=span["conversation"]`, `enable.idempotence` and `acks=all`, and `on_delivery` calling `outbox.insert(span, reason)`; drop the prompt from the log; increment, then `consumer.commit`.',
  ],
  debrief: `Each change decides what a guarantee covers. Keying by conversation is an ordering choice: a partition is the only place Kafka orders anything, and a support timeline is read per conversation. Idempotence with \`acks=all\` keeps one model call one span through a lost acknowledgement and a leader change, which is what makes token totals trustworthy. Leaving the text out is a retention decision: a topic keeps what it is given for its whole retention, so latency and token metrics never needed the guest's words. The outbox is filled from the delivery callback, where the broker's refusal actually arrives. Increment-then-commit turns a crash into a possible double count rather than a loss. Production pipelines dedupe spans by id in the consumer and sample traces by tenant.`,
};
