import type {Step} from '@/lib/types';

export const evalGateStep: Step = {
  id: 'eval-gate',
  title: 'Eval gate: block a release on evidence',
  concept: 'kafka',
  file: 'eval_gate',
  focus: ['events', 'eval', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it compiles and passes the
happy path, so a quick demo makes it look done. Review it like the service owner. Find the subtle
flaw, fix it, and prove the fix with the checks below.

Consume \`answer.events\` in consumer group **\`rag-eval\`**. Each event carries answer metadata and
golden labels, never the raw question or answer text:
\`{answer_id, prompt_version, model_version, grounded, has_citation, recall_at_k, refused, should_refuse}\`.

- Compute **groundedness** (fraction of answers with a supported citation), **recall@k** (mean of
  the per-sample labels) and **refusal correctness** (fraction of refusals that should have been
  refusals).
- Require at least **200 samples** before a metric can gate anything. One passing example is a demo,
  not an eval.
- Block the \`prompt_version\`/\`model_version\` when groundedness is below **0.95**, recall@k is
  below **0.90**, or groundedness drops by more than **1%** versus the previous release.
- Store the metrics **before** committing the consumer offset. A crash after commit but before the
  store loses the evidence for the answers already acknowledged.
- Publish \`eval.metrics\` with aggregate counts and verdicts only. No raw question, answer text,
  email or other PII.

**Failure mode the checks target.** The draft gates on one event, lets auto-commit acknowledge it
before the metrics are durable, and copies the raw question into the metrics topic. A single lucky
answer can therefore "approve" a release, and the audit trail leaks user content.

:::widget delivery-semantics {}

> The offset is the acknowledgement. Store the derived metrics first, then commit: replay is
> cheap; a lost eval window is not.`,
  sequence: {
    participants: ['answer.events', 'Eval consumer', 'eval_metrics'],
    messages: [
      {from: 'answer.events', to: 'Eval consumer', label: 'answer metadata + golden labels', kind: 'async'},
      {from: 'Eval consumer', to: 'Eval consumer', label: 'buffer ≥ 200 samples', kind: 'sync'},
      {from: 'Eval consumer', to: 'Eval consumer', label: 'groundedness · recall@k · refusal', kind: 'sync'},
      {from: 'Eval consumer', to: 'Eval consumer', label: 'compare 0.95 / 0.90 / 1% regression', kind: 'sync'},
      {from: 'Eval consumer', to: 'eval_metrics', label: 'store metrics + release verdict', kind: 'sync'},
      {from: 'Eval consumer', to: 'answer.events', label: 'publish eval.metrics (aggregates)', kind: 'async'},
      {from: 'Eval consumer', to: 'answer.events', label: 'commit offset after store', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'consumer-group',
      title: 'Consumes answer.events in group rag-eval',
      detail:
        'The dedicated `rag-eval` group owns this evaluation stream. Another group id splits the offsets and silently under-counts samples.',
      match: {
        python: {all: [/(group\.id|groupID|GroupId|kGroup|GROUP)/, /["']rag-eval["']/]},
        typescript: {all: [/(group\.id|groupId|GroupId|kGroup|\bGROUP\b)/, /["']rag-eval["']/]},
        go: {all: [/(group\.id|groupID|GroupId|kGroup|GROUP)/, /["']rag-eval["']/]},
        scala: {all: [/(group\.id|groupID|GroupId|kGroup|GROUP)/, /["']rag-eval["']/]},
        cpp: {all: [/(group\.id|groupID|GroupId|kGroup|GROUP)/, /["']rag-eval["']/]},
      },
    },
    {
      id: 'metrics',
      title: 'Computes groundedness, recall@k and refusal correctness',
      detail:
        'Derive all three metrics from the golden labels: supported citations / samples, mean `recall_at_k`, and correct refusals / refusals. A single boolean is not an eval.',
      match: {
        python: {all: [/(groundedness|Groundedness)/, /(recall|Recall)/, /(refusal|Refusal)/]},
        typescript: {all: [/(groundedness|Groundedness)/, /(recall|Recall)/, /(refusal|Refusal)/]},
        go: {all: [/(groundedness|Groundedness)/, /(recall|Recall)/, /(refusal|Refusal)/]},
        scala: {all: [/(groundedness|Groundedness)/, /(recall|Recall)/, /(refusal|Refusal)/]},
        cpp: {all: [/(groundedness|Groundedness)/, /(recall|Recall)/, /(refusal|Refusal)/]},
      },
    },
    {
      id: 'sample-and-thresholds',
      title: 'Requires 200 samples and enforces the release thresholds',
      detail:
        'Gate only after 200 samples; block below groundedness 0.95, below recall@k 0.90, or on a more-than-1% groundedness regression. One green sample must not ship a prompt.',
      match: {
        python: {
          all: [
            /(MIN_SAMPLES|minSamples|MinSamples|kMinSamples|\b200\b)/,
            /(0\.95|95)/,
            /(0\.90|90)/,
            /(0\.01|1\s*%|1\.01)/,
          ],
        },
        typescript: {
          all: [
            /(MIN_SAMPLES|minSamples|MinSamples|kMinSamples|\b200\b)/,
            /(0\.95|95)/,
            /(0\.90|90)/,
            /(0\.01|1\s*%|1\.01)/,
          ],
        },
        go: {
          all: [
            /(MIN_SAMPLES|minSamples|MinSamples|kMinSamples|\b200\b)/,
            /(0\.95|95)/,
            /(0\.90|90)/,
            /(0\.01|1\s*%|1\.01)/,
          ],
        },
        scala: {
          all: [
            /(MIN_SAMPLES|minSamples|MinSamples|kMinSamples|\b200\b)/,
            /(0\.95|95)/,
            /(0\.90|90)/,
            /(0\.01|1\s*%|1\.01)/,
          ],
        },
        cpp: {
          all: [
            /(MIN_SAMPLES|minSamples|MinSamples|kMinSamples|\b200\b)/,
            /(0\.95|95)/,
            /(0\.90|90)/,
            /(0\.01|1\s*%|1\.01)/,
          ],
        },
      },
    },
    {
      id: 'commit-after-store',
      title: 'Stores metrics before committing the offset',
      detail:
        'The offset commit comes after the metrics write. Committing first means a crash loses the evaluation that justified the acknowledged answers.',
      match: {
        python: {
          order: [
            /(store\.put|store\.save|metrics\.put|writeMetrics|INSERT INTO)/,
            /(consumer\.commit|commitSync|commitAsync|CommitSync|CommitMessages|Commit\()/,
          ],
        },
        typescript: {
          order: [
            /(store\.put|store\.save|metrics\.put|writeMetrics|INSERT INTO)/,
            /(consumer\.commit|commitSync|commitAsync|CommitSync|CommitMessages|Commit\()/,
          ],
        },
        go: {
          order: [
            /(store\.put|store\.save|metrics\.put|writeMetrics|INSERT INTO)/i,
            /(consumer\.commit|commitSync|commitAsync|CommitSync|CommitMessages|Commit\()/,
          ],
        },
        scala: {
          order: [
            /(store\.put|store\.save|metrics\.put|writeMetrics|INSERT INTO)/,
            /(consumer\.commit|commitSync|commitAsync|CommitSync|CommitMessages|Commit\()/,
          ],
        },
        cpp: {
          order: [
            /(store\.put|store\.save|metrics\.put|writeMetrics|INSERT INTO)/,
            /(consumer->commit|commitSync|commitAsync|CommitSync|CommitMessages)/,
          ],
        },
      },
    },
    {
      id: 'no-raw-pii',
      title: 'Keeps raw question and answer text out of eval.metrics',
      detail:
        'Metrics events carry ids, aggregates and verdicts only. The draft copies `question` into the payload, which puts user content in an analytics topic with different retention and access rules.',
      match: {
        python: {none: [/"question"|question_text|raw_answer|user_email|email/i]},
        typescript: {
          none: [/"question"|question_text|raw_answer|user_email|\bemail\b|\bquestion\s*:/i],
        },
        go: {none: [/"question"|question_text|raw_answer|user_email|email/i]},
        scala: {none: [/"question"|question_text|raw_answer|user_email|email/i]},
        cpp: {none: [/"question"|question_text|raw_answer|user_email|email/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer

from rag.metrics import MetricsStore

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "rag-eval-v2",
        "enable.auto.commit": True,
    }
)
producer = Producer({"bootstrap.servers": "kafka:9092"})
store = MetricsStore()


def main() -> None:
    consumer.subscribe(["answer.events"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        # TODO: one sample is not an eval, auto-commit can acknowledge a sample before its
        # metrics are stored, and the raw question is copied into eval.metrics.
        if event["grounded"] < 0.95:
            record = {
                "prompt_version": event["prompt_version"],
                "model_version": event["model_version"],
                "groundedness": event["grounded"],
                "question": event["question"],
                "blocked": True,
            }
            store.put(record)
            producer.produce("eval.metrics", json.dumps(record).encode("utf-8"))


if __name__ == "__main__":
    main()
`,
      solution: `import json
from dataclasses import dataclass

from confluent_kafka import Consumer, Producer

from rag.metrics import MetricsStore

GROUP = "rag-eval"
MIN_SAMPLES = 200
GROUNDEDNESS_MIN = 0.95
RECALL_MIN = 0.90
MAX_REGRESSION = 0.01

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "enable.auto.commit": False,
    }
)
producer = Producer({"bootstrap.servers": "kafka:9092"})
store = MetricsStore()


@dataclass
class Sample:
    grounded: bool
    has_citation: bool
    recall_at_k: float
    refused: bool
    should_refuse: bool


def compute(samples: list[Sample]) -> dict:
    total = len(samples)
    supported = sum(1 for sample in samples if sample.grounded and sample.has_citation)
    recall = sum(sample.recall_at_k for sample in samples) / total
    refusals = [sample for sample in samples if sample.refused]
    refusal_correctness = (
        sum(1 for sample in refusals if sample.should_refuse) / len(refusals) if refusals else 1.0
    )
    return {
        "samples": total,
        "groundedness": supported / total,
        "recall_at_k": recall,
        "refusal_correctness": refusal_correctness,
    }


def gate(current: dict, previous: dict | None) -> tuple[bool, list[str]]:
    reasons = []
    if current["groundedness"] < GROUNDEDNESS_MIN:
        reasons.append("groundedness")
    if current["recall_at_k"] < RECALL_MIN:
        reasons.append("recall_at_k")
    if previous is not None and previous["groundedness"] - current["groundedness"] > MAX_REGRESSION:
        reasons.append("groundedness_regression")
    return (len(reasons) == 0, reasons)


def main() -> None:
    consumer.subscribe(["answer.events"])
    samples: list[Sample] = []
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        samples.append(
            Sample(
                grounded=event["grounded"],
                has_citation=event["has_citation"],
                recall_at_k=event["recall_at_k"],
                refused=event["refused"],
                should_refuse=event["should_refuse"],
            )
        )
        if len(samples) < MIN_SAMPLES:
            continue

        window = samples
        samples = []
        current = compute(window)
        previous = store.latest(event["prompt_version"], event["model_version"])
        release_allowed, reasons = gate(current, previous)
        record = {
            **current,
            "prompt_version": event["prompt_version"],
            "model_version": event["model_version"],
            "release_allowed": release_allowed,
            "blocked_by": reasons,
        }
        store.put(record)
        producer.produce("eval.metrics", json.dumps(record).encode("utf-8"))
        producer.flush()
        consumer.commit(asynchronous=False)


if __name__ == "__main__":
    main()
`,
    },
    typescript: {
      starter: `/** answer.events consumer: a model-generated eval that treats one event as a verdict. */
import {Kafka} from 'kafkajs';

import {MetricsStore} from './metrics';

const kafka = new Kafka({clientId: 'rag-eval-draft', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'rag-eval-v2'});
const producer = kafka.producer();
const store = new MetricsStore();

interface AnswerEvent {
  prompt_version: string;
  model_version: string;
  grounded: number;
  has_citation: boolean;
  recall_at_k: number;
  refused: boolean;
  should_refuse: boolean;
  question: string;
}

async function main(): Promise<void> {
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({topic: 'answer.events'});
  await consumer.run({
    autoCommit: true,
    eachMessage: async ({message}) => {
      const event = JSON.parse(message.value!.toString()) as AnswerEvent;
      // TODO: one sample is not an eval, auto-commit can acknowledge a sample before its
      // metrics are stored, and the raw question is copied into eval.metrics.
      if (event.grounded < 0.95) {
        const record = {
          prompt_version: event.prompt_version,
          model_version: event.model_version,
          groundedness: event.grounded,
          question: event.question,
          blocked: true,
        };
        await store.put(record);
        await producer.send({topic: 'eval.metrics', messages: [{value: JSON.stringify(record)}]});
      }
    },
  });
}

void main();
`,
      solution: `/** answer.events consumer: a windowed eval gate that stores evidence before committing offsets. */
import {Kafka} from 'kafkajs';

import {MetricsStore} from './metrics';

const GROUP = 'rag-eval';
const MIN_SAMPLES = 200;
const GROUNDEDNESS_MIN = 0.95;
const RECALL_MIN = 0.90;
const MAX_REGRESSION = 0.01;

const kafka = new Kafka({clientId: 'rag-eval', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});
const producer = kafka.producer();
const store = new MetricsStore();

interface AnswerEvent {
  prompt_version: string;
  model_version: string;
  grounded: boolean;
  has_citation: boolean;
  recall_at_k: number;
  refused: boolean;
  should_refuse: boolean;
}

interface Sample {
  grounded: boolean;
  has_citation: boolean;
  recall_at_k: number;
  refused: boolean;
  should_refuse: boolean;
}

interface Metrics {
  samples: number;
  groundedness: number;
  recall_at_k: number;
  refusal_correctness: number;
}

function compute(samples: Sample[]): Metrics {
  const total = samples.length;
  const supported = samples.filter(sample => sample.grounded && sample.has_citation).length;
  const recall = samples.reduce((sum, sample) => sum + sample.recall_at_k, 0) / total;
  const refusals = samples.filter(sample => sample.refused);
  const refusalCorrectness =
    refusals.length === 0 ? 1 : refusals.filter(sample => sample.should_refuse).length / refusals.length;
  return {
    samples: total,
    groundedness: supported / total,
    recall_at_k: recall,
    refusal_correctness: refusalCorrectness,
  };
}

function gate(current: Metrics, previous: Metrics | null): string[] {
  const reasons: string[] = [];
  if (current.groundedness < GROUNDEDNESS_MIN) reasons.push('groundedness');
  if (current.recall_at_k < RECALL_MIN) reasons.push('recall_at_k');
  if (previous !== null && previous.groundedness - current.groundedness > MAX_REGRESSION)
    reasons.push('groundedness_regression');
  return reasons;
}

async function main(): Promise<void> {
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({topic: 'answer.events'});
  let samples: Sample[] = [];
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value!.toString()) as AnswerEvent;
      samples.push({
        grounded: event.grounded,
        has_citation: event.has_citation,
        recall_at_k: event.recall_at_k,
        refused: event.refused,
        should_refuse: event.should_refuse,
      });
      if (samples.length < MIN_SAMPLES) return;

      const window = samples;
      samples = [];
      const current = compute(window);
      const previous = await store.latest(event.prompt_version, event.model_version);
      const blocked_by = gate(current, previous);
      const record = {
        ...current,
        prompt_version: event.prompt_version,
        model_version: event.model_version,
        release_allowed: blocked_by.length === 0,
        blocked_by,
      };
      await store.put(record);
      await producer.send({topic: 'eval.metrics', messages: [{value: JSON.stringify(record)}]});
      await consumer.commitOffsets([
        {topic, partition, offset: (Number(message.offset) + 1).toString()},
      ]);
    },
  });
}

void main();
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
	"rag/metrics"
)

var store = metrics.NewStore()

func main() {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		GroupID: "rag-eval-v2",
		Topic:   "answer.events",
	})
	writer := &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "eval.metrics"}
	for {
		msg, err := reader.FetchMessage(context.Background())
		if err != nil {
			log.Fatal(err)
		}
		var event map[string]any
		json.Unmarshal(msg.Value, &event)
		// TODO: one sample is not an eval, the offset is committed before metrics are durable,
		// and the raw question is copied into eval.metrics.
		if event["grounded"].(float64) < 0.95 {
			record := map[string]any{
				"prompt_version": event["prompt_version"],
				"model_version":  event["model_version"],
				"groundedness":   event["grounded"],
				"question":       event["question"],
				"blocked":        true,
			}
			payload, _ := json.Marshal(record)
			reader.CommitMessages(context.Background(), msg)
			store.Put(record)
			writer.WriteMessages(context.Background(), kafka.Message{Value: payload})
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
	"rag/metrics"
)

const (
	groupID         = "rag-eval"
	minSamples      = 200
	groundednessMin = 0.95
	recallMin       = 0.90
	maxRegression   = 0.01
)

var store = metrics.NewStore()

type Sample struct {
	Grounded     bool
	HasCitation  bool
	RecallAtK    float64
	Refused      bool
	ShouldRefuse bool
}

type WindowMetrics struct {
	Samples            int
	Groundedness       float64
	RecallAtK          float64
	RefusalCorrectness float64
}

func compute(samples []Sample) WindowMetrics {
	total := float64(len(samples))
	supported := 0
	recall := 0.0
	refusals := 0
	correctRefusals := 0
	for _, sample := range samples {
		if sample.Grounded && sample.HasCitation {
			supported++
		}
		recall += sample.RecallAtK
		if sample.Refused {
			refusals++
			if sample.ShouldRefuse {
				correctRefusals++
			}
		}
	}
	refusalCorrectness := 1.0
	if refusals > 0 {
		refusalCorrectness = float64(correctRefusals) / float64(refusals)
	}
	return WindowMetrics{
		Samples:            len(samples),
		Groundedness:       float64(supported) / total,
		RecallAtK:          recall / total,
		RefusalCorrectness: refusalCorrectness,
	}
}

func gate(current WindowMetrics, previous *metrics.Record) (bool, []string) {
	var reasons []string
	if current.Groundedness < groundednessMin {
		reasons = append(reasons, "groundedness")
	}
	if current.RecallAtK < recallMin {
		reasons = append(reasons, "recall_at_k")
	}
	if previous != nil && previous.Groundedness-current.Groundedness > maxRegression {
		reasons = append(reasons, "groundedness_regression")
	}
	return len(reasons) == 0, reasons
}

func main() {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		GroupID: groupID,
		Topic:   "answer.events",
	})
	writer := &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "eval.metrics"}
	ctx := context.Background()
	var samples []Sample
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			log.Fatal(err)
		}
		var event struct {
			PromptVersion string  \`json:"prompt_version"\`
			ModelVersion  string  \`json:"model_version"\`
			Grounded      bool    \`json:"grounded"\`
			HasCitation   bool    \`json:"has_citation"\`
			RecallAtK     float64 \`json:"recall_at_k"\`
			Refused       bool    \`json:"refused"\`
			ShouldRefuse  bool    \`json:"should_refuse"\`
		}
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		samples = append(samples, Sample{
			Grounded:     event.Grounded,
			HasCitation:  event.HasCitation,
			RecallAtK:    event.RecallAtK,
			Refused:      event.Refused,
			ShouldRefuse: event.ShouldRefuse,
		})
		if len(samples) < minSamples {
			continue
		}

		window := samples
		samples = nil
		current := compute(window)
		previous, _ := store.Latest(event.PromptVersion, event.ModelVersion)
		releaseAllowed, reasons := gate(current, previous)
		record := metrics.Record{
			Samples:            current.Samples,
			Groundedness:       current.Groundedness,
			RecallAtK:          current.RecallAtK,
			RefusalCorrectness: current.RefusalCorrectness,
			PromptVersion:      event.PromptVersion,
			ModelVersion:       event.ModelVersion,
			ReleaseAllowed:     releaseAllowed,
			BlockedBy:          reasons,
		}
		if err := store.Put(record); err != nil {
			log.Printf("eval-gate: metrics store failed: %v", err)
			continue
		}
		payload, _ := json.Marshal(record)
		if err := writer.WriteMessages(ctx, kafka.Message{Value: payload}); err != nil {
			log.Printf("eval-gate: publish failed: %v", err)
			continue
		}
		reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Collections
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object EvalGate {
  val props = new Properties()
  props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ConsumerConfig.GROUP_ID_CONFIG, "rag-eval-v2")
  props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "true")
  val consumer = new KafkaConsumer[String, String](props)
  val producer = new KafkaProducer[String, String](KafkaConfig.producer())
  val store = MetricsStore.open()

  def main(args: Array[String]): Unit = {
    consumer.subscribe(Collections.singletonList("answer.events"))
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.forEach { record =>
        val event = parse(record.value())
        // TODO: one sample is not an eval, auto-commit acknowledges before metrics are durable,
        // and the raw question is copied into eval.metrics.
        if (event.grounded < 0.95) {
          val metrics = Map(
            "prompt_version" -> event.promptVersion,
            "model_version" -> event.modelVersion,
            "groundedness" -> event.grounded,
            "question" -> event.question,
            "blocked" -> true,
          )
          store.put(metrics)
          producer.send(new ProducerRecord("eval.metrics", metrics.toString))
        }
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Collections
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object EvalGate {
  val GroupId = "rag-eval"
  val MinSamples = 200
  val GroundednessMin = 0.95
  val RecallMin = 0.90
  val MaxRegression = 0.01

  val props = new Properties()
  props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ConsumerConfig.GROUP_ID_CONFIG, GroupId)
  props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
  val consumer = new KafkaConsumer[String, String](props)
  val producer = new KafkaProducer[String, String](KafkaConfig.producer())
  val store = MetricsStore.open()

  case class Sample(grounded: Boolean, hasCitation: Boolean, recallAtK: Double, refused: Boolean, shouldRefuse: Boolean)
  case class Metrics(samples: Int, groundedness: Double, recallAtK: Double, refusalCorrectness: Double)

  def compute(window: Seq[Sample]): Metrics = {
    val total = window.size
    val supported = window.count(sample => sample.grounded && sample.hasCitation)
    val recall = window.map(_.recallAtK).sum / total
    val refusals = window.filter(_.refused)
    val refusalCorrectness =
      if (refusals.isEmpty) 1.0 else refusals.count(_.shouldRefuse).toDouble / refusals.size
    Metrics(total, supported.toDouble / total, recall, refusalCorrectness)
  }

  def gate(current: Metrics, previous: Option[Metrics]): (Boolean, Seq[String]) = {
    val reasons = Seq.newBuilder[String]
    if (current.groundedness < GroundednessMin) reasons += "groundedness"
    if (current.recallAtK < RecallMin) reasons += "recall_at_k"
    if (previous.exists(prev => prev.groundedness - current.groundedness > MaxRegression)) {
      reasons += "groundedness_regression"
    }
    val all = reasons.result()
    (all.isEmpty, all)
  }

  def main(args: Array[String]): Unit = {
    consumer.subscribe(Collections.singletonList("answer.events"))
    var samples = Vector.empty[Sample]
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      val it = records.iterator()
      while (it.hasNext) {
        val record = it.next()
        val event = parse(record.value())
        samples = samples :+ Sample(
          grounded = event.grounded,
          hasCitation = event.hasCitation,
          recallAtK = event.recallAtK,
          refused = event.refused,
          shouldRefuse = event.shouldRefuse,
        )
        if (samples.size >= MinSamples) {
          val window = samples
          samples = Vector.empty
          val current = compute(window)
          val previous = store.latest(event.promptVersion, event.modelVersion)
          val (releaseAllowed, reasons) = gate(current, previous)
          val recordOut = Map(
            "samples" -> current.samples,
            "groundedness" -> current.groundedness,
            "recall_at_k" -> current.recallAtK,
            "refusal_correctness" -> current.refusalCorrectness,
            "prompt_version" -> event.promptVersion,
            "model_version" -> event.modelVersion,
            "release_allowed" -> releaseAllowed,
            "blocked_by" -> reasons.mkString(","),
          )
          store.put(recordOut)
          producer.send(new ProducerRecord("eval.metrics", recordOut.toString))
          producer.flush()
          consumer.commitSync()
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <string>

#include "metrics_store.h"

using json = nlohmann::json;

int main() {
  std::string errstr;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("group.id", "rag-eval-v2", errstr);
  conf->set("enable.auto.commit", "true", errstr);
  auto* consumer = RdKafka::KafkaConsumer::create(conf, errstr);
  auto* producer = RdKafka::Producer::create(conf, errstr);
  auto store = MetricsStore::open();
  consumer->subscribe({"answer.events"});

  while (true) {
    auto* msg = consumer->consume(1000);
    if (msg->err() == RdKafka::ERR_NO_ERROR) {
      const auto event = json::parse(static_cast<const char*>(msg->payload()));
      // TODO: one sample is not an eval, auto-commit acknowledges before metrics are durable,
      // and the raw question is copied into eval.metrics.
      if (event.value("grounded", 0.0) < 0.95) {
        const auto record = json{
            {"prompt_version", event["prompt_version"]},
            {"model_version", event["model_version"]},
            {"groundedness", event["grounded"]},
            {"question", event["question"]},
            {"blocked", true},
        }.dump();
        consumer->commitSync(msg);
        store.put(record);
        producer->produce("eval.metrics", RdKafka::Producer::RK_MSG_COPY,
                          const_cast<char*>(record.c_str()), record.size(), nullptr, 0, 0, nullptr);
      }
    }
    delete msg;
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

#include "metrics_store.h"

using json = nlohmann::json;

constexpr const char* kGroup = "rag-eval";
constexpr int kMinSamples = 200;
constexpr double kGroundednessMin = 0.95;
constexpr double kRecallMin = 0.90;
constexpr double kMaxRegression = 0.01;

struct Sample {
  bool grounded;
  bool hasCitation;
  double recallAtK;
  bool refused;
  bool shouldRefuse;
};

struct Metrics {
  int samples;
  double groundedness;
  double recallAtK;
  double refusalCorrectness;
};

Metrics compute(const std::vector<Sample>& window) {
  const auto total = static_cast<double>(window.size());
  int supported = 0;
  int refusals = 0;
  int correctRefusals = 0;
  double recall = 0.0;
  for (const auto& sample : window) {
    if (sample.grounded && sample.hasCitation) ++supported;
    recall += sample.recallAtK;
    if (sample.refused) {
      ++refusals;
      if (sample.shouldRefuse) ++correctRefusals;
    }
  }
  const double refusalCorrectness =
      refusals == 0 ? 1.0 : static_cast<double>(correctRefusals) / static_cast<double>(refusals);
  return Metrics{static_cast<int>(window.size()), supported / total, recall / total, refusalCorrectness};
}

bool gate(const Metrics& current, const std::optional<Metrics>& previous, std::vector<std::string>& reasons) {
  if (current.groundedness < kGroundednessMin) reasons.push_back("groundedness");
  if (current.recallAtK < kRecallMin) reasons.push_back("recall_at_k");
  if (previous && previous->groundedness - current.groundedness > kMaxRegression) {
    reasons.push_back("groundedness_regression");
  }
  return reasons.empty();
}

int main() {
  std::string errstr;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("group.id", kGroup, errstr);
  conf->set("enable.auto.commit", "false", errstr);
  auto* consumer = RdKafka::KafkaConsumer::create(conf, errstr);
  auto* producer = RdKafka::Producer::create(conf, errstr);
  auto store = MetricsStore::open();
  consumer->subscribe({"answer.events"});

  std::vector<Sample> samples;
  while (true) {
    auto* msg = consumer->consume(1000);
    if (msg->err() == RdKafka::ERR_NO_ERROR) {
      const auto event = json::parse(static_cast<const char*>(msg->payload()));
      samples.push_back(Sample{
          event.value("grounded", false),
          event.value("has_citation", false),
          event.value("recall_at_k", 0.0),
          event.value("refused", false),
          event.value("should_refuse", false),
      });
      if (static_cast<int>(samples.size()) >= kMinSamples) {
        const auto window = samples;
        samples.clear();
        const auto current = compute(window);
        const auto previous = store.latest(event["prompt_version"], event["model_version"]);
        std::vector<std::string> reasons;
        const bool releaseAllowed = gate(current, previous, reasons);
        const auto record = json{
            {"samples", current.samples},
            {"groundedness", current.groundedness},
            {"recall_at_k", current.recallAtK},
            {"refusal_correctness", current.refusalCorrectness},
            {"prompt_version", event["prompt_version"]},
            {"model_version", event["model_version"]},
            {"release_allowed", releaseAllowed},
            {"blocked_by", reasons},
        }.dump();
        store.put(record);
        producer->produce("eval.metrics", RdKafka::Producer::RK_MSG_COPY,
                          const_cast<char*>(record.c_str()), record.size(), nullptr, 0, 0, nullptr);
        consumer->commitSync(msg);
      }
    }
    delete msg;
  }
}
`,
    },
  },
  hints: [
    'Disable auto-commit and buffer samples. Only when the buffer reaches `MIN_SAMPLES` do you compute a window, and only after the window is stored do you call `commit`.',
    'Groundedness is not “the model said grounded”: require both `grounded` and `has_citation` from the joined golden record. Keep recall as the mean of `recall_at_k` over the window.',
    'Read the previous release’s groundedness before deciding. A metric at 0.96 can still be a regression if the last release was 0.99; the 1% rule catches that.',
  ],
  debrief: `The interviewer learns whether you can turn a product claim into a release contract. The starter is the classic generated eval: it treats one event as a result, lets Kafka acknowledge before the verdict is durable, and leaks the raw question into an analytics topic. The corrected version is a windowed job with a minimum sample size, three metrics that are computed rather than asserted, a comparison against the previous release, and an evidence-before-acknowledgement commit order. Thresholds are policy, so they live as named constants and the blocked reasons are emitted with the metrics for audit. Real eval systems add stratified slices (tenant, language, document type), confidence intervals so a 200-sample window is not treated as exact, offline golden-set refresh, and a human review step before a blocked prompt is rewritten.`,
};
