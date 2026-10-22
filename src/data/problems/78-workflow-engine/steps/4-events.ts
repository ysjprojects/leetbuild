import type {Step} from '@/lib/types';

/**
 * Step 4 — the run-keyed step event. One `workflow.step` record per transition, keyed by the run id
 * so one run's history stays in order on one partition, carrying the step name, the effect id and
 * the outcome and never the step's document, with an outbox row written before the produce.
 */
export const eventsStep: Step = {
  id: 'events',
  title: 'Step events keyed by run id for audit',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'kafka', 'audit'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: every transition publishes a
\`workflow.step\` event and the audit consumer appends it to the run's history, so the demo shows a
run's story from start to finish. It compiles, it produces, and it hides five production flaws.
Review it like the worker's owner, fix it, and prove the fix with the checks below.

\`publish_step(run_id, step, effect_id, outcome)\` — \`publishStep\` in the other languages — is the
worker's only way to report a transition.

- The message key is the **run id**, so every event about one run lands on one partition and the
  audit consumer reads that run's history in order. The draft keys by the workflow definition name,
  so one run's events scatter across partitions and a replay cannot rebuild the run.
- The event carries \`step\`, \`effect_id\`, \`outcome\` and \`run_id\` — and **never the step's
  document**. The topic is retained for days and replicated, so whatever the step received outlives
  every retention policy the run itself has.
- \`outcome\` is one of the four names the engine understands: \`started\`, \`succeeded\`, \`failed\`,
  \`skipped\` — the \`OUTCOMES\` set in python and typescript, \`Outcomes\` in scala, \`kOutcomes\` in
  cpp, \`outcomeStarted\` and \`outcomeSucceeded\` in go. The caller publishes \`started\` before the
  step runs and \`succeeded\` after it returns. The draft reports \`"done"\`, so a retried step looks
  finished while it is still running.
- An **outbox row is written before the produce** and deleted **only after the broker acknowledged**
  the record — \`outbox.insert(...)\` → produce → \`outbox.delete(...)\` — so a transition survives a
  broker outage instead of vanishing from the history.
- The producer is **durable and idempotent**: \`acks=all\` with \`enable.idempotence\` (KafkaJS
  \`idempotent: true\` with \`acks: -1\`, kafka-go \`RequiredAcks: kafka.RequireAll\` with a
  \`Completion\` callback). The draft leaves the defaults, so a record it called published can be
  lost on a leader failover and a producer retry can duplicate it.

**Failure mode the checks target.** The draft is a working publisher that answers the wrong
questions: keying by the workflow definition name scatters one run's history, so the auditor's
replay sees another run's events interleaved; \`"done"\` is not an outcome, so the history cannot
tell a step that is running from one that finished, and a step that retries after reporting its
start looks complete while it is still in flight; the step's document in the event is a leak every
replica keeps for the topic's whole retention; a produce with no outbox row loses the transition
exactly when the broker is down, which is when the history matters most; and default
acknowledgements make "published" a statement about the client's socket rather than about the
replicas.`,
  sequence: {
    participants: ['Worker', 'Outbox (Postgres)', 'workflow.step topic', 'Audit consumer'],
    messages: [
      {
        from: 'Worker',
        to: 'Outbox (Postgres)',
        label: 'insert(run_id, effect_id, outcome) — the row lands first',
        kind: 'sync',
      },
      {from: 'Outbox (Postgres)', to: 'Worker', label: 'row committed', kind: 'reply'},
      {from: 'Worker', to: 'workflow.step topic', label: 'produce key = run_id · acks=all', kind: 'sync'},
      {from: 'workflow.step topic', to: 'Worker', label: 'acknowledged by every replica', kind: 'reply'},
      {from: 'Worker', to: 'Outbox (Postgres)', label: 'delete(effect_id) — the event is durable now', kind: 'sync'},
      {from: 'workflow.step topic', to: 'Audit consumer', label: 'one partition per run id', kind: 'async'},
      {from: 'Audit consumer', to: 'Audit consumer', label: "append the outcome to the run's history", kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'key-run',
      title: 'Keys every event by run id',
      detail:
        'The message key is the run id — `key=run_id`, `key: runId`, `Key: []byte(runID)`, `new ProducerRecord[String, String]("workflow.step", runId, …)`, `runId.data()`. Every event about one run then lands on one partition and the audit consumer reads that run’s history in order. The draft keys by the workflow definition name, so one run’s events scatter and a replay cannot rebuild the run.',
      match: {
        python: {all: [/"workflow\.step"/, /key=run_id/]},
        typescript: {all: [/workflow\.step/, /key: runId/]},
        go: {all: [/"workflow\.step"/, /Key: \[\]byte\(runID\)/]},
        scala: {all: [/new ProducerRecord\[String, String\]\("workflow\.step", runId/]},
        cpp: {all: [/kStepTopic/, /runId\.data\(\)/]},
      },
    },
    {
      id: 'outcome',
      title: 'Publishes the step outcomes from a fixed set',
      detail:
        'The vocabulary is the four names the engine understands — `OUTCOMES` in python and typescript, `Outcomes` in scala, `kOutcomes` in cpp, `outcomeStarted` and `outcomeSucceeded` in go — and the caller publishes `started` before the step runs and `succeeded` once it returns. The draft reports `"done"`, so a step that retried after reporting its start looks finished while it is still running.',
      match: {
        python: {all: [/OUTCOMES/, /"started"/, /"succeeded"/]},
        typescript: {all: [/OUTCOMES/, /'started'/, /'succeeded'/]},
        go: {all: [/outcomeStarted/, /outcomeSucceeded/, /outcome(s)?\s*(=|:=)/]},
        scala: {all: [/Outcomes/, /"started"/, /"succeeded"/]},
        cpp: {all: [/kOutcomes/, /kStarted/, /kSucceeded/]},
      },
    },
    {
      id: 'no-payload',
      title: 'Keeps the step payload out of the event',
      detail:
        'The event carries the run id, the step name, the `effect_id` and the `outcome` — and nothing the step received. The topic is retained for days and replicated, so the step’s document written there outlives every retention policy the run has. The draft ships the document in the event, so the auditor reads a customer’s input on a topic that never expires it.',
      match: {
        python: {all: [/effect_id/, /"outcome"/], none: [/"payload"/]},
        typescript: {all: [/effectId/, /outcome/], none: [/payload/]},
        go: {all: [/EffectID/, /Outcome/], none: [/payload/]},
        scala: {all: [/effectId/, /"outcome"/], none: [/"payload"/]},
        cpp: {all: [/effect_id/, /"outcome"/], none: [/"payload"/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row before the produce',
      detail:
        '`outbox.insert(...)` runs before the produce and `outbox.delete(...)` runs only after the broker acknowledged the record, so a transition survives a broker outage: the row stays behind for a relay to republish. The draft produces with no row at all, so the history loses the transition exactly when the broker is down.',
      match: {
        python: {all: [/outbox\.delete\(/], order: [/outbox\.insert\(/, /producer\.produce\(/]},
        typescript: {all: [/outbox\.delete\(/], order: [/outbox\.insert\(/, /producer\.send\(/]},
        go: {all: [/outbox\.Delete\(/], order: [/outbox\.Insert\(/, /writer\.WriteMessages\(/]},
        scala: {all: [/outbox\.delete\(/], order: [/outbox\.insert\(/, /producer\.send\(/]},
        cpp: {all: [/outbox\.remove\(/], order: [/outbox\.insert\(/, /producer\.produce\(/]},
      },
    },
    {
      id: 'acks',
      title: 'Configures a durable, idempotent producer',
      detail:
        '`acks=all` with `enable.idempotence` (KafkaJS `idempotent: true` with `acks: -1`, kafka-go `RequiredAcks: kafka.RequireAll` with a `Completion` callback) means an acknowledged record is replicated and a producer retry cannot duplicate it. The draft leaves the defaults, so "published" does not mean "durable" and a leader failover can lose a transition the worker already reported.',
      match: {
        python: {all: [/"acks":\s*"all"/, /"enable\.idempotence":\s*True/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Completion:/]},
        scala: {all: [/ACKS_CONFIG, "all"/, /ENABLE_IDEMPOTENCE_CONFIG/]},
        cpp: {all: [/set\("acks", "all"\)/, /set\("enable\.idempotence", "true"\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_step(run_id: str, workflow: str, step: str, document: dict) -> None:
    """Report one step transition to the workflow.step topic."""
    # TODO: this draft keys by the workflow definition name instead of the run id, reports "done"
    # instead of the engine's outcome vocabulary, ships the step's document in the event, writes no
    # outbox row, and leaves the producer on its default settings.
    event = {
        "run_id": run_id,
        "workflow": workflow,
        "step": step,
        "document": document,
        "outcome": "done",
    }
    producer.produce("workflow.step", key=workflow, value=json.dumps(event))
    producer.flush(2.0)
`,
      solution: `import json
from typing import Callable

from confluent_kafka import KafkaException, Producer

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
    }
)

OUTCOMES = {"started", "succeeded", "failed", "skipped"}


class OutboxStore:
    """One row per undelivered event; a relay republishes it when the broker recovers."""

    def insert(self, run_id: str, event_id: str, document: str) -> None:
        raise NotImplementedError

    def delete(self, event_id: str) -> None:
        raise NotImplementedError


outbox = OutboxStore()


def publish_step(run_id: str, step: str, effect_id: str, outcome: str) -> None:
    """Report one step transition: the outbox row lands first, the event second."""
    if outcome not in OUTCOMES:
        raise ValueError(f"unknown outcome {outcome}")
    event = {
        "run_id": run_id,
        "step": step,
        "effect_id": effect_id,
        "outcome": outcome,
    }
    document = json.dumps(event)
    outbox.insert(run_id, effect_id, document)
    try:
        producer.produce("workflow.step", key=run_id, value=document)
        producer.flush(2.0)
    except KafkaException:
        # The row stays put: a relay republishes it once the broker is back.
        return
    outbox.delete(effect_id)


def run_step(run_id: str, step: str, effect_id: str, effect: Callable[[], None]) -> None:
    """Report the transition around the step's effect: started, then what actually happened."""
    publish_step(run_id, step, effect_id, "started")
    try:
        effect()
    except Exception:
        publish_step(run_id, step, effect_id, "failed")
        raise
    publish_step(run_id, step, effect_id, "succeeded")
`,
    },
    typescript: {
      starter: `/** workflow.step: a model-generated draft that keys by the workflow definition name. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'workflow', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Report one step transition to the workflow.step topic. */
export async function publishStep(
  runId: string,
  workflow: string,
  step: string,
  document: Record<string, unknown>,
): Promise<void> {
  // TODO: this draft keys by the workflow definition name instead of the run id, reports "done"
  // instead of the engine's outcome vocabulary, ships the step's document in the event, writes no
  // outbox row, and leaves the producer on its default settings.
  const event = {run_id: runId, workflow, step, document, outcome: 'done'};
  await producer.send({
    topic: 'workflow.step',
    messages: [{key: workflow, value: JSON.stringify(event)}],
  });
}
`,
      solution: `/** workflow.step: one durable, run-keyed event per step transition; the outbox row goes first. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'workflow', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const OUTCOMES = ['started', 'succeeded', 'failed', 'skipped'] as const;
type Outcome = (typeof OUTCOMES)[number];

export const outbox = {
  insert: async (_runId: string, _eventId: string, _document: string): Promise<void> => {
    throw new Error('not implemented');
  },
  delete: async (_eventId: string): Promise<void> => {
    throw new Error('not implemented');
  },
};

/** Report one step transition: the outbox row lands first, the event second. */
export async function publishStep(
  runId: string,
  step: string,
  effectId: string,
  outcome: Outcome,
): Promise<void> {
  const event = {run_id: runId, step, effect_id: effectId, outcome};
  const document = JSON.stringify(event);
  await outbox.insert(runId, effectId, document);
  try {
    await producer.send({
      topic: 'workflow.step',
      acks: -1,
      messages: [{key: runId, value: document}],
    });
  } catch {
    // The row stays put: a relay republishes it once the broker is back.
    return;
  }
  await outbox.delete(effectId);
}

/** Report the transition around the step's effect: started, then what actually happened. */
export async function runStep(
  runId: string,
  step: string,
  effectId: string,
  effect: () => Promise<void>,
): Promise<void> {
  await publishStep(runId, step, effectId, 'started');
  try {
    await effect();
  } catch (error) {
    await publishStep(runId, step, effectId, 'failed');
    throw error;
  }
  await publishStep(runId, step, effectId, 'succeeded');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

// The draft writes straight to the topic with the workflow definition name as the key.
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "workflow.step"}

type stepEvent struct {
	RunID    string         \`json:"run_id"\`
	Workflow string         \`json:"workflow"\`
	Step     string         \`json:"step"\`
	Document map[string]any \`json:"document"\`
	Outcome  string         \`json:"outcome"\`
}

// PublishStep reports one step transition to the workflow.step topic.
// TODO: this draft keys by the workflow definition name instead of the run id, reports "done"
// instead of the engine's outcome vocabulary, ships the step's document in the event, writes no
// outbox row, and leaves the writer on its default acknowledgements.
func PublishStep(ctx context.Context, runID string, workflow string, step string, document map[string]any) error {
	event := stepEvent{RunID: runID, Workflow: workflow, Step: step, Document: document, Outcome: "done"}
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(workflow), Value: value})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/segmentio/kafka-go"
)

const (
	outcomeStarted   = "started"
	outcomeSucceeded = "succeeded"
	outcomeFailed    = "failed"
	outcomeSkipped   = "skipped"
)

var stepOutcomes = map[string]bool{
	outcomeStarted:   true,
	outcomeSucceeded: true,
	outcomeFailed:    true,
	outcomeSkipped:   true,
}

// RequiredAcks=RequireAll plus a completion callback: the record is on every replica when the
// callback fires, so the outbox row may be deleted only then. The callback also reports a batch the
// broker refused, which a synchronous WriteMessages would have returned as an error.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "workflow.step",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Completion: func(messages []kafka.Message, err error) {
		if err != nil {
			log.Printf("%d step events not delivered: %v", len(messages), err)
		}
	},
}

// OutboxStore is the seam the worker's transaction store implements.
type OutboxStore struct{}

func (s *OutboxStore) Insert(ctx context.Context, runID string, eventID string, document string) error {
	return nil
}

func (s *OutboxStore) Delete(ctx context.Context, eventID string) error {
	return nil
}

var outbox = &OutboxStore{}

type stepEvent struct {
	RunID    string \`json:"run_id"\`
	Step     string \`json:"step"\`
	EffectID string \`json:"effect_id"\`
	Outcome  string \`json:"outcome"\`
}

// PublishStep writes the outbox row first and deletes it only once the broker acknowledged the
// record, so a broker outage leaves the row behind for a relay instead of losing the transition.
func PublishStep(ctx context.Context, runID string, step string, effectID string, outcome string) error {
	if !stepOutcomes[outcome] {
		return fmt.Errorf("unknown outcome %q", outcome)
	}
	event := stepEvent{RunID: runID, Step: step, EffectID: effectID, Outcome: outcome}
	document, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := outbox.Insert(ctx, runID, effectID, string(document)); err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(runID), Value: document}); err != nil {
		// The row stays put: a relay republishes it once the broker is back.
		return err
	}
	return outbox.Delete(ctx, effectID)
}

// RunStep reports "started" before the step runs and "succeeded" once its effect returned.
func RunStep(ctx context.Context, runID string, step string, effectID string, effect func(context.Context) error) error {
	outcome := outcomeStarted
	if err := PublishStep(ctx, runID, step, effectID, outcome); err != nil {
		return err
	}
	if err := effect(ctx); err != nil {
		outcome = outcomeFailed
		return PublishStep(ctx, runID, step, effectID, outcome)
	}
	outcome = outcomeSucceeded
	return PublishStep(ctx, runID, step, effectID, outcome)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}

object StepEvents {
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props
  })

  // TODO: this draft keys by the workflow definition name instead of the run id, reports "done"
  // instead of the engine's outcome vocabulary, ships the step's document in the event, writes no
  // outbox row, and leaves the producer on its default settings.
  def publishStep(runId: String, workflow: String, step: String, document: String): Unit = {
    val event = s"""{"run_id":"$runId","workflow":"$workflow","step":"$step","document":$document,"outcome":"done"}"""
    producer.send(new ProducerRecord("workflow.step", workflow, event))
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}

object StepEvents {
  /** The outcome vocabulary the engine understands; anything else is a bug in the worker. */
  val Outcomes: Set[String] = Set("started", "succeeded", "failed", "skipped")

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ProducerConfig.ACKS_CONFIG, "all")
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
    props
  })

  /** The outbox seam: the row is written by the worker's transaction store. */
  object OutboxStore {
    def insert(runId: String, eventId: String, document: String): Unit = ()
    def delete(eventId: String): Unit = ()
  }

  val outbox = OutboxStore

  /** Report one step transition: the outbox row lands first, the event second. */
  def publishStep(runId: String, step: String, effectId: String, outcome: String): Unit = {
    require(Outcomes.contains(outcome), s"unknown outcome $outcome")
    val event = s"""{"run_id":"$runId","step":"$step","effect_id":"$effectId","outcome":"$outcome"}"""
    outbox.insert(runId, effectId, event)
    // get() waits for the broker's acknowledgement, so the row is deleted only once the record is
    // durable: a produce that never lands leaves the row behind for a relay to republish.
    producer.send(new ProducerRecord[String, String]("workflow.step", runId, event)).get()
    outbox.delete(effectId)
  }

  /** Report the transition around the step's effect: started, then what actually happened. */
  def runStep(runId: String, step: String, effectId: String)(effect: => Unit): Unit = {
    publishStep(runId, step, effectId, "started")
    try {
      effect
      publishStep(runId, step, effectId, "succeeded")
    } catch {
      case error: Throwable =>
        publishStep(runId, step, effectId, "failed")
        throw error
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kStepTopic = "workflow.step";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

// TODO: this draft keys by the workflow definition name instead of the run id, reports "done"
// instead of the engine's outcome vocabulary, ships the step's document in the event, writes no
// outbox row, and leaves the producer on its default acknowledgements.
void publishStep(RdKafka::Producer& producer, const std::string& runId, const std::string& workflow,
                 const std::string& step, const json& document) {
  const json event = {
      {"run_id", runId}, {"workflow", workflow}, {"step", step}, {"document", document}, {"outcome", "done"}};
  const auto body = event.dump();
  producer.produce(kStepTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                   const_cast<char*>(body.data()), body.size(), workflow.data(), workflow.size(), 0, nullptr);
  producer.flush(2000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kStepTopic = "workflow.step";

const std::vector<std::string> kOutcomes = {"started", "succeeded", "failed", "skipped"};
const std::string kStarted = "started";
const std::string kSucceeded = "succeeded";

/** Options applies one global option to the rdkafka conf and throws when the name is unknown. */
struct Options {
  explicit Options(RdKafka::Conf* conf) : conf_(conf) {}

  void set(const std::string& name, const std::string& value) const {
    std::string errstr;
    if (conf_->set(name, value, errstr) != RdKafka::Conf::CONF_OK) {
      throw std::runtime_error("kafka option " + name + ": " + errstr);
    }
  }

  RdKafka::Conf* conf_;
};

/** OutboxStore is the seam the worker's transaction store implements. */
struct OutboxStore {
  void insert(const std::string& runId, const std::string& eventId, const std::string& document);
  void remove(const std::string& eventId);
};

OutboxStore outbox;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  const Options options(conf.get());
  options.set("bootstrap.servers", "kafka:9092");
  options.set("acks", "all");
  options.set("enable.idempotence", "true");
  std::string err;
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

/** publishStep writes the outbox row first and removes it only once the broker acknowledged. */
void publishStep(RdKafka::Producer& producer, const std::string& runId, const std::string& step,
                 const std::string& effectId, const std::string& outcome) {
  const json event = {{"run_id", runId}, {"step", step}, {"effect_id", effectId}, {"outcome", outcome}};
  const auto document = event.dump();
  outbox.insert(runId, effectId, document);
  const auto delivery = producer.produce(kStepTopic, RdKafka::Topic::PARTITION_UA,
                                         RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(document.data()),
                                         document.size(), runId.data(), runId.size(), 0, nullptr);
  if (delivery != RdKafka::ERR_NO_ERROR) {
    // The row stays put: a relay republishes it once the broker is back.
    return;
  }
  if (producer.flush(2000) != RdKafka::ERR_NO_ERROR) {
    return;
  }
  outbox.remove(effectId);
}

/** runStep reports "started" before the step and "succeeded" once its effect returned. */
void runStep(RdKafka::Producer& producer, const std::string& runId, const std::string& step,
             const std::string& effectId, const std::function<void()>& effect) {
  publishStep(producer, runId, step, effectId, kStarted);
  effect();
  publishStep(producer, runId, step, effectId, kSucceeded);
}
`,
    },
  },
  hints: [
    'The message key is the partition key. Key by the run id — `key=run_id`, `key: runId`, `Key: []byte(runID)`, `new ProducerRecord[String, String]("workflow.step", runId, …)`, `runId.data()` — and every event about one run lands on one partition in order. Keyed by the workflow definition name, a single run’s history scatters across partitions and a replay cannot rebuild it.',
    'The outbox row is the durability half, and its order matters: insert the row first, produce second, and delete the row only after the broker acknowledged the record. A produce the broker refused leaves the row behind for a relay to republish, instead of dropping the transition. And keep the step’s document out of the event — the topic’s retention is measured in days, so anything written there outlives the run.',
    'Configure durability on the producer, not per call: `acks=all` with `enable.idempotence=true` (KafkaJS `idempotent: true` with `acks: -1`, kafka-go `RequiredAcks: kafka.RequireAll` with a `Completion` callback). Then report the vocabulary the engine understands — `started` before the step runs, `succeeded` after it returns — and never `"done"`, which cannot tell a running step from a finished one.',
  ],
  debrief: `The interviewer is testing whether you can review a generated producer at the point where a worker's transition becomes an audit trail. The draft reads fine because the demo runs one workflow once, the broker stays up and nobody replays the topic. Five defects are being checked, and each one is a class of production incident: keyed by the definition name, a run's history is scattered across partitions, so a replay interleaves other runs and cannot rebuild the sequence; "done" is not an outcome, so the history cannot distinguish a step that is running from one that finished, and a step that retried after reporting its start looks complete while it is still in flight; the step's document in the event is a leak that outlives the run, because the topic's retention is measured in days and every replica keeps a copy; a produce with no outbox row loses the transition exactly when the broker is down, which is when the history matters most; and default acknowledgements make "published" a statement about the client's socket rather than about the replicas. The order matters as much as the pieces: the row is inserted before the produce and deleted only after the broker acknowledged, so a crash between the two replays the row instead of losing the transition. In a real engine the consumer is what turns the topic into the run's history, the relay republishes rows the broker rejected, and the event also carries the definition version and a monotonically increasing sequence number so the auditor can order a run without trusting the clock.`,
};
