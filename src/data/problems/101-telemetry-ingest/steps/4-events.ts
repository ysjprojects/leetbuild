import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Windowed rollups keyed by device, with an outbox',
  concept: 'kafka',
  file: 'events',
  focus: ['ingest', 'kafka', 'rollup', 'redis'],
  task: `## Task

**Starting point.** The starter implements \`publish_rollup(device_id, samples)\`, which tells the
rollup consumer what a device sent: it groups the samples by metric, produces one
\`{"device_id", "metric", "samples"}\` record per metric to \`telemetry.rollup\` keyed by the metric
name, from a producer with \`acks=1\`, and returns \`True\` without waiting for the broker. The demo
shows the topic filling. It hides five flaws.

**Failure mode the checks target.** A device's windows land on different partitions and arrive out of
order; the topic carries every raw reading, so it is as large as the store it summarises; no event
says which minute it covers; a retry after a lost acknowledgement writes a rollup twice and a leader
failover loses one; and a broker that refuses or stalls drops the window for good.

- One event per device and **60-second window** (\`WINDOW_S\`; \`window_start = ts - ts % 60\`), keyed
  by \`device_id\`.
- The payload is \`{"device_id", "window_start", "buckets": {metric: {"mean", "count", "max"}}}\`,
  with no raw samples.
- The producer is idempotent with \`acks=all\`.
- Wait at most \`ACK_TIMEOUT_S = 2\` for each event's delivery report; when it fails or does not
  come, insert \`{topic, key, payload}\` with \`outbox.insert\` and return \`False\`.`,
  sequence: {
    participants: ['Telemetry Ingest', 'telemetry.rollup', 'Outbox', 'Rollup consumer'],
    messages: [
      {
        from: 'Telemetry Ingest',
        to: 'telemetry.rollup',
        label: 'produce key=d-1 · {window_start, buckets{mean, count, max}} · idempotent, acks=all',
        kind: 'sync',
      },
      {from: 'telemetry.rollup', to: 'Telemetry Ingest', label: 'delivery report within 2 s', kind: 'reply'},
      {
        from: 'Telemetry Ingest',
        to: 'Outbox',
        label: 'insert(topic, key, payload) when refused or late',
        kind: 'async',
      },
      {
        from: 'telemetry.rollup',
        to: 'Rollup consumer',
        label: 'one device, one partition, in window order',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'device-key',
      title: 'Keys every rollup by the device id',
      detail:
        "Rollups for d-1, d-2, d-1 carry those keys and both d-1 records share a partition, so a consumer reads one device's windows in order. The starter keys by the metric name.",
      match: {
        python: {all: [/key\s*=\s*(device_id|event\[["']device_id["']\])/], none: [/key\s*=\s*metric/]},
        typescript: {all: [/key:\s*(deviceId|event\.device_id)\b/], none: [/key:\s*metric\b/]},
        go: {all: [/Key:\s*\[\]byte\((deviceID|event\.DeviceID)\)/], none: [/Key:\s*\[\]byte\(metric\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*deviceId/], none: [/\(Topic,\s*metric/]},
        cpp: {
          all: [/(key|device_id)\.c_str\(\),\s*(key|device_id)\.size\(\)/],
          none: [/metric\.c_str\(\)/],
        },
      },
    },
    {
      id: 'bucketed-payload',
      title: 'Carries per-metric mean, count and max, not raw samples',
      detail:
        'Five samples of one window produce one event whose `buckets` hold each metric’s mean, count and max, and no `samples` field. The starter ships every raw reading, one record per metric.',
      match: {
        python: {all: [/["']mean["']/, /["']count["']/, /["']max["']/], none: [/["']samples["']\s*:/]},
        typescript: {all: [/\bmean:/, /\bcount:/, /\bmax:/], none: [/samples:\s*points/]},
        go: {all: [/json:"mean"/, /json:"count"/, /json:"max"/], none: [/"samples":/]},
        scala: {all: [/"mean"/, /"count"/, /"max"/], none: [/"samples"\s*->/]},
        cpp: {all: [/"mean"/, /"count"/, /"max"/], none: [/\{"samples",/]},
      },
    },
    {
      id: 'window-events',
      title: 'One event per 60-second window, named by window_start',
      detail:
        'Samples that span two windows produce two events with `window_start` 60 seconds apart, each counting only its own samples. The starter names no window, so a consumer cannot tell which minute a value belongs to.',
      match: {
        python: {all: [/window_start/, /%\s*WINDOW_S/]},
        typescript: {all: [/window_start/, /%\s*WINDOW_S/]},
        go: {all: [/window_start/, /%\s*windowS/]},
        scala: {all: [/window_start/, /%\s*WindowSeconds/]},
        cpp: {all: [/window_start/, /%\s*kWindowS/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'An idempotent producer with acks=all',
      detail:
        'A rollup whose acknowledgement was lost is retried and lands once; a rollup survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A refused delivery, or none within 2 s, leaves an outbox row with the topic, the device key and the rollup, and the call returns false. The starter never looks at the broker’s answer.',
      match: {
        python: {all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/\binsert\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /time\.After\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insert\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/outbox::insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from ingestd import outbox  # outbox.insert(topic, key, payload)

TOPIC = "telemetry.rollup"
WINDOW_S = 60

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_rollup(device_id: str, samples: list[dict]) -> bool:
    """Summarise a device's samples ({"metric", "value", "ts"}) on telemetry.rollup; True once the broker has every event."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    by_metric = {}
    for sample in samples:
        by_metric.setdefault(sample["metric"], []).append(sample)
    for metric, points in by_metric.items():
        payload = {"device_id": device_id, "metric": metric, "samples": points}
        producer.produce(TOPIC, key=metric, value=json.dumps(payload))
    producer.poll(0)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from ingestd import outbox  # outbox.insert(topic, key, payload)

TOPIC = "telemetry.rollup"
WINDOW_S = 60
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the rollup before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def rollups(device_id: str, samples: list[dict]) -> list[dict]:
    """One event per window: each metric's mean, count and max over the window's samples."""
    windows: dict[int, dict[str, list[float]]] = {}
    for sample in samples:
        start = sample["ts"] - sample["ts"] % WINDOW_S
        windows.setdefault(start, {}).setdefault(sample["metric"], []).append(sample["value"])
    return [
        {
            "device_id": device_id,
            "window_start": start,
            "buckets": {metric: {"mean": sum(v) / len(v), "count": len(v), "max": max(v)} for metric, v in sorted(metrics.items())},
        }
        for start, metrics in sorted(windows.items())
    ]


def send_rollup(event: dict) -> bool:
    """Produce one rollup and wait for its delivery report; a refused or late one goes to the outbox."""
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=event["device_id"], value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so the window is late, not lost.
        outbox.insert(TOPIC, event["device_id"], event)
        return False
    return True


def publish_rollup(device_id: str, samples: list[dict]) -> bool:
    """Summarise a device's samples ({"metric", "value", "ts"}) on telemetry.rollup; True once the broker has every event."""
    delivered = True
    for event in rollups(device_id, samples):
        delivered = send_rollup(event) and delivered
    return delivered
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {insert} from 'ingestd/outbox';
import type {Sample} from 'ingestd/wal';

export const TOPIC = 'telemetry.rollup';
export const WINDOW_S = 60;

const kafka = new Kafka({clientId: 'ingestd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Summarise a device's samples on telemetry.rollup; true once the broker has every event. */
export async function publishRollup(deviceId: string, samples: Sample[]): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const byMetric = new Map<string, Sample[]>();
  for (const sample of samples) byMetric.set(sample.metric, [...(byMetric.get(sample.metric) ?? []), sample]);
  for (const [metric, points] of byMetric) {
    void producer.send({topic: TOPIC, messages: [{key: metric, value: JSON.stringify({device_id: deviceId, metric, samples: points})}], acks: 1});
  }
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {insert} from 'ingestd/outbox';
import type {Sample} from 'ingestd/wal';

export const TOPIC = 'telemetry.rollup';
export const WINDOW_S = 60;
export const ACK_TIMEOUT_MS = 2000;

export interface Bucket {
  mean: number;
  count: number;
  max: number;
}

export interface Rollup {
  device_id: string;
  window_start: number;
  buckets: Record<string, Bucket>;
}

const kafka = new Kafka({clientId: 'ingestd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One event per window: each metric's mean, count and max over the window's samples. */
export function rollups(deviceId: string, samples: Sample[]): Rollup[] {
  const windows = new Map<number, Map<string, number[]>>();
  for (const sample of samples) {
    const start = sample.ts - (sample.ts % WINDOW_S);
    const metrics = windows.get(start) ?? new Map<string, number[]>();
    metrics.set(sample.metric, [...(metrics.get(sample.metric) ?? []), sample.value]);
    windows.set(start, metrics);
  }
  return [...windows.keys()]
    .sort((a, b) => a - b)
    .map(start => {
      const buckets: Record<string, Bucket> = {};
      for (const [metric, values] of windows.get(start) ?? []) {
        buckets[metric] = {mean: values.reduce((sum, v) => sum + v, 0) / values.length, count: values.length, max: Math.max(...values)};
      }
      return {device_id: deviceId, window_start: start, buckets};
    });
}

/** Produce one rollup and wait for the broker; a refused or late one goes to the outbox. */
async function sendRollup(event: Rollup): Promise<boolean> {
  try {
    // acks: -1 (all): every in-sync replica has the rollup before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: event.device_id, value: JSON.stringify(event)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay produces the row later, so the window is late, not lost.
    await insert(TOPIC, event.device_id, {...event});
    return false;
  }
}

/** Summarise a device's samples on telemetry.rollup; true once the broker has every event. */
export async function publishRollup(deviceId: string, samples: Sample[]): Promise<boolean> {
  let delivered = true;
  for (const event of rollups(deviceId, samples)) delivered = (await sendRollup(event)) && delivered;
  return delivered;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"ingestd/wal" // wal.Sample
)

const (
	topic   = "telemetry.rollup"
	windowS = 60
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// publishRollup summarises a device's samples on telemetry.rollup; true once the broker has every event.
func publishRollup(ctx context.Context, deviceID string, samples []wal.Sample) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	byMetric := map[string][]wal.Sample{}
	var order []string
	for _, s := range samples {
		if _, seen := byMetric[s.Metric]; !seen {
			order = append(order, s.Metric)
		}
		byMetric[s.Metric] = append(byMetric[s.Metric], s)
	}
	for _, metric := range order {
		value, _ := json.Marshal(map[string]any{"device_id": deviceID, "metric": metric, "samples": byMetric[metric]})
		t := topic
		msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(metric), Value: value}
		if err := producer.Produce(msg, nil); err != nil {
			return false, err
		}
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"ingestd/outbox" // outbox.Insert(ctx, topic, key, payload)
	"ingestd/wal"    // wal.Sample
)

const (
	topic      = "telemetry.rollup"
	windowS    = 60
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the rollup before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// Bucket summarises one metric over one window.
type Bucket struct {
	Mean  float64 \`json:"mean"\`
	Count int     \`json:"count"\`
	Max   float64 \`json:"max"\`
}

// Rollup is one event: a device's window.
type Rollup struct {
	DeviceID    string            \`json:"device_id"\`
	WindowStart int64             \`json:"window_start"\`
	Buckets     map[string]Bucket \`json:"buckets"\`
}

// rollups is one event per window: each metric's mean, count and max over the window's samples.
func rollups(deviceID string, samples []wal.Sample) []Rollup {
	windows := map[int64]map[string][]float64{}
	for _, s := range samples {
		start := s.TS - s.TS%windowS
		if windows[start] == nil {
			windows[start] = map[string][]float64{}
		}
		windows[start][s.Metric] = append(windows[start][s.Metric], s.Value)
	}
	starts := make([]int64, 0, len(windows))
	for start := range windows {
		starts = append(starts, start)
	}
	sort.Slice(starts, func(i, j int) bool { return starts[i] < starts[j] })
	events := make([]Rollup, 0, len(starts))
	for _, start := range starts {
		buckets := map[string]Bucket{}
		for metric, values := range windows[start] {
			b := Bucket{Count: len(values), Max: values[0]}
			sum := 0.0
			for _, v := range values {
				sum += v
				if v > b.Max {
					b.Max = v
				}
			}
			b.Mean = sum / float64(len(values))
			buckets[metric] = b
		}
		events = append(events, Rollup{DeviceID: deviceID, WindowStart: start, Buckets: buckets})
	}
	return events
}

// sendRollup produces one rollup and waits for its delivery report; a refused or late one goes to the outbox.
func sendRollup(ctx context.Context, event Rollup) (bool, error) {
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(event.DeviceID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no acknowledgement within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay produces the row later, so the window is late, not lost.
		return false, outbox.Insert(ctx, topic, event.DeviceID, event)
	}
	return true, nil
}

// publishRollup summarises a device's samples on telemetry.rollup; true once the broker has every event.
func publishRollup(ctx context.Context, deviceID string, samples []wal.Sample) (bool, error) {
	delivered := true
	for _, event := range rollups(deviceID, samples) {
		ok, err := sendRollup(ctx, event)
		if err != nil {
			return false, err
		}
		delivered = delivered && ok
	}
	return delivered, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import ingestd.{Outbox, Sample} // Outbox.insert(topic, key, payload)

object RollupEvents {
  val Topic = "telemetry.rollup"
  val WindowSeconds = 60L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Summarise a device's samples on telemetry.rollup; true once the broker has every event. */
  def publishRollup(deviceId: String, samples: Seq[Sample]): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    samples.groupBy(_.metric).foreach { case (metric, points) =>
      val raw = JsArray(points.map(s => JsObject("metric" -> JsString(s.metric), "value" -> JsNumber(s.value), "ts" -> JsNumber(s.ts))).toVector)
      val payload = JsObject("device_id" -> JsString(deviceId), "metric" -> JsString(metric), "samples" -> raw)
      producer.send(new ProducerRecord[String, String](Topic, metric, payload.compactPrint))
    }
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

import ingestd.{Outbox, Sample} // Outbox.insert(topic, key, payload)

object RollupEvents {
  val Topic = "telemetry.rollup"
  val WindowSeconds = 60L
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the rollup before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** One event per window: each metric's mean, count and max over the window's samples. */
  def rollups(deviceId: String, samples: Seq[Sample]): Seq[JsObject] =
    samples.groupBy(s => s.ts - s.ts % WindowSeconds).toSeq.sortBy(_._1).map { case (start, inWindow) =>
      val buckets = inWindow.groupBy(_.metric).map { case (metric, points) =>
        val values = points.map(_.value)
        metric -> JsObject("mean" -> JsNumber(values.sum / values.size), "count" -> JsNumber(values.size), "max" -> JsNumber(values.max))
      }
      JsObject("device_id" -> JsString(deviceId), "window_start" -> JsNumber(start), "buckets" -> JsObject(buckets))
    }

  /** Produce one rollup and wait for the broker; a refused or late one goes to the outbox. */
  private def sendRollup(deviceId: String, event: JsObject): Boolean = {
    val record = new ProducerRecord[String, String](Topic, deviceId, event.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    // The broker did not take it: the relay produces the row later, so the window is late, not lost.
    if (acked.isFailure) Outbox.insert(Topic, deviceId, event)
    acked.isSuccess
  }

  /** Summarise a device's samples on telemetry.rollup; true once the broker has every event. */
  def publishRollup(deviceId: String, samples: Seq[Sample]): Boolean =
    rollups(deviceId, samples).map(sendRollup(deviceId, _)).forall(identity)
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "ingestd/outbox.h"  // outbox::insert(topic, key, payload)
#include "ingestd/wal.h"     // wal::Sample

using json = nlohmann::json;

const std::string kTopic = "telemetry.rollup";
constexpr long long kWindowS = 60;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Summarise a device's samples on telemetry.rollup; true once the broker has every event.
bool publishRollup(const std::string& device_id, const std::vector<wal::Sample>& samples) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  std::map<std::string, json> by_metric;
  for (const wal::Sample& s : samples) by_metric[s.metric].push_back({{"metric", s.metric}, {"value", s.value}, {"ts", s.ts}});
  for (const auto& [metric, points] : by_metric) {
    const std::string value = json{{"device_id", device_id}, {"metric", metric}, {"samples", points}}.dump();
    producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                      metric.c_str(), metric.size(), 0, nullptr);
  }
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "ingestd/outbox.h"  // outbox::insert(topic, key, payload)
#include "ingestd/wal.h"     // wal::Sample

using json = nlohmann::json;

const std::string kTopic = "telemetry.rollup";
constexpr long long kWindowS = 60;
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the rollup in flight: sendRollup produces one record and waits for it.
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
  conf->set("acks", "all", err);                // every in-sync replica has the rollup before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// One event per window: each metric's mean, count and max over the window's samples.
std::vector<json> rollups(const std::string& device_id, const std::vector<wal::Sample>& samples) {
  std::map<long long, std::map<std::string, std::vector<double>>> windows;
  for (const wal::Sample& s : samples) windows[s.ts - s.ts % kWindowS][s.metric].push_back(s.value);
  std::vector<json> events;
  for (const auto& [start, metrics] : windows) {
    json buckets = json::object();
    for (const auto& [metric, values] : metrics) {
      double sum = 0;
      double peak = values.front();
      for (const double v : values) {
        sum += v;
        peak = std::max(peak, v);
      }
      buckets[metric] = {{"mean", sum / values.size()}, {"count", values.size()}, {"max", peak}};
    }
    events.push_back({{"device_id", device_id}, {"window_start", start}, {"buckets", buckets}});
  }
  return events;
}

// Produce one rollup and wait for its delivery report; a refused or late one goes to the outbox.
bool sendRollup(const json& event) {
  const std::string key = event["device_id"].get<std::string>();
  const std::string value = event.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), key.c_str(), key.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so the window is late, not lost.
    outbox::insert(kTopic, key, event);
    return false;
  }
  return true;
}

// Summarise a device's samples on telemetry.rollup; true once the broker has every event.
bool publishRollup(const std::string& device_id, const std::vector<wal::Sample>& samples) {
  bool delivered = true;
  for (const json& event : rollups(device_id, samples)) delivered = sendRollup(event) && delivered;
  return delivered;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "telemetry.rollup"
T0 = 1_800_000_000  # a window boundary


def _s(metric, value, ts):
    return {"metric": metric, "value": value, "ts": ts}


def _settle(m):
    """Serve the producer's delivery reports, as the writer's loop would between batches."""
    m.producer.poll(0)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_device_key(ctx):
    m = ctx.load("events")
    m.publish_rollup("d-1", [_s("temp_c", 20, T0 + 1), _s("humidity", 40, T0 + 2)])
    m.publish_rollup("d-2", [_s("temp_c", 25, T0 + 3)])
    m.publish_rollup("d-1", [_s("temp_c", 22, T0 + 61)])
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    keys = [r.key for r in records]
    assert keys == [b"d-1", b"d-2", b"d-1"], f"the rollups are keyed {keys}, expected the device ids d-1, d-2, d-1: keyed by anything else, one device's windows scatter across partitions"
    assert records[0].partition == records[2].partition, "both d-1 rollups must land on one partition, or a consumer reads its windows out of order"


def check_bucketed_payload(ctx):
    m = ctx.load("events")
    samples = [_s("temp_c", 20, T0 + 1), _s("temp_c", 22, T0 + 10), _s("temp_c", 27, T0 + 20), _s("humidity", 40, T0 + 5), _s("humidity", 44, T0 + 25)]
    m.publish_rollup("d-1", samples)
    _settle(m)
    events = _events(ctx)
    assert len(events) == 1, f"five samples of one window produced {len(events)} records, expected one rollup for the window: {events}"
    event = events[0]
    assert "samples" not in event, f"the rollup carries the raw samples: {event}. The topic is meant to be smaller than the store it summarises"
    buckets = event.get("buckets") or {}
    assert buckets.get("temp_c") == {"mean": 23, "count": 3, "max": 27}, f"temp_c's bucket is {buckets.get('temp_c')}, expected mean 23, count 3, max 27"
    assert buckets.get("humidity") == {"mean": 42, "count": 2, "max": 44}, f"humidity's bucket is {buckets.get('humidity')}, expected mean 42, count 2, max 44"


def check_window_events(ctx):
    m = ctx.load("events")
    m.publish_rollup("d-1", [_s("temp_c", 20, T0 + 5), _s("temp_c", 22, T0 + 30), _s("temp_c", 30, T0 + 65)])
    _settle(m)
    events = _events(ctx)
    starts = [e.get("window_start") for e in events]
    assert starts == [T0, T0 + 60], f"samples at T0+5, T0+30 and T0+65 produced events with window_start {starts}, expected [{T0}, {T0 + 60}]"
    counts = [((e.get("buckets") or {}).get("temp_c") or {}).get("count") for e in events]
    assert counts == [2, 1], f"each window counts only its own samples: the counts are {counts}, expected [2, 1]"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_rollup("d-1", [_s("temp_c", 20, T0 + 1)])
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the rollup twice. Enable idempotence"
    m.publish_rollup("d-1", [_s("temp_c", 22, T0 + 61)])
    _settle(m)
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the rollup the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_rollup("d-1", [_s("temp_c", 20, T0 + 1)])
    _settle(m)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused the rollup and the outbox holds {len(rows)} rows: the window is gone for every consumer"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "d-1" and (row.get("payload") or {}).get("window_start") == T0, f"the outbox row is {row}, expected the topic, the key d-1 and the rollup"
    assert ok is False, f"publish_rollup returned {ok!r} after a refused delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_rollup("d-1", [_s("temp_c", 22, T0 + 61)])
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_rollup waited {waited:.0f} s for a broker that does not answer: wait at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and (rows[1].get("payload") or {}).get("window_start") == T0 + 60, f"no acknowledgement within the window and the outbox holds {rows}"
    assert ok is False, f"publish_rollup returned {ok!r} without an acknowledgement, expected False"
`,
    typescript: `const TOPIC = 'telemetry.rollup';
const T0 = 1_800_000_000; // a window boundary

const s = (metric: string, value: number, ts: number) => ({metric, value, ts});
const events = ctx => ctx.kafka.values(TOPIC).map(value => JSON.parse(value));
const outboxRows = ctx => ctx.redis.lrange('outbox', 0, -1).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_device_key(ctx) {
  const m = ctx.load('events');
  await m.publishRollup('d-1', [s('temp_c', 20, T0 + 1), s('humidity', 40, T0 + 2)]);
  await m.publishRollup('d-2', [s('temp_c', 25, T0 + 3)]);
  await m.publishRollup('d-1', [s('temp_c', 22, T0 + 61)]);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['d-1', 'd-2', 'd-1'], \`the rollups are keyed \${JSON.stringify(keys)}, expected the device ids d-1, d-2, d-1: keyed by anything else, one device's windows scatter across partitions\`);
  assert.equal(records[0].partition, records[2].partition, 'both d-1 rollups must land on one partition, or a consumer reads its windows out of order');
}

export async function check_bucketed_payload(ctx) {
  const m = ctx.load('events');
  await m.publishRollup('d-1', [s('temp_c', 20, T0 + 1), s('temp_c', 22, T0 + 10), s('temp_c', 27, T0 + 20), s('humidity', 40, T0 + 5), s('humidity', 44, T0 + 25)]);
  await settle();
  const all = events(ctx);
  assert.equal(all.length, 1, \`five samples of one window produced \${all.length} records, expected one rollup for the window: \${JSON.stringify(all)}\`);
  const event = all[0];
  assert(!('samples' in event), \`the rollup carries the raw samples: \${JSON.stringify(event)}. The topic is meant to be smaller than the store it summarises\`);
  const buckets = event.buckets ?? {};
  assert.deepEqual(buckets.temp_c, {mean: 23, count: 3, max: 27}, \`temp_c's bucket is \${JSON.stringify(buckets.temp_c)}, expected mean 23, count 3, max 27\`);
  assert.deepEqual(buckets.humidity, {mean: 42, count: 2, max: 44}, \`humidity's bucket is \${JSON.stringify(buckets.humidity)}, expected mean 42, count 2, max 44\`);
}

export async function check_window_events(ctx) {
  const m = ctx.load('events');
  await m.publishRollup('d-1', [s('temp_c', 20, T0 + 5), s('temp_c', 22, T0 + 30), s('temp_c', 30, T0 + 65)]);
  await settle();
  const all = events(ctx);
  const starts = all.map(e => e.window_start);
  assert.deepEqual(starts, [T0, T0 + 60], \`samples at T0+5, T0+30 and T0+65 produced events with window_start \${JSON.stringify(starts)}, expected [\${T0}, \${T0 + 60}]\`);
  const counts = all.map(e => e.buckets?.temp_c?.count);
  assert.deepEqual(counts, [2, 1], \`each window counts only its own samples: the counts are \${JSON.stringify(counts)}, expected [2, 1]\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishRollup('d-1', [s('temp_c', 20, T0 + 1)]);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the rollup twice. Enable idempotence\`);
  await m.publishRollup('d-1', [s('temp_c', 22, T0 + 61)]);
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the rollup the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishRollup('d-1', [s('temp_c', 20, T0 + 1)]);
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused the rollup and the outbox holds \${rows.length} rows: the window is gone for every consumer\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'd-1' && rows[0].payload?.window_start === T0, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key d-1 and the rollup\`);
  assert.equal(ok, false, \`publishRollup resolved \${JSON.stringify(ok)} after a refused delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishRollup('d-1', [s('temp_c', 22, T0 + 61)]);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishRollup waited \${waited.toFixed(0)} s for a broker that does not answer: wait at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.window_start === T0 + 60, \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishRollup resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"ingestd/wal"

	"leetbuild/harness"
)

const (
	rollupTopic = "telemetry.rollup"
	t0          = int64(1_800_000_000) // a window boundary
)

func smp(metric string, value float64, ts int64) wal.Sample {
	return wal.Sample{Metric: metric, Value: value, TS: ts}
}

func publishAll(ctx *harness.Ctx, device string, samples ...wal.Sample) bool {
	ok, err := publishRollup(context.Background(), device, samples)
	ctx.NoError(err, "publishRollup(%s)", device)
	return ok
}

func rollupEvents(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, value := range ctx.Kafka.Values(rollupTopic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(value), &e), "a rollup must be JSON: %s", value)
		out = append(out, e)
	}
	return out
}

type outboxEntry struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func outboxEntries(ctx *harness.Ctx) []outboxEntry {
	var rows []outboxEntry
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row outboxEntry
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func bucketOf(e map[string]any, metric string) map[string]any {
	buckets, _ := e["buckets"].(map[string]any)
	b, _ := buckets[metric].(map[string]any)
	return b
}

func CheckDeviceKey(ctx *harness.Ctx) {
	publishAll(ctx, "d-1", smp("temp_c", 20, t0+1), smp("humidity", 40, t0+2))
	publishAll(ctx, "d-2", smp("temp_c", 25, t0+3))
	publishAll(ctx, "d-1", smp("temp_c", 22, t0+61))
	ctx.Settle()
	keys := ctx.Kafka.Keys(rollupTopic)
	ctx.Equal(keys, []string{"d-1", "d-2", "d-1"}, "the rollups must be keyed by the device ids (keyed by anything else, one device's windows scatter across partitions)")
	records := ctx.Kafka.Records(rollupTopic)
	ctx.Equal(records[0].Partition, records[2].Partition, "both d-1 rollups must land on one partition, or a consumer reads its windows out of order; the partitions")
}

func CheckBucketedPayload(ctx *harness.Ctx) {
	publishAll(ctx, "d-1", smp("temp_c", 20, t0+1), smp("temp_c", 22, t0+10), smp("temp_c", 27, t0+20), smp("humidity", 40, t0+5), smp("humidity", 44, t0+25))
	ctx.Settle()
	all := rollupEvents(ctx)
	ctx.Equal(len(all), 1, "five samples of one window must produce one rollup (%v); the records", all)
	_, raw := all[0]["samples"]
	ctx.Assert(!raw, "the rollup carries the raw samples: %v. The topic is meant to be smaller than the store it summarises", all[0])
	ctx.Equal(bucketOf(all[0], "temp_c"), map[string]any{"mean": 23.0, "count": 3.0, "max": 27.0}, "temp_c's bucket")
	ctx.Equal(bucketOf(all[0], "humidity"), map[string]any{"mean": 42.0, "count": 2.0, "max": 44.0}, "humidity's bucket")
}

func CheckWindowEvents(ctx *harness.Ctx) {
	publishAll(ctx, "d-1", smp("temp_c", 20, t0+5), smp("temp_c", 22, t0+30), smp("temp_c", 30, t0+65))
	ctx.Settle()
	var starts, counts []any
	for _, e := range rollupEvents(ctx) {
		starts = append(starts, e["window_start"])
		counts = append(counts, bucketOf(e, "temp_c")["count"])
	}
	ctx.Equal(starts, []any{float64(t0), float64(t0 + 60)}, "samples at t0+5, t0+30 and t0+65 must produce one event per window; window_start")
	ctx.Equal(counts, []any{2.0, 1.0}, "each window counts only its own samples; the counts")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(rollupTopic, 1) // the broker wrote it, the acknowledgement never arrived
	publishAll(ctx, "d-1", smp("temp_c", 20, t0+1))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(rollupTopic)), 1, "after one lost acknowledgement the producer's retry must not write the rollup twice (enable.idempotence); the records")
	publishAll(ctx, "d-1", smp("temp_c", 22, t0+61))
	ctx.Settle()
	ctx.Kafka.Failover(rollupTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(rollupTopic)), 2, "a leader failover must not lose a rollup (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(rollupTopic, 1)
	ok := publishAll(ctx, "d-1", smp("temp_c", 20, t0+1))
	ctx.Settle()
	rows := outboxEntries(ctx)
	ctx.Equal(len(rows), 1, "the broker refused the rollup: without an outbox row the window is gone for every consumer; the rows")
	ctx.Assert(rows[0].Topic == rollupTopic && rows[0].Key == "d-1" && rows[0].Payload["window_start"] == float64(t0), "the outbox row is %+v, expected the topic, the key d-1 and the rollup", rows[0])
	ctx.Equal(ok, false, "publishRollup's result after a refused delivery")
	ctx.Kafka.Stall(rollupTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = publishAll(ctx, "d-1", smp("temp_c", 22, t0+61))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishRollup waited %.0f s for a broker that does not answer: wait at most 2 s, then write the outbox row", waited)
	rows = outboxEntries(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["window_start"] == float64(t0+60), "no acknowledgement within the window and the outbox holds %+v", rows)
	ctx.Equal(ok, false, "publishRollup's result without an acknowledgement")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "ingestd/wal.h"

using json = nlohmann::json;

namespace {

const std::string kRollupTopic = "telemetry.rollup";
constexpr long long kT0 = 1800000000LL;  // a window boundary

wal::Sample smp(const std::string& metric, double value, long long ts) { return wal::Sample{metric, value, ts}; }

std::vector<json> rollupEvents(harness::Ctx& ctx) {
  std::vector<json> out;
  for (const auto& value : ctx.Kafka.Values(kRollupTopic)) out.push_back(json::parse(value, nullptr, false));
  return out;
}

std::vector<json> outboxEntries(harness::Ctx& ctx) {
  std::vector<json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) rows.push_back(json::parse(text, nullptr, false));
  return rows;
}

json at(const json& j, const std::string& field) { return j.is_object() && j.contains(field) ? j[field] : json(); }

}  // namespace

void CheckDeviceKey(harness::Ctx& ctx) {
  publishRollup("d-1", {smp("temp_c", 20, kT0 + 1), smp("humidity", 40, kT0 + 2)});
  publishRollup("d-2", {smp("temp_c", 25, kT0 + 3)});
  publishRollup("d-1", {smp("temp_c", 22, kT0 + 61)});
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Keys(kRollupTopic), {"d-1", "d-2", "d-1"}, "the rollups must be keyed by the device ids (keyed by anything else, one device's windows scatter across partitions)");
  const auto records = ctx.Kafka.Records(kRollupTopic);
  ctx.Equal(records[0].Partition, records[2].Partition, "both d-1 rollups must land on one partition, or a consumer reads its windows out of order; the partitions");
}

void CheckBucketedPayload(harness::Ctx& ctx) {
  publishRollup("d-1", {smp("temp_c", 20, kT0 + 1), smp("temp_c", 22, kT0 + 10), smp("temp_c", 27, kT0 + 20), smp("humidity", 40, kT0 + 5), smp("humidity", 44, kT0 + 25)});
  ctx.Settle();
  const auto all = rollupEvents(ctx);
  ctx.Equal(all.size(), 1, "five samples of one window must produce one rollup; the records");
  ctx.Assert(at(all[0], "samples").is_null(), "the rollup carries the raw samples: %s. The topic is meant to be smaller than the store it summarises", all[0].dump());
  ctx.Equal(at(at(all[0], "buckets"), "temp_c"), json{{"mean", 23}, {"count", 3}, {"max", 27}}, "temp_c's bucket");
  ctx.Equal(at(at(all[0], "buckets"), "humidity"), json{{"mean", 42}, {"count", 2}, {"max", 44}}, "humidity's bucket");
}

void CheckWindowEvents(harness::Ctx& ctx) {
  publishRollup("d-1", {smp("temp_c", 20, kT0 + 5), smp("temp_c", 22, kT0 + 30), smp("temp_c", 30, kT0 + 65)});
  ctx.Settle();
  json starts = json::array();
  json counts = json::array();
  for (const json& e : rollupEvents(ctx)) {
    starts.push_back(at(e, "window_start"));
    counts.push_back(at(at(at(e, "buckets"), "temp_c"), "count"));
  }
  ctx.Equal(starts, json::array({kT0, kT0 + 60}), "samples at kT0+5, kT0+30 and kT0+65 must produce one event per window; window_start");
  ctx.Equal(counts, json::array({2, 1}), "each window counts only its own samples; the counts");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kRollupTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishRollup("d-1", {smp("temp_c", 20, kT0 + 1)});
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kRollupTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the rollup twice (enable.idempotence); the records");
  publishRollup("d-1", {smp("temp_c", 22, kT0 + 61)});
  ctx.Settle();
  ctx.Kafka.Failover(kRollupTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kRollupTopic).size(), 2, "a leader failover must not lose a rollup (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kRollupTopic, 1);
  bool ok = publishRollup("d-1", {smp("temp_c", 20, kT0 + 1)});
  ctx.Settle();
  auto rows = outboxEntries(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused the rollup: without an outbox row the window is gone for every consumer; the rows");
  ctx.Assert(!rows.empty() && at(rows[0], "topic") == kRollupTopic && at(rows[0], "key") == "d-1" && at(at(rows[0], "payload"), "window_start") == kT0,
             "the outbox row is %s, expected the topic, the key d-1 and the rollup", rows.empty() ? "none" : rows[0].dump());
  ctx.Equal(ok, false, "publishRollup's result after a refused delivery");
  ctx.Kafka.Stall(kRollupTopic);  // the broker stops answering
  const long long before = ctx.Clock.Now();
  ok = publishRollup("d-1", {smp("temp_c", 22, kT0 + 61)});
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishRollup waited %.0f s for a broker that does not answer: wait at most 2 s, then write the outbox row", waited);
  rows = outboxEntries(ctx);
  ctx.Assert(rows.size() == 2 && at(at(rows[1], "payload"), "window_start") == kT0 + 60, "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishRollup's result without an acknowledgement");
}
`,
  },
  hints: [
    'Publish two windows for one device and read the topic: the records are keyed by metric, each one carries every raw reading, and none says which minute it covers. Stop the broker: the call still returns true.',
    'The key decides the partition and the key is the metric; the payload is built per metric from the raw samples; the producer runs with `acks=1`, no idempotence, and the produce is never waited on.',
    'Group by `ts - ts % WINDOW_S`, build `{"device_id", "window_start", "buckets"}` with mean, count and max, produce with `key=device_id` from an idempotent `acks=all` producer, `flush(ACK_TIMEOUT_S)` and `outbox.insert` on an error or a timeout.',
  ],
  debrief: `A rollup is a promise about a device's minute, so the device is the key (Kafka orders only within a partition) and the minute is in the payload, where a consumer can upsert it instead of guessing. Shipping mean, count and max instead of the samples is what makes the topic a summary: the count lets a consumer merge two partial windows into a correct mean, which a bare mean cannot do. Idempotence and acks=all close the two broker-side gaps, a retry after a lost acknowledgement and a leader that dies after acknowledging alone. Waiting for the delivery report gives the return value a meaning, and the outbox turns a broker outage into a late window. Production pipelines write the outbox row in the same transaction as the WAL entry and let a relay do every produce.`,
};
