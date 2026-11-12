import type {Step} from '@/lib/types';

export const assistTraceStep: Step = {
  id: 'assist-trace',
  title: 'assist.trace: shop key, no merchant data, outbox, insert before commit',
  concept: 'kafka',
  file: 'assist_trace',
  focus: ['api', 'kafka', 'builder', 'gtx'],
  task: `## Task

**Starting point.** The starter is the trace path that feeds step 4's ground-truth set.
\`publish(turn)\` takes the provided \`TurnRecord\`, logs the shop, the turn and the merchant's
message, and produces an event with the turn's fields plus \`merchant_message\` and \`tool_results\` to
\`assist.trace\`, keyed by \`turn_id\`, from a producer with default settings. \`run_gtx_builder()\`
consumes the topic as group \`gtx-builder\`, commits the offset, then calls
\`gtx.insert_candidate(event)\`. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** One shop's turns scatter across partitions. A retry after a lost
acknowledgement writes a trace twice. The merchant's words and a customer list sit in a topic every
consumer group can read for days. A broker refusal loses the trace, and a builder crash between
commit and insert loses the candidate.

- Key by \`turn.shop\`. The event is \`turn_id\`, \`shop\`, \`page\`, \`tools_used\`, \`latency_ms\`,
  \`tokens\`, \`judge_score\` and \`prompt_version\` (\`PROMPT_VERSION\`), with no message or tool results,
  in the event or the logs.
- The producer is idempotent with \`acks=all\` (Go: confluent-kafka-go).
- A delivery failure, reported to the delivery callback, goes to the provided
  \`outbox.insert(event, reason)\`.
- The builder inserts the candidate, then commits.`,
  sequence: {
    participants: ['sidekick', 'assist.trace', 'gtx-builder', 'ground-truth set'],
    messages: [
      {from: 'sidekick', to: 'assist.trace', label: 'produce key = shop · idempotent · acks = all', kind: 'async'},
      {from: 'assist.trace', to: 'sidekick', label: 'delivery report: error → outbox.insert', kind: 'reply'},
      {from: 'assist.trace', to: 'gtx-builder', label: 'consume · group gtx-builder', kind: 'async'},
      {from: 'gtx-builder', to: 'ground-truth set', label: 'insert_candidate(event)', kind: 'sync'},
      {from: 'gtx-builder', to: 'assist.trace', label: 'commit offset (after the insert)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'shop-key',
      title: 'Keyed by shop, with the trace fields',
      detail:
        "Three turns from shops s1, s2, s1 produce records keyed s1, s2, s1, and s1's land on one partition; the event carries the eight trace fields and the prompt version. The starter keys by turn id.",
      match: {
        python: {all: [/\.produce\([\s\S]{0,300}?key\s*=\s*turn\.shop/]},
        typescript: {all: [/key:\s*turn\.shop/]},
        go: {all: [/Key:\s*\[\]byte\(\s*turn\.Shop\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*Config\.Topic\s*,\s*turn\.shop/]},
        cpp: {all: [/turn\.shop\.c_str\(\)\s*,\s*turn\.shop\.(size|length)\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'After a lost acknowledgement the topic holds the trace once, and a leader failover right after the acknowledgement keeps it. The starter retries into a duplicate and acknowledges on the leader alone.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*(["']all["']|-1)/]},
        typescript: {all: [/idempotent:\s*true/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/ENABLE_IDEMPOTENCE_CONFIG|"enable\.idempotence"/, /ACKS_CONFIG|"acks"/, /"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'no-merchant-data',
      title: "No merchant's words or tool results in the event or the logs",
      detail:
        'A turn whose message and tool result name a customer produces an event and log lines without that name, and without `merchant_message` or `tool_results`. The starter copies both into the event and the message into the log.',
      match: {
        python: {none: [/turn\.message/, /turn\.tool_results/]},
        typescript: {none: [/turn\.message/, /turn\.tool_results/]},
        go: {none: [/turn\.Message\b/, /turn\.ToolResults/]},
        scala: {none: [/turn\.message/, /turn\.toolResults/]},
        cpp: {none: [/turn\.message/, /turn\.tool_results/]},
      },
    },
    {
      id: 'outbox',
      title: 'A refused delivery goes to the outbox',
      detail:
        'When the broker refuses the record, `publish` does not fail and the outbox holds the event with a reason; the next healthy produce reaches the topic and adds no row. The starter ignores the delivery report.',
      match: {
        python: {all: [/outbox\.insert\(/, /on_delivery\s*=/], none: [/except KafkaException/]},
        typescript: {all: [/outbox\.insert\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insert\(/, /Callback/]},
        cpp: {all: [/outbox::insert\(/, /dr_cb/]},
      },
    },
    {
      id: 'insert-before-commit',
      title: 'Inserts the candidate before it commits',
      detail:
        'At the first commit of group gtx-builder the ground-truth candidates already hold the record, all three seeded traces end up as candidates, and the lag is 0. The starter commits first, so a crash in between skips the candidate.',
      match: {
        python: {order: [/gtx\.insert_candidate\(/, /consumer\.commit\(/]},
        typescript: {order: [/insertCandidate\(/, /commitOffsets\(/]},
        go: {order: [/gtx\.InsertCandidate\(/, /consumer\.CommitMessage\(/]},
        scala: {order: [/Gtx\.insertCandidate\(/, /commitSync\(/]},
        cpp: {order: [/gtx::insert_candidate\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer

from sidekick import gtx
from sidekick.config import PROMPT_VERSION, TOPIC
from sidekick.trace import TurnRecord

logger = logging.getLogger("sidekick.trace")

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish(turn: TurnRecord) -> None:
    """One assist.trace event per finished turn; runs after the merchant has the answer."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "turn_id": turn.turn_id,
        "shop": turn.shop,
        "page": turn.page,
        "tools_used": turn.tools_used,
        "latency_ms": turn.latency_ms,
        "tokens": turn.tokens,
        "judge_score": turn.judge_score,
        "prompt_version": PROMPT_VERSION,
        "merchant_message": turn.message,
        "tool_results": turn.tool_results,
    }
    logger.info("assist.trace shop=%s turn=%s message=%r", turn.shop, turn.turn_id, turn.message)
    producer.produce(TOPIC, key=turn.turn_id, value=json.dumps(event))
    producer.poll(0)


def run_gtx_builder() -> None:
    """The gtx-builder consumer: every trace becomes a candidate for the ground-truth set."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "gtx-builder", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        consumer.commit(record, asynchronous=False)
        gtx.insert_candidate(json.loads(record.value()))
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, Producer

from sidekick import gtx, outbox
from sidekick.config import PROMPT_VERSION, TOPIC
from sidekick.trace import TurnRecord

logger = logging.getLogger("sidekick.trace")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        outbox.insert(json.loads(msg.value()), str(err))  # the broker refused it: a relay produces it later


def publish(turn: TurnRecord) -> None:
    """One assist.trace event per finished turn; runs after the merchant has the answer."""
    event = {
        "turn_id": turn.turn_id,
        "shop": turn.shop,
        "page": turn.page,
        "tools_used": turn.tools_used,
        "latency_ms": turn.latency_ms,
        "tokens": turn.tokens,
        "judge_score": turn.judge_score,
        "prompt_version": PROMPT_VERSION,
    }
    logger.info("assist.trace shop=%s turn=%s tools=%d", turn.shop, turn.turn_id, len(turn.tools_used))
    producer.produce(TOPIC, key=turn.shop, value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery reports already in; returns at once


def run_gtx_builder() -> None:
    """The gtx-builder consumer: every trace becomes a candidate for the ground-truth set."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "gtx-builder", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        gtx.insert_candidate(json.loads(record.value()))
        consumer.commit(record, asynchronous=False)  # after the insert: a crash before this line redelivers
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {PROMPT_VERSION, TOPIC} from 'sidekick/config';
import * as gtx from 'sidekick/gtx';
import type {TurnRecord} from 'sidekick/trace';

const kafka = new Kafka({clientId: 'sidekick', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();

/** One assist.trace event per finished turn; runs after the merchant has the answer. */
export async function publish(turn: TurnRecord): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const event = {
    turn_id: turn.turn_id,
    shop: turn.shop,
    page: turn.page,
    tools_used: turn.tools_used,
    latency_ms: turn.latency_ms,
    tokens: turn.tokens,
    judge_score: turn.judge_score,
    prompt_version: PROMPT_VERSION,
    merchant_message: turn.message,
    tool_results: turn.tool_results,
  };
  console.log(\`assist.trace shop=\${turn.shop} turn=\${turn.turn_id} message=\${JSON.stringify(turn.message)}\`);
  void producer.send({topic: TOPIC, messages: [{key: turn.turn_id, value: JSON.stringify(event)}]});
}

/** The gtx-builder consumer: every trace becomes a candidate for the ground-truth set. */
export async function runGtxBuilder(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'gtx-builder'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await gtx.insertCandidate(JSON.parse(message.value?.toString() ?? '{}'));
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {PROMPT_VERSION, TOPIC} from 'sidekick/config';
import * as gtx from 'sidekick/gtx';
import * as outbox from 'sidekick/outbox';
import type {TurnRecord} from 'sidekick/trace';

const kafka = new Kafka({clientId: 'sidekick', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true}); // idempotent implies acks: -1 (all)
void producer.connect();

/** One assist.trace event per finished turn; runs after the merchant has the answer. */
export async function publish(turn: TurnRecord): Promise<void> {
  const event = {
    turn_id: turn.turn_id,
    shop: turn.shop,
    page: turn.page,
    tools_used: turn.tools_used,
    latency_ms: turn.latency_ms,
    tokens: turn.tokens,
    judge_score: turn.judge_score,
    prompt_version: PROMPT_VERSION,
  };
  console.log(\`assist.trace shop=\${turn.shop} turn=\${turn.turn_id} tools=\${turn.tools_used.length}\`);
  try {
    await producer.send({topic: TOPIC, messages: [{key: turn.shop, value: JSON.stringify(event)}], acks: -1});
  } catch (err) {
    await outbox.insert(event, (err as Error).message); // the broker refused it: a relay produces it later
  }
}

/** The gtx-builder consumer: every trace becomes a candidate for the ground-truth set. */
export async function runGtxBuilder(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'gtx-builder'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await gtx.insertCandidate(JSON.parse(message.value?.toString() ?? '{}'));
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]); // after the insert
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

	"sidekick/config" // config.Topic, config.PromptVersion — provided
	"sidekick/gtx"    // gtx.InsertCandidate(ctx, eventJSON) — provided
	"sidekick/trace"  // trace.TurnRecord — provided
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

type traceEvent struct {
	TurnID          string   \`json:"turn_id"\`
	Shop            string   \`json:"shop"\`
	Page            string   \`json:"page"\`
	ToolsUsed       []string \`json:"tools_used"\`
	LatencyMs       int      \`json:"latency_ms"\`
	Tokens          int      \`json:"tokens"\`
	JudgeScore      float64  \`json:"judge_score"\`
	PromptVersion   string   \`json:"prompt_version"\`
	MerchantMessage string   \`json:"merchant_message"\`
	ToolResults     []string \`json:"tool_results"\`
}

// publish produces one assist.trace event per finished turn; it runs after the merchant has the answer.
func publish(ctx context.Context, turn trace.TurnRecord) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	value, err := json.Marshal(traceEvent{
		TurnID: turn.TurnID, Shop: turn.Shop, Page: turn.Page, ToolsUsed: turn.ToolsUsed, LatencyMs: turn.LatencyMs,
		Tokens: turn.Tokens, JudgeScore: turn.JudgeScore, PromptVersion: config.PromptVersion,
		MerchantMessage: turn.Message, ToolResults: turn.ToolResults,
	})
	if err != nil {
		return err
	}
	log.Printf("assist.trace shop=%s turn=%s message=%q", turn.Shop, turn.TurnID, turn.Message)
	topic := config.Topic
	return producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(turn.TurnID), Value: value}, nil)
}

// runGtxBuilder is the gtx-builder consumer: every trace becomes a candidate for the ground-truth set.
func runGtxBuilder(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": "gtx-builder", "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		return err
	}
	if err := consumer.SubscribeTopics([]string{config.Topic}, nil); err != nil {
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
		if err := gtx.InsertCandidate(ctx, msg.Value); err != nil {
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"sidekick/config" // config.Topic, config.PromptVersion — provided
	"sidekick/gtx"    // gtx.InsertCandidate(ctx, eventJSON) — provided
	"sidekick/outbox" // outbox.Insert(ctx, eventJSON, reason) — provided
	"sidekick/trace"  // trace.TurnRecord — provided
)

var producer = newProducer()

// newProducer is idempotent with acks=all, and serves its delivery reports: a refused record goes to the outbox.
func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
		"acks":               "all", // every in-sync replica has it before the broker answers
	})
	if err != nil {
		panic(err)
	}
	go func() {
		for e := range p.Events() {
			if m, ok := e.(*kafka.Message); ok && m.TopicPartition.Error != nil {
				outbox.Insert(context.Background(), m.Value, m.TopicPartition.Error.Error()) // a relay produces it later
			}
		}
	}()
	return p
}

type traceEvent struct {
	TurnID        string   \`json:"turn_id"\`
	Shop          string   \`json:"shop"\`
	Page          string   \`json:"page"\`
	ToolsUsed     []string \`json:"tools_used"\`
	LatencyMs     int      \`json:"latency_ms"\`
	Tokens        int      \`json:"tokens"\`
	JudgeScore    float64  \`json:"judge_score"\`
	PromptVersion string   \`json:"prompt_version"\`
}

// publish produces one assist.trace event per finished turn; it runs after the merchant has the answer.
func publish(ctx context.Context, turn trace.TurnRecord) error {
	value, err := json.Marshal(traceEvent{
		TurnID: turn.TurnID, Shop: turn.Shop, Page: turn.Page, ToolsUsed: turn.ToolsUsed, LatencyMs: turn.LatencyMs,
		Tokens: turn.Tokens, JudgeScore: turn.JudgeScore, PromptVersion: config.PromptVersion,
	})
	if err != nil {
		return err
	}
	log.Printf("assist.trace shop=%s turn=%s tools=%d", turn.Shop, turn.TurnID, len(turn.ToolsUsed))
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(turn.Shop), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return outbox.Insert(ctx, value, err.Error()) // refused before it was even queued
	}
	return nil
}

// runGtxBuilder is the gtx-builder consumer: every trace becomes a candidate for the ground-truth set.
func runGtxBuilder(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": "gtx-builder", "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		return err
	}
	if err := consumer.SubscribeTopics([]string{config.Topic}, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		if err := gtx.InsertCandidate(ctx, msg.Value); err != nil {
			return err // not committed: the record is redelivered
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
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
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}

import scala.jdk.CollectionConverters._

import sidekick.{Config, Gtx, TurnRecord}

object AssistTrace {
  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** One assist.trace event per finished turn; runs after the merchant has the answer. */
  def publish(turn: TurnRecord): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val event = ujson.Obj(
      "turn_id" -> turn.turnId,
      "shop" -> turn.shop,
      "page" -> turn.page,
      "tools_used" -> ujson.Arr.from(turn.toolsUsed),
      "latency_ms" -> turn.latencyMs,
      "tokens" -> turn.tokens,
      "judge_score" -> turn.judgeScore,
      "prompt_version" -> Config.PromptVersion,
      "merchant_message" -> turn.message,
      "tool_results" -> ujson.Arr.from(turn.toolResults)
    )
    System.err.println(s"assist.trace shop=\${turn.shop} turn=\${turn.turnId} message=\${turn.message}")
    producer.send(new ProducerRecord[String, String](Config.Topic, turn.turnId, ujson.write(event)))
    ()
  }

  /** The gtx-builder consumer: every trace becomes a candidate for the ground-truth set. */
  def runGtxBuilder(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "gtx-builder")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync()
        Gtx.insertCandidate(record.value())
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

import scala.jdk.CollectionConverters._

import sidekick.{Config, Gtx, Outbox, TurnRecord}

object AssistTrace {
  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** One assist.trace event per finished turn; runs after the merchant has the answer. */
  def publish(turn: TurnRecord): Unit = {
    val event = ujson.write(
      ujson.Obj(
        "turn_id" -> turn.turnId,
        "shop" -> turn.shop,
        "page" -> turn.page,
        "tools_used" -> ujson.Arr.from(turn.toolsUsed),
        "latency_ms" -> turn.latencyMs,
        "tokens" -> turn.tokens,
        "judge_score" -> turn.judgeScore,
        "prompt_version" -> Config.PromptVersion
      )
    )
    System.err.println(s"assist.trace shop=\${turn.shop} turn=\${turn.turnId} tools=\${turn.toolsUsed.size}")
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) Outbox.insert(event, exception.getMessage) // the broker refused it: a relay produces it later
    }
    producer.send(new ProducerRecord[String, String](Config.Topic, turn.shop, event), onDelivery)
    ()
  }

  /** The gtx-builder consumer: every trace becomes a candidate for the ground-truth set. */
  def runGtxBuilder(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "gtx-builder")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        Gtx.insertCandidate(record.value())
        consumer.commitSync() // after the insert: a crash before this line redelivers
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

#include "sidekick/config.h"  // config::kTopic, config::kPromptVersion — provided
#include "sidekick/gtx.h"     // gtx::insert_candidate(event_json) — provided
#include "sidekick/trace.h"   // trace::TurnRecord — provided

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One assist.trace event per finished turn; runs after the merchant has the answer.
void publish(const trace::TurnRecord& turn) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  nlohmann::json event = {{"turn_id", turn.turn_id}, {"shop", turn.shop}, {"page", turn.page}, {"tools_used", turn.tools_used},
                          {"latency_ms", turn.latency_ms}, {"tokens", turn.tokens}, {"judge_score", turn.judge_score},
                          {"prompt_version", config::kPromptVersion}};
  event["merchant_message"] = turn.message;
  event["tool_results"] = turn.tool_results;
  std::cerr << "assist.trace shop=" << turn.shop << " turn=" << turn.turn_id << " message=" << turn.message << "\\n";
  const std::string value = event.dump();
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), turn.turn_id.c_str(), turn.turn_id.size(), 0, nullptr);
  producer->poll(0);
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "gtx-builder", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  return consumer;
}

// The gtx-builder consumer: every trace becomes a candidate for the ground-truth set.
void run_gtx_builder() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    gtx::insert_candidate(std::string(static_cast<const char*>(msg->payload()), msg->len()));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "sidekick/config.h"  // config::kTopic, config::kPromptVersion — provided
#include "sidekick/gtx.h"     // gtx::insert_candidate(event_json) — provided
#include "sidekick/outbox.h"  // outbox::insert(event_json, reason) — provided
#include "sidekick/trace.h"   // trace::TurnRecord — provided

// The delivery report: a refused record goes to the outbox for a relay to produce later.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    outbox::insert(std::string(static_cast<const char*>(message.payload()), message.len()), message.errstr());
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One assist.trace event per finished turn; runs after the merchant has the answer.
void publish(const trace::TurnRecord& turn) {
  const nlohmann::json event = {{"turn_id", turn.turn_id}, {"shop", turn.shop}, {"page", turn.page}, {"tools_used", turn.tools_used},
                                {"latency_ms", turn.latency_ms}, {"tokens", turn.tokens}, {"judge_score", turn.judge_score},
                                {"prompt_version", config::kPromptVersion}};
  std::cerr << "assist.trace shop=" << turn.shop << " turn=" << turn.turn_id << " tools=" << turn.tools_used.size() << "\\n";
  const std::string value = event.dump();
  const RdKafka::ErrorCode err =
      producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), turn.shop.c_str(), turn.shop.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) outbox::insert(value, RdKafka::err2str(err));  // refused before it was queued
  producer->poll(0);  // serve delivery reports already in; returns at once
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "gtx-builder", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  return consumer;
}

// The gtx-builder consumer: every trace becomes a candidate for the ground-truth set.
void run_gtx_builder() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    gtx::insert_candidate(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    consumer->commitSync(msg.get());  // after the insert: a crash before this line redelivers
  }
}
`,
    },
  },
  harness: {
    python: `import json
import logging

from sidekick.trace import TurnRecord

TOPIC = "assist.trace"
CUSTOMER = "Jane Okafor, jane.okafor@example.com"
FIELDS = ("turn_id", "shop", "page", "tools_used", "latency_ms", "tokens", "judge_score", "prompt_version")


def _turn(turn_id="t-1", shop="s1"):
    return TurnRecord(
        turn_id=turn_id,
        shop=shop,
        page="customers",
        message=f"which customers spend like {CUSTOMER}?",
        tools_used=["segment_customers"],
        tool_results=[json.dumps({"customers": [CUSTOMER]})],
        latency_ms=840,
        tokens=2400,
        judge_score=0.92,
    )


def _settle(m):
    """Serve the producer's delivery reports, as the service loop would between turns."""
    m.producer.poll(0)


def _ids(ctx):
    return [json.loads(r.value)["turn_id"] for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox:assist.trace", 0, -1)]


def check_shop_key(ctx):
    m = ctx.load("assist_trace")
    m.publish(_turn("t-1", "s1"))
    m.publish(_turn("t-2", "s2"))
    m.publish(_turn("t-3", "s1"))
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three turns produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"s1", b"s2", b"s1"], f"records must be keyed by the shop, got {keys}: keyed by turn id, one shop's traces scatter across partitions"
    assert records[0].partition == records[2].partition, "one shop's traces must land on one partition"
    event = json.loads(records[0].value)
    for field in FIELDS:
        assert field in event, f"the event lacks {field}: {event}"
    assert event["turn_id"] == "t-1" and event["shop"] == "s1" and event["prompt_version"] == "sk-prompt-14", f"the event carries the turn id, the shop and PROMPT_VERSION: {event}"


def check_idempotent_acks(ctx):
    m = ctx.load("assist_trace")
    ctx.kafka.lose_acks(TOPIC, 1)
    m.publish(_turn("t-1"))
    _settle(m)
    assert _ids(ctx) == ["t-1"], f"after one produce whose acknowledgement was lost the topic holds {_ids(ctx)}: the retry wrote the trace again. Enable idempotence"
    m.publish(_turn("t-2"))
    _settle(m)
    ctx.kafka.failover(TOPIC)
    assert "t-2" in _ids(ctx), "a leader failover right after the acknowledgement lost the trace: wait for all in-sync replicas (acks=all)"


def check_no_merchant_data(ctx):
    class Capture(logging.Handler):
        def __init__(self):
            super().__init__()
            self.lines = []

        def emit(self, record):
            self.lines.append(record.getMessage())

    capture = Capture()
    logging.getLogger().addHandler(capture)
    logging.getLogger().setLevel(logging.DEBUG)
    try:
        m = ctx.load("assist_trace")
        m.publish(_turn("t-1"))
        _settle(m)
    finally:
        logging.getLogger().removeHandler(capture)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one turn produced {len(records)} records"
    value = records[0].value.decode()
    assert "Okafor" not in value, f"the trace carries the merchant's words or a tool's customer list: {value}"
    event = json.loads(value)
    leaked = [k for k in ("merchant_message", "tool_results", "message") if k in event]
    assert not leaked, f"the trace has the fields {leaked}: a topic is retained and readable by every consumer group"
    lines = [line for line in capture.lines if "Okafor" in line]
    assert not lines, f"a log line carries the merchant's message: {lines[0]!r}"


def check_outbox(ctx):
    m = ctx.load("assist_trace")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.publish(_turn("t-9"))
        _settle(m)
    except Exception as exc:  # noqa: BLE001 - whatever it raised is the verdict
        raise AssertionError(f"publish raised when the broker refused the record: {exc!r}. Write the event to the outbox instead") from None
    rows = _outbox(ctx)
    assert rows, "the broker refused the record and nothing reached outbox:assist.trace: handle the delivery report (on_delivery) with outbox.insert(event, reason)"
    assert rows[0].get("event", {}).get("turn_id") == "t-9" and rows[0].get("reason"), f"the outbox row carries the event and the reason: {rows[0]}"
    m.publish(_turn("t-10"))
    _settle(m)
    assert _ids(ctx) == ["t-10"] and len(_outbox(ctx)) == 1, f"a healthy produce reaches the topic and adds no outbox row: topic {_ids(ctx)}, outbox {len(_outbox(ctx))} rows"


def check_insert_before_commit(ctx):
    for i, shop in enumerate(("s1", "s1", "s2")):
        ctx.kafka.seed(TOPIC, key=shop, value=json.dumps({"turn_id": f"t-{i}", "shop": shop, "page": "home", "tools_used": [], "latency_ms": 500, "tokens": 900, "judge_score": 0.9, "prompt_version": "sk-prompt-14"}))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(ctx.redis.llen("gtx:candidates")))
    m = ctx.load("assist_trace")
    ctx.drain(m.run_gtx_builder)
    assert at_commit, "the gtx-builder never committed an offset"
    assert at_commit[0] >= 1, f"at the first commit the ground-truth candidates held {at_commit[0]} rows: insert before you commit, or a crash in between skips the trace"
    assert ctx.redis.llen("gtx:candidates") == 3, f"three traces must become three candidates, found {ctx.redis.llen('gtx:candidates')}"
    assert ctx.kafka.lag("gtx-builder", TOPIC) == 0, "every inserted trace must be committed"
`,
    typescript: `const TOPIC = 'assist.trace';
const CUSTOMER = 'Jane Okafor, jane.okafor@example.com';
const FIELDS = ['turn_id', 'shop', 'page', 'tools_used', 'latency_ms', 'tokens', 'judge_score', 'prompt_version'];

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const turn = (turnId = 't-1', shop = 's1') => ({
  turn_id: turnId,
  shop,
  page: 'customers',
  message: \`which customers spend like \${CUSTOMER}?\`,
  tools_used: ['segment_customers'],
  tool_results: [JSON.stringify({customers: [CUSTOMER]})],
  latency_ms: 840,
  tokens: 2400,
  judge_score: 0.92,
});

const ids = (ctx): string[] => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()).turn_id);
const outboxRows = (ctx): Record<string, any>[] => ctx.redis.lrange('outbox:assist.trace', 0, -1).map((row: string) => JSON.parse(row));

export async function check_shop_key(ctx) {
  const m = ctx.load('assist_trace');
  await m.publish(turn('t-1', 's1'));
  await m.publish(turn('t-2', 's2'));
  await m.publish(turn('t-3', 's1'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three turns produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepEqual(keys, ['s1', 's2', 's1'], \`records must be keyed by the shop, got \${JSON.stringify(keys)}: keyed by turn id, one shop's traces scatter across partitions\`);
  assert.equal(records[0].partition, records[2].partition, "one shop's traces must land on one partition");
  const event = JSON.parse(records[0].value.toString());
  for (const field of FIELDS) assert(field in event, \`the event lacks \${field}: \${records[0].value}\`);
  assert(event.turn_id === 't-1' && event.shop === 's1' && event.prompt_version === 'sk-prompt-14', \`the event carries the turn id, the shop and PROMPT_VERSION: \${records[0].value}\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('assist_trace');
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.publish(turn('t-1'));
  await settle();
  assert.deepEqual(ids(ctx), ['t-1'], \`after one produce whose acknowledgement was lost the topic holds \${JSON.stringify(ids(ctx))}: the retry wrote the trace again. Enable idempotence\`);
  await m.publish(turn('t-2'));
  await settle();
  ctx.kafka.failover(TOPIC);
  assert(ids(ctx).includes('t-2'), 'a leader failover right after the acknowledgement lost the trace: wait for all in-sync replicas (acks: -1)');
}

export async function check_no_merchant_data(ctx) {
  const m = ctx.load('assist_trace');
  const logged: string[] = [];
  const prior = {log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  try {
    await m.publish(turn('t-1'));
    await settle();
  } finally {
    Object.assign(console, prior);
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one turn produced \${records.length} records\`);
  const value = records[0].value.toString();
  assert(!value.includes('Okafor'), \`the trace carries the merchant's words or a tool's customer list: \${value}\`);
  const event = JSON.parse(value);
  const leaked = ['merchant_message', 'tool_results', 'message'].filter(k => k in event);
  assert.deepEqual(leaked, [], \`the trace has the fields \${JSON.stringify(leaked)}: a topic is retained and readable by every consumer group\`);
  const leak = logged.find(l => l.includes('Okafor'));
  assert(leak === undefined, \`a log line carries the merchant's message: \${JSON.stringify(leak)}\`);
}

export async function check_outbox(ctx) {
  const m = ctx.load('assist_trace');
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await m.publish(turn('t-9'));
  } catch (e) {
    assert.fail(\`publish rejected when the broker refused the record: \${e}. Write the event to the outbox instead\`);
  }
  await settle();
  const rows = outboxRows(ctx);
  assert(rows.length > 0, 'the broker refused the record and nothing reached outbox:assist.trace: catch the rejected send and call outbox.insert(event, reason)');
  assert(rows[0].event?.turn_id === 't-9' && rows[0].reason, \`the outbox row carries the event and the reason: \${JSON.stringify(rows[0])}\`);
  await m.publish(turn('t-10'));
  await settle();
  assert(JSON.stringify(ids(ctx)) === '["t-10"]' && outboxRows(ctx).length === 1, \`a healthy produce reaches the topic and adds no outbox row: topic \${JSON.stringify(ids(ctx))}, outbox \${outboxRows(ctx).length} rows\`);
}

export async function check_insert_before_commit(ctx) {
  ['s1', 's1', 's2'].forEach((shop, i) => {
    ctx.kafka.seed(TOPIC, {key: shop, value: JSON.stringify({turn_id: \`t-\${i}\`, shop, page: 'home', tools_used: [], latency_ms: 500, tokens: 900, judge_score: 0.9, prompt_version: 'sk-prompt-14'})});
  });
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.llen('gtx:candidates')));
  const m = ctx.load('assist_trace');
  await ctx.drain(m.runGtxBuilder());
  assert(atCommit.length > 0, 'the gtx-builder never committed an offset');
  assert(atCommit[0] >= 1, \`at the first commit the ground-truth candidates held \${atCommit[0]} rows: insert before you commit, or a crash in between skips the trace\`);
  assert.equal(ctx.redis.llen('gtx:candidates'), 3, \`three traces must become three candidates, found \${ctx.redis.llen('gtx:candidates')}\`);
  assert.equal(ctx.kafka.lag('gtx-builder', TOPIC), 0, 'every inserted trace must be committed');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"os"
	"sort"
	"strings"

	"sidekick/trace"

	"leetbuild/harness"
)

const (
	traceTopic    = "assist.trace"
	traceCustomer = "Jane Okafor, jane.okafor@example.com"
)

func traceTurn(turnID, shop string) trace.TurnRecord {
	result, _ := json.Marshal(map[string]any{"customers": []string{traceCustomer}})
	return trace.TurnRecord{
		TurnID: turnID, Shop: shop, Page: "customers", Message: "which customers spend like " + traceCustomer + "?",
		ToolsUsed: []string{"segment_customers"}, ToolResults: []string{string(result)}, LatencyMs: 840, Tokens: 2400, JudgeScore: 0.92,
	}
}

func tracePublish(ctx *harness.Ctx, turn trace.TurnRecord) {
	ctx.NoError(publish(context.Background(), turn), "publish(%s)", turn.TurnID)
}

func traceIDs(ctx *harness.Ctx) []string {
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
	rows := []map[string]any{}
	for _, row := range ctx.Redis.LRange("outbox:assist.trace", 0, -1) {
		var v map[string]any
		json.Unmarshal([]byte(row), &v)
		rows = append(rows, v)
	}
	return rows
}

func CheckShopKey(ctx *harness.Ctx) {
	tracePublish(ctx, traceTurn("t-1", "s1"))
	tracePublish(ctx, traceTurn("t-2", "s2"))
	tracePublish(ctx, traceTurn("t-3", "s1"))
	ctx.Settle()
	records := ctx.Kafka.Records(traceTopic)
	ctx.Equal(len(records), 3, "three turns must produce three records on %s; records", traceTopic)
	keys := ctx.Kafka.Keys(traceTopic)
	sort.Strings(keys)
	ctx.Equal(keys, []string{"s1", "s1", "s2"}, "records must be keyed by the shop (keyed by turn id, one shop's traces scatter across partitions)")
	var s1 []int
	var first map[string]any
	for _, r := range records {
		if string(r.Key) == "s1" {
			s1 = append(s1, r.Partition)
		}
		var event map[string]any
		ctx.NoError(json.Unmarshal(r.Value, &event), "the event must be JSON: %s", r.Value)
		if event["turn_id"] == "t-1" {
			first = event
		}
	}
	ctx.Assert(len(s1) == 2 && s1[0] == s1[1], "one shop's traces must land on one partition; s1's partitions %v", s1)
	ctx.Assert(first != nil, "no record carries turn_id t-1")
	for _, field := range []string{"turn_id", "shop", "page", "tools_used", "latency_ms", "tokens", "judge_score", "prompt_version"} {
		_, ok := first[field]
		ctx.Assert(ok, "the event lacks %s: %v", field, first)
	}
	ctx.Assert(first["shop"] == "s1" && first["prompt_version"] == "sk-prompt-14", "the event carries the shop and PromptVersion: %v", first)
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(traceTopic, 1)
	tracePublish(ctx, traceTurn("t-1", "s1"))
	ctx.Settle()
	ctx.Equal(traceIDs(ctx), []string{"t-1"}, "after one produce whose acknowledgement was lost the topic must hold the trace once (enable.idempotence); the records")
	tracePublish(ctx, traceTurn("t-2", "s1"))
	ctx.Settle()
	ctx.Kafka.Failover(traceTopic)
	ctx.Equal(traceIDs(ctx), []string{"t-1", "t-2"}, "a leader failover right after the acknowledgement must keep the trace (acks=all); the records")
}

func CheckNoMerchantData(ctx *harness.Ctx) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	tracePublish(ctx, traceTurn("t-1", "s1"))
	ctx.Settle()
	log.SetOutput(os.Stderr)
	records := ctx.Kafka.Records(traceTopic)
	ctx.Equal(len(records), 1, "one turn; records")
	value := string(records[0].Value)
	ctx.Assert(!strings.Contains(value, "Okafor"), "the trace carries the merchant's words or a tool's customer list: %s", value)
	var event map[string]any
	json.Unmarshal(records[0].Value, &event)
	for _, k := range []string{"merchant_message", "tool_results", "message"} {
		_, has := event[k]
		ctx.Assert(!has, "the trace has the field %s: a topic is retained and readable by every consumer group", k)
	}
	ctx.Assert(!strings.Contains(logged.String(), "Okafor"), "a log line carries the merchant's message: %q", strings.TrimSpace(logged.String()))
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(traceTopic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("publish panicked when the broker refused the record: %v. Write the event to the outbox instead", e)
			}
		}()
		tracePublish(ctx, traceTurn("t-9", "s1"))
	}()
	ctx.Settle()
	rows := traceOutbox(ctx)
	ctx.Assert(len(rows) > 0, "the broker refused the record and nothing reached outbox:assist.trace: read the delivery report (TopicPartition.Error) and call outbox.Insert")
	event, _ := rows[0]["event"].(map[string]any)
	ctx.Assert(event["turn_id"] == "t-9" && rows[0]["reason"] != "", "the outbox row carries the event and the reason: %v", rows[0])
	tracePublish(ctx, traceTurn("t-10", "s1"))
	ctx.Settle()
	ctx.Equal(traceIDs(ctx), []string{"t-10"}, "a healthy produce reaches the topic; the records")
	ctx.Equal(len(traceOutbox(ctx)), 1, "a delivered record must not be written to the outbox; the rows")
}

func CheckInsertBeforeCommit(ctx *harness.Ctx) {
	for i, shop := range []string{"s1", "s1", "s2"} {
		value, _ := json.Marshal(map[string]any{"turn_id": "t-" + string(rune('0'+i)), "shop": shop, "page": "home", "tools_used": []string{}, "latency_ms": 500, "tokens": 900, "judge_score": 0.9, "prompt_version": "sk-prompt-14"})
		ctx.Kafka.Seed(traceTopic, shop, string(value))
	}
	var atCommit []int64
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, ctx.Redis.LLen("gtx:candidates")) })
	ctx.Drain(func() { runGtxBuilder(context.Background()) })
	ctx.Assert(len(atCommit) > 0, "the gtx-builder never committed an offset")
	ctx.Assert(atCommit[0] >= 1, "at the first commit the ground-truth candidates held %d rows: insert before you commit, or a crash in between skips the trace", atCommit[0])
	ctx.Equal(ctx.Redis.LLen("gtx:candidates"), int64(3), "three traces must become three candidates; candidates")
	ctx.Equal(ctx.Kafka.Lag("gtx-builder", traceTopic), 0, "every inserted trace must be committed; the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "sidekick/trace.h"

namespace {

const std::string kTraceTopic = "assist.trace";
const std::string kCustomer = "Jane Okafor, jane.okafor@example.com";

trace::TurnRecord traceTurn(const std::string& turn_id, const std::string& shop) {
  trace::TurnRecord t;
  t.turn_id = turn_id;
  t.shop = shop;
  t.page = "customers";
  t.message = "which customers spend like " + kCustomer + "?";
  t.tools_used = {"segment_customers"};
  t.tool_results = {nlohmann::json({{"customers", {kCustomer}}}).dump()};
  t.latency_ms = 840;
  t.tokens = 2400;
  t.judge_score = 0.92;
  return t;
}

void settle(harness::Ctx& ctx) {
  ctx.Settle();
  producer->poll(0);  // the service loop serves delivery reports between turns
}

std::vector<std::string> traceIDs(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (const auto& r : ctx.Kafka.Records(kTraceTopic)) {
    const auto v = nlohmann::json::parse(r.Value.value_or(""), nullptr, false);
    ids.push_back(v.is_object() ? v.value("turn_id", "") : "");
  }
  return ids;
}

std::vector<nlohmann::json> traceOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& row : ctx.Redis.LRange("outbox:assist.trace", 0, -1)) rows.push_back(nlohmann::json::parse(row, nullptr, false));
  return rows;
}

}  // namespace

void CheckShopKey(harness::Ctx& ctx) {
  publish(traceTurn("t-1", "s1"));
  publish(traceTurn("t-2", "s2"));
  publish(traceTurn("t-3", "s1"));
  settle(ctx);
  const auto records = ctx.Kafka.Records(kTraceTopic);
  ctx.Equal(records.size(), 3, "three turns must produce three records on %s; records", kTraceTopic);
  ctx.Equal(ctx.Kafka.Keys(kTraceTopic), {"s1", "s2", "s1"}, "records must be keyed by the shop (keyed by turn id, one shop's traces scatter across partitions)");
  ctx.Equal(records[0].Partition, records[2].Partition, "one shop's traces must land on one partition; s1's partitions");
  const auto event = nlohmann::json::parse(records[0].Value.value_or(""), nullptr, false);
  for (const std::string field : {"turn_id", "shop", "page", "tools_used", "latency_ms", "tokens", "judge_score", "prompt_version"}) {
    ctx.Assert(event.is_object() && event.contains(field), "the event lacks %s: %s", field, records[0].Value.value_or(""));
  }
  ctx.Assert(event.value("turn_id", "") == "t-1" && event.value("shop", "") == "s1" && event.value("prompt_version", "") == "sk-prompt-14",
             "the event carries the turn id, the shop and kPromptVersion: %s", records[0].Value.value_or(""));
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTraceTopic, 1);
  publish(traceTurn("t-1", "s1"));
  settle(ctx);
  ctx.Equal(traceIDs(ctx), {"t-1"}, "after one produce whose acknowledgement was lost the topic must hold the trace once (enable.idempotence); the records");
  publish(traceTurn("t-2", "s1"));
  settle(ctx);
  ctx.Kafka.Failover(kTraceTopic);
  ctx.Equal(traceIDs(ctx), {"t-1", "t-2"}, "a leader failover right after the acknowledgement must keep the trace (acks=all); the records");
}

void CheckNoMerchantData(harness::Ctx& ctx) {
  std::ostringstream logged;
  auto* out = std::cout.rdbuf(logged.rdbuf());
  auto* err = std::cerr.rdbuf(logged.rdbuf());
  publish(traceTurn("t-1", "s1"));
  settle(ctx);
  std::cout.rdbuf(out);
  std::cerr.rdbuf(err);
  const auto records = ctx.Kafka.Records(kTraceTopic);
  ctx.Equal(records.size(), 1, "one turn; records");
  const std::string value = records[0].Value.value_or("");
  ctx.Assert(value.find("Okafor") == std::string::npos, "the trace carries the merchant's words or a tool's customer list: %s", value);
  const auto event = nlohmann::json::parse(value, nullptr, false);
  for (const std::string k : {"merchant_message", "tool_results", "message"}) {
    ctx.Assert(!event.is_object() || !event.contains(k), "the trace has the field %s: a topic is retained and readable by every consumer group", k);
  }
  ctx.Assert(logged.str().find("Okafor") == std::string::npos, "a log line carries the merchant's message: %q", logged.str());
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTraceTopic, 1);
  try {
    publish(traceTurn("t-9", "s1"));
  } catch (const std::exception& e) {
    ctx.Fatalf("publish threw when the broker refused the record: %s. Write the event to the outbox instead", e.what());
  }
  settle(ctx);
  const auto rows = traceOutbox(ctx);
  ctx.Assert(!rows.empty(), "the broker refused the record and nothing reached outbox:assist.trace: handle the delivery report (dr_cb) with outbox::insert");
  ctx.Assert(rows[0].is_object() && rows[0].contains("event") && rows[0]["event"].value("turn_id", "") == "t-9" && !rows[0].value("reason", "").empty(),
             "the outbox row carries the event and the reason: %s", rows[0].dump());
  publish(traceTurn("t-10", "s1"));
  settle(ctx);
  ctx.Equal(traceIDs(ctx), {"t-10"}, "a healthy produce reaches the topic; the records");
  ctx.Equal(traceOutbox(ctx).size(), 1, "a delivered record must not be written to the outbox; the rows");
}

void CheckInsertBeforeCommit(harness::Ctx& ctx) {
  int i = 0;
  for (const std::string shop : {"s1", "s1", "s2"}) {
    const nlohmann::json v = {{"turn_id", "t-" + std::to_string(i++)}, {"shop", shop}, {"page", "home"}, {"tools_used", nlohmann::json::array()},
                              {"latency_ms", 500}, {"tokens", 900}, {"judge_score", 0.9}, {"prompt_version", "sk-prompt-14"}};
    ctx.Kafka.Seed(kTraceTopic, shop, v.dump());
  }
  std::vector<long long> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(ctx.Redis.LLen("gtx:candidates")); });
  ctx.Drain([] { run_gtx_builder(); });
  ctx.Assert(!atCommit.empty(), "the gtx-builder never committed an offset");
  ctx.Assert(atCommit[0] >= 1, "at the first commit the ground-truth candidates held %d rows: insert before you commit, or a crash in between skips the trace", atCommit[0]);
  ctx.Equal(ctx.Redis.LLen("gtx:candidates"), 3, "three traces must become three candidates; candidates");
  ctx.Equal(ctx.Kafka.Lag("gtx-builder", kTraceTopic), 0, "every inserted trace must be committed; the lag");
}
`,
  },
  hints: [
    "Symptom: a privacy review finds a merchant's customer names in a Kafka topic every team can read, the ground-truth set holds some turns twice, and turns from a broker restart never became candidates.",
    'Mechanism: the event copies `message` and `tool_results` and the log line prints the message; `key=turn.turn_id` scatters a shop; the default producer retries into duplicates; nobody reads the delivery report; the builder commits before it inserts.',
    'Change: produce `key=turn.shop` the eight trace fields only, from a producer with `enable.idempotence` and `acks=all`; pass `on_delivery` that calls `outbox.insert(event, str(err))`; log ids, not words; `insert_candidate`, then `consumer.commit`.',
  ],
  debrief: `A trace topic is a second copy of the product's behaviour, so it gets the same care as the product data it describes, and less of it. Keying by shop keeps one merchant's turns in order for whoever replays them; idempotence and \`acks=all\` make "exactly the turns that happened" hold through a lost acknowledgement or a leader change. Leaving out the message and tool results is a retention decision: the topic lives for days and every consumer group reads it, so merchant data reaches the ground-truth set later, through a consented sampling path. The outbox is written where the broker's refusal arrives, and insert-then-commit trades a rare duplicate candidate for no lost one. Production pipelines also register the event schema and drain the outbox with the same idempotent producer.`,
};
