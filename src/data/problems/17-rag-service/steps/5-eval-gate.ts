import type {Step} from '@/lib/types';

export const evalGateStep: Step = {
  id: 'eval-gate',
  title: 'Eval gate: one verdict per release, on evidence',
  concept: 'kafka',
  guides: ['consuming-events', 'model-output', 'producing-events'],
  file: 'eval_gate',
  focus: ['events', 'eval', 'redis', 'metrics'],
  task: `## Task

**Starting point.** The starter's \`run()\` consumes \`eval.samples\` (one record per golden question the
eval runner replayed against a release: \`release\`, \`sample_id\`, \`grounded\`, \`recall_at_k\`,
\`should_refuse\`, \`refused\`, \`question\`) in group \`rag-eval-v2\`. For each record it commits the
offset, counts the sample with \`evalstore.record\`, and publishes the release's running metrics to
\`eval.metrics\` with a verdict: \`pass\` at groundedness 0.95 or more, else \`block\`. It runs and hides
five flaws.

**Failure mode the checks target.** The release dashboard reads group \`rag-eval\` and sees nothing move.
A crash between the commit and the count loses samples. A verdict after the first sample ships a
release on one green answer; recall and regression are never looked at; and the question text, user
content, lands in an analytics topic.

Requirements:

- Consumer group \`rag-eval\`; each offset is committed after \`evalstore.record\` (and any verdict) for
  that record.
- One verdict per release, when its count reaches \`MIN_SAMPLES\` = 200.
- \`block\` when groundedness < 0.95, recall@k < \`MIN_RECALL\` = 0.90, or groundedness more than
  \`MAX_REGRESSION\` = 0.01 under \`evalstore.baseline()\`; a \`pass\` becomes the baseline.
- The verdict is \`{release, samples, groundedness, recall_at_k, refusal_accuracy, verdict}\`.`,
  sequence: {
    participants: ['eval.samples', 'Eval gate', 'Redis', 'eval.metrics'],
    messages: [
      {from: 'eval.samples', to: 'Eval gate', label: 'sample (group rag-eval)', kind: 'async'},
      {from: 'Eval gate', to: 'Redis', label: 'EVALSHA record (once per sample_id)', kind: 'sync'},
      {from: 'Redis', to: 'Eval gate', label: 'count = 200', kind: 'reply'},
      {from: 'Eval gate', to: 'Redis', label: 'metrics · baseline', kind: 'sync'},
      {from: 'Eval gate', to: 'eval.metrics', label: '{release, metrics, verdict}', kind: 'async'},
      {from: 'Eval gate', to: 'eval.samples', label: 'commit offset', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'consumer-group',
      title: 'Consumes eval.samples in group rag-eval',
      detail:
        'The gate subscribes to eval.samples as group rag-eval, counts every record and leaves no lag. The starter joins rag-eval-v2, so the offsets and the dashboards on rag-eval never move.',
      match: {
        python: {all: [/["']rag-eval["']/]},
        typescript: {all: [/['"]rag-eval['"]/]},
        go: {all: [/"rag-eval"/]},
        scala: {all: [/"rag-eval"/]},
        cpp: {all: [/"rag-eval"/]},
      },
    },
    {
      id: 'commit-after-store',
      title: 'Commits an offset only after its sample is counted',
      detail:
        'At every commit, the samples counted in rag:eval:{release} cover every offset committed. The starter commits each record before it counts it.',
      match: {
        python: {order: [/^\s+handle\(/m, /consumer\.commit\(/]},
        typescript: {order: [/await handle\(/, /commitOffsets\(/]},
        go: {order: [/handle\(ctx,\s*\w+\)/, /CommitMessages\(/]},
        scala: {order: [/=>\s*handle\(/, /commitSync\(/]},
        cpp: {order: [/handle\(\s*\*?\w+\s*\)\s*;/, /commitSync\(/]},
      },
    },
    {
      id: 'min-samples',
      title: 'Publishes one verdict per release, at 200 samples',
      detail:
        'A release with 205 samples gets exactly one verdict, made at 200; a release with 150 gets none. The starter publishes after every sample.',
      match: {
        python: {all: [/(!=|==)\s*MIN_SAMPLES\b/]},
        typescript: {all: [/(!==?|===?)\s*MIN_SAMPLES\b/]},
        go: {all: [/(!=|==)\s*minSamples\b/]},
        scala: {all: [/(!=|==)\s*MinSamples\b/]},
        cpp: {all: [/(!=|==)\s*kMinSamples\b/]},
      },
    },
    {
      id: 'release-thresholds',
      title: 'Blocks on recall and on regression, not only on groundedness',
      detail:
        'With a baseline of 0.98, a release at 0.98 groundedness and 0.85 recall is blocked, one at 0.96 and 0.95 is blocked as a regression, and one at 0.99 and 0.95 passes. The starter checks groundedness against 0.95 alone.',
      match: {
        python: {all: [/\bMIN_RECALL\b/, /\bMAX_REGRESSION\b/]},
        typescript: {all: [/\bMIN_RECALL\b/, /\bMAX_REGRESSION\b/]},
        go: {all: [/\bminRecall\b/, /\bmaxRegression\b/]},
        scala: {all: [/\bMinRecall\b/, /\bMaxRegression\b/]},
        cpp: {all: [/\bkMinRecall\b/, /\bkMaxRegression\b/]},
      },
    },
    {
      id: 'no-raw-text',
      title: 'Keeps question text out of eval.metrics',
      detail:
        "Verdicts carry the release, the four metrics and the verdict; no question text. The starter copies the sample's question into every event.",
      match: {
        python: {none: [/\bquestion\b/]},
        typescript: {none: [/\bquestion\b/]},
        go: {none: [/\.Question\b/]},
        scala: {none: [/\.question\b/]},
        cpp: {none: [/"question"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer

from rag import evalstore
from rag.config import METRICS_TOPIC, SAMPLES_TOPIC

logger = logging.getLogger("ragd.eval")

GROUP = "rag-eval-v2"
MIN_GROUNDEDNESS = 0.95

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def handle(sample: dict) -> None:
    """Count one sample and publish the release's verdict."""
    count = evalstore.record(sample)
    release = sample["release"]
    metrics = evalstore.metrics(release)
    decision = "pass" if metrics["groundedness"] >= MIN_GROUNDEDNESS else "block"
    if decision == "pass":
        evalstore.set_baseline(release, metrics["groundedness"])
    event = {"release": release, **metrics, "verdict": decision, "question": sample["question"]}
    failures = []
    producer.produce(METRICS_TOPIC, key=release, value=json.dumps(event).encode("utf-8"), on_delivery=lambda err, msg: err and failures.append(err))
    if producer.flush(10) > 0 or failures:
        raise RuntimeError(f"verdict for {release} not acknowledged: {failures}")
    logger.info("eval release=%s samples=%d verdict=%s", release, count, decision)


def run() -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([SAMPLES_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(message=msg, asynchronous=False)
        try:
            sample = json.loads(msg.value())
        except ValueError:
            logger.warning("skipping malformed sample at offset %d", msg.offset())
            continue
        handle(sample)
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, Producer

from rag import evalstore
from rag.config import METRICS_TOPIC, SAMPLES_TOPIC

logger = logging.getLogger("ragd.eval")

GROUP = "rag-eval"
MIN_SAMPLES = 200
MIN_GROUNDEDNESS = 0.95
MIN_RECALL = 0.90
MAX_REGRESSION = 0.01

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def verdict(metrics: dict, baseline: float | None) -> str:
    if metrics["groundedness"] < MIN_GROUNDEDNESS or metrics["recall_at_k"] < MIN_RECALL:
        return "block"
    if baseline is not None and baseline - metrics["groundedness"] > MAX_REGRESSION:
        return "block"
    return "pass"


def handle(sample: dict) -> None:
    """Count one sample; at MIN_SAMPLES, publish the release's verdict."""
    count = evalstore.record(sample)
    if count != MIN_SAMPLES:
        return
    release = sample["release"]
    metrics = evalstore.metrics(release)
    decision = verdict(metrics, evalstore.baseline())
    if decision == "pass":
        evalstore.set_baseline(release, metrics["groundedness"])
    event = {"release": release, **metrics, "verdict": decision}
    failures = []
    producer.produce(METRICS_TOPIC, key=release, value=json.dumps(event).encode("utf-8"), on_delivery=lambda err, msg: err and failures.append(err))
    if producer.flush(10) > 0 or failures:
        raise RuntimeError(f"verdict for {release} not acknowledged: {failures}")
    logger.info("eval release=%s samples=%d verdict=%s", release, count, decision)


def run() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([SAMPLES_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        try:
            sample = json.loads(msg.value())
        except ValueError:
            logger.warning("skipping malformed sample at offset %d", msg.offset())
        else:
            handle(sample)
        consumer.commit(message=msg, asynchronous=False)  # after the count: a crash before it redelivers, and record() counts once
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {METRICS_TOPIC, SAMPLES_TOPIC} from 'rag/config';
import * as evalstore from 'rag/evalstore';

export const GROUP = 'rag-eval-v2';
export const MIN_GROUNDEDNESS = 0.95;

const kafka = new Kafka({clientId: 'ragd-eval', brokers: ['kafka:9092']});
const producer = kafka.producer();

/** Count one sample and publish the release's verdict. */
export async function handle(sample: evalstore.Sample): Promise<void> {
  const count = await evalstore.record(sample);
  const metrics = await evalstore.metrics(sample.release);
  const decision = metrics.groundedness >= MIN_GROUNDEDNESS ? 'pass' : 'block';
  if (decision === 'pass') await evalstore.setBaseline(sample.release, metrics.groundedness);
  const event = {release: sample.release, ...metrics, verdict: decision, question: sample.question};
  await producer.send({topic: METRICS_TOPIC, acks: -1, messages: [{key: sample.release, value: JSON.stringify(event)}]});
  console.log(\`eval release=\${sample.release} samples=\${count} verdict=\${decision}\`);
}

function parse(value: Buffer | null): evalstore.Sample | null {
  try {
    return JSON.parse(value?.toString() ?? '') as evalstore.Sample;
  } catch {
    return null;
  }
}

export async function run(): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  await producer.connect();
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: SAMPLES_TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const sample = parse(message.value);
      if (sample === null) {
        console.warn(\`skipping malformed sample at offset \${message.offset}\`);
        return;
      }
      await handle(sample);
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {METRICS_TOPIC, SAMPLES_TOPIC} from 'rag/config';
import * as evalstore from 'rag/evalstore';

export const GROUP = 'rag-eval';
export const MIN_SAMPLES = 200;
export const MIN_GROUNDEDNESS = 0.95;
export const MIN_RECALL = 0.9;
export const MAX_REGRESSION = 0.01;

const kafka = new Kafka({clientId: 'ragd-eval', brokers: ['kafka:9092']});
const producer = kafka.producer();

export function verdict(metrics: evalstore.Metrics, baseline: number | null): 'pass' | 'block' {
  if (metrics.groundedness < MIN_GROUNDEDNESS || metrics.recall_at_k < MIN_RECALL) return 'block';
  if (baseline !== null && baseline - metrics.groundedness > MAX_REGRESSION) return 'block';
  return 'pass';
}

/** Count one sample; at MIN_SAMPLES, publish the release's verdict. */
export async function handle(sample: evalstore.Sample): Promise<void> {
  const count = await evalstore.record(sample);
  if (count !== MIN_SAMPLES) return;
  const metrics = await evalstore.metrics(sample.release);
  const decision = verdict(metrics, await evalstore.baseline());
  if (decision === 'pass') await evalstore.setBaseline(sample.release, metrics.groundedness);
  const event = {release: sample.release, ...metrics, verdict: decision};
  await producer.send({topic: METRICS_TOPIC, acks: -1, messages: [{key: sample.release, value: JSON.stringify(event)}]});
  console.log(\`eval release=\${sample.release} samples=\${count} verdict=\${decision}\`);
}

function parse(value: Buffer | null): evalstore.Sample | null {
  try {
    return JSON.parse(value?.toString() ?? '') as evalstore.Sample;
  } catch {
    return null;
  }
}

export async function run(): Promise<void> {
  await producer.connect();
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: SAMPLES_TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const sample = parse(message.value);
      if (sample === null) console.warn(\`skipping malformed sample at offset \${message.offset}\`);
      else await handle(sample);
      // after the count: a crash before it redelivers, and record() counts once
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

	"github.com/segmentio/kafka-go"

	"rag/config"    // config.SamplesTopic, config.MetricsTopic — provided
	"rag/evalstore" // evalstore.Sample, Record, Of, Baseline, SetBaseline — provided
)

const (
	group           = "rag-eval-v2"
	minGroundedness = 0.95
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: config.MetricsTopic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

// handle counts one sample and publishes the release's verdict.
func handle(ctx context.Context, s evalstore.Sample) error {
	count, err := evalstore.Record(ctx, s)
	if err != nil {
		return err
	}
	m, err := evalstore.Of(ctx, s.Release)
	if err != nil {
		return err
	}
	decision := "block"
	if m.Groundedness >= minGroundedness {
		decision = "pass"
		if err := evalstore.SetBaseline(ctx, s.Release, m.Groundedness); err != nil {
			return err
		}
	}
	event, _ := json.Marshal(map[string]any{"release": s.Release, "samples": m.Samples, "groundedness": m.Groundedness, "recall_at_k": m.RecallAtK, "refusal_accuracy": m.RefusalAccuracy, "verdict": decision, "question": s.Question})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(s.Release), Value: event}); err != nil {
		return err
	}
	log.Printf("eval release=%s samples=%d verdict=%s", s.Release, count, decision)
	return nil
}

func run(ctx context.Context) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: config.SamplesTopic, StartOffset: kafka.FirstOffset})
	defer reader.Close()
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var s evalstore.Sample
		if err := json.Unmarshal(msg.Value, &s); err != nil {
			log.Printf("skipping malformed sample at offset %d", msg.Offset)
			continue
		}
		if err := handle(ctx, s); err != nil {
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

	"github.com/segmentio/kafka-go"

	"rag/config"    // config.SamplesTopic, config.MetricsTopic — provided
	"rag/evalstore" // evalstore.Sample, Record, Of, Baseline, SetBaseline — provided
)

const (
	group           = "rag-eval"
	minSamples      = 200
	minGroundedness = 0.95
	minRecall       = 0.90
	maxRegression   = 0.01
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: config.MetricsTopic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

func verdict(m evalstore.Metrics, baseline float64, hasBaseline bool) string {
	if m.Groundedness < minGroundedness || m.RecallAtK < minRecall {
		return "block"
	}
	if hasBaseline && baseline-m.Groundedness > maxRegression {
		return "block"
	}
	return "pass"
}

// handle counts one sample; at minSamples it publishes the release's verdict.
func handle(ctx context.Context, s evalstore.Sample) error {
	count, err := evalstore.Record(ctx, s)
	if err != nil || count != minSamples {
		return err
	}
	m, err := evalstore.Of(ctx, s.Release)
	if err != nil {
		return err
	}
	baseline, hasBaseline, err := evalstore.Baseline(ctx)
	if err != nil {
		return err
	}
	decision := verdict(m, baseline, hasBaseline)
	if decision == "pass" {
		if err := evalstore.SetBaseline(ctx, s.Release, m.Groundedness); err != nil {
			return err
		}
	}
	event, _ := json.Marshal(map[string]any{"release": s.Release, "samples": m.Samples, "groundedness": m.Groundedness, "recall_at_k": m.RecallAtK, "refusal_accuracy": m.RefusalAccuracy, "verdict": decision})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(s.Release), Value: event}); err != nil {
		return err
	}
	log.Printf("eval release=%s samples=%d verdict=%s", s.Release, count, decision)
	return nil
}

func run(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: config.SamplesTopic, StartOffset: kafka.FirstOffset})
	defer reader.Close()
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var s evalstore.Sample
		if err := json.Unmarshal(msg.Value, &s); err != nil {
			log.Printf("skipping malformed sample at offset %d", msg.Offset)
		} else if err := handle(ctx, s); err != nil {
			return err // not committed: redelivered after a restart, and Record counts it once
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

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}

import scala.jdk.CollectionConverters._
import scala.util.Try

import rag.{Config, EvalStore, Sample}

object EvalGate {
  val Group = "rag-eval-v2"
  val MinGroundedness = 0.95

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** Count one sample and publish the release's verdict. */
  def handle(sample: Sample): Unit = {
    val count = EvalStore.record(sample)
    val m = EvalStore.metrics(sample.release)
    val decision = if (m.groundedness >= MinGroundedness) "pass" else "block"
    if (decision == "pass") EvalStore.setBaseline(sample.release, m.groundedness)
    val event = ujson.Obj(
      "release" -> sample.release,
      "samples" -> m.samples,
      "groundedness" -> m.groundedness,
      "recall_at_k" -> m.recall_at_k,
      "refusal_accuracy" -> m.refusal_accuracy,
      "verdict" -> decision,
      "question" -> sample.question
    )
    producer.send(new ProducerRecord[String, String](Config.MetricsTopic, sample.release, ujson.write(event))).get()
    System.err.println(s"eval release=\${sample.release} samples=$count verdict=$decision")
  }

  private def parse(raw: String): Option[Sample] = Try {
    val j = ujson.read(raw)
    Sample(j("release").str, j("sample_id").str, j("grounded").bool, j("recall_at_k").num, j("should_refuse").bool, j("refused").bool, j("question").str)
  }.toOption

  def run(): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("enable.auto.commit", "false")
    props.put("auto.offset.reset", "earliest")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.SamplesTopic).asJava)
    while (true) {
      for (record <- consumer.poll(Duration.ofSeconds(1)).asScala) {
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
        parse(record.value()) match {
          case Some(sample) => handle(sample)
          case None => System.err.println(s"skipping malformed sample at offset \${record.offset}")
        }
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}

import scala.jdk.CollectionConverters._
import scala.util.Try

import rag.{Config, EvalStore, Metrics, Sample}

object EvalGate {
  val Group = "rag-eval"
  val MinSamples = 200
  val MinGroundedness = 0.95
  val MinRecall = 0.90
  val MaxRegression = 0.01

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  def verdict(m: Metrics, baseline: Option[Double]): String =
    if (m.groundedness < MinGroundedness || m.recall_at_k < MinRecall) "block"
    else if (baseline.exists(b => b - m.groundedness > MaxRegression)) "block"
    else "pass"

  /** Count one sample; at MinSamples, publish the release's verdict. */
  def handle(sample: Sample): Unit = {
    val count = EvalStore.record(sample)
    if (count != MinSamples) return
    val m = EvalStore.metrics(sample.release)
    val decision = verdict(m, EvalStore.baseline())
    if (decision == "pass") EvalStore.setBaseline(sample.release, m.groundedness)
    val event = ujson.Obj(
      "release" -> sample.release,
      "samples" -> m.samples,
      "groundedness" -> m.groundedness,
      "recall_at_k" -> m.recall_at_k,
      "refusal_accuracy" -> m.refusal_accuracy,
      "verdict" -> decision
    )
    producer.send(new ProducerRecord[String, String](Config.MetricsTopic, sample.release, ujson.write(event))).get()
    System.err.println(s"eval release=\${sample.release} samples=$count verdict=$decision")
  }

  private def parse(raw: String): Option[Sample] = Try {
    val j = ujson.read(raw)
    val text = j.obj.get("question").map(_.str).getOrElse("")
    Sample(j("release").str, j("sample_id").str, j("grounded").bool, j("recall_at_k").num, j("should_refuse").bool, j("refused").bool, text)
  }.toOption

  def run(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("enable.auto.commit", "false")
    props.put("auto.offset.reset", "earliest")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.SamplesTopic).asJava)
    while (true) {
      for (record <- consumer.poll(Duration.ofSeconds(1)).asScala) {
        parse(record.value()) match {
          case Some(sample) => handle(sample)
          case None => System.err.println(s"skipping malformed sample at offset \${record.offset}")
        }
        // after the count: a crash before it redelivers, and record() counts once
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
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
#include <optional>
#include <stdexcept>
#include <string>

#include "rag/config.h"     // config::kSamplesTopic, config::kMetricsTopic — provided
#include "rag/evalstore.h"  // evalstore::Sample, record, metrics, baseline, set_baseline — provided

using json = nlohmann::json;

const std::string kGroup = "rag-eval-v2";
constexpr double kMinGroundedness = 0.95;

// The delivery report: whether the last verdict reached the broker.
class Delivery : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode last = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { last = message.err(); }
};

Delivery delivery;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Count one sample and publish the release's verdict.
void handle(const evalstore::Sample& s) {
  const long long count = evalstore::record(s);
  const auto m = evalstore::metrics(s.release);
  const std::string decision = m.groundedness >= kMinGroundedness ? "pass" : "block";
  if (decision == "pass") evalstore::set_baseline(s.release, m.groundedness);
  const std::string event = json{{"release", s.release}, {"samples", m.samples}, {"groundedness", m.groundedness}, {"recall_at_k", m.recall_at_k},
                                 {"refusal_accuracy", m.refusal_accuracy}, {"verdict", decision}, {"question", s.question}}
                                .dump();
  delivery.last = RdKafka::ERR_NO_ERROR;
  producer->produce(config::kMetricsTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                    event.size(), s.release.data(), s.release.size(), 0, nullptr);
  if (producer->flush(10000) != RdKafka::ERR_NO_ERROR || delivery.last != RdKafka::ERR_NO_ERROR)
    throw std::runtime_error("verdict for " + s.release + " not acknowledged");
  std::cerr << "eval release=" << s.release << " samples=" << count << " verdict=" << decision << "\\n";
}

std::optional<evalstore::Sample> parse(const std::string& raw) {
  const json j = json::parse(raw, nullptr, false);
  if (!j.is_object() || !j.contains("release") || !j.contains("sample_id")) return std::nullopt;
  evalstore::Sample s;
  s.release = j.value("release", "");
  s.sample_id = j.value("sample_id", "");
  s.grounded = j.value("grounded", false);
  s.recall_at_k = j.value("recall_at_k", 0.0);
  s.should_refuse = j.value("should_refuse", false);
  s.refused = j.value("refused", false);
  s.question = j.value("question", "");
  return s;
}

void run() {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("enable.auto.commit", "false", err);
  conf->set("auto.offset.reset", "earliest", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kSamplesTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    consumer->commitSync(msg.get());
    const auto sample = parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    if (!sample) {
      std::cerr << "skipping malformed sample at offset " << msg->offset() << "\\n";
      continue;
    }
    handle(*sample);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>

#include "rag/config.h"     // config::kSamplesTopic, config::kMetricsTopic — provided
#include "rag/evalstore.h"  // evalstore::Sample, record, metrics, baseline, set_baseline — provided

using json = nlohmann::json;

const std::string kGroup = "rag-eval";
constexpr long long kMinSamples = 200;
constexpr double kMinGroundedness = 0.95;
constexpr double kMinRecall = 0.90;
constexpr double kMaxRegression = 0.01;

// The delivery report: whether the last verdict reached the broker.
class Delivery : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode last = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { last = message.err(); }
};

Delivery delivery;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

std::string verdict(const evalstore::Metrics& m, std::optional<double> baseline) {
  if (m.groundedness < kMinGroundedness || m.recall_at_k < kMinRecall) return "block";
  if (baseline && *baseline - m.groundedness > kMaxRegression) return "block";
  return "pass";
}

// Count one sample; at kMinSamples, publish the release's verdict.
void handle(const evalstore::Sample& s) {
  const long long count = evalstore::record(s);
  if (count != kMinSamples) return;
  const auto m = evalstore::metrics(s.release);
  const std::string decision = verdict(m, evalstore::baseline());
  if (decision == "pass") evalstore::set_baseline(s.release, m.groundedness);
  const std::string event = json{{"release", s.release}, {"samples", m.samples}, {"groundedness", m.groundedness}, {"recall_at_k", m.recall_at_k},
                                 {"refusal_accuracy", m.refusal_accuracy}, {"verdict", decision}}
                                .dump();
  delivery.last = RdKafka::ERR_NO_ERROR;
  producer->produce(config::kMetricsTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                    event.size(), s.release.data(), s.release.size(), 0, nullptr);
  if (producer->flush(10000) != RdKafka::ERR_NO_ERROR || delivery.last != RdKafka::ERR_NO_ERROR)
    throw std::runtime_error("verdict for " + s.release + " not acknowledged");
  std::cerr << "eval release=" << s.release << " samples=" << count << " verdict=" << decision << "\\n";
}

std::optional<evalstore::Sample> parse(const std::string& raw) {
  const json j = json::parse(raw, nullptr, false);
  if (!j.is_object() || !j.contains("release") || !j.contains("sample_id")) return std::nullopt;
  evalstore::Sample s;
  s.release = j.value("release", "");
  s.sample_id = j.value("sample_id", "");
  s.grounded = j.value("grounded", false);
  s.recall_at_k = j.value("recall_at_k", 0.0);
  s.should_refuse = j.value("should_refuse", false);
  s.refused = j.value("refused", false);
  return s;
}

void run() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("enable.auto.commit", "false", err);
  conf->set("auto.offset.reset", "earliest", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kSamplesTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const auto sample = parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    if (sample) handle(*sample);
    else std::cerr << "skipping malformed sample at offset " << msg->offset() << "\\n";
    consumer->commitSync(msg.get());  // after the count: a crash before it redelivers, and record() counts once
  }
}
`,
    },
  },
  harness: {
    python: `import json

SAMPLES = "eval.samples"
METRICS = "eval.metrics"


def _seed(ctx, release, n, ungrounded=0, recall=0.95):
    for i in range(n):
        sample = {
            "release": release,
            "sample_id": f"{release}-{i:03d}",
            "grounded": i >= ungrounded,
            "recall_at_k": recall,
            "should_refuse": i % 10 == 0,
            "refused": i % 10 == 0,
            "question": f"What is the refund window for order {i}?",
        }
        ctx.kafka.seed(SAMPLES, key=release, value=json.dumps(sample))


def _run(ctx):
    m = ctx.load("eval_gate")
    ctx.drain(m.run)


def _verdicts(ctx):
    return [json.loads(v) for v in ctx.kafka.values(METRICS)]


def check_consumer_group(ctx):
    _seed(ctx, "r1", 3)
    _run(ctx)
    subs = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subs, "the gate never subscribed to a topic"
    group, topics = subs[-1][1], subs[-1][2]
    assert group == "rag-eval", f"the gate joined group {group!r}: rag-eval owns this stream's offsets and the dashboards read it; another id starts counting from scratch"
    assert SAMPLES in topics, f"the gate must subscribe to {SAMPLES}, got {topics}"
    assert ctx.kafka.lag("rag-eval", SAMPLES) == 0, f"{ctx.kafka.lag('rag-eval', SAMPLES)} samples left uncommitted in rag-eval"
    assert ctx.redis.hget("rag:eval:r1", "samples") == "3", f"three samples consumed, rag:eval:r1 counts {ctx.redis.hget('rag:eval:r1', 'samples')}"


def check_commit_after_store(ctx):
    _seed(ctx, "r1", 5)
    seen = []
    ctx.kafka.on_commit(lambda group, offsets: seen.append((sum(o for (t, _), o in offsets.items() if t == SAMPLES), int(ctx.redis.hget("rag:eval:r1", "samples") or 0))))
    _run(ctx)
    assert seen, "no offset was ever committed"
    for committed, counted in seen:
        assert committed <= counted, f"an offset covering {committed} samples was committed while rag:eval:r1 counted {counted}: a crash right then loses the samples in between; commit after evalstore.record"


def check_min_samples(ctx):
    _seed(ctx, "r1", 205)
    _seed(ctx, "r2", 150)
    _run(ctx)
    verdicts = _verdicts(ctx)
    r2 = [v for v in verdicts if v.get("release") == "r2"]
    assert not r2, f"r2 has 150 samples and got {len(r2)} verdicts: a release is judged at MIN_SAMPLES = 200, not on a handful"
    r1 = [v for v in verdicts if v.get("release") == "r1"]
    assert len(r1) == 1, f"r1 has 205 samples and got {len(r1)} verdicts: one verdict per release, made at the 200th"
    assert r1[0].get("samples") == 200 and r1[0].get("verdict") == "pass", f"r1's verdict is made on 200 samples, all grounded: {r1[0]}"


def check_release_thresholds(ctx):
    ctx.redis.hset("rag:eval:baseline", mapping={"release": "r0", "groundedness": "0.98"})
    _seed(ctx, "r1", 200, ungrounded=4, recall=0.85)  # groundedness 0.98, recall 0.85
    _seed(ctx, "r2", 200, ungrounded=8, recall=0.95)  # groundedness 0.96: 0.02 under the baseline
    _seed(ctx, "r3", 200, ungrounded=2, recall=0.95)  # groundedness 0.99
    _run(ctx)
    final = {v["release"]: v for v in _verdicts(ctx) if v.get("samples") == 200}
    assert set(final) == {"r1", "r2", "r3"}, f"each release gets a verdict at 200 samples, got {sorted(final)}"
    assert final["r1"]["verdict"] == "block", f"r1's recall@k is 0.85, under 0.90: it must be blocked, the gate said {final['r1']['verdict']!r}"
    assert final["r2"]["verdict"] == "block", f"r2's groundedness 0.96 is 0.02 under the last release that passed (0.98): a regression over 0.01 is blocked, the gate said {final['r2']['verdict']!r}"
    assert final["r3"]["verdict"] == "pass", f"r3 clears every bar (0.99, 0.95): it must pass, the gate said {final['r3']['verdict']!r}"
    assert ctx.redis.hget("rag:eval:baseline", "release") == "r3", "a release that passes becomes the baseline"


def check_no_raw_text(ctx):
    _seed(ctx, "r1", 200)
    _run(ctx)
    values = ctx.kafka.values(METRICS)
    assert values, "200 samples published no verdict"
    for value in values:
        assert b"refund window" not in value, f"a verdict carries question text: {value[:160]!r}; eval.metrics is an analytics topic, ids and aggregates only"
        assert "question" not in json.loads(value), f"a verdict has a question field: {value[:160]!r}"
`,
    typescript: `const SAMPLES = 'eval.samples';
const METRICS = 'eval.metrics';

function seed(ctx, release: string, n: number, ungrounded = 0, recall = 0.95) {
  for (let i = 0; i < n; i++) {
    const sample = {
      release,
      sample_id: \`\${release}-\${String(i).padStart(3, '0')}\`,
      grounded: i >= ungrounded,
      recall_at_k: recall,
      should_refuse: i % 10 === 0,
      refused: i % 10 === 0,
      question: \`What is the refund window for order \${i}?\`,
    };
    ctx.kafka.seed(SAMPLES, {key: release, value: JSON.stringify(sample)});
  }
}

async function run(ctx) {
  const m = ctx.load('eval_gate');
  await ctx.drain(m.run());
}

const verdicts = ctx => ctx.kafka.values(METRICS).map(v => JSON.parse(v.toString()));

export async function check_consumer_group(ctx) {
  seed(ctx, 'r1', 3);
  await run(ctx);
  const subs = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subs.length > 0, 'the gate never subscribed to a topic');
  const [, group, topics] = subs[subs.length - 1];
  assert.equal(group, 'rag-eval', \`the gate joined group \${JSON.stringify(group)}: rag-eval owns this stream's offsets and the dashboards read it; another id starts counting from scratch\`);
  assert(topics.includes(SAMPLES), \`the gate must subscribe to \${SAMPLES}, got \${JSON.stringify(topics)}\`);
  assert.equal(ctx.kafka.lag('rag-eval', SAMPLES), 0, \`\${ctx.kafka.lag('rag-eval', SAMPLES)} samples left uncommitted in rag-eval\`);
  assert.equal(ctx.redis.hget('rag:eval:r1', 'samples'), '3', \`three samples consumed, rag:eval:r1 counts \${ctx.redis.hget('rag:eval:r1', 'samples')}\`);
}

export async function check_commit_after_store(ctx) {
  seed(ctx, 'r1', 5);
  const seen: [number, number][] = [];
  ctx.kafka.onCommit((group, offsets) => {
    let committed = 0;
    for (const [tp, offset] of offsets) if (tp.startsWith(\`\${SAMPLES}|\`)) committed += offset;
    seen.push([committed, Number(ctx.redis.hget('rag:eval:r1', 'samples') ?? 0)]);
  });
  await run(ctx);
  assert(seen.length > 0, 'no offset was ever committed');
  for (const [committed, counted] of seen)
    assert(committed <= counted, \`an offset covering \${committed} samples was committed while rag:eval:r1 counted \${counted}: a crash right then loses the samples in between; commit after evalstore.record\`);
}

export async function check_min_samples(ctx) {
  seed(ctx, 'r1', 205);
  seed(ctx, 'r2', 150);
  await run(ctx);
  const all = verdicts(ctx);
  const r2 = all.filter(v => v.release === 'r2');
  assert.equal(r2.length, 0, \`r2 has 150 samples and got \${r2.length} verdicts: a release is judged at MIN_SAMPLES = 200, not on a handful\`);
  const r1 = all.filter(v => v.release === 'r1');
  assert.equal(r1.length, 1, \`r1 has 205 samples and got \${r1.length} verdicts: one verdict per release, made at the 200th\`);
  assert(r1[0].samples === 200 && r1[0].verdict === 'pass', \`r1's verdict is made on 200 samples, all grounded: \${JSON.stringify(r1[0])}\`);
}

export async function check_release_thresholds(ctx) {
  ctx.redis.hset('rag:eval:baseline', 'release', 'r0', 'groundedness', '0.98');
  seed(ctx, 'r1', 200, 4, 0.85); // groundedness 0.98, recall 0.85
  seed(ctx, 'r2', 200, 8, 0.95); // groundedness 0.96: 0.02 under the baseline
  seed(ctx, 'r3', 200, 2, 0.95); // groundedness 0.99
  await run(ctx);
  const final: Record<string, {verdict: string}> = {};
  for (const v of verdicts(ctx)) if (v.samples === 200) final[v.release] = v;
  assert.deepEqual(Object.keys(final).sort(), ['r1', 'r2', 'r3'], \`each release gets a verdict at 200 samples, got \${JSON.stringify(Object.keys(final).sort())}\`);
  assert.equal(final.r1.verdict, 'block', \`r1's recall@k is 0.85, under 0.90: it must be blocked, the gate said \${final.r1.verdict}\`);
  assert.equal(final.r2.verdict, 'block', \`r2's groundedness 0.96 is 0.02 under the last release that passed (0.98): a regression over 0.01 is blocked, the gate said \${final.r2.verdict}\`);
  assert.equal(final.r3.verdict, 'pass', \`r3 clears every bar (0.99, 0.95): it must pass, the gate said \${final.r3.verdict}\`);
  assert.equal(ctx.redis.hget('rag:eval:baseline', 'release'), 'r3', 'a release that passes becomes the baseline');
}

export async function check_no_raw_text(ctx) {
  seed(ctx, 'r1', 200);
  await run(ctx);
  const values = ctx.kafka.values(METRICS).map(v => v.toString());
  assert(values.length > 0, '200 samples published no verdict');
  for (const value of values) {
    assert(!value.includes('refund window'), \`a verdict carries question text: \${value.slice(0, 160)}; eval.metrics is an analytics topic, ids and aggregates only\`);
    assert(!('question' in JSON.parse(value)), \`a verdict has a question field: \${value.slice(0, 160)}\`);
  }
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const (
	evalSamples = "eval.samples"
	evalMetrics = "eval.metrics"
)

func evalSeed(ctx *harness.Ctx, release string, n, ungrounded int, recall float64) {
	for i := 0; i < n; i++ {
		ctx.Kafka.Seed(evalSamples, release, map[string]any{
			"release":       release,
			"sample_id":     fmt.Sprintf("%s-%03d", release, i),
			"grounded":      i >= ungrounded,
			"recall_at_k":   recall,
			"should_refuse": i%10 == 0,
			"refused":       i%10 == 0,
			"question":      fmt.Sprintf("What is the refund window for order %d?", i),
		})
	}
}

func evalRun(ctx *harness.Ctx) {
	runCtx, cancel := context.WithCancel(context.Background())
	ctx.Drain(func() { _ = run(runCtx) })
	cancel()
	ctx.Settle()
}

func evalVerdicts(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, v := range ctx.Kafka.Values(evalMetrics) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(v), &e), "a verdict is JSON: %s", v)
		out = append(out, e)
	}
	return out
}

func evalCount(ctx *harness.Ctx, release string) int {
	raw, _ := ctx.Redis.HGet("rag:eval:"+release, "samples")
	n, _ := strconv.Atoi(raw)
	return n
}

func CheckConsumerGroup(ctx *harness.Ctx) {
	evalSeed(ctx, "r1", 3, 0, 0.95)
	evalRun(ctx)
	subs := ctx.Kafka.EventsOf("subscribe")
	ctx.Assert(len(subs) > 0, "the gate never subscribed to a topic")
	last := subs[len(subs)-1]
	ctx.Equal(last.Group, "rag-eval", "the gate's group (rag-eval owns this stream's offsets and the dashboards read it; another id starts counting from scratch)")
	ctx.Assert(slices.Contains(last.Topics, evalSamples), "the gate must subscribe to %s, got %v", evalSamples, last.Topics)
	ctx.Equal(ctx.Kafka.Lag("rag-eval", evalSamples), int64(0), "samples left uncommitted in rag-eval")
	ctx.Equal(evalCount(ctx, "r1"), 3, "three samples consumed; rag:eval:r1 counts")
}

func CheckCommitAfterStore(ctx *harness.Ctx) {
	evalSeed(ctx, "r1", 5, 0, 0.95)
	type snapshot struct{ committed, counted int64 }
	var seen []snapshot
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		var committed int64
		for tp, offset := range offsets {
			if tp.Topic == evalSamples {
				committed += offset
			}
		}
		seen = append(seen, snapshot{committed, int64(evalCount(ctx, "r1"))})
	})
	evalRun(ctx)
	ctx.Assert(len(seen) > 0, "no offset was ever committed")
	for _, s := range seen {
		ctx.Assert(s.committed <= s.counted, "an offset covering %d samples was committed while rag:eval:r1 counted %d: a crash right then loses the samples in between; commit after evalstore.Record", s.committed, s.counted)
	}
}

func CheckMinSamples(ctx *harness.Ctx) {
	evalSeed(ctx, "r1", 205, 0, 0.95)
	evalSeed(ctx, "r2", 150, 0, 0.95)
	evalRun(ctx)
	var r1, r2 []map[string]any
	for _, v := range evalVerdicts(ctx) {
		switch fmt.Sprint(v["release"]) {
		case "r1":
			r1 = append(r1, v)
		case "r2":
			r2 = append(r2, v)
		}
	}
	ctx.Assert(len(r2) == 0, "r2 has 150 samples and got %d verdicts: a release is judged at minSamples = 200, not on a handful", len(r2))
	ctx.Assert(len(r1) == 1, "r1 has 205 samples and got %d verdicts: one verdict per release, made at the 200th", len(r1))
	ctx.Assert(r1[0]["samples"] == float64(200) && r1[0]["verdict"] == "pass", "r1's verdict is made on 200 samples, all grounded: %v", r1[0])
}

func CheckReleaseThresholds(ctx *harness.Ctx) {
	ctx.Redis.Do("HSET", "rag:eval:baseline", "release", "r0", "groundedness", "0.98")
	evalSeed(ctx, "r1", 200, 4, 0.85) // groundedness 0.98, recall 0.85
	evalSeed(ctx, "r2", 200, 8, 0.95) // groundedness 0.96: 0.02 under the baseline
	evalSeed(ctx, "r3", 200, 2, 0.95) // groundedness 0.99
	evalRun(ctx)
	final := map[string]string{}
	for _, v := range evalVerdicts(ctx) {
		if v["samples"] == float64(200) {
			final[fmt.Sprint(v["release"])] = fmt.Sprint(v["verdict"])
		}
	}
	ctx.Equal(len(final), 3, "each release gets a verdict at 200 samples (%v); releases judged", final)
	ctx.Equal(final["r1"], "block", "r1's recall@k is 0.85, under 0.90: its verdict")
	ctx.Equal(final["r2"], "block", "r2's groundedness 0.96 is 0.02 under the last release that passed (0.98), a regression over 0.01: its verdict")
	ctx.Equal(final["r3"], "pass", "r3 clears every bar (0.99, 0.95): its verdict")
	release, _ := ctx.Redis.HGet("rag:eval:baseline", "release")
	ctx.Equal(release, "r3", "a release that passes becomes the baseline")
}

func CheckNoRawText(ctx *harness.Ctx) {
	evalSeed(ctx, "r1", 200, 0, 0.95)
	evalRun(ctx)
	values := ctx.Kafka.Values(evalMetrics)
	ctx.Assert(len(values) > 0, "200 samples published no verdict")
	for _, value := range values {
		ctx.Assert(!strings.Contains(value, "refund window"), "a verdict carries question text: %.160s; eval.metrics is an analytics topic, ids and aggregates only", value)
		var e map[string]any
		json.Unmarshal([]byte(value), &e)
		_, has := e["question"]
		ctx.Assert(!has, "a verdict has a question field: %.160s", value)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const std::string kSamples = "eval.samples";
const std::string kMetrics = "eval.metrics";

void evalSeed(harness::Ctx& ctx, const std::string& release, int n, int ungrounded = 0, double recall = 0.95) {
  for (int i = 0; i < n; i++) {
    char id[32];
    std::snprintf(id, sizeof id, "%s-%03d", release.c_str(), i);
    const json sample = {{"release", release},
                         {"sample_id", id},
                         {"grounded", i >= ungrounded},
                         {"recall_at_k", recall},
                         {"should_refuse", i % 10 == 0},
                         {"refused", i % 10 == 0},
                         {"question", "What is the refund window for order " + std::to_string(i) + "?"}};
    ctx.Kafka.Seed(kSamples, release, sample);
  }
}

void evalRun(harness::Ctx& ctx) { ctx.Drain([] { run(); }); }

std::vector<json> evalVerdicts(harness::Ctx& ctx) {
  std::vector<json> out;
  for (const auto& v : ctx.Kafka.Values(kMetrics)) out.push_back(json::parse(v, nullptr, false));
  return out;
}

long long evalCount(harness::Ctx& ctx, const std::string& release) {
  const auto raw = ctx.Redis.HGet("rag:eval:" + release, "samples");
  return raw ? std::stoll(*raw) : 0;
}

}  // namespace

void CheckConsumerGroup(harness::Ctx& ctx) {
  evalSeed(ctx, "r1", 3);
  evalRun(ctx);
  const auto subs = ctx.Kafka.EventsOf("subscribe");
  ctx.Assert(!subs.empty(), "the gate never subscribed to a topic");
  const auto& last = subs.back();
  ctx.Equal(last.Group, "rag-eval", "the gate's group (rag-eval owns this stream's offsets and the dashboards read it; another id starts counting from scratch)");
  ctx.Assert(std::find(last.Topics.begin(), last.Topics.end(), kSamples) != last.Topics.end(), "the gate must subscribe to %s, got %v", kSamples, last.Topics);
  ctx.Equal(ctx.Kafka.Lag("rag-eval", kSamples), 0, "samples left uncommitted in rag-eval");
  ctx.Equal(evalCount(ctx, "r1"), 3, "three samples consumed; rag:eval:r1 counts");
}

void CheckCommitAfterStore(harness::Ctx& ctx) {
  evalSeed(ctx, "r1", 5);
  std::vector<std::pair<long long, long long>> seen;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) {
    long long committed = 0;
    for (const auto& [tp, offset] : offsets)
      if (tp.Topic == kSamples) committed += offset;
    seen.push_back({committed, evalCount(ctx, "r1")});
  });
  evalRun(ctx);
  ctx.Assert(!seen.empty(), "no offset was ever committed");
  for (const auto& [committed, counted] : seen)
    ctx.Assert(committed <= counted, "an offset covering %d samples was committed while rag:eval:r1 counted %d: a crash right then loses the samples in between; commit after evalstore::record", committed, counted);
}

void CheckMinSamples(harness::Ctx& ctx) {
  evalSeed(ctx, "r1", 205);
  evalSeed(ctx, "r2", 150);
  evalRun(ctx);
  std::vector<json> r1, r2;
  for (const auto& v : evalVerdicts(ctx)) {
    if (v.value("release", "") == "r1") r1.push_back(v);
    if (v.value("release", "") == "r2") r2.push_back(v);
  }
  ctx.Assert(r2.empty(), "r2 has 150 samples and got %d verdicts: a release is judged at kMinSamples = 200, not on a handful", r2.size());
  ctx.Assert(r1.size() == 1, "r1 has 205 samples and got %d verdicts: one verdict per release, made at the 200th", r1.size());
  ctx.Assert(r1[0].value("samples", 0) == 200 && r1[0].value("verdict", "") == "pass", "r1's verdict is made on 200 samples, all grounded: %v", r1[0]);
}

void CheckReleaseThresholds(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", "rag:eval:baseline", "release", "r0", "groundedness", "0.98");
  evalSeed(ctx, "r1", 200, 4, 0.85);  // groundedness 0.98, recall 0.85
  evalSeed(ctx, "r2", 200, 8, 0.95);  // groundedness 0.96: 0.02 under the baseline
  evalSeed(ctx, "r3", 200, 2, 0.95);  // groundedness 0.99
  evalRun(ctx);
  std::map<std::string, std::string> final;
  for (const auto& v : evalVerdicts(ctx))
    if (v.value("samples", 0) == 200) final[v.value("release", "")] = v.value("verdict", "");
  ctx.Equal(final.size(), 3, "each release gets a verdict at 200 samples (%v); releases judged", final);
  ctx.Equal(final["r1"], "block", "r1's recall@k is 0.85, under 0.90: its verdict");
  ctx.Equal(final["r2"], "block", "r2's groundedness 0.96 is 0.02 under the last release that passed (0.98), a regression over 0.01: its verdict");
  ctx.Equal(final["r3"], "pass", "r3 clears every bar (0.99, 0.95): its verdict");
  ctx.Equal(ctx.Redis.HGet("rag:eval:baseline", "release").value_or(""), "r3", "a release that passes becomes the baseline");
}

void CheckNoRawText(harness::Ctx& ctx) {
  evalSeed(ctx, "r1", 200);
  evalRun(ctx);
  const auto values = ctx.Kafka.Values(kMetrics);
  ctx.Assert(!values.empty(), "200 samples published no verdict");
  for (const auto& value : values) {
    ctx.Assert(value.find("refund window") == std::string::npos, "a verdict carries question text: %s; eval.metrics is an analytics topic, ids and aggregates only", value.substr(0, 160));
    const json e = json::parse(value, nullptr, false);
    ctx.Assert(!e.is_object() || !e.contains("question"), "a verdict has a question field: %s", value.substr(0, 160));
  }
}
`,
  },
  hints: [
    "Symptom: the release dashboard shows a verdict after the first answer of a run, a release with poor recall ships, a restart loses a few samples from the count, and analysts can read users' questions in eval.metrics.",
    'Mechanism: the group id was renamed to `rag-eval-v2`; `consumer.commit` runs before `handle`; `handle` publishes after every record; the verdict looks at groundedness alone; the event copies `sample["question"]`.',
    'Change: `GROUP = "rag-eval"`; `handle(sample)` then `consumer.commit(message=msg, asynchronous=False)`; return unless `evalstore.record(sample) == MIN_SAMPLES`; block on `MIN_RECALL` and on `baseline - groundedness > MAX_REGRESSION`; drop `question`.',
  ],
  debrief: `The gate's correctness is a counting problem. The group id is its identity: committed offsets and the progress dashboards hang on it, so renaming it restarts the count somewhere nobody looks. The commit follows the count because a committed offset promises the record is accounted for; the Lua script that counts by sample_id makes the redelivery this ordering implies harmless. A verdict is a statistical claim, so it waits for 200 samples, and it compares against the last release that passed because a release can clear the floor and still be worse than what is live. Production gates use confidence intervals instead of fixed floors, slice the metrics by tenant and question type, and keep transcripts in a store with its own access rules.`,
};
