import type {Step} from '@/lib/types';

export const driftEventsStep: Step = {
  id: 'events',
  title: 'Drift events keyed by monitor for an auditable history',
  concept: 'kafka',
  file: 'events',
  focus: ['monitor', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter is \`publish_evaluation(monitor, window, distance, sample_count)\`,
called once per window evaluation: it produces \`{"type": "drift.evaluated", monitor_id, metric,
distance, threshold}\` to \`drift.evaluated\`, keyed by the window, with \`acks=1\` and no wait for the
delivery report, and returns \`True\`. Evaluations show up on the topic; it hides five flaws.

**Failure mode the checks target.** One monitor's events land on whichever partition their window
hashes to, so the history consumer can apply a recovery before the crossing; every quiet tick is an
event that buries the crossings; an event names neither its window nor its sample count; a lost
acknowledgement writes an event twice and a failover drops one; and a broker that does not answer
erases the crossing.

- The record key is the **monitor id**.
- A crossing (\`distance >= threshold\`) publishes \`type: "drift.crossed"\`. A quiet evaluation calls
  \`store.count_quiet(monitor_id)\` and publishes only every \`SUMMARY_EVERY\` = 60th, as
  \`type: "drift.summary"\` with \`quiet_ticks: 60\`.
- The event carries \`monitor_id\`, \`metric\`, \`distance\`, \`threshold\`, \`window_start\`,
  \`window_end\` (\`window + window_s\`) and \`sample_count\`.
- The producer is **idempotent** with **\`acks=all\`** (Go uses confluent-kafka-go: kafka-go has no
  idempotent producer).
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` = 2 s; when it fails or does not come, call
  \`store.insert_outbox(TOPIC, monitor_id, event)\` and return \`False\`.`,
  sequence: {
    participants: ['Window evaluator', 'Monitor store', 'Kafka drift.evaluated', 'Outbox'],
    messages: [
      {
        from: 'Window evaluator',
        to: 'Monitor store',
        label: 'quiet: count_quiet(m-1) → 59, nothing to publish',
        kind: 'sync',
      },
      {
        from: 'Window evaluator',
        to: 'Kafka drift.evaluated',
        label: 'drift.crossed · key = m-1 · idempotent · acks=all',
        kind: 'sync',
      },
      {
        from: 'Kafka drift.evaluated',
        to: 'Window evaluator',
        label: 'delivery report within 2 s → True',
        kind: 'reply',
      },
      {from: 'Kafka drift.evaluated', to: 'Window evaluator', label: 'failed / no report', kind: 'reply'},
      {from: 'Window evaluator', to: 'Outbox', label: 'insert_outbox(topic, m-1, event) → False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'monitor-key',
      title: 'Keys drift.evaluated by monitor id',
      detail:
        'The record key is the monitor id, so one monitor’s events share a partition and stay in order; keyed by the window, one monitor’s history spreads over every partition.',
      match: {
        python: {all: [/key\s*=\s*monitor\[["']monitor_id["']\]/], none: [/key\s*=\s*str\(window\)/]},
        typescript: {all: [/key:\s*monitor\.monitor_id/], none: [/key:\s*String\(window\)/]},
        go: {all: [/Key:\s*\[\]byte\(monitor\.MonitorID\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(\s*Topic\s*,\s*monitor\.monitorId/]},
        cpp: {all: [/monitor\.monitor_id\.c_str\(\),\s*monitor\.monitor_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'crossings-only',
      title: 'Publishes crossings, summarizes quiet ticks',
      detail:
        'A crossing publishes `drift.crossed`; a quiet evaluation is counted (`count_quiet`/`countQuiet`) and only every `SUMMARY_EVERY` = 60th publishes a `drift.summary` with `quiet_ticks`.',
      match: {
        python: {all: [/SUMMARY_EVERY\s*=\s*60\b/, /store\.count_quiet\(/]},
        typescript: {all: [/SUMMARY_EVERY\s*=\s*60\b/, /countQuiet\(/]},
        go: {all: [/summaryEvery\s*=\s*60\b/, /store\.CountQuiet\(/]},
        scala: {all: [/SummaryEvery\s*=\s*60\b/, /Store\.countQuiet\(/]},
        cpp: {all: [/kSummaryEvery\s*=\s*60\b/, /store::countQuiet\(/]},
      },
    },
    {
      id: 'payload-evidence',
      title: 'Carries the window and the sample count',
      detail:
        'The event carries `window_start`, `window_end` and `sample_count` next to the metric, distance and threshold, so a consumer can join it to a report and judge it.',
      match: {
        python: {all: [/["']window_start["']/, /["']window_end["']/, /["']sample_count["']/]},
        typescript: {all: [/window_start:/, /window_end:/, /sample_count:/]},
        go: {all: [/"window_start"/, /"window_end"/, /"sample_count"/]},
        scala: {all: [/"window_start"/, /"window_end"/, /"sample_count"/]},
        cpp: {all: [/"window_start"/, /"window_end"/, /"sample_count"/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover; the starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the event, and the call returns false; the starter fires and forgets.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/, /isFailure|Failure|catch/]},
        cpp: {all: [/store::insertOutbox\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from drift import store  # count_quiet, insert_outbox

TOPIC = "drift.evaluated"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_evaluation(monitor: dict, window: int, distance: float, sample_count: int) -> bool:
    """Record one evaluation of a window in the drift history; True when an event was acknowledged."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    event = {
        "type": "drift.evaluated",
        "monitor_id": monitor["monitor_id"],
        "metric": monitor["metric"],
        "distance": distance,
        "threshold": monitor["threshold"],
    }
    producer.produce(TOPIC, key=str(window), value=json.dumps(event))
    producer.poll(0)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from drift import store  # count_quiet, insert_outbox

TOPIC = "drift.evaluated"
SUMMARY_EVERY = 60
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def publish_evaluation(monitor: dict, window: int, distance: float, sample_count: int) -> bool:
    """Record one evaluation of a window in the drift history; True when an event was acknowledged."""
    crossed = distance >= monitor["threshold"]
    event = {
        "type": "drift.crossed" if crossed else "drift.summary",
        "monitor_id": monitor["monitor_id"],
        "metric": monitor["metric"],
        "distance": distance,
        "threshold": monitor["threshold"],
        "window_start": window,
        "window_end": window + monitor["window_s"],
        "sample_count": sample_count,
    }
    if not crossed:
        # Quiet ticks are counted, and only every SUMMARY_EVERY-th one reaches the history.
        if store.count_quiet(monitor["monitor_id"]) % SUMMARY_EVERY != 0:
            return False
        event["quiet_ticks"] = SUMMARY_EVERY
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=monitor["monitor_id"], value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the history is late, not wrong.
        store.insert_outbox(TOPIC, monitor["monitor_id"], event)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Monitor, countQuiet, insertOutbox} from 'drift/store';

export const TOPIC = 'drift.evaluated';

const kafka = new Kafka({clientId: 'driftd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Record one evaluation of a window in the drift history; true when an event was acknowledged. */
export async function publishEvaluation(monitor: Monitor, window: number, distance: number, sampleCount: number): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const event = {
    type: 'drift.evaluated',
    monitor_id: monitor.monitor_id,
    metric: monitor.metric,
    distance,
    threshold: monitor.threshold,
  };
  void producer.send({topic: TOPIC, messages: [{key: String(window), value: JSON.stringify(event)}], acks: 1});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Monitor, countQuiet, insertOutbox} from 'drift/store';

export const TOPIC = 'drift.evaluated';
export const SUMMARY_EVERY = 60;
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'driftd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Record one evaluation of a window in the drift history; true when an event was acknowledged. */
export async function publishEvaluation(monitor: Monitor, window: number, distance: number, sampleCount: number): Promise<boolean> {
  const crossed = distance >= monitor.threshold;
  const event: Record<string, unknown> = {
    type: crossed ? 'drift.crossed' : 'drift.summary',
    monitor_id: monitor.monitor_id,
    metric: monitor.metric,
    distance,
    threshold: monitor.threshold,
    window_start: window,
    window_end: window + monitor.window_s,
    sample_count: sampleCount,
  };
  if (!crossed) {
    // Quiet ticks are counted, and only every SUMMARY_EVERY-th one reaches the history.
    if ((await countQuiet(monitor.monitor_id)) % SUMMARY_EVERY !== 0) return false;
    event.quiet_ticks = SUMMARY_EVERY;
  }
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: monitor.monitor_id, value: JSON.stringify(event)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the history is late, not wrong.
    await insertOutbox(TOPIC, monitor.monitor_id, event);
    return false;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"drift/store" // store.Monitor, CountQuiet, InsertOutbox
)

const topic = "drift.evaluated"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// publishEvaluation records one evaluation of a window in the drift history; true when an event was acknowledged.
func publishEvaluation(ctx context.Context, monitor store.Monitor, window int64, distance float64, sampleCount int64) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	event := map[string]any{
		"type":       "drift.evaluated",
		"monitor_id": monitor.MonitorID,
		"metric":     monitor.Metric,
		"distance":   distance,
		"threshold":  monitor.Threshold,
	}
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(strconv.FormatInt(window, 10)), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"drift/store" // store.Monitor, CountQuiet, InsertOutbox
)

const (
	topic        = "drift.evaluated"
	summaryEvery = 60
	ackTimeout   = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// publishEvaluation records one evaluation of a window in the drift history; true when an event was acknowledged.
func publishEvaluation(ctx context.Context, monitor store.Monitor, window int64, distance float64, sampleCount int64) (bool, error) {
	crossed := distance >= monitor.Threshold
	event := map[string]any{
		"type":         "drift.crossed",
		"monitor_id":   monitor.MonitorID,
		"metric":       monitor.Metric,
		"distance":     distance,
		"threshold":    monitor.Threshold,
		"window_start": window,
		"window_end":   window + monitor.WindowS,
		"sample_count": sampleCount,
	}
	if !crossed {
		// Quiet ticks are counted, and only every summaryEvery-th one reaches the history.
		if store.CountQuiet(ctx, monitor.MonitorID)%summaryEvery != 0 {
			return false, nil
		}
		event["type"] = "drift.summary"
		event["quiet_ticks"] = summaryEvery
	}
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(monitor.MonitorID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the history is late, not wrong.
		return false, store.InsertOutbox(ctx, topic, monitor.MonitorID, event)
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import drift.Store // Store.Monitor, countQuiet, insertOutbox

object Events {
  val Topic = "drift.evaluated"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Record one evaluation of a window in the drift history; true when an event was acknowledged. */
  def publishEvaluation(monitor: Store.Monitor, window: Long, distance: Double, sampleCount: Long): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val event = JsObject(
      "type" -> JsString("drift.evaluated"),
      "monitor_id" -> JsString(monitor.monitorId),
      "metric" -> JsString(monitor.metric),
      "distance" -> JsNumber(distance),
      "threshold" -> JsNumber(monitor.threshold))
    producer.send(new ProducerRecord[String, String](Topic, window.toString, event.compactPrint))
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import drift.Store // Store.Monitor, countQuiet, insertOutbox

object Events {
  val Topic = "drift.evaluated"
  val SummaryEvery = 60
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Record one evaluation of a window in the drift history; true when an event was acknowledged. */
  def publishEvaluation(monitor: Store.Monitor, window: Long, distance: Double, sampleCount: Long): Boolean = {
    val crossed = distance >= monitor.threshold
    val evidence = JsObject(
      "type" -> JsString(if (crossed) "drift.crossed" else "drift.summary"),
      "monitor_id" -> JsString(monitor.monitorId),
      "metric" -> JsString(monitor.metric),
      "distance" -> JsNumber(distance),
      "threshold" -> JsNumber(monitor.threshold),
      "window_start" -> JsNumber(window),
      "window_end" -> JsNumber(window + monitor.windowS),
      "sample_count" -> JsNumber(sampleCount))
    // Quiet ticks are counted, and only every SummaryEvery-th one reaches the history.
    if (!crossed && Store.countQuiet(monitor.monitorId) % SummaryEvery != 0) return false
    val event = if (crossed) evidence else JsObject(evidence.fields + ("quiet_ticks" -> JsNumber(SummaryEvery)))
    val record = new ProducerRecord[String, String](Topic, monitor.monitorId, event.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the history is late, not wrong.
      Store.insertOutbox(Topic, monitor.monitorId, event)
    }
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "drift/store.h"  // store::Monitor, countQuiet, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "drift.evaluated";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Record one evaluation of a window in the drift history; true when an event was acknowledged.
bool publishEvaluation(const store::Monitor& monitor, long window, double distance, long sample_count) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const json event = {{"type", "drift.evaluated"},
                      {"monitor_id", monitor.monitor_id},
                      {"metric", monitor.metric},
                      {"distance", distance},
                      {"threshold", monitor.threshold}};
  const std::string value = event.dump();
  const std::string key = std::to_string(window);
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), key.c_str(), key.size(), 0, nullptr);
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "drift/store.h"  // store::Monitor, countQuiet, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "drift.evaluated";
constexpr long kSummaryEvery = 60;
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishEvaluation produces one record and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Record one evaluation of a window in the drift history; true when an event was acknowledged.
bool publishEvaluation(const store::Monitor& monitor, long window, double distance, long sample_count) {
  const bool crossed = distance >= monitor.threshold;
  json event = {{"type", crossed ? "drift.crossed" : "drift.summary"},
                {"monitor_id", monitor.monitor_id},
                {"metric", monitor.metric},
                {"distance", distance},
                {"threshold", monitor.threshold},
                {"window_start", window},
                {"window_end", window + monitor.window_s},
                {"sample_count", sample_count}};
  if (!crossed) {
    // Quiet ticks are counted, and only every kSummaryEvery-th one reaches the history.
    if (store::countQuiet(monitor.monitor_id) % kSummaryEvery != 0) return false;
    event["quiet_ticks"] = kSummaryEvery;
  }
  const std::string value = event.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), monitor.monitor_id.c_str(), monitor.monitor_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the history is late, not wrong.
    store::insertOutbox(kTopic, monitor.monitor_id, event);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "drift.evaluated"
M1 = {"monitor_id": "m-1", "tenant": "t1", "model_version": "v3", "metric": "input_distribution", "window_s": 300, "baseline": "baseline:v3:2026-10-01", "threshold": 0.2}
M2 = {**M1, "monitor_id": "m-2"}
CROSSED = {"type": "drift.crossed", "monitor_id": "m-1", "metric": "input_distribution", "distance": 0.31, "threshold": 0.2, "window_start": 900, "window_end": 1200, "sample_count": 640}


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_monitor_key(ctx):
    m = ctx.load("events")
    m.publish_evaluation(M1, 900, 0.31, 640)
    m.publish_evaluation(M2, 900, 0.35, 700)
    m.publish_evaluation(M1, 1200, 0.33, 650)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three crossings produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"m-1", b"m-2", b"m-1"], f"the records are keyed {keys}, expected the monitor ids m-1, m-2, m-1"
    assert records[0].partition == records[2].partition, "both m-1 events must land on one partition, or the history consumer sees one monitor's events out of order"


def check_crossings_only(ctx):
    m = ctx.load("events")
    for _ in range(59):
        m.publish_evaluation(M1, 900, 0.05, 640)
    assert len(ctx.kafka.records(TOPIC)) == 0, f"59 quiet evaluations put {len(ctx.kafka.records(TOPIC))} events on {TOPIC}: quiet ticks are counted (store.count_quiet) and summarized every 60th, not published one by one"
    m.publish_evaluation(M1, 900, 0.05, 640)
    events = _events(ctx)
    assert len(events) == 1 and events[0].get("type") == "drift.summary" and events[0].get("quiet_ticks") == 60, f"the 60th quiet evaluation must publish one drift.summary with quiet_ticks 60, the topic holds {events}"
    m.publish_evaluation(M1, 900, 0.31, 640)
    events = _events(ctx)
    assert len(events) == 2 and events[1].get("type") == "drift.crossed", f"a crossing must publish a drift.crossed event at once, the topic holds {events}"


def check_payload_evidence(ctx):
    m = ctx.load("events")
    m.publish_evaluation(M1, 900, 0.31, 640)
    events = _events(ctx)
    assert len(events) == 1, f"one crossing produced {len(events)} events"
    seen = {name: events[0].get(name) for name in CROSSED}
    assert seen == CROSSED, f"the event carries {events[0]}, expected {CROSSED}: without the window and the sample count a consumer cannot join it to a report or judge it"


def check_idempotent_acks(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_evaluation(M1, 900, 0.31, 640)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_evaluation(M1, 1200, 0.33, 650)
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_fallback(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_evaluation(M1, 900, 0.31, 640)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the crossing is gone from the history"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "m-1" and rows[0].get("payload", {}).get("window_start") == 900, f"the outbox row is {rows[0]}, expected the topic, the key m-1 and the event"
    assert ok is False, f"publish_evaluation returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_evaluation(M1, 1200, 0.33, 650)
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_evaluation waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("window_start") == 1200, f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_evaluation returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'drift.evaluated';
const M1 = {monitor_id: 'm-1', tenant: 't1', model_version: 'v3', metric: 'input_distribution', window_s: 300, baseline: 'baseline:v3:2026-10-01', threshold: 0.2};
const M2 = {...M1, monitor_id: 'm-2'};
const CROSSED = {type: 'drift.crossed', monitor_id: 'm-1', metric: 'input_distribution', distance: 0.31, threshold: 0.2, window_start: 900, window_end: 1200, sample_count: 640};

const events = ctx => (ctx.kafka.values(TOPIC) as string[]).map(value => JSON.parse(value));
const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_monitor_key(ctx) {
  const m = ctx.load('events');
  await m.publishEvaluation(M1, 900, 0.31, 640);
  await m.publishEvaluation(M2, 900, 0.35, 700);
  await m.publishEvaluation(M1, 1200, 0.33, 650);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three crossings produced \${records.length} records on \${TOPIC}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['m-1', 'm-2', 'm-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the monitor ids m-1, m-2, m-1\`);
  assert.equal(records[0].partition, records[2].partition, "both m-1 events must land on one partition, or the history consumer sees one monitor's events out of order");
}

export async function check_crossings_only(ctx) {
  const m = ctx.load('events');
  for (let i = 0; i < 59; i += 1) await m.publishEvaluation(M1, 900, 0.05, 640);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 0, \`59 quiet evaluations put \${ctx.kafka.records(TOPIC).length} events on \${TOPIC}: quiet ticks are counted (countQuiet) and summarized every 60th, not published one by one\`);
  await m.publishEvaluation(M1, 900, 0.05, 640);
  await settle();
  let seen = events(ctx);
  assert(seen.length === 1 && seen[0].type === 'drift.summary' && seen[0].quiet_ticks === 60, \`the 60th quiet evaluation must publish one drift.summary with quiet_ticks 60, the topic holds \${JSON.stringify(seen)}\`);
  await m.publishEvaluation(M1, 900, 0.31, 640);
  await settle();
  seen = events(ctx);
  assert(seen.length === 2 && seen[1].type === 'drift.crossed', \`a crossing must publish a drift.crossed event at once, the topic holds \${JSON.stringify(seen)}\`);
}

export async function check_payload_evidence(ctx) {
  const m = ctx.load('events');
  await m.publishEvaluation(M1, 900, 0.31, 640);
  await settle();
  const seen = events(ctx);
  assert.equal(seen.length, 1, \`one crossing produced \${seen.length} events\`);
  const picked = Object.fromEntries(Object.keys(CROSSED).map(name => [name, seen[0][name]]));
  assert.deepStrictEqual(picked, CROSSED, \`the event carries \${JSON.stringify(seen[0])}, expected \${JSON.stringify(CROSSED)}: without the window and the sample count a consumer cannot join it to a report or judge it\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishEvaluation(M1, 900, 0.31, 640);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publishEvaluation(M1, 1200, 0.33, 650);
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_fallback(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishEvaluation(M1, 900, 0.31, 640);
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the crossing is gone from the history\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'm-1' && rows[0].payload?.window_start === 900, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key m-1 and the event\`);
  assert.equal(ok, false, \`publishEvaluation resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishEvaluation(M1, 1200, 0.33, 650);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishEvaluation waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.window_start === 1200, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishEvaluation resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"drift/store"

	"leetbuild/harness"
)

var (
	m1      = store.Monitor{MonitorID: "m-1", Tenant: "t1", ModelVersion: "v3", Metric: "input_distribution", WindowS: 300, Baseline: "baseline:v3:2026-10-01", Threshold: 0.2}
	m2      = store.Monitor{MonitorID: "m-2", Tenant: "t1", ModelVersion: "v3", Metric: "input_distribution", WindowS: 300, Baseline: "baseline:v3:2026-10-01", Threshold: 0.2}
	crossed = map[string]any{"type": "drift.crossed", "monitor_id": "m-1", "metric": "input_distribution", "distance": 0.31, "threshold": 0.2, "window_start": 900, "window_end": 1200, "sample_count": 640}
)

func evaluate(ctx *harness.Ctx, m store.Monitor, window int64, distance float64, samples int64) bool {
	ok, err := publishEvaluation(context.Background(), m, window, distance, samples)
	ctx.NoError(err, "publishEvaluation(%s, %d, %v) failed", m.MonitorID, window, distance)
	return ok
}

func driftEvents(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, value := range ctx.Kafka.Values(topic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(value), &e), "an event must be JSON, got %s", value)
		out = append(out, e)
	}
	return out
}

type outboxRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func outbox(ctx *harness.Ctx) []outboxRow {
	var rows []outboxRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row outboxRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckMonitorKey(ctx *harness.Ctx) {
	evaluate(ctx, m1, 900, 0.31, 640)
	evaluate(ctx, m2, 900, 0.35, 700)
	evaluate(ctx, m1, 1200, 0.33, 650)
	ctx.Settle()
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 3, "three crossings must produce three records on %s; the records", topic)
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"m-1", "m-2", "m-1"}, "the records must be keyed by the monitor ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both m-1 events must land on one partition, or the history consumer sees one monitor's events out of order; the partitions")
}

func CheckCrossingsOnly(ctx *harness.Ctx) {
	for i := 0; i < 59; i++ {
		evaluate(ctx, m1, 900, 0.05, 640)
	}
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 0, "59 quiet evaluations must publish nothing (quiet ticks are counted with store.CountQuiet and summarized every 60th); the events on %s", topic)
	evaluate(ctx, m1, 900, 0.05, 640)
	ctx.Settle()
	seen := driftEvents(ctx)
	ctx.Assert(len(seen) == 1 && seen[0]["type"] == "drift.summary" && seen[0]["quiet_ticks"] == float64(60), "the 60th quiet evaluation must publish one drift.summary with quiet_ticks 60, the topic holds %v", seen)
	evaluate(ctx, m1, 900, 0.31, 640)
	ctx.Settle()
	seen = driftEvents(ctx)
	ctx.Assert(len(seen) == 2 && seen[1]["type"] == "drift.crossed", "a crossing must publish a drift.crossed event at once, the topic holds %v", seen)
}

func CheckPayloadEvidence(ctx *harness.Ctx) {
	evaluate(ctx, m1, 900, 0.31, 640)
	ctx.Settle()
	seen := driftEvents(ctx)
	ctx.Equal(len(seen), 1, "one crossing must produce one event; the events")
	picked := map[string]any{}
	for name := range crossed {
		picked[name] = seen[0][name]
	}
	ctx.Equal(picked, crossed, "the event must carry the window and the sample count, or a consumer cannot join it to a report or judge it")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(topic, 1) // the broker wrote it, the acknowledgement never arrived
	evaluate(ctx, m1, 900, 0.31, 640)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	evaluate(ctx, m1, 1200, 0.33, 650)
	ctx.Settle()
	ctx.Kafka.Failover(topic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxFallback(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(topic, 1)
	ok := evaluate(ctx, m1, 900, 0.31, 640)
	ctx.Settle()
	rows := outbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the crossing is gone from the history; the rows")
	ctx.Assert(rows[0].Topic == topic && rows[0].Key == "m-1" && rows[0].Payload["window_start"] == float64(900), "the outbox row is %v, expected the topic, the key m-1 and the event", rows[0])
	ctx.Equal(ok, false, "publishEvaluation's result after a failed delivery")
	ctx.Kafka.Stall(topic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = evaluate(ctx, m1, 1200, 0.33, 650)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishEvaluation waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = outbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["window_start"] == float64(1200), "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishEvaluation's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "drift/store.h"

using json = nlohmann::json;

namespace {

const store::Monitor kM1{"m-1", "t1", "v3", "input_distribution", 300, "baseline:v3:2026-10-01", 0.2};
const store::Monitor kM2{"m-2", "t1", "v3", "input_distribution", 300, "baseline:v3:2026-10-01", 0.2};
const json kCrossed = {{"type", "drift.crossed"}, {"monitor_id", "m-1"}, {"metric", "input_distribution"}, {"distance", 0.31},
                       {"threshold", 0.2},       {"window_start", 900}, {"window_end", 1200},                {"sample_count", 640}};

std::vector<json> driftEvents(harness::Ctx& ctx) {
  std::vector<json> out;
  for (const auto& value : ctx.Kafka.Values(kTopic)) out.push_back(json::parse(value, nullptr, false));
  return out;
}

std::vector<json> outbox(harness::Ctx& ctx) {
  std::vector<json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

long windowOf(const json& row) {
  return row.contains("payload") && row["payload"].is_object() ? row["payload"].value("window_start", 0L) : 0L;
}

}  // namespace

void CheckMonitorKey(harness::Ctx& ctx) {
  publishEvaluation(kM1, 900, 0.31, 640);
  publishEvaluation(kM2, 900, 0.35, 700);
  publishEvaluation(kM1, 1200, 0.33, 650);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three crossings must produce three records on %s; the records", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"m-1", "m-2", "m-1"}, "the records must be keyed by the monitor ids");
  ctx.Equal(records[0].Partition, records[2].Partition, "both m-1 events must land on one partition, or the history consumer sees one monitor's events out of order; the partitions");
}

void CheckCrossingsOnly(harness::Ctx& ctx) {
  for (int i = 0; i < 59; i++) publishEvaluation(kM1, 900, 0.05, 640);
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "59 quiet evaluations must publish nothing (quiet ticks are counted with store::countQuiet and summarized every 60th); the events on %s", kTopic);
  publishEvaluation(kM1, 900, 0.05, 640);
  ctx.Settle();
  auto seen = driftEvents(ctx);
  ctx.Assert(seen.size() == 1 && seen[0].value("type", "") == "drift.summary" && seen[0].value("quiet_ticks", 0L) == 60, "the 60th quiet evaluation must publish one drift.summary with quiet_ticks 60, the topic holds %d events", seen.size());
  publishEvaluation(kM1, 900, 0.31, 640);
  ctx.Settle();
  seen = driftEvents(ctx);
  ctx.Assert(seen.size() == 2 && seen[1].value("type", "") == "drift.crossed", "a crossing must publish a drift.crossed event at once, the topic holds %d events", seen.size());
}

void CheckPayloadEvidence(harness::Ctx& ctx) {
  publishEvaluation(kM1, 900, 0.31, 640);
  ctx.Settle();
  const auto seen = driftEvents(ctx);
  ctx.Equal(seen.size(), 1, "one crossing must produce one event; the events");
  json picked = json::object();
  for (const auto& [name, value] : kCrossed.items()) picked[name] = seen[0].is_object() && seen[0].contains(name) ? seen[0][name] : json();
  ctx.Equal(picked, kCrossed, "the event must carry the window and the sample count, or a consumer cannot join it to a report or judge it");
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishEvaluation(kM1, 900, 0.31, 640);
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishEvaluation(kM1, 1200, 0.33, 650);
  ctx.Settle();
  ctx.Kafka.Failover(kTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxFallback(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  bool ok = publishEvaluation(kM1, 900, 0.31, 640);
  ctx.Settle();
  auto rows = outbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the crossing is gone from the history; the rows");
  ctx.Assert(rows[0].value("topic", "") == kTopic && rows[0].value("key", "") == "m-1" && windowOf(rows[0]) == 900, "the outbox row is %s, expected the topic, the key m-1 and the event", rows[0].dump());
  ctx.Equal(ok, false, "publishEvaluation's result after a failed delivery");
  ctx.Kafka.Stall(kTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishEvaluation(kM1, 1200, 0.33, 650);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishEvaluation waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = outbox(ctx);
  ctx.Assert(rows.size() == 2 && windowOf(rows[1]) == 1200, "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishEvaluation's result without a delivery report");
}
`,
  },
  hints: [
    'Replay one monitor’s history from the topic: a recovery arrives before the crossing it recovers from, quiet ticks outnumber crossings a thousand to one, and after a broker outage the crossing that paged is missing.',
    'The key is the window, so one monitor’s events hash to many partitions. Every evaluation is produced, none carries its window or counts, and the produce is never waited on, so a failed delivery goes unnoticed.',
    'Key by `monitor_id`; publish crossings, and every 60th `store.count_quiet` as a summary; add `window_start`, `window_end`, `sample_count`; set `enable.idempotence` with `acks=all`; wait for `on_delivery` through `flush(ACK_TIMEOUT_S)` and `store.insert_outbox` otherwise.',
  ],
  debrief: `The key decides what stays ordered, and the history has to answer questions per monitor, so the monitor id is the key. Summarizing quiet ticks keeps the topic about decisions: a reader scanning a monitor's history sees crossings and a heartbeat every sixty evaluations, not a wall of numbers. Waiting for the delivery report is what gives the return value a meaning, and the outbox is what turns a broker outage into a late event instead of a lost one; idempotence closes the gap that waiting opens, the retry after a lost acknowledgement. Production systems write the outbox row in the same transaction as the evaluation and let a relay do every produce, and register the event schema so a consumer is never surprised by a field.`,
};
