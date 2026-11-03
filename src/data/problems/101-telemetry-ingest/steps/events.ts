import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Telemetry events keyed by device with bucketed values',
  concept: 'kafka',
  file: 'events',
  focus: ['ingest', 'kafka', 'rollup'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/rollups\`, the ingest path's event side: it builds
an event with the device id, the metric and the raw samples, produces it to \`telemetry.rollup\`
keyed by the metric name from a default producer, and answers accepted without looking at the
result. The demo shows a topic filling up. It hides five flaws.

**Failure mode the checks target.** A device's "hot, then cold" sequence arrives interleaved across
partitions and no consumer can put it back. The downsampled topic carries every raw reading, so it is
the firehose it was meant to replace, retained and replicated at fleet scale, with no window named
for any value. A client retry publishes the rollup twice. And a broker rejection is a rollup that is
simply lost, because nothing observes the produce result.

- Publish one \`telemetry.rollup\` event per device per window with the device id as the message key
  (\`key=device_id\`).
- The payload carries \`window_start\` and \`buckets\`: per metric the bucket \`mean\`, \`count\` and
  peak. No raw \`samples\` array.
- The producer is idempotent with \`acks=all\` (\`enable.idempotence\` with \`acks\`; KafkaJS
  \`idempotent: true\` with \`acks: -1\`; required acks \`all\` with a hash balancer), and the produce
  is flushed or awaited so a rejection is observable.
- When the broker rejects the produce, write the event to the outbox (\`insert_outbox\`) instead of
  dropping it or failing the ingest path; a relay republishes outbox rows when the broker returns.`,
  sequence: {
    participants: ['Telemetry Ingest', 'telemetry.rollup', 'Rollup consumer'],
    messages: [
      {
        from: 'Telemetry Ingest',
        to: 'telemetry.rollup',
        label: 'produce · key = device_id · window_start · buckets[{metric, mean, count}]',
        kind: 'sync',
      },
      {from: 'telemetry.rollup', to: 'Telemetry Ingest', label: 'ack (acks=all) / broker error', kind: 'reply'},
      {
        from: 'Telemetry Ingest',
        to: 'Telemetry Ingest',
        label: 'insert_outbox(device_id, event) on rejection',
        kind: 'sync',
      },
      {
        from: 'telemetry.rollup',
        to: 'Rollup consumer',
        label: 'consume · group rollups · one device, one partition',
        kind: 'async',
      },
      {from: 'Rollup consumer', to: 'Rollup consumer', label: 'store bucket means — no raw samples', kind: 'sync'},
    ],
  },
  hints: [
    "A device's rollup consumer reports it cooling before it warmed, the topic's retention bill is the size of the raw store, and a broker restart leaves a ten-minute hole in every dashboard.",
    '`key=window.metric` splits one device across partitions; the event ships `samples` instead of a bucket; `Producer({...})` has defaults and `producer.produce` is never flushed, so a rejection is invisible.',
    'Produce `{"window_start", "buckets": {metric: {"mean", "count", "max"}}}` with `key=device_id`; configure `enable.idempotence` and `"acks": "all"`; `producer.flush()` and on `KafkaException` call `insert_outbox`.',
  ],
  checks: [
    {
      id: 'device-key',
      title: 'Publishes to telemetry.rollup keyed by device',
      detail:
        'The message key is the device id (partition by device), so one device’s events stay on one partition and keep their order. The starter keys by the metric name, which scatters a device’s stream across partitions.',
      match: {
        python: {all: [/telemetry\.rollup/, /key=device_id/], none: [/key=metric/]},
        typescript: {all: [/telemetry\.rollup/, /key: deviceId/], none: [/key: metricName|key: metric/]},
        go: {all: [/telemetry\.rollup/, /Key:\s*\[\]byte\(deviceID\)/], none: [/Key:\s*\[\]byte\(metric/]},
        scala: {
          all: [/telemetry\.rollup/, /new ProducerRecord\(RollupTopic, deviceId/],
          none: [/new ProducerRecord\(RollupTopic, metric/],
        },
        cpp: {
          all: [/telemetry\.rollup/, /deviceId\.data\(\),\s*deviceId\.size\(\)/],
          none: [/metricName\.data\(\)/],
        },
      },
    },
    {
      id: 'bucketed-payload',
      title: 'Carries bucket means and counts, never raw samples',
      detail:
        'The payload is downsampled: bucket `mean` and `count` (and the peak) instead of the raw readings, and no `samples` array of untouched points. The starter publishes the raw samples and leaves the consumer to recompute.',
      match: {
        python: {all: [/mean/, /count/], none: [/["']samples["']/]},
        typescript: {all: [/mean/, /count/], none: [/["']samples["']/]},
        go: {all: [/Mean/, /Count/], none: [/json:"samples"/]},
        scala: {all: [/mean/, /count/], none: [/["']samples["']/]},
        cpp: {all: [/"mean"/, /"count"/], none: [/"samples"/]},
      },
    },
    {
      id: 'window-bucket',
      title: 'Names the bucket window in the event',
      detail:
        'The event carries `window_start` and its `buckets`, so a consumer knows which window each downsampled value belongs to. The starter has no window at all — its payload is a bag of raw points.',
      match: {
        python: {all: [/window_start/, /buckets/]},
        typescript: {all: [/window_start/, /buckets/]},
        go: {all: [/window_start/, /buckets/]},
        scala: {all: [/window_start/, /buckets/]},
        cpp: {all: [/window_start/, /buckets/]},
      },
    },
    {
      id: 'outbox',
      title: 'Falls back to the outbox when the broker rejects',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox`/`insertOutbox`/`InsertOutbox`) instead of dropping the event or failing the caller. The starter ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — Kafka’s `enable.idempotence` with `acks`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer — and the produce is flushed or awaited so a rejection is observable. The starter publishes fire-and-forget from a default producer, so a retry duplicates the rollup and a rejection is invisible.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/, /producer\.flush\(/]},
        typescript: {all: [/idempotent: true/, /acks: -1/, /await producer\.send\(/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/, /\.get\(\)/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/, /producer->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
producer = Producer({"bootstrap.servers": "kafka:9092"})


class Sample(BaseModel):
    ts: int
    value: float


class RollupWindow(BaseModel):
    device_id: str
    metric: str
    samples: list[Sample]


@app.post("/v1/rollups")
def publish(window: RollupWindow) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    event = {
        "device_id": window.device_id,
        "metric": window.metric,
        "samples": [sample.model_dump() for sample in window.samples],
    }
    producer.produce("telemetry.rollup", key=window.metric, value=json.dumps(event))
    return {"accepted": True}
`,
      solution: `import json

from confluent_kafka import KafkaException, Producer

TOPIC = "telemetry.rollup"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class OutboxStore:
    def insert_outbox(self, device_id: str, event: dict) -> None:
        """One row per undelivered rollup; a relay republishes it when the broker returns."""
        raise NotImplementedError


store = OutboxStore()


def publish_rollup(device_id: str, window_start: int, buckets: list[dict]) -> None:
    """One downsampled window per device, keyed by the device so its stream stays ordered."""
    event = {
        "device_id": device_id,
        "window_start": window_start,
        "buckets": [
            {
                "metric": bucket["metric"],
                "mean": bucket["mean"],
                "count": bucket["count"],
                "max": bucket["max"],
            }
            for bucket in buckets
        ],
    }
    try:
        producer.produce(TOPIC, key=device_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(device_id, event)
`,
    },
    typescript: {
      starter: `/** telemetry.rollup: flawed code that keys by metric and ships raw samples. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'telemetry-ingest', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface Sample {
  ts: number;
  value: number;
}

export async function publishRollup(deviceId: string, metricName: string, samples: Sample[]): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const event = {device_id: deviceId, metric: metricName, samples};
  void producer.send({
    topic: 'telemetry.rollup',
    messages: [{key: metricName, value: JSON.stringify(event)}],
  });
}
`,
      solution: `/** telemetry.rollup: one bucketed event per device window, durable through broker outages. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'telemetry-ingest', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

const TOPIC = 'telemetry.rollup';

interface Bucket {
  metric: string;
  mean: number;
  count: number;
  max: number;
}

interface OutboxStore {
  insertOutbox(deviceId: string, event: unknown): Promise<void>;
}

export async function publishRollup(
  store: OutboxStore,
  deviceId: string,
  windowStart: number,
  buckets: Bucket[],
): Promise<void> {
  const event = {
    device_id: deviceId,
    window_start: windowStart,
    buckets: buckets.map(bucket => ({
      metric: bucket.metric,
      mean: bucket.mean,
      count: bucket.count,
      max: bucket.max,
    })),
  };
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: deviceId, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(deviceId, event);
  }
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

var rollupWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "telemetry.rollup"}

type Sample struct {
	TS    int64   \`json:"ts"\`
	Value float64 \`json:"value"\`
}

func publishRollup(ctx context.Context, deviceID, metricName string, samples []Sample) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	event := map[string]any{"device_id": deviceID, "metric": metricName, "samples": samples}
	payload, _ := json.Marshal(event)
	return rollupWriter.WriteMessages(ctx, kafka.Message{Key: []byte(metricName), Value: payload})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const rollupTopic = "telemetry.rollup"

// RequiredAcks=RequireAll with a stable hash balancer is kafka-go's idempotent equivalent: the
// broker acknowledges only once the record is replicated, and retries of the same key land on the
// same partition instead of duplicating across them.
var rollupWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        rollupTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type Bucket struct {
	Metric string  \`json:"metric"\`
	Mean   float64 \`json:"mean"\`
	Count  int     \`json:"count"\`
	Max    float64 \`json:"max"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, deviceID string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

func publishRollup(ctx context.Context, deviceID string, windowStart int64, buckets []Bucket) error {
	event := map[string]any{
		"device_id":    deviceID,
		"window_start": windowStart,
		"buckets":      buckets,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	err = rollupWriter.WriteMessages(ctx, kafka.Message{Key: []byte(deviceID), Value: payload})
	if err != nil {
		return store.InsertOutbox(ctx, deviceID, event)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object RollupPublisher {
  val producer = new KafkaProducer[String, String](new Properties())

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def publishRollup(deviceId: String, metricName: String, samples: List[Sample]): Unit = {
    val event = Map(
      "device_id" -> deviceId,
      "metric" -> metricName,
      "samples" -> samples.map(sample => Map("ts" -> sample.ts, "value" -> sample.value))
    ).toJson.compactPrint
    producer.send(new ProducerRecord("telemetry.rollup", metricName, event))
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object RollupPublisher {
  val RollupTopic = "telemetry.rollup"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  def publishRollup(deviceId: String, windowStart: Long, buckets: List[Bucket]): Unit = {
    val event = Map(
      "device_id" -> deviceId,
      "window_start" -> windowStart,
      "buckets" -> buckets.map(bucket =>
        Map(
          "metric" -> bucket.metric,
          "mean" -> bucket.mean,
          "count" -> bucket.count,
          "max" -> bucket.max
        )
      )
    ).toJson.compactPrint
    try {
      producer.send(new ProducerRecord(RollupTopic, deviceId, event)).get()
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        RollupStore.insertOutbox(deviceId, event)
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

const std::string kRollupTopic = "telemetry.rollup";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
void publishRollup(const std::string& deviceId, const std::string& metricName, const json& samples) {
  const json event = {{"device_id", deviceId}, {"metric", metricName}, {"samples", samples}};
  const auto payload = event.dump();
  producer->produce(
      kRollupTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      metricName.data(),
      metricName.size(),
      0,
      nullptr);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kRollupTopic = "telemetry.rollup";

struct Bucket {
  std::string metric;
  double mean;
  long long count;
  double max;
};

struct RollupStore {
  void insertOutbox(const std::string& deviceId, const json& event);
};

RollupStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

void publishRollup(const std::string& deviceId, long long windowStart, const std::vector<Bucket>& buckets) {
  json bucketJson = json::array();
  for (const auto& bucket : buckets) {
    bucketJson.push_back({
        {"metric", bucket.metric},
        {"mean", bucket.mean},
        {"count", bucket.count},
        {"max", bucket.max},
    });
  }
  const json event = {{"device_id", deviceId}, {"window_start", windowStart}, {"buckets", bucketJson}};
  const auto payload = event.dump();
  const auto err = producer->produce(
      kRollupTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      deviceId.data(),
      deviceId.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(deviceId, event);
  }
  producer->flush(2000);
}
`,
    },
  },
  debrief: `Three contracts shape the fix. Ordering: a message key decides the partition, and the partition is the only ordering guarantee Kafka offers, so keying by device is what makes "hot, then cold" a readable sequence. Payload responsibility: a pipeline that publishes raw samples has moved the aggregation cost, the storage cost and the retention risk downstream and put tenant data in a replicated log for no reason; buckets with mean, count and peak are everything an alert or a dashboard needs. Durability: an idempotent producer with \`acks=all\` makes a retry harmless and an ack meaningful, and the outbox turns a broker outage into a delay rather than data loss, the difference between a pipeline that is down and one that is behind. Production platforms register the event schema so a future producer cannot smuggle raw points back in, and apply per-device quotas on the topic.`,
};
