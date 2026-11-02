import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Rollup events keyed by series for downstream consumers',
  concept: 'kafka',
  file: 'events',
  focus: ['shards', 'kafka'],
  task: `## Task

**Starting point.** The starter implements \`publish_rollup\`, the event side of the shard flush:
for each window it produces a \`metrics.rolled\` record from a default producer, and the demo shows
the rollup stream filling. It compiles and hides 5 flaws.

**Failure mode the checks target.** A shard key destroys the per-series ordering consumers rely on,
and no later stage can restore order the partition did not guarantee. A publish that precedes the
shard confirmation announces a rollup the store may not commit. A missing outbox turns one broker
outage into a rollup the dashboard will not see, and a payload without boundaries leaves consumers
to place windows by guesswork.

- Publish one \`metrics.rolled\` event per **confirmed** series window, keyed by the **series id**.
- Publish **only after the shard writer confirms the window**: the flush returns the windows the
  shards accepted, and a rejected window must not appear on the topic.
- The payload carries \`window_start\`, \`window_end\` and the \`count\` of aggregated samples.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks \`all\`
  plus hashed, stable keys), so a retried produce cannot duplicate a rollup.
- When the broker rejects the produce, write the event to \`rollup_outbox\` for a relay to republish.
  Observe the produce result, or a rejection has nowhere to go.`,
  sequence: {
    participants: ['Metrics Flusher', 'Shard Writers', 'metrics.rolled', 'Rollup Consumer'],
    messages: [
      {from: 'Metrics Flusher', to: 'Shard Writers', label: 'flush windows · 2 s deadline per shard', kind: 'sync'},
      {
        from: 'Shard Writers',
        to: 'Metrics Flusher',
        label: 'accepted windows per shard — the publish gate',
        kind: 'reply',
      },
      {
        from: 'Metrics Flusher',
        to: 'metrics.rolled',
        label: 'produce · key = series · window_start · window_end · count',
        kind: 'sync',
      },
      {from: 'metrics.rolled', to: 'Metrics Flusher', label: 'ack (acks=all) / broker error', kind: 'reply'},
      {
        from: 'Metrics Flusher',
        to: 'Metrics Flusher',
        label: 'insert a rollup_outbox row on rejection · a relay republishes',
        kind: 'sync',
      },
      {
        from: 'metrics.rolled',
        to: 'Rollup Consumer',
        label: 'consume · group rollups · one series, one partition',
        kind: 'async',
      },
      {
        from: 'Rollup Consumer',
        to: 'Rollup Consumer',
        label: 'fold the window into the series rollup — no resorting',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'key-by-series',
      title: 'Keys every rollup event by the series',
      detail:
        'The message key is the series id, so one series’ windows stay on one partition and in order and a consumer can fold them without sorting. The starter keys by the shard, which carries many series and scatters every series’ stream.',
      match: {
        python: {all: [/metrics\.rolled/, /key=series_id/], none: [/key=shard/]},
        typescript: {all: [/metrics\.rolled/, /key:\s*seriesId\b/], none: [/key:\s*shardId\b/]},
        go: {all: [/metrics\.rolled/, /Key:\s*\[\]byte\(seriesID\)/], none: [/Key:\s*\[\]byte\(shardID\)/]},
        scala: {
          all: [/metrics\.rolled/, /ProducerRecord\[String, String\]\(RollupTopic,\s*seriesId/],
          none: [/ProducerRecord[^)]*shardId/],
        },
        cpp: {all: [/metrics\.rolled/, /seriesId\.data\(\),\s*seriesId\.size\(\)/], none: [/shardId\.data\(\)/]},
      },
    },
    {
      id: 'publish-after-confirm',
      title: 'Publishes only after the shard confirms the window',
      detail:
        'The events go out only after the shard-writer flush returns the windows the shards accepted; publishing first announces a rollup the store may never commit. The starter produces before the confirmation.',
      match: {
        python: {order: [/accepted\s*=\s*flush_windows\(/, /producer\.produce\(/]},
        typescript: {order: [/accepted\s*=\s*await\s+flushWindows\(/, /producer\.send\(/]},
        go: {order: [/accepted,\s*err\s*:=\s*flushWindows\(/, /WriteMessages\(/]},
        scala: {order: [/val accepted\s*=\s*ShardWriter\.flushWindows\(/, /producer\.send\(/]},
        cpp: {order: [/auto accepted\s*=\s*flushWindows\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox-on-rejection',
      title: 'Writes a rollup_outbox row when the broker rejects the produce',
      detail:
        'A rejected produce writes a row into `rollup_outbox` instead of dropping the event; a relay republishes it when the broker returns. The starter ignores the broker result, so one outage erases the rollup.',
      match: {
        python: {all: [/rollup_outbox/, /insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/rollup_outbox/, /insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/rollup_outbox/, /InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/rollup_outbox/, /insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/rollup_outbox/, /insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'window-boundaries',
      title: 'Carries window_start, window_end and the count',
      detail:
        'Each event carries the window start, the window end and the count of samples the window aggregated, so a consumer knows exactly which window it is folding. The starter’s payload has neither boundary.',
      match: {
        python: {all: [/window_start/, /window_end/, /\bcount\b/]},
        typescript: {all: [/window_start/, /window_end/, /\bcount\b/]},
        go: {all: [/window_start/, /window_end/, /\bCount\b/]},
        scala: {all: [/window_start/, /window_end/, /\bcount\b/]},
        cpp: {all: [/window_start/, /window_end/, /\bcount\b/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` with `acks`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer — so a retried produce cannot duplicate a rollup and an ack means the broker has the record. The starter publishes fire-and-forget from a default producer.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks",\s*"all"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

TOPIC = "metrics.rolled"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_rollup(windows: list[dict]) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    for window in windows:
        shard_id = window["shard_id"]
        event = {"series": window["series_id"], "shard": shard_id, "count": window["count"]}
        producer.produce(TOPIC, key=shard_id, value=json.dumps(event))
    producer.flush()
    flush_windows(windows)


def flush_windows(windows: list[dict]) -> list[dict]:
    """Step 3's shard-writer flush: returns only the windows the shards confirmed."""
    raise NotImplementedError
`,
      solution: `import json

from confluent_kafka import KafkaException, Producer

TOPIC = "metrics.rolled"
OUTBOX_TABLE = "rollup_outbox"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class OutboxStore:
    def insert_outbox(self, series_id: str, event: dict) -> None:
        """One row per undelivered rollup; a relay republishes it when the broker returns."""
        raise NotImplementedError


store = OutboxStore()


def publish_rollup(windows: list[dict]) -> None:
    """Publish one metrics.rolled event per confirmed series window, keyed by the series."""
    accepted = flush_windows(windows)
    for window in accepted:
        series_id = window["series_id"]
        event = {
            "series": series_id,
            "window_start": window["window_start"],
            "window_end": window["window_end"],
            "count": window["count"],
        }
        try:
            producer.produce(TOPIC, key=series_id, value=json.dumps(event))
            producer.flush(2.0)
        except KafkaException:
            store.insert_outbox(series_id, event)


def flush_windows(windows: list[dict]) -> list[dict]:
    """Step 3's shard-writer flush: returns only the windows the shards confirmed."""
    raise NotImplementedError
`,
    },
    typescript: {
      starter: `/** metrics.rolled: flawed code that keys by shard and publishes before the shard confirms. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'metrics-pipeline', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

const TOPIC = 'metrics.rolled';

interface Window {
  series_id: string;
  shard_id: string;
  count: number;
}

/** Step 3's shard-writer flush: resolves to the windows the shards confirmed. */
declare function flushWindows(windows: Window[]): Promise<Window[]>;

export async function publishRollup(windows: Window[]): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  for (const window of windows) {
    const shardId = window.shard_id;
    const event = {series: window.series_id, shard: shardId, count: window.count};
    void producer.send({
      topic: TOPIC,
      messages: [{key: shardId, value: JSON.stringify(event)}],
    });
  }
  await flushWindows(windows);
}
`,
      solution: `/** metrics.rolled: one event per shard-confirmed series window, keyed by series, outbox on rejection. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'metrics-pipeline', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

const TOPIC = 'metrics.rolled';
const OUTBOX_TABLE = 'rollup_outbox';

interface Window {
  series_id: string;
  window_start: number;
  window_end: number;
  count: number;
}

interface OutboxStore {
  insertOutbox(seriesId: string, event: unknown): Promise<void>;
}

/** Step 3's shard-writer flush: resolves to the windows the shards confirmed, never the rejected ones. */
declare function flushWindows(windows: Window[]): Promise<Window[]>;

export async function publishRollup(store: OutboxStore, windows: Window[]): Promise<void> {
  const accepted = await flushWindows(windows);
  for (const window of accepted) {
    const seriesId = window.series_id;
    const event = {
      series: seriesId,
      window_start: window.window_start,
      window_end: window.window_end,
      count: window.count,
    };
    try {
      await producer.send({
        topic: TOPIC,
        acks: -1,
        messages: [{key: seriesId, value: JSON.stringify(event)}],
      });
    } catch (error) {
      await store.insertOutbox(seriesId, event);
    }
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

const rollupTopic = "metrics.rolled"

var rollupWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: rollupTopic}

type Window struct {
	SeriesID string \`json:"series_id"\`
	ShardID  string \`json:"shard_id"\`
	Count    int    \`json:"count"\`
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
func publishRollup(ctx context.Context, windows []Window) error {
	for _, window := range windows {
		shardID := window.ShardID
		event := map[string]any{"series": window.SeriesID, "shard": shardID, "count": window.Count}
		payload, _ := json.Marshal(event)
		_ = rollupWriter.WriteMessages(ctx, kafka.Message{Key: []byte(shardID), Value: payload})
	}
	_, err := flushWindows(ctx, windows)
	return err
}

// flushWindows is step 3's shard-writer flush: it returns only the windows the shards confirmed.
func flushWindows(ctx context.Context, windows []Window) ([]Window, error) {
	return windows, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const (
	rollupTopic = "metrics.rolled"
	outboxTable = "rollup_outbox"
)

// RequiredAcks=RequireAll with a stable hash balancer is kafka-go's idempotent delivery: the broker
// acknowledges only after replication, and a retry of the same key lands on the same partition.
var rollupWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        rollupTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type Window struct {
	SeriesID    string \`json:"series_id"\`
	WindowStart int64  \`json:"window_start"\`
	WindowEnd   int64  \`json:"window_end"\`
	Count       int64  \`json:"count"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, seriesID string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

func publishRollup(ctx context.Context, windows []Window) error {
	accepted, err := flushWindows(ctx, windows)
	if err != nil {
		return err
	}
	for _, window := range accepted {
		seriesID := window.SeriesID
		event := map[string]any{
			"series":       seriesID,
			"window_start": window.WindowStart,
			"window_end":   window.WindowEnd,
			"count":        window.Count,
		}
		payload, err := json.Marshal(event)
		if err != nil {
			return err
		}
		if err := rollupWriter.WriteMessages(ctx, kafka.Message{Key: []byte(seriesID), Value: payload}); err != nil {
			return store.InsertOutbox(ctx, seriesID, event)
		}
	}
	return nil
}

// flushWindows is step 3's shard-writer flush: it returns only the windows the shards confirmed.
func flushWindows(ctx context.Context, windows []Window) ([]Window, error) {
	return windows, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

case class Window(seriesId: String, shardId: String, count: Long)

object RollupPublisher {
  val producer = new KafkaProducer[String, String](new Properties())

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def publishRollup(windows: List[Window]): Unit = {
    windows.foreach { window =>
      val payload = Map("series" -> window.seriesId, "shard" -> window.shardId, "count" -> window.count).toJson.compactPrint
      producer.send(new ProducerRecord("metrics.rolled", window.shardId, payload))
    }
    ShardWriter.flushWindows(windows)
  }
}

// Step 3's shard-writer flush: returns only the windows the shards confirmed.
object ShardWriter {
  def flushWindows(windows: List[Window]): List[Window] = windows
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

case class Window(seriesId: String, windowStart: Long, windowEnd: Long, count: Long)

// Step 3's shard-writer flush: returns only the windows the shards confirmed.
object ShardWriter {
  def flushWindows(windows: List[Window]): List[Window] = windows
}

object OutboxStore {
  def insertOutbox(seriesId: String, event: String): Unit = ()
}

object RollupPublisher {
  val RollupTopic = "metrics.rolled"
  val OutboxTable = "rollup_outbox"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  def publishRollup(windows: List[Window]): Unit = {
    val accepted = ShardWriter.flushWindows(windows)
    accepted.foreach { window =>
      val seriesId = window.seriesId
      val event = Map(
        "series" -> seriesId,
        "window_start" -> window.windowStart,
        "window_end" -> window.windowEnd,
        "count" -> window.count
      ).toJson.compactPrint
      try {
        producer.send(new ProducerRecord[String, String](RollupTopic, seriesId, event)).get()
      } catch {
        case _: org.apache.kafka.common.KafkaException =>
          OutboxStore.insertOutbox(seriesId, event)
      }
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
#include <vector>

using json = nlohmann::json;

const std::string kRollupTopic = "metrics.rolled";

struct Window {
  std::string seriesId;
  std::string shardId;
  long long count;
};

/** Step 3's shard-writer flush: returns only the windows the shards confirmed. */
std::vector<Window> flushWindows(const std::vector<Window>& windows);

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
void publishRollup(const std::vector<Window>& windows) {
  for (const auto& window : windows) {
    const json event = {{"series", window.seriesId}, {"shard", window.shardId}, {"count", window.count}};
    const auto payload = event.dump();
    producer->produce(
        kRollupTopic,
        RdKafka::Topic::PARTITION_UA,
        RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(payload.data()),
        payload.size(),
        window.shardId.data(),
        window.shardId.size(),
        0,
        nullptr);
  }
  flushWindows(windows);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kRollupTopic = "metrics.rolled";
const std::string kOutboxTable = "rollup_outbox";

struct Window {
  std::string seriesId;
  long long windowStart;
  long long windowEnd;
  long long count;
};

struct OutboxStore {
  void insertOutbox(const std::string& seriesId, const json& event);
};

/** Step 3's shard-writer flush: returns only the windows the shards confirmed. */
std::vector<Window> flushWindows(const std::vector<Window>& windows);

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
OutboxStore store;

void publishRollup(const std::vector<Window>& windows) {
  const auto accepted = flushWindows(windows);
  for (const auto& window : accepted) {
    const std::string seriesId = window.seriesId;
    const json event = {
        {"series", seriesId},
        {"window_start", window.windowStart},
        {"window_end", window.windowEnd},
        {"count", window.count},
    };
    const auto payload = event.dump();
    const auto err = producer->produce(
        kRollupTopic,
        RdKafka::Topic::PARTITION_UA,
        RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(payload.data()),
        payload.size(),
        seriesId.data(),
        seriesId.size(),
        0,
        nullptr);
    if (err != RdKafka::ERR_NO_ERROR) {
      store.insertOutbox(seriesId, event);
    }
    producer->flush(2000);
  }
}
`,
    },
  },
  hints: [
    'A consumer folding one series sees windows arrive out of order, and after a short broker outage a few minutes are missing from the chart while the shards show them as written.',
    'The record key is the shard id, so one series is spread over partitions; the produce runs before the flush result is known and its outcome is discarded, with no boundaries in the payload.',
    'Publish from the accepted windows with `key=series_id`, carry `window_start`, `window_end` and `count`, configure `enable.idempotence` with `acks=all`, and insert a `rollup_outbox` row when the produce fails.',
  ],
  debrief: `The fix has three parts because the stream makes three promises. Keying by series is the ordering promise: one series' windows land on one partition in window order, which is what every consumer folds on. Publishing from the flush result is the currency promise: only windows the shards accepted are real, so an event cannot announce a rollup the store did not commit. The idempotent producer with \`acks=all\`, the observed produce result and the \`rollup_outbox\` row are the durability promise: a retry cannot duplicate a rollup and a broker outage delays one instead of erasing it. Production platforms add a schema registry for the payload, retention sized to the rollup cadence and outbox-lag alarms, and replay the stream, which works because key and boundaries ride on every event.`,
};
