import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Rollup events keyed by series for downstream consumers',
  concept: 'kafka',
  file: 'events',
  focus: ['shards', 'kafka'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the flush publishes a
\`metrics.rolled\` event per window and a consumer sees records arrive, so the demo shows the rollup
stream filling. It compiles, and it hides four production flaws — a stream keyed by shard, a publish
that races the shard confirmation, no outbox, and no window boundaries. Review it like the pipeline
owner, fix it, and prove the fix with the checks below.

The flush that moves aggregated windows to the shard writers is also the source of the
\`metrics.rolled\` stream that dashboards and downstream rollup consumers read. Implement
\`publish_rollup\`, the flush path's event side:

- Publish one \`metrics.rolled\` event per **confirmed** series window, keyed by the **series id**.
  The key is the partition key: one series' windows then land on one partition and keep their order,
  so a consumer can fold a series' stream without sorting it. The draft keys by the shard, and a
  shard carries many series — every consumer must resort the interleaving, and no key can order it
  back afterwards.
- Publish **only after the shard writer confirms the window**. The flush returns the windows the
  shards accepted; a window they rejected must not appear on the topic, or the consumer's stream
  announces a rollup the store never committed and the two copies disagree forever. The draft
  produces before the confirmation.
- The payload carries the **window boundaries and the count**: \`window_start\`, \`window_end\` and
  the \`count\` of samples the window aggregated. A consumer told only that a rollup happened cannot
  place it on a graph; the draft's payload has neither boundary.
- The producer must be **idempotent with \`acks=all\`** (or the stack's equivalent: required acks
  \`all\` plus hashed, stable keys), so a retried produce cannot duplicate a rollup and an ack means
  the broker has the record.
- When the broker rejects the produce, write the event to the **outbox** (\`rollup_outbox\`) instead
  of dropping it: a relay republishes outbox rows when the broker returns. Observe the produce
  result, or a rejection has nowhere to go.

**Failure mode the checks target.** A shard key destroys the per-series ordering consumers rely on;
a publish that precedes the confirmation announces a rollup the shard never stored; a missing outbox
turns one broker outage into a rollup the dashboard will never see; and a payload without boundaries
leaves consumers to resort windows that arrive out of order — the exact work the key was supposed to
spare them.`,
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
        'The message key is the series id, so one series’ windows stay on one partition and in order and a consumer can fold them without sorting. The draft keys by the shard, which carries many series and scatters every series’ stream.',
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
        'The events go out only after the shard-writer flush returns the windows the shards accepted; publishing first announces a rollup the store may never commit. The draft produces before the confirmation.',
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
        'A rejected produce writes a row into `rollup_outbox` instead of dropping the event; a relay republishes it when the broker returns. The draft ignores the broker result, so one outage erases the rollup.',
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
        'Each event carries the window start, the window end and the count of samples the window aggregated, so a consumer knows exactly which window it is folding. The draft’s payload has neither boundary.',
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
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` with `acks`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer — so a retried produce cannot duplicate a rollup and an ack means the broker has the record. The draft publishes fire-and-forget from a default producer.',
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
    # TODO: this draft keys every event by the shard, publishes before the shard confirms the
    # windows, skips the outbox on a broker rejection and omits the window boundaries. Key by the
    # series, publish only the windows the shards accepted, carry window_start/window_end/count in
    # the event and insert a rollup_outbox row when the produce is rejected.
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
      starter: `/** metrics.rolled: a model-generated draft that keys by shard and publishes before the shard confirms. */
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
  // TODO: this draft keys every event by the shard, publishes before the shard confirms the
  // windows, skips the outbox on a broker rejection and omits the window boundaries. Key by the
  // series, publish only the accepted windows, carry window_start/window_end/count in the event
  // and insert a rollup_outbox row when the produce is rejected.
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

// TODO: this draft keys every event by the shard, publishes before the shard confirms the windows,
// skips the outbox on a broker rejection and omits the window boundaries. Key by the series,
// publish only the windows the shards accepted, carry window_start/window_end/count in the event
// and insert a rollup_outbox row when the produce is rejected.
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

  // TODO: this draft keys every event by the shard, publishes before the shard confirms the
  // windows, skips the outbox on a broker rejection and omits the window boundaries. Key by the
  // series, publish only the accepted windows, carry window_start/window_end/count in the event
  // and insert a rollup_outbox row when the produce is rejected.
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

// TODO: this draft keys every event by the shard, produces before the shard confirms the windows,
// skips the outbox on a broker rejection and omits the window boundaries. Key by the series,
// produce only the windows the shards accepted, carry window_start/window_end/count in the event
// and insert a rollup_outbox row when the produce is rejected.
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
    'The message key is the partition key: `key=series_id` (`key: seriesId`, `Key: []byte(seriesID)`, `ProducerRecord(topic, seriesId, event)`). Keyed by the shard, one series’ windows land in different partitions and their order is gone — and a shard carries many series, so no consumer can put one series’ order back afterwards.',
    'The shard flush already knows what was accepted: publish from its result, never straight from the input list. Producing first announces a rollup before the store commits it; wrap the produce, flush or await it so a rejection is real, and insert a `rollup_outbox` row when the broker refuses. The event carries `window_start`, `window_end` and the `count` so a consumer can fold it without asking the store.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` plus `acks: -1`, or required acks `all` with a hash balancer. Then a retried produce cannot duplicate a rollup and an acknowledged produce means the broker has the record.',
  ],
  debrief: `The interviewer is checking whether you can review an event-publishing path whose failure modes are ordering, currency and durability rather than syntax. The draft is convincing because the demo shows a well-shaped record arriving; nothing in it survives a broker rejection, an out-of-order stream or a consumer that cannot place a window on a graph. Three contracts are under review. The key is an ordering contract: partition by series and one series’ rollup stream arrives in window order, which is the assumption every consumer of that stream is built on; key by shard and every consumer inherits the resorting, and no later stage can restore order that the partition never guaranteed. The flush result is a currency contract: only the windows the shards accepted are real, so the produce follows the confirmation — an event published first announces a rollup the store may never commit, and the topic and the store disagree forever. The outbox is the durability contract: an idempotent producer with acks=all makes a retry harmless and an ack meaningful, and a rejected produce parks the event in rollup_outbox for a relay, so a broker outage delays a rollup instead of erasing one the dashboard will never see. Real platforms add a schema registry so consumers can trust the payload shape, topic compaction or retention sized to the rollup cadence, per-tenant produce quotas, and outbox-lag alarms — and they treat the rollup stream as replayable: a consumer rebuilds a series’ total by folding the windows it reads, which only works because the key and the boundaries are on every event.`,
};
