import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Telemetry events keyed by device with bucketed values',
  concept: 'kafka',
  file: 'events',
  focus: ['ingest', 'kafka', 'rollup'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes an event per
window and the consumer sees data arrive, so the demo shows a topic filling up. Three production
contracts are broken, and the first one silently reorders a fleet's stream. Find them, fix them, and
prove the fix with the checks below.

Implement \`publish_rollup(device_id, window_start, buckets)\`, the ingest path's event side:

- Publish one \`telemetry.rollup\` event per device per window with the **device id as the message
  key**. The key is the partition key: one device’s events then land in one partition and keep their
  order, which is what every consumer of a device’s history assumes. The draft keys by metric name,
  so a device’s events scatter across partitions and their order is gone.
- The payload carries the **downsampled bucket result**: \`window_start\` and, per metric, the
  bucket **mean**, **count** and peak. It must **not** carry the raw samples — a topic that carries
  every raw reading is a topic that is retained and replicated at fleet scale, and “consumers can
  recompute” is not a reason to publish them.
- The producer must be **idempotent with \`acks=all\`** (or the stack’s equivalent: required acks
  \`all\` plus hashed, stable keys), so a retried produce cannot duplicate a rollup and an ack means
  the broker has the record.
- When the broker rejects the produce, write the event to the **outbox** instead of dropping it or
  failing the ingest path: a relay republishes outbox rows when the broker returns. Observe the
  produce result and flush it before returning, or a rejection has nowhere to go.

**Failure mode the checks target.** Keying by metric breaks per-device ordering; shipping raw
samples turns a downsampled topic back into the firehose it was meant to replace; a producer without
idempotence duplicates a rollup whenever the client retries; and a rejection that nobody looks at is
a rollup that is simply lost.`,
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
    'The message key is the partition key: `key=device_id` (or `key: deviceId`, `Key: []byte(deviceID)`, `ProducerRecord(topic, deviceId, payload)`). Keyed by the metric name, one device’s events land in different partitions and their order is no longer guaranteed — and no consumer can fix that afterwards.',
    'The event carries the answer, not the inputs: `window_start`, and per metric the bucket `mean`, `count` and peak. Raw samples in a retained topic are the leak and the cost that downsampling existed to avoid; keep them in the store, where they belong.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` plus `acks: -1`, or required acks `all` with a hash balancer. Then wrap the produce and, when the broker rejects it, insert an outbox row — and flush or await so you actually see the rejection.',
  ],
  checks: [
    {
      id: 'device-key',
      title: 'Publishes to telemetry.rollup keyed by device',
      detail:
        'The message key is the device id (partition by device), so one device’s events stay on one partition and keep their order. The draft keys by the metric name, which scatters a device’s stream across partitions.',
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
        'The payload is downsampled: bucket `mean` and `count` (and the peak) instead of the raw readings, and no `samples` array of untouched points. The draft publishes the raw samples and leaves the consumer to recompute.',
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
        'The event carries `window_start` and its `buckets`, so a consumer knows which window each downsampled value belongs to. The draft has no window at all — its payload is a bag of raw points.',
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
        'A rejected produce writes an outbox row (`insert_outbox`/`insertOutbox`/`InsertOutbox`) instead of dropping the event or failing the caller. The draft ignores the broker result entirely.',
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
        'The producer is configured for idempotence and `acks=all` — Kafka’s `enable.idempotence` with `acks`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer — and the produce is flushed or awaited so a rejection is observable. The draft publishes fire-and-forget from a default producer, so a retry duplicates the rollup and a rejection is invisible.',
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
    # TODO: the draft keys by the metric name, so one device's events scatter across partitions and
    # lose their order; it publishes the raw samples for consumers to recompute; it runs a default
    # producer without idempotence; and it skips the outbox, so a broker rejection drops the window.
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
      starter: `/** telemetry.rollup: a model-generated draft that keys by metric and ships raw samples. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'telemetry-ingest', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface Sample {
  ts: number;
  value: number;
}

export async function publishRollup(deviceId: string, metricName: string, samples: Sample[]): Promise<void> {
  // TODO: the draft keys by the metric name, so one device's events scatter across partitions and
  // lose their order; it publishes the raw samples for consumers to recompute; it runs a default
  // producer without idempotence; and it skips the outbox, so a broker rejection drops the window.
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
	// TODO: the draft keys by the metric name, so one device's events scatter across partitions and
	// lose their order; it publishes the raw samples for consumers to recompute; it runs a default
	// producer without idempotence; and it skips the outbox, so a broker rejection drops the window.
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

  // TODO: the draft keys by the metric name, so one device's events scatter across partitions and
  // lose their order; it publishes the raw samples for consumers to recompute; it runs a default
  // producer without idempotence; and it skips the outbox, so a broker rejection drops the window.
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

// TODO: the draft keys by the metric name, so one device's events scatter across partitions and
// lose their order; it publishes the raw samples for consumers to recompute; it runs a default
// producer without idempotence; and it skips the outbox, so a broker rejection drops the window.
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
  debrief: `Three separate contracts are being checked here. The first is ordering: a message key decides the partition, and partition is the only ordering guarantee Kafka offers, so keying by device is what makes "this device was hot, then cold" a readable sequence rather than an interleaving. The second is payload responsibility: a pipeline that publishes raw samples has moved the aggregation cost, the storage cost and the retention risk downstream, and has published tenant data into a replicated log for no reason — buckets carry the mean, the count and the peak, which is everything an alert or a dashboard actually needs. The third is durability: an idempotent producer with acks=all makes a retry harmless and an ack meaningful, and the outbox turns a broker outage into a delay instead of data loss, which is the difference between a pipeline that is down and a pipeline that is behind. Real platforms add a schema registry so a future producer cannot smuggle raw points back in, outbox relays with their own publish keys, and per-device quota on the topic.`,
};
