import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'browser.step events keyed by session, redacted, appended before the commit',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'kafka', 'consumer', 'store'],
  task: `## Task

**Starting point.** The starter is the event path of the steps \`run_action\` makes:
\`publish_step(step)\` produces \`step_event(step)\` to \`browser.step\` on an idempotent producer
with \`acks=all\`, keyed by the step index, and \`run_trace_consumer()\` reads the topic in group
\`trace-store\`, commits each record and appends it to the trace with \`trace.append_step\`. It
serves the demo and hides three flaws.

**Failure mode the checks target.** One session's steps spread across partitions and reach the
trace out of order; the record is the whole step, so the password a \`type\` action typed and every
URL the browser visited sit in a retained topic; a consumer that dies between its commit and its
append loses that step for good.

- The record key is the **session id**.
- \`step_event\` carries \`session_id\`, \`step_index\`, \`action\`, \`outcome\`, \`reason\` and
  \`target_digest\` (\`trace.digest(target)\`), nothing else: no \`text\`, \`target\` or \`url\`.
- The consumer **appends first and commits after**; a redelivered step overwrites itself in the
  trace.`,
  sequence: {
    participants: ['Worker', 'browser.step', 'Trace consumer', 'Trace store'],
    messages: [
      {
        from: 'Worker',
        to: 'browser.step',
        label: 'produce · key = session id · {action, outcome, target_digest}',
        kind: 'sync',
      },
      {from: 'browser.step', to: 'Trace consumer', label: 'poll · group trace-store', kind: 'async'},
      {from: 'Trace consumer', to: 'Trace store', label: 'append_step(session_id, event)', kind: 'sync'},
      {from: 'Trace consumer', to: 'browser.step', label: 'commit offset', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'session-key',
      title: 'Keyed by session id',
      detail:
        'The record key is the session id, so one session’s steps share a partition and stay in order; the starter keys by the step index, which spreads a session over every partition.',
      match: {
        python: {all: [/key=step\[["']session_id["']\]/], none: [/key=str\(step\[["']step_index/]},
        typescript: {all: [/key:\s*step\.session_id/], none: [/key:\s*String\(step\.step_index\)/]},
        go: {all: [/Key:\s*\[\]byte\(step\.SessionID\)/], none: [/strconv\.Itoa\(step\.StepIndex\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(Topic,\s*step\.sessionId/],
          none: [/step\.stepIndex\.toString/],
        },
        cpp: {all: [/step\.session_id\.c_str\(\)/], none: [/std::to_string\(step\.step_index\)/]},
      },
    },
    {
      id: 'no-typed-values',
      title: 'Carries a target digest, never typed text, targets or URLs',
      detail:
        'The event is built from `session_id`, `step_index`, `action`, `outcome`, `reason` and `target_digest` (the provided digest of the target); the starter copies the whole step, typed text and URL included.',
      match: {
        python: {all: [/trace\.digest\(/, /target_digest/], none: [/dict\(step\)|\*\*step\b/]},
        typescript: {all: [/digest\(step\.target\)/, /target_digest/], none: [/\.\.\.step\b/]},
        go: {all: [/trace\.Digest\(/, /target_digest/], none: [/json\.Marshal\(step\)/]},
        scala: {all: [/Trace\.digest\(/, /target_digest/], none: [/"text"\s*->/]},
        cpp: {all: [/trace::digest\(/, /target_digest/], none: [/\{"text",/]},
      },
    },
    {
      id: 'append-before-commit',
      title: 'Appends to the trace before committing the offset',
      detail:
        'The consumer calls `append_step`/`appendStep` and only then commits, so a crash between the two redelivers the step instead of losing it.',
      match: {
        python: {order: [/trace\.append_step\(/, /consumer\.commit\(/]},
        typescript: {order: [/appendStep\(/, /commitOffsets\(/]},
        go: {order: [/trace\.AppendStep\(/, /CommitMessages\(/]},
        scala: {order: [/Trace\.appendStep\(/, /commitSync\(/]},
        cpp: {order: [/trace::appendStep\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer

from browser import trace  # digest, append_step

TOPIC = "browser.step"
GROUP = "trace-store"
log = logging.getLogger("browser.events")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("browser.step not delivered: %s", err)


def step_event(step: dict) -> dict:
    """The browser.step record of one step run_action made."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    return dict(step)


def publish_step(step: dict) -> None:
    producer.produce(TOPIC, key=str(step["step_index"]), value=json.dumps(step_event(step)), on_delivery=on_delivery)
    producer.flush(5.0)


def run_trace_consumer() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        consumer.commit(record, asynchronous=False)
        event = json.loads(record.value())
        trace.append_step(event["session_id"], event)
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, Producer

from browser import trace  # digest, append_step

TOPIC = "browser.step"
GROUP = "trace-store"
EVENT_FIELDS = ("session_id", "step_index", "action", "outcome", "reason")
log = logging.getLogger("browser.events")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("browser.step not delivered: %s", err)


def step_event(step: dict) -> dict:
    """The browser.step record of one step run_action made."""
    # What happened, not what the browser saw: no typed text, no selector, no URL.
    event = {name: step[name] for name in EVENT_FIELDS}
    event["target_digest"] = trace.digest(step["target"])
    return event


def publish_step(step: dict) -> None:
    producer.produce(TOPIC, key=step["session_id"], value=json.dumps(step_event(step)), on_delivery=on_delivery)
    producer.flush(5.0)


def run_trace_consumer() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        event = json.loads(record.value())
        trace.append_step(event["session_id"], event)
        consumer.commit(record, asynchronous=False)  # after the append: a crash in between redelivers
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Step, type StepEvent, appendStep, digest} from 'browser/trace';

export const TOPIC = 'browser.step';
export const GROUP = 'trace-store';

const kafka = new Kafka({clientId: 'browserd', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true}); // idempotent implies acks: -1 (all)
void producer.connect();

/** The browser.step record of one step runAction made. */
export function stepEvent(step: Step): StepEvent {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  return {...step};
}

export async function publishStep(step: Step): Promise<void> {
  try {
    await producer.send({topic: TOPIC, messages: [{key: String(step.step_index), value: JSON.stringify(stepEvent(step))}], acks: -1});
  } catch (err) {
    console.warn(\`browser.step not delivered: \${(err as Error).message}\`);
  }
}

export async function runTraceConsumer(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as StepEvent;
      await appendStep(event.session_id, event);
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Step, type StepEvent, appendStep, digest} from 'browser/trace';

export const TOPIC = 'browser.step';
export const GROUP = 'trace-store';

const kafka = new Kafka({clientId: 'browserd', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true}); // idempotent implies acks: -1 (all)
void producer.connect();

/** The browser.step record of one step runAction made. */
export function stepEvent(step: Step): StepEvent {
  // What happened, not what the browser saw: no typed text, no selector, no URL.
  return {
    session_id: step.session_id,
    step_index: step.step_index,
    action: step.action,
    outcome: step.outcome,
    reason: step.reason,
    target_digest: digest(step.target),
  };
}

export async function publishStep(step: Step): Promise<void> {
  try {
    await producer.send({topic: TOPIC, messages: [{key: step.session_id, value: JSON.stringify(stepEvent(step))}], acks: -1});
  } catch (err) {
    console.warn(\`browser.step not delivered: \${(err as Error).message}\`);
  }
}

export async function runTraceConsumer(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as StepEvent;
      await appendStep(event.session_id, event);
      // After the append: a crash in between redelivers.
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
	"strconv"

	"github.com/segmentio/kafka-go"

	"browser/trace" // trace.Step, Digest, AppendStep
)

const (
	topic = "browser.step"
	group = "trace-store"
)

// kafka-go has no idempotent mode: RequireAll is what it can promise.
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

// stepEvent is the browser.step record of one step runAction made.
func stepEvent(step trace.Step) map[string]any {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	raw, _ := json.Marshal(step)
	event := map[string]any{}
	json.Unmarshal(raw, &event)
	return event
}

func publishStep(ctx context.Context, step trace.Step) error {
	value, err := json.Marshal(stepEvent(step))
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(strconv.Itoa(step.StepIndex)), Value: value}); err != nil {
		log.Printf("browser.step not delivered: %v", err)
		return err
	}
	return nil
}

func runTraceConsumer(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		event := map[string]any{}
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		sessionID, _ := event["session_id"].(string)
		if err := trace.AppendStep(ctx, sessionID, event); err != nil {
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

	"browser/trace" // trace.Step, Digest, AppendStep
)

const (
	topic = "browser.step"
	group = "trace-store"
)

// kafka-go has no idempotent mode: RequireAll is what it can promise.
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

// stepEvent is the browser.step record of one step runAction made.
func stepEvent(step trace.Step) map[string]any {
	// What happened, not what the browser saw: no typed text, no selector, no URL.
	return map[string]any{
		"session_id":    step.SessionID,
		"step_index":    step.StepIndex,
		"action":        step.Action,
		"outcome":       step.Outcome,
		"reason":        step.Reason,
		"target_digest": trace.Digest(step.Target),
	}
}

func publishStep(ctx context.Context, step trace.Step) error {
	value, err := json.Marshal(stepEvent(step))
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(step.SessionID), Value: value}); err != nil {
		log.Printf("browser.step not delivered: %v", err)
		return err
	}
	return nil
}

func runTraceConsumer(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		event := map[string]any{}
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			reader.CommitMessages(ctx, msg) // malformed: skip it rather than replay it forever
			continue
		}
		sessionID, _ := event["session_id"].(string)
		if err := trace.AppendStep(ctx, sessionID, event); err != nil {
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
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerConfig, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import scala.jdk.CollectionConverters._

import browser.Trace // Trace.Step, digest, appendStep

object Events {
  val Topic = "browser.step"
  val Group = "trace-store"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** The browser.step record of one step runAction made. */
  def stepEvent(step: Trace.Step): JsObject = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    JsObject(
      "session_id" -> JsString(step.sessionId), "step_index" -> JsNumber(step.stepIndex), "action" -> JsString(step.action),
      "target" -> JsString(step.target), "text" -> JsString(step.text), "outcome" -> JsString(step.outcome),
      "url" -> JsString(step.url), "digest" -> JsString(step.digest), "reason" -> JsString(step.reason),
    )
  }

  def publishStep(step: Trace.Step): Unit = {
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) System.err.println(s"browser.step not delivered: \${exception.getMessage}")
    }
    producer.send(new ProducerRecord[String, String](Topic, step.stepIndex.toString, stepEvent(step).compactPrint), onDelivery)
    producer.flush()
  }

  def runTraceConsumer(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject
        Trace.appendStep(event.fields("session_id").convertTo[String](DefaultJsonProtocol.StringJsonFormat), event)
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
import spray.json._

import scala.jdk.CollectionConverters._

import browser.Trace // Trace.Step, digest, appendStep

object Events {
  val Topic = "browser.step"
  val Group = "trace-store"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** The browser.step record of one step runAction made. */
  def stepEvent(step: Trace.Step): JsObject =
    // What happened, not what the browser saw: no typed text, no selector, no URL.
    JsObject(
      "session_id" -> JsString(step.sessionId), "step_index" -> JsNumber(step.stepIndex), "action" -> JsString(step.action),
      "outcome" -> JsString(step.outcome), "reason" -> JsString(step.reason), "target_digest" -> JsString(Trace.digest(step.target)),
    )

  def publishStep(step: Trace.Step): Unit = {
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) System.err.println(s"browser.step not delivered: \${exception.getMessage}")
    }
    producer.send(new ProducerRecord[String, String](Topic, step.sessionId, stepEvent(step).compactPrint), onDelivery)
    producer.flush()
  }

  def runTraceConsumer(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = record.value().parseJson.asJsObject
        Trace.appendStep(event.fields("session_id").convertTo[String](DefaultJsonProtocol.StringJsonFormat), event)
        consumer.commitSync() // after the append: a crash in between redelivers
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

#include "browser/trace.h"  // trace::Step, digest, appendStep

const std::string kTopic = "browser.step";
const std::string kGroup = "trace-store";

class LogDelivery : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "browser.step not delivered: " << message.errstr() << "\\n";
  }
};

LogDelivery delivery_report;

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

// The browser.step record of one step runAction made.
nlohmann::json stepEvent(const trace::Step& step) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  return nlohmann::json{{"session_id", step.session_id}, {"step_index", step.step_index}, {"action", step.action},
                        {"target", step.target},         {"text", step.text},             {"outcome", step.outcome},
                        {"url", step.url},               {"digest", step.digest},         {"reason", step.reason}};
}

void publishStep(const trace::Step& step) {
  const std::string value = stepEvent(step).dump();
  const std::string key = std::to_string(step.step_index);
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    key.c_str(), key.size(), 0, nullptr);
  producer->flush(5000);
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

void runTraceConsumer() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) continue;
    trace::appendStep(event.value("session_id", ""), event);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "browser/trace.h"  // trace::Step, digest, appendStep

const std::string kTopic = "browser.step";
const std::string kGroup = "trace-store";

class LogDelivery : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "browser.step not delivered: " << message.errstr() << "\\n";
  }
};

LogDelivery delivery_report;

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

// The browser.step record of one step runAction made.
nlohmann::json stepEvent(const trace::Step& step) {
  // What happened, not what the browser saw: no typed text, no selector, no URL.
  return nlohmann::json{{"session_id", step.session_id}, {"step_index", step.step_index}, {"action", step.action},
                        {"outcome", step.outcome},       {"reason", step.reason},         {"target_digest", trace::digest(step.target)}};
}

void publishStep(const trace::Step& step) {
  const std::string value = stepEvent(step).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    step.session_id.c_str(), step.session_id.size(), 0, nullptr);
  producer->flush(5000);
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

void runTraceConsumer() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) {
      consumer->commitSync(msg.get());  // malformed: skip it rather than replay it forever
      continue;
    }
    trace::appendStep(event.value("session_id", ""), event);
    consumer->commitSync(msg.get());  // after the append: a crash in between redelivers
  }
}
`,
    },
  },
  harness: {
    python: `import json

from browser import trace

TOPIC = "browser.step"
EVENT_KEYS = {"session_id", "step_index", "action", "outcome", "reason", "target_digest"}
CANARY = "hunter2-CANARY-7731"


def _step(session_id, index, action="click", target="#buy", text=""):
    return {"session_id": session_id, "step_index": index, "action": action, "target": target, "text": text,
            "outcome": "ok", "url": f"https://www.example.com/{session_id}/{index}", "digest": f"page#{index}", "reason": ""}


def check_session_key(ctx):
    m = ctx.load("events")
    for index in range(1, 5):
        m.publish_step(_step("s-1", index))
        if index < 4:
            m.publish_step(_step("s-2", index))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 7, f"7 published steps put {len(records)} records on {TOPIC}"
    for r in records:
        session = json.loads(r.value)["session_id"]
        assert r.key == session.encode(), f"a step of {session} was keyed {r.key!r}: key every record by its session id, so one session's steps share a partition"
    for session in ("s-1", "s-2"):
        mine = [r for r in records if json.loads(r.value)["session_id"] == session]
        assert len({r.partition for r in mine}) == 1, f"the steps of {session} landed on partitions {sorted({r.partition for r in mine})}"
        order = [json.loads(r.value)["step_index"] for r in mine]
        assert order == sorted(order), f"the steps of {session} are on the topic in the order {order}"


def check_no_typed_values(ctx):
    m = ctx.load("events")
    m.publish_step(_step("s-1", 3, action="type", target="#password", text=CANARY))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one published step put {len(records)} records on {TOPIC}"
    raw = records[0].value.decode()
    assert CANARY not in raw, f"the typed password is on the topic: {raw}. The event must not carry text"
    assert "#password" not in raw and "https://www.example.com/" not in raw, f"the event carries the selector or the URL: {raw}. Carry target_digest instead"
    event = json.loads(raw)
    assert set(event) == EVENT_KEYS, f"the event has the fields {sorted(event)}, expected exactly {sorted(EVENT_KEYS)}"
    assert event["target_digest"] == trace.digest("#password"), f"target_digest is {event['target_digest']!r}, expected trace.digest('#password') = {trace.digest('#password')!r}"
    assert event["action"] == "type" and event["step_index"] == 3 and event["outcome"] == "ok", f"the event lost what happened: {event}"


def check_append_before_commit(ctx):
    for index in (1, 2, 3):
        event = {"session_id": "s-1", "step_index": index, "action": "click", "outcome": "ok", "reason": "", "target_digest": trace.digest(f"#b{index}")}
        ctx.kafka.seed(TOPIC, key="s-1", value=json.dumps(event))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(len(trace.read_trace("s-1"))))
    m = ctx.load("events")
    ctx.drain(m.run_trace_consumer)
    assert at_commit, "the consumer never committed an offset"
    assert at_commit[0] >= 1, f"at the first commit the trace of s-1 held {at_commit[0]} steps: the offset was committed before the step was appended, so a crash in between loses it"
    assert at_commit == sorted(at_commit) and all(n >= i + 1 for i, n in enumerate(at_commit)), f"the trace lengths at each commit were {at_commit}: every commit must follow its append"
    steps = [e["step_index"] for e in trace.read_trace("s-1")]
    assert steps == [1, 2, 3], f"the trace of s-1 holds steps {steps}, expected [1, 2, 3]"
    assert ctx.kafka.lag("trace-store", TOPIC) == 0, "every appended step must be committed"
`,
    typescript: `const TOPIC = 'browser.step';
const EVENT_KEYS = ['action', 'outcome', 'reason', 'session_id', 'step_index', 'target_digest'];
const CANARY = 'hunter2-CANARY-7731';

const step = (sessionId: string, index: number, action = 'click', target = '#buy', text = '') => ({
  session_id: sessionId,
  step_index: index,
  action,
  target,
  text,
  outcome: 'ok',
  url: \`https://www.example.com/\${sessionId}/\${index}\`,
  digest: \`page#\${index}\`,
  reason: '',
});

export async function check_session_key(ctx) {
  const m = ctx.load('events');
  for (let index = 1; index <= 4; index++) {
    await m.publishStep(step('s-1', index));
    if (index < 4) await m.publishStep(step('s-2', index));
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 7, \`7 published steps put \${records.length} records on \${TOPIC}\`);
  for (const r of records) {
    const session = JSON.parse(r.value.toString()).session_id;
    assert.equal(r.key?.toString(), session, \`a step of \${session} was keyed \${r.key?.toString()}: key every record by its session id, so one session's steps share a partition\`);
  }
  for (const session of ['s-1', 's-2']) {
    const mine = records.filter(r => JSON.parse(r.value.toString()).session_id === session);
    assert.equal(new Set(mine.map(r => r.partition)).size, 1, \`the steps of \${session} landed on several partitions\`);
    const order = mine.map(r => JSON.parse(r.value.toString()).step_index);
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), \`the steps of \${session} are on the topic in the order \${JSON.stringify(order)}\`);
  }
}

export async function check_no_typed_values(ctx) {
  const m = ctx.load('events');
  const {digest} = ctx.load('/support/browser/trace.ts');
  await m.publishStep(step('s-1', 3, 'type', '#password', CANARY));
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one published step put \${records.length} records on \${TOPIC}\`);
  const raw = records[0].value.toString();
  assert(!raw.includes(CANARY), \`the typed password is on the topic: \${raw}. The event must not carry text\`);
  assert(!raw.includes('#password') && !raw.includes('https://www.example.com/'), \`the event carries the selector or the URL: \${raw}. Carry target_digest instead\`);
  const event = JSON.parse(raw);
  assert.deepStrictEqual(Object.keys(event).sort(), EVENT_KEYS, \`the event has the fields \${JSON.stringify(Object.keys(event).sort())}, expected exactly \${JSON.stringify(EVENT_KEYS)}\`);
  assert.equal(event.target_digest, digest('#password'), \`target_digest is \${event.target_digest}, expected digest('#password') = \${digest('#password')}\`);
  assert(event.action === 'type' && event.step_index === 3 && event.outcome === 'ok', \`the event lost what happened: \${raw}\`);
}

export async function check_append_before_commit(ctx) {
  const trace = ctx.load('/support/browser/trace.ts');
  for (const index of [1, 2, 3]) {
    const event = {session_id: 's-1', step_index: index, action: 'click', outcome: 'ok', reason: '', target_digest: trace.digest(\`#b\${index}\`)};
    ctx.kafka.seed(TOPIC, {key: 's-1', value: JSON.stringify(event)});
  }
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.hlen('browser:trace:s-1')));
  const m = ctx.load('events');
  await ctx.drain(m.runTraceConsumer());
  assert(atCommit.length > 0, 'the consumer never committed an offset');
  assert(atCommit[0] >= 1, \`at the first commit the trace of s-1 held \${atCommit[0]} steps: the offset was committed before the step was appended, so a crash in between loses it\`);
  assert(atCommit.every((n, i) => n >= i + 1), \`the trace lengths at each commit were \${JSON.stringify(atCommit)}: every commit must follow its append\`);
  const steps = (await trace.readTrace('s-1')).map(e => e.step_index);
  assert.deepStrictEqual(steps, [1, 2, 3], \`the trace of s-1 holds steps \${JSON.stringify(steps)}, expected [1, 2, 3]\`);
  assert.equal(ctx.kafka.lag('trace-store', TOPIC), 0, 'every appended step must be committed');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"browser/trace"

	"leetbuild/harness"
)

const (
	stepTopic = "browser.step"
	canary    = "hunter2-CANARY-7731"
)

var eventsBg = context.Background()

func testStep(sessionID string, index int, action, target, text string) trace.Step {
	return trace.Step{SessionID: sessionID, StepIndex: index, Action: action, Target: target, Text: text, Outcome: "ok",
		URL: fmt.Sprintf("https://www.example.com/%s/%d", sessionID, index), Digest: fmt.Sprintf("page#%d", index)}
}

func decode(raw []byte) map[string]any {
	event := map[string]any{}
	json.Unmarshal(raw, &event)
	return event
}

func CheckSessionKey(ctx *harness.Ctx) {
	for index := 1; index <= 4; index++ {
		ctx.NoError(publishStep(eventsBg, testStep("s-1", index, "click", "#buy", "")), "publishStep(s-1, %d)", index)
		if index < 4 {
			ctx.NoError(publishStep(eventsBg, testStep("s-2", index, "click", "#buy", "")), "publishStep(s-2, %d)", index)
		}
	}
	records := ctx.Kafka.Records(stepTopic)
	ctx.Equal(len(records), 7, "7 published steps; records on %s", stepTopic)
	partitions := map[string]map[int]bool{}
	order := map[string][]int{}
	for _, r := range records {
		event := decode(r.Value)
		session := fmt.Sprint(event["session_id"])
		ctx.Equal(string(r.Key), session, "a step of %s must be keyed by its session id, so one session's steps share a partition; the key", session)
		if partitions[session] == nil {
			partitions[session] = map[int]bool{}
		}
		partitions[session][r.Partition] = true
		order[session] = append(order[session], trace.StepIndex(event))
	}
	for _, session := range []string{"s-1", "s-2"} {
		ctx.Equal(len(partitions[session]), 1, "the steps of %s must share one partition; partitions", session)
		ctx.Assert(sort.IntsAreSorted(order[session]), "the steps of %s are on the topic in the order %v", session, order[session])
	}
}

func CheckNoTypedValues(ctx *harness.Ctx) {
	ctx.NoError(publishStep(eventsBg, testStep("s-1", 3, "type", "#password", canary)), "publishStep")
	records := ctx.Kafka.Records(stepTopic)
	ctx.Equal(len(records), 1, "one published step; records on %s", stepTopic)
	raw := string(records[0].Value)
	ctx.Assert(!strings.Contains(raw, canary), "the typed password is on the topic: %s. The event must not carry text", raw)
	ctx.Assert(!strings.Contains(raw, "#password") && !strings.Contains(raw, "https://www.example.com/"), "the event carries the selector or the URL: %s. Carry target_digest instead", raw)
	event := decode(records[0].Value)
	keys := make([]string, 0, len(event))
	for k := range event {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	ctx.Equal(keys, []string{"action", "outcome", "reason", "session_id", "step_index", "target_digest"}, "the event's fields")
	ctx.Equal(event["target_digest"], trace.Digest("#password"), "target_digest must be trace.Digest of the target")
	ctx.Assert(event["action"] == "type" && trace.StepIndex(event) == 3 && event["outcome"] == "ok", "the event lost what happened: %s", raw)
}

func CheckAppendBeforeCommit(ctx *harness.Ctx) {
	for index := 1; index <= 3; index++ {
		value, _ := json.Marshal(map[string]any{"session_id": "s-1", "step_index": index, "action": "click", "outcome": "ok", "reason": "", "target_digest": trace.Digest(fmt.Sprintf("#b%d", index))})
		ctx.Kafka.Seed(stepTopic, "s-1", string(value))
	}
	var atCommit []int64
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		atCommit = append(atCommit, ctx.Redis.HLen("browser:trace:s-1"))
	})
	ctx.Drain(func() { runTraceConsumer(eventsBg) })
	ctx.Assert(len(atCommit) > 0, "the consumer never committed an offset")
	ctx.Assert(atCommit[0] >= 1, "at the first commit the trace of s-1 held %d steps: the offset was committed before the step was appended, so a crash in between loses it", atCommit[0])
	for i, n := range atCommit {
		ctx.Assert(n >= int64(i+1), "the trace lengths at each commit were %v: every commit must follow its append", atCommit)
	}
	events, err := trace.ReadTrace(eventsBg, "s-1")
	ctx.NoError(err, "ReadTrace(s-1)")
	steps := []int{}
	for _, e := range events {
		steps = append(steps, trace.StepIndex(e))
	}
	ctx.Equal(steps, []int{1, 2, 3}, "the trace of s-1")
	ctx.Equal(ctx.Kafka.Lag("trace-store", stepTopic), 0, "every appended step must be committed; the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "browser/trace.h"

namespace {

const std::string kStepTopic = "browser.step";
const std::string kCanary = "hunter2-CANARY-7731";

trace::Step testStep(const std::string& session_id, long index, const std::string& action = "click", const std::string& target = "#buy",
                     const std::string& text = "") {
  return trace::Step{session_id, index, action, target, text, "ok", "https://www.example.com/" + session_id + "/" + std::to_string(index),
                     "page#" + std::to_string(index), ""};
}

nlohmann::json decode(const std::optional<std::string>& raw) {
  const auto v = nlohmann::json::parse(raw.value_or(""), nullptr, false);
  return v.is_object() ? v : nlohmann::json::object();
}

}  // namespace

void CheckSessionKey(harness::Ctx& ctx) {
  for (long index = 1; index <= 4; index++) {
    publishStep(testStep("s-1", index));
    if (index < 4) publishStep(testStep("s-2", index));
  }
  const auto records = ctx.Kafka.Records(kStepTopic);
  ctx.Equal(records.size(), 7, "7 published steps; records on %s", kStepTopic);
  std::map<std::string, std::set<int>> partitions;
  std::map<std::string, std::vector<long>> order;
  for (const auto& r : records) {
    const auto event = decode(r.Value);
    const std::string session = event.value("session_id", "");
    ctx.Equal(r.Key.value_or(""), session, "a step of %s must be keyed by its session id, so one session's steps share a partition; the key", session);
    partitions[session].insert(r.Partition);
    order[session].push_back(event.value("step_index", 0L));
  }
  for (const std::string session : {"s-1", "s-2"}) {
    ctx.Equal(partitions[session].size(), 1, "the steps of %s must share one partition; partitions", session);
    ctx.Assert(std::is_sorted(order[session].begin(), order[session].end()), "the steps of %s are on the topic in the order %v", session, order[session]);
  }
}

void CheckNoTypedValues(harness::Ctx& ctx) {
  publishStep(testStep("s-1", 3, "type", "#password", kCanary));
  const auto records = ctx.Kafka.Records(kStepTopic);
  ctx.Equal(records.size(), 1, "one published step; records on %s", kStepTopic);
  const std::string raw = records[0].Value.value_or("");
  ctx.Assert(raw.find(kCanary) == std::string::npos, "the typed password is on the topic: %s. The event must not carry text", raw);
  ctx.Assert(raw.find("#password") == std::string::npos && raw.find("https://www.example.com/") == std::string::npos, "the event carries the selector or the URL: %s. Carry target_digest instead", raw);
  const auto event = decode(records[0].Value);
  std::vector<std::string> keys;
  for (const auto& item : event.items()) keys.push_back(item.key());
  std::sort(keys.begin(), keys.end());
  ctx.Equal(keys, {"action", "outcome", "reason", "session_id", "step_index", "target_digest"}, "the event's fields");
  ctx.Equal(event.value("target_digest", ""), trace::digest("#password"), "target_digest must be trace::digest of the target");
  ctx.Assert(event.value("action", "") == "type" && event.value("step_index", 0L) == 3 && event.value("outcome", "") == "ok", "the event lost what happened: %s", raw);
}

void CheckAppendBeforeCommit(harness::Ctx& ctx) {
  for (long index = 1; index <= 3; index++) {
    const nlohmann::json event = {{"session_id", "s-1"}, {"step_index", index}, {"action", "click"}, {"outcome", "ok"}, {"reason", ""}, {"target_digest", trace::digest("#b" + std::to_string(index))}};
    ctx.Kafka.Seed(kStepTopic, "s-1", event.dump());
  }
  std::vector<long long> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(ctx.Redis.HLen("browser:trace:s-1")); });
  ctx.Drain([] { runTraceConsumer(); });
  ctx.Assert(!atCommit.empty(), "the consumer never committed an offset");
  ctx.Assert(atCommit[0] >= 1, "at the first commit the trace of s-1 held %d steps: the offset was committed before the step was appended, so a crash in between loses it", atCommit[0]);
  for (size_t i = 0; i < atCommit.size(); i++) {
    ctx.Assert(atCommit[i] >= static_cast<long long>(i + 1), "the trace lengths at each commit were %v: every commit must follow its append", atCommit);
  }
  std::vector<long> steps;
  for (const auto& e : trace::readTrace("s-1")) steps.push_back(e.value("step_index", 0L));
  ctx.Equal(steps, std::vector<long>{1, 2, 3}, "the trace of s-1");
  ctx.Equal(ctx.Kafka.Lag("trace-store", kStepTopic), 0, "every appended step must be committed; the lag");
}
`,
  },
  hints: [
    'Run two sessions at once and read the trace: the steps of one session arrive out of order. Type a password in a session and read the topic: the password is there, next to the URL.',
    'The key is the step index, which spreads one session over every partition; `step_event` copies the whole step; the consumer commits the offset before `append_step` runs, so a crash in between skips the step.',
    'Key by `step["session_id"]`; build the event from `session_id`, `step_index`, `action`, `outcome`, `reason` and `target_digest = trace.digest(step["target"])`; call `trace.append_step` before `consumer.commit`.',
  ],
  debrief: `Kafka orders records per partition only, so the key is whatever must stay in order, and for a trace that is the session. The event records what happened rather than what the browser saw: an action, an outcome and a digest that lets an operator match a step to a selector without the topic holding the selector, the URL or the typed text, because a topic is retained, replicated and read by more teams than the session ever was. Append-then-commit turns a crash into a duplicate, and a trace keyed by step index absorbs duplicates for free. Production pipelines encrypt the few fields an investigation needs under a per-tenant key and expire traces with the session.`,
};
