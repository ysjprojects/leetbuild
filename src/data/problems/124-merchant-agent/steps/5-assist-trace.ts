import type {Step} from '@/lib/types';

export const assistTraceStep: Step = {
  id: 'assist-trace',
  title: 'assist.trace: shop key, no merchant data, outbox, write before commit',
  concept: 'kafka',
  file: 'assist_trace',
  focus: ['api', 'kafka', 'builder', 'gtx'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: every finished turn becomes an
event, and a consumer turns events into ground-truth candidates, so the demo shows the set growing.
Four production contracts are broken. Review it, fix it, and prove the fix.

\`publish(turn)\` is how a finished assist turn reaches the evaluation pipeline, and the
**gtx-builder** consumer is how the ground-truth set of step 4 is fed from production.

- Publish **exactly one** \`assist.trace\` event per turn with the **shop** as the message key, so
  one merchant's turns stay ordered on one partition. The payload carries \`turn_id\`, \`shop\`,
  \`page\`, \`tools_used\`, \`latency_ms\`, \`tokens\`, \`judge_score\` and \`prompt_version\`.
- **No merchant data** in the event or the logs: not the merchant's message, not the tool results.
  The topic is retained for days and replicated; a customer list written into it outlives every
  retention rule the request path has. The ground-truth set gets the conversation later, through a
  consented sampling path, not through the trace topic.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent), so a retried produce
  cannot duplicate a trace.
- When the broker rejects the produce, write the event to the **outbox** instead of dropping it or
  failing the merchant's turn; a relay republishes outbox rows when the broker recovers.
- The consumer (group \`gtx-builder\`) inserts the ground-truth candidate
  (\`gtx.insert_candidate(event)\`) and **only then** commits the offset. Commit first and one crash
  loses the candidate forever.

**Failure mode the checks target.** Keying by turn id scatters one shop's turns across partitions;
an unconfigured producer duplicates on retry; the merchant's message and the tool results in the
event are a data leak with a long tail; a failed produce silently loses the trace; and
commit-before-insert trades correctness for exactly-once *looking* code.`,
  sequence: {
    participants: ['sidekick API', 'assist.trace', 'gtx-builder', 'ground-truth set'],
    messages: [
      {from: 'sidekick API', to: 'assist.trace', label: 'produce · key = shop · acks = all', kind: 'sync'},
      {from: 'assist.trace', to: 'sidekick API', label: 'ack / broker error', kind: 'reply'},
      {from: 'sidekick API', to: 'sidekick API', label: 'insert_outbox(shop, event) on failure', kind: 'sync'},
      {from: 'assist.trace', to: 'gtx-builder', label: 'consume · group gtx-builder', kind: 'async'},
      {from: 'gtx-builder', to: 'ground-truth set', label: 'insert_candidate(event)', kind: 'sync'},
      {from: 'ground-truth set', to: 'gtx-builder', label: 'ok', kind: 'reply'},
      {from: 'gtx-builder', to: 'assist.trace', label: 'commit offset after the insert', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=turn.shop` (or `Key: []byte(turn.Shop)`, `ProducerRecord(topic, turn.shop, …)`). Keyed by the turn id, one shop’s turns land on different partitions and their order is gone.',
    'Idempotence is producer configuration: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. Then delete `merchant_message` and `tool_results` from the event — the trace carries ids, counts and scores, nothing a merchant typed or a tool returned.',
    'The outbox is the durability half: wrap the produce and, when the broker rejects it, insert the event into the outbox. In the consumer, turn off auto-commit, call `insert_candidate` first and `commit` second — a crash between the two replays the record instead of losing it.',
  ],
  checks: [
    {
      id: 'shop-key',
      title: 'Keyed by shop, carries the turn id',
      detail:
        'The message key is the shop (partition by shop) and the event carries `turn_id`. The draft keys by the turn id, so one shop’s turns scatter across partitions and lose order.',
      match: {
        python: {all: [/key\s*=\s*turn\.shop/, /turn_id/]},
        typescript: {all: [/key:\s*turn\.shop/, /turn_id/]},
        go: {all: [/Key:\s*\[\]byte\(turn\.Shop\)/, /TurnID/]},
        scala: {all: [/ProducerRecord\("assist.trace",\s*turn\.shop/, /turnId/]},
        cpp: {all: [/turn\.shop\.data\(\)/, /turnId/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. A retry of a produce must not duplicate the trace.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-merchant-data',
      title: 'No merchant message or tool results in the event or logs',
      detail:
        'Neither the event nor any log line carries the merchant’s message or the tool results. The draft copies both into the event — a leak that is retained and replicated with the topic.',
      match: {
        python: {none: [/merchant_?message|tool_?results/i]},
        typescript: {none: [/merchant_?message|tool_?results/i]},
        go: {none: [/merchant_?message|tool_?results/i]},
        scala: {none: [/merchant_?message|tool_?results/i]},
        cpp: {none: [/merchant_?message|tool_?results/i]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox`/`insertOutbox`) inside the error branch instead of dropping the trace or failing the turn. The draft ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'insert-before-commit',
      title: 'Inserts the candidate before committing the offset',
      detail:
        'The consumer inserts the ground-truth candidate before committing the offset; committing first makes a crash lose the candidate forever. The draft commits first.',
      match: {
        python: {order: [/\.insert_candidate\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.insertCandidate\(/, /commitOffsets\(/]},
        go: {order: [/\.InsertCandidate\(/, /CommitMessages\(/]},
        scala: {order: [/\.insertCandidate\(/, /commitSync\(/]},
        cpp: {order: [/\.insertCandidate\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
from dataclasses import dataclass, field

from confluent_kafka import Consumer, Producer

logger = logging.getLogger("trace")
producer = Producer({"bootstrap.servers": "kafka:9092"})


@dataclass
class Turn:
    turn_id: str
    shop: str
    page: str
    merchant_message: str
    tools_used: list[str]
    tool_results: list[str]
    latency_ms: int
    tokens: int
    judge_score: float
    prompt_version: str = "v12"
    extra: dict = field(default_factory=dict)


class GroundTruthStore:
    def insert_candidate(self, event: dict) -> None:
        """One ground-truth candidate per traced turn; experts label a sample of them."""
        raise NotImplementedError


gtx = GroundTruthStore()


def publish(turn: Turn) -> None:
    # TODO: key by shop instead of the turn id, configure the idempotent producer with acks=all,
    # keep the merchant's message and the tool results out of the event and the logs, and write an
    # outbox row when the broker rejects the produce.
    logger.info("trace shop=%s message=%r", turn.shop, turn.merchant_message)
    event = {
        "turn_id": turn.turn_id,
        "shop": turn.shop,
        "merchant_message": turn.merchant_message,
        "tool_results": turn.tool_results,
        "tools_used": turn.tools_used,
        "latency_ms": turn.latency_ms,
        "tokens": turn.tokens,
        "judge_score": turn.judge_score,
    }
    producer.produce("assist.trace", key=turn.turn_id, value=json.dumps(event))
    producer.flush()


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "gtx-builder"})
    consumer.subscribe(["assist.trace"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        gtx.insert_candidate(event)
`,
      solution: `import json
import logging
from dataclasses import dataclass

from confluent_kafka import Consumer, KafkaException, Producer

logger = logging.getLogger("trace")
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


@dataclass
class Turn:
    turn_id: str
    shop: str
    page: str
    tools_used: list[str]
    latency_ms: int
    tokens: int
    judge_score: float
    prompt_version: str = "v12"


class GroundTruthStore:
    def insert_candidate(self, event: dict) -> None:
        """One ground-truth candidate per traced turn; experts label a sample of them."""
        raise NotImplementedError


class OutboxStore:
    def insert_outbox(self, shop: str, event: dict) -> None:
        """One row per undelivered trace; a relay republishes it."""
        raise NotImplementedError


gtx = GroundTruthStore()
outbox = OutboxStore()


def publish(turn: Turn) -> None:
    event = {
        "turn_id": turn.turn_id,
        "shop": turn.shop,
        "page": turn.page,
        "tools_used": turn.tools_used,
        "latency_ms": turn.latency_ms,
        "tokens": turn.tokens,
        "judge_score": turn.judge_score,
        "prompt_version": turn.prompt_version,
    }
    try:
        producer.produce("assist.trace", key=turn.shop, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        outbox.insert_outbox(turn.shop, event)
    logger.info("trace shop=%s turn=%s tools=%d score=%.2f", turn.shop, turn.turn_id, len(turn.tools_used), turn.judge_score)


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "gtx-builder", "enable.auto.commit": False}
    )
    consumer.subscribe(["assist.trace"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        gtx.insert_candidate(event)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** assist.trace: a model-generated draft that keys by turn id and commits too early. */
import {Kafka} from 'kafkajs';

import {gtx} from './stores';

const kafka = new Kafka({clientId: 'sidekick', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export interface Turn {
  turn_id: string;
  shop: string;
  page: string;
  merchantMessage: string;
  toolsUsed: string[];
  toolResults: string[];
  latencyMs: number;
  tokens: number;
  judgeScore: number;
  promptVersion: string;
}

export async function publish(turn: Turn): Promise<void> {
  // TODO: key by shop instead of the turn id, configure the idempotent producer with acks=all,
  // keep the merchant's message and the tool results out of the event and the logs, and write an
  // outbox row when the broker rejects the produce.
  console.log('trace', turn.shop, turn.merchantMessage);
  const event = {
    turn_id: turn.turn_id,
    shop: turn.shop,
    merchant_message: turn.merchantMessage,
    tool_results: turn.toolResults,
    tools_used: turn.toolsUsed,
    latency_ms: turn.latencyMs,
    tokens: turn.tokens,
    judge_score: turn.judgeScore,
  };
  await producer.send({
    topic: 'assist.trace',
    messages: [{key: turn.turn_id, value: JSON.stringify(event)}],
  });
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'gtx-builder'});
  await consumer.connect();
  await consumer.subscribe({topic: 'assist.trace'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as Record<string, unknown>;
      await gtx.insertCandidate(event);
    },
  });
}
`,
      solution: `/** assist.trace: one idempotent, shop-keyed event per turn with no merchant data; insert before the commit. */
import {Kafka} from 'kafkajs';

import {gtx, outbox} from './stores';

const kafka = new Kafka({clientId: 'sidekick', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

export interface Turn {
  turn_id: string;
  shop: string;
  page: string;
  toolsUsed: string[];
  latencyMs: number;
  tokens: number;
  judgeScore: number;
  promptVersion: string;
}

export async function publish(turn: Turn): Promise<void> {
  const event = {
    turn_id: turn.turn_id,
    shop: turn.shop,
    page: turn.page,
    tools_used: turn.toolsUsed,
    latency_ms: turn.latencyMs,
    tokens: turn.tokens,
    judge_score: turn.judgeScore,
    prompt_version: turn.promptVersion,
  };
  try {
    await producer.send({
      topic: 'assist.trace',
      acks: -1,
      messages: [{key: turn.shop, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await outbox.insertOutbox(turn.shop, event);
  }
  console.log('trace', turn.shop, turn.turn_id, turn.toolsUsed.length, turn.judgeScore);
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'gtx-builder'});
  await consumer.connect();
  await consumer.subscribe({topic: 'assist.trace'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as Record<string, unknown>;
      await gtx.insertCandidate(event);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package trace

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

var traceWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "assist.trace"}

type Turn struct {
	TurnID          string
	Shop            string
	Page            string
	MerchantMessage string
	ToolsUsed       []string
	ToolResults     []string
	LatencyMS       int
	Tokens          int
	JudgeScore      float64
	PromptVersion   string
}

type GroundTruthStore struct{}

// InsertCandidate stores one ground-truth candidate per traced turn; experts label a sample of them.
func (s *GroundTruthStore) InsertCandidate(ctx context.Context, event map[string]any) error {
	return nil
}

var gtx = &GroundTruthStore{}

// TODO: key by shop instead of the turn id, configure acks=all / idempotence, keep the merchant's
// message and the tool results out of the event and the logs, and write an outbox row when the
// broker rejects the produce.
func Publish(ctx context.Context, turn Turn) {
	log.Printf("trace shop=%s message=%q", turn.Shop, turn.MerchantMessage)
	event := map[string]any{
		"turn_id":          turn.TurnID,
		"shop":             turn.Shop,
		"merchant_message": turn.MerchantMessage,
		"tool_results":     turn.ToolResults,
		"tools_used":       turn.ToolsUsed,
		"latency_ms":       turn.LatencyMS,
		"tokens":           turn.Tokens,
		"judge_score":      turn.JudgeScore,
	}
	payload, _ := json.Marshal(event)
	_ = traceWriter.WriteMessages(ctx, kafka.Message{Key: []byte(turn.TurnID), Value: payload})
}

func Consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "assist.trace",
		GroupID: "gtx-builder",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event map[string]any
		_ = json.Unmarshal(msg.Value, &event)
		_ = gtx.InsertCandidate(ctx, event)
	}
}
`,
      solution: `package trace

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var traceWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "assist.trace",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type Turn struct {
	TurnID        string
	Shop          string
	Page          string
	ToolsUsed     []string
	LatencyMS     int
	Tokens        int
	JudgeScore    float64
	PromptVersion string
}

type GroundTruthStore struct{}

// InsertCandidate stores one ground-truth candidate per traced turn; experts label a sample of them.
func (s *GroundTruthStore) InsertCandidate(ctx context.Context, event map[string]any) error {
	return nil
}

type OutboxStore struct{}

// InsertOutbox stores one row per undelivered trace; a relay republishes it.
func (s *OutboxStore) InsertOutbox(ctx context.Context, shop string, event map[string]any) error {
	return nil
}

var (
	gtx    = &GroundTruthStore{}
	outbox = &OutboxStore{}
)

func Publish(ctx context.Context, turn Turn) {
	event := map[string]any{
		"turn_id":        turn.TurnID,
		"shop":           turn.Shop,
		"page":           turn.Page,
		"tools_used":     turn.ToolsUsed,
		"latency_ms":     turn.LatencyMS,
		"tokens":         turn.Tokens,
		"judge_score":    turn.JudgeScore,
		"prompt_version": turn.PromptVersion,
	}
	payload, _ := json.Marshal(event)
	if err := traceWriter.WriteMessages(ctx, kafka.Message{Key: []byte(turn.Shop), Value: payload}); err != nil {
		_ = outbox.InsertOutbox(ctx, turn.Shop, event)
	}
	log.Printf("trace shop=%s turn=%s tools=%d score=%.2f", turn.Shop, turn.TurnID, len(turn.ToolsUsed), turn.JudgeScore)
}

func Consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "assist.trace",
		GroupID: "gtx-builder",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		if err := gtx.InsertCandidate(ctx, event); err != nil {
			continue
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
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Turn(
    turnId: String,
    shop: String,
    page: String,
    merchantMessage: String,
    toolsUsed: List[String],
    toolResults: List[String],
    latencyMs: Int,
    tokens: Int,
    judgeScore: Double,
    promptVersion: String
)

object TraceApi {
  private val log = Logger.getLogger("trace")
  val producer = new KafkaProducer[String, String](new Properties())

  // TODO: key by shop instead of the turn id, configure the idempotent producer with acks=all, keep
  // the merchant's message and the tool results out of the event and the logs, and write an outbox
  // row when the broker rejects the produce.
  def publish(turn: Turn): Unit = {
    log.info(s"trace shop=\${turn.shop} message=\${turn.merchantMessage}")
    val event = JsObject(
      "turn_id" -> JsString(turn.turnId),
      "shop" -> JsString(turn.shop),
      "merchant_message" -> JsString(turn.merchantMessage),
      "tool_results" -> turn.toolResults.toJson,
      "tools_used" -> turn.toolsUsed.toJson,
      "latency_ms" -> JsNumber(turn.latencyMs),
      "tokens" -> JsNumber(turn.tokens),
      "judge_score" -> JsNumber(turn.judgeScore)
    )
    producer.send(new ProducerRecord("assist.trace", turn.turnId, event.compactPrint))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of("assist.trace"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        GroundTruthStore.insertCandidate(record.value().parseJson.asJsObject)
      }
    }
  }
}
`,
      solution: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Turn(
    turnId: String,
    shop: String,
    page: String,
    toolsUsed: List[String],
    latencyMs: Int,
    tokens: Int,
    judgeScore: Double,
    promptVersion: String
)

object TraceApi {
  private val log = Logger.getLogger("trace")
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  def publish(turn: Turn): Unit = {
    val event = JsObject(
      "turn_id" -> JsString(turn.turnId),
      "shop" -> JsString(turn.shop),
      "page" -> JsString(turn.page),
      "tools_used" -> turn.toolsUsed.toJson,
      "latency_ms" -> JsNumber(turn.latencyMs),
      "tokens" -> JsNumber(turn.tokens),
      "judge_score" -> JsNumber(turn.judgeScore),
      "prompt_version" -> JsString(turn.promptVersion)
    )
    val payload = event.compactPrint
    try {
      producer.send(new ProducerRecord("assist.trace", turn.shop, payload)).get()
    } catch {
      case _: Exception =>
        OutboxStore.insertOutbox(turn.shop, payload)
    }
    log.info(s"trace shop=\${turn.shop} turn=\${turn.turnId} tools=\${turn.toolsUsed.size} score=\${turn.judgeScore}")
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "gtx-builder")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("assist.trace"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        GroundTruthStore.insertCandidate(record.value().parseJson.asJsObject)
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
#include <vector>

using json = nlohmann::json;

const std::string kTraceTopic = "assist.trace";

struct Turn {
  std::string turnId;
  std::string shop;
  std::string page;
  std::string merchantMessage;
  std::vector<std::string> toolsUsed;
  std::vector<std::string> toolResults;
  int latencyMs;
  int tokens;
  double judgeScore;
  std::string promptVersion;
};

struct GroundTruthStore {
  // One ground-truth candidate per traced turn; experts label a sample of them.
  void insertCandidate(const json& event);
};

GroundTruthStore gtx;
std::unique_ptr<RdKafka::Producer> producer;

// TODO: key by shop instead of the turn id, configure the idempotent producer with acks=all, keep
// the merchant's message and the tool results out of the event and the logs, and write an outbox
// row when the broker rejects the produce.
void publish(const Turn& turn) {
  std::cerr << "trace shop=" << turn.shop << " message=" << turn.merchantMessage << "\\n";
  const json event = {
      {"turn_id", turn.turnId},
      {"shop", turn.shop},
      {"merchant_message", turn.merchantMessage},
      {"tool_results", turn.toolResults},
      {"tools_used", turn.toolsUsed},
      {"latency_ms", turn.latencyMs},
      {"tokens", turn.tokens},
      {"judge_score", turn.judgeScore},
  };
  const auto payload = event.dump();
  producer->produce(kTraceTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), turn.turnId.data(), turn.turnId.size(), 0, nullptr);
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "gtx-builder", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTraceTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync();
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    gtx.insertCandidate(event);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTraceTopic = "assist.trace";

struct Turn {
  std::string turnId;
  std::string shop;
  std::string page;
  std::vector<std::string> toolsUsed;
  int latencyMs;
  int tokens;
  double judgeScore;
  std::string promptVersion;
};

struct GroundTruthStore {
  // One ground-truth candidate per traced turn; experts label a sample of them.
  void insertCandidate(const json& event);
};

struct OutboxStore {
  // One row per undelivered trace; a relay republishes it.
  void insertOutbox(const std::string& shop, const json& event);
};

GroundTruthStore gtx;
OutboxStore outbox;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

void publish(const Turn& turn) {
  const json event = {
      {"turn_id", turn.turnId},
      {"shop", turn.shop},
      {"page", turn.page},
      {"tools_used", turn.toolsUsed},
      {"latency_ms", turn.latencyMs},
      {"tokens", turn.tokens},
      {"judge_score", turn.judgeScore},
      {"prompt_version", turn.promptVersion},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(kTraceTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), turn.shop.data(), turn.shop.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox.insertOutbox(turn.shop, event);
  }
  producer->flush(2000);
  std::cerr << "trace shop=" << turn.shop << " turn=" << turn.turnId << " tools=" << turn.toolsUsed.size()
            << " score=" << turn.judgeScore << "\\n";
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "gtx-builder", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTraceTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    gtx.insertCandidate(event);
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking the three things a generated Kafka snippet almost always gets wrong, plus the one that is specific to an assistant. The message key is an ordering contract: partition by shop and one merchant's turns arrive in order; key by turn id and they do not. Exactly-once *looking* code is not exactly-once: the producer needs idempotence and acks=all for retries, and the consumer must insert the candidate before the offset commit, or a crash between the two loses it permanently. A broker is not a database: when the produce fails, the durable path is an outbox row that a relay republishes. The assistant-specific one is the payload. The source builds its ground-truth sets by sampling real merchant conversations, and that is a deliberate, consented path with labelling by product experts — not a trace topic that every service with a consumer group can read. The trace carries ids, tool names, latency, tokens and the judge's score, which is everything the evaluation pipeline needs to pick what to sample. Real platforms add schema registry enforcement so a field like \`merchant_message\` cannot be added by accident, a relay with backoff for the outbox, and a dead-letter topic for candidates the builder cannot insert.`,
};
