import type {Step} from '@/lib/types';

export const driftEventsStep: Step = {
  id: 'events',
  title: 'Drift events keyed by monitor for auditable history',
  concept: 'kafka',
  file: 'events',
  focus: ['monitor', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: every evaluation produces a
\`drift.evaluated\` event and the topic looks healthy in the console. It hides three flaws, and the first
one is the reason an audit cannot answer "when did this monitor last fire?". Review it, fix it, and
prove the fix.

Every evaluation can publish to \`drift.evaluated\`:

- **Keyed by monitor id.** The key decides the partition, so all events for one monitor keep their
  order relative to each other. The draft keys by model version, so two monitors watching the same
  version interleave and one monitor's history is split across partitions.
- **Routine evaluations are summarized, not published one by one.** Only a threshold crossing (or a
  state change) publishes an event; no-drift ticks are counted and rolled into one summary every
  \`SUMMARY_EVERY = 60\` evaluations, because a topic that carries every tick at full volume is
  unaffordable and useless for audit.
- The event carries the **metric, threshold, distance and both window boundaries**.
- The producer is **idempotent with \`acks=all\`**, so a retried produce cannot duplicate or reorder the
  history.
- A rejected produce writes an **outbox row** (\`insert_outbox\`) instead of dropping the event, so a
  broker outage cannot erase an alert from history.
- The consumer updates the monitor's Redis counters **before** it commits the offset.

**Failure mode the checks target.** A history is only auditable if it is ordered, complete and
affordable. Keying by the wrong entity destroys order; publishing every tick destroys the topic and
buries the crossing that mattered; and a produce error that is ignored destroys completeness exactly
when the broker is already sick — the moment you most need the record.`,
  sequence: {
    participants: ['Drift Monitor', 'Kafka drift.evaluated', 'History consumer', 'outbox'],
    messages: [
      {
        from: 'Drift Monitor',
        to: 'Kafka drift.evaluated',
        label: 'produce key=monitor_id · value=evidence',
        kind: 'sync',
      },
      {from: 'Kafka drift.evaluated', to: 'Drift Monitor', label: 'ack (idempotent, acks=all)', kind: 'reply'},
      {from: 'Drift Monitor', to: 'outbox', label: 'insert_outbox(payload) on a rejected produce', kind: 'async'},
      {from: 'Kafka drift.evaluated', to: 'History consumer', label: 'consume · per-monitor order', kind: 'async'},
      {
        from: 'History consumer',
        to: 'History consumer',
        label: 'HINCRBY counters, then commit the offset',
        kind: 'sync',
      },
      {
        from: 'Drift Monitor',
        to: 'Drift Monitor',
        label: 'quiet ticks roll into a summary every 60 evaluations',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'monitor-key',
      title: 'Keys drift.evaluated by monitor id',
      detail:
        'The record key is the monitor id, so every event for one monitor lands in one partition and keeps its order. The draft keys by model version, which interleaves monitors and scatters a single monitor’s history.',
      match: {
        python: {all: [/key=monitor\["monitor_id"\]/, /drift\.evaluated/]},
        typescript: {all: [/key:\s*monitor\.monitor_id/, /drift\.evaluated/]},
        go: {all: [/Key:\s*\[\]byte\(monitorID\)/, /drift\.evaluated/]},
        scala: {all: [/new ProducerRecord\[String, String\]\(\s*"drift\.evaluated"\s*,\s*monitor\.monitorId/]},
        cpp: {all: [/produce\([\s\S]{0,240}monitorId/, /drift\.evaluated/]},
      },
    },
    {
      id: 'threshold-only',
      title: 'Publishes crossings, summarizes routine ticks',
      detail:
        'A crossing publishes immediately; quiet ticks are counted and rolled into one summary every `SUMMARY_EVERY = 60` evaluations instead of one event per tick. The draft publishes every evaluation at full volume.',
      match: {
        python: {all: [/crossed/, /SUMMARY_EVERY/]},
        typescript: {all: [/crossed/, /SUMMARY_EVERY/]},
        go: {all: [/crossed/, /summaryEvery/]},
        scala: {all: [/crossed/, /SummaryEvery/]},
        cpp: {all: [/crossed/, /kSummaryEvery/]},
      },
    },
    {
      id: 'payload-evidence',
      title: 'Carries the metric, threshold, distance and boundaries',
      detail:
        'The event contains the metric, the threshold, the distance and both window boundaries. The draft sends no boundaries, so a consumer cannot tell which window an event describes or join it to a report.',
      match: {
        python: {all: [/metric/, /distance/, /threshold/, /window_start/, /window_end/]},
        typescript: {all: [/metric/, /distance/, /threshold/, /window_start/, /window_end/]},
        go: {all: [/Metric/, /distance/, /Threshold/, /windowStart/, /windowEnd/]},
        scala: {all: [/metric/, /distance/, /threshold/, /windowStart/, /windowEnd/]},
        cpp: {all: [/metric/, /distance/, /threshold/, /window_start/, /window_end/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true` + `acks: -1`, or required acks `all` with a hash balancer. A produce retry must not duplicate or reorder a monitor’s history.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Writes an outbox row when the produce is rejected',
      detail:
        'A rejected produce calls `insert_outbox` inside the error branch instead of dropping the event. The draft ignores the broker result, so an outage silently erases the alert from history.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("drift-monitor")

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_evaluation(monitor: dict, window: int, distance: float, over_threshold: bool) -> None:
    # TODO: this draft keys by model version, publishes every evaluation including no-drift ticks at
    # full volume, carries no window boundaries, configures no idempotence, and has no outbox for a
    # rejected produce. Review all five.
    event = {
        "monitor_id": monitor["monitor_id"],
        "metric": monitor["metric"],
        "distance": distance,
        "threshold": monitor["threshold"],
    }
    producer.produce("drift.evaluated", key=monitor["model_version"], value=json.dumps(event))
    producer.poll(0)
    logger.info("published drift evaluation monitor=%s", monitor["monitor_id"])
`,
      solution: `import json
import logging

import redis
from confluent_kafka import KafkaException, Producer

logger = logging.getLogger("drift-monitor")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SUMMARY_EVERY = 60

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


def insert_outbox(monitor_id: str, payload: str) -> None:
    """Record the event for replay when the broker rejects the produce."""
    r.lpush("outbox:drift.evaluated", json.dumps({"monitor_id": monitor_id, "payload": payload}))


def publish_evaluation(
    monitor: dict,
    window: int,
    distance: float,
    crossed: bool,
    summary: bool = False,
) -> bool:
    """Publish a drift event keyed by monitor: a crossing, or a periodic summary of quiet ticks."""
    if not crossed:
        quiet = r.hincrby(f"quiet:{monitor['monitor_id']}", "ticks", 1)
        if not summary and quiet % SUMMARY_EVERY != 0:
            return False
    event = {
        "monitor_id": monitor["monitor_id"],
        "metric": monitor["metric"],
        "distance": distance,
        "threshold": monitor["threshold"],
        "window_start": window,
        "window_end": window + monitor["window_s"],
        "crossed": crossed,
    }
    payload = json.dumps(event)
    try:
        producer.produce("drift.evaluated", key=monitor["monitor_id"], value=payload)
        producer.flush(5)
    except KafkaException:
        insert_outbox(monitor["monitor_id"], payload)
        return False
    logger.info("published drift event monitor=%s crossed=%s", monitor["monitor_id"], crossed)
    return True
`,
    },
    typescript: {
      starter: `/** drift.evaluated: a model-generated draft that publishes every evaluation. */
import {Kafka, logLevel} from 'kafkajs';

const kafka = new Kafka({clientId: 'drift-monitor', brokers: ['kafka:9092'], logLevel: logLevel.WARN});
const producer = kafka.producer();

interface Monitor {
  monitor_id: string;
  model_version: string;
  metric: string;
  threshold: number;
  window_s: number;
}

export async function publishEvaluation(
  monitor: Monitor,
  window: number,
  distance: number,
  overThreshold: boolean,
): Promise<void> {
  // TODO: this draft keys by model version, publishes every evaluation including no-drift ticks at
  // full volume, carries no window boundaries, configures no idempotence, and has no outbox for a
  // rejected produce. Review all five.
  const event = {
    monitor_id: monitor.monitor_id,
    metric: monitor.metric,
    distance,
    threshold: monitor.threshold,
  };
  await producer.send({
    topic: 'drift.evaluated',
    messages: [{key: monitor.model_version, value: JSON.stringify(event)}],
  });
  console.log({monitor: monitor.monitor_id, overThreshold}, 'published drift evaluation');
}
`,
      solution: `/** drift.evaluated keyed by monitor: crossings and summaries, with an outbox. */
import Redis from 'ioredis';
import {Kafka, logLevel} from 'kafkajs';

const r = new Redis({host: 'redis', port: 6379});

const SUMMARY_EVERY = 60;

const kafka = new Kafka({clientId: 'drift-monitor', brokers: ['kafka:9092'], logLevel: logLevel.WARN});
const producer = kafka.producer({idempotent: true, acks: -1});

interface Monitor {
  monitor_id: string;
  metric: string;
  threshold: number;
  window_s: number;
}

/** Record the event for replay when the broker rejects the produce. */
async function insertOutbox(monitorId: string, payload: string): Promise<void> {
  await r.lpush('outbox:drift.evaluated', JSON.stringify({monitor_id: monitorId, payload}));
}

export async function publishEvaluation(
  monitor: Monitor,
  window: number,
  distance: number,
  crossed: boolean,
  summary: boolean = false,
): Promise<boolean> {
  if (!crossed) {
    const quiet = await r.hincrby('quiet:' + monitor.monitor_id, 'ticks', 1);
    if (!summary && quiet % SUMMARY_EVERY !== 0) return false;
  }
  const window_start = window;
  const window_end = window + monitor.window_s;
  const event = {
    monitor_id: monitor.monitor_id,
    metric: monitor.metric,
    distance,
    threshold: monitor.threshold,
    window_start,
    window_end,
    crossed,
  };
  const payload = JSON.stringify(event);
  try {
    await producer.send({
      topic: 'drift.evaluated',
      messages: [{key: monitor.monitor_id, value: payload}],
    });
  } catch (error) {
    console.warn({monitor: monitor.monitor_id, error}, 'produce rejected, writing the outbox row');
    await insertOutbox(monitor.monitor_id, payload);
    return false;
  }
  console.log({monitor: monitor.monitor_id, crossed}, 'published drift event');
  return true;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	kafka "github.com/segmentio/kafka-go"
)

var writer *kafka.Writer

type Monitor struct {
	MonitorID    string
	ModelVersion string
	Metric       string
	Threshold    float64
	WindowS      int64
}

func publishEvaluation(ctx context.Context, monitor Monitor, window int64, distance float64, overThreshold bool) error {
	// TODO: this draft keys by model version, publishes every evaluation including no-drift ticks at
	// full volume, carries no window boundaries, configures no idempotence, and has no outbox for a
	// rejected produce. Review all five.
	event := map[string]any{
		"monitor_id": monitor.MonitorID,
		"metric":     monitor.Metric,
		"distance":   distance,
		"threshold":  monitor.Threshold,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	key := []byte(monitor.ModelVersion)
	err = writer.WriteMessages(ctx, kafka.Message{Topic: "drift.evaluated", Key: key, Value: payload})
	if err != nil {
		return err
	}
	log.Printf("published drift evaluation monitor=%s", monitor.MonitorID)
	return nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	kafka "github.com/segmentio/kafka-go"
	"github.com/redis/go-redis/v9"
)

const summaryEvery = 60

var (
	writer *kafka.Writer
	rdb    *redis.Client
)

type Monitor struct {
	MonitorID string
	Metric    string
	Threshold float64
	WindowS   int64
}

func newWriter() *kafka.Writer {
	return &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Topic:        "drift.evaluated",
		RequiredAcks: kafka.RequireAll,
		Balancer:     &kafka.Hash{},
	}
}

// InsertOutbox records the event for replay when the broker rejects the produce.
func InsertOutbox(ctx context.Context, monitorID, payload string) {
	rdb.LPush(ctx, "outbox:drift.evaluated", payload)
}

func publishEvaluation(
	ctx context.Context,
	monitor Monitor,
	window int64,
	distance float64,
	crossed bool,
	summary bool,
) (bool, error) {
	if !crossed {
		quiet, err := rdb.HIncrBy(ctx, "quiet:"+monitor.MonitorID, "ticks", 1).Result()
		if err != nil {
			return false, err
		}
		if !summary && quiet%summaryEvery != 0 {
			return false, nil
		}
	}
	windowStart := window
	windowEnd := window + monitor.WindowS
	event := map[string]any{
		"monitor_id":   monitor.MonitorID,
		"metric":       monitor.Metric,
		"distance":     distance,
		"threshold":    monitor.Threshold,
		"window_start": windowStart,
		"window_end":   windowEnd,
		"crossed":      crossed,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return false, err
	}
	monitorID := monitor.MonitorID
	err = writer.WriteMessages(ctx, kafka.Message{
		Topic: "drift.evaluated",
		Key:   []byte(monitorID),
		Value: payload,
	})
	if err != nil {
		InsertOutbox(ctx, monitorID, string(payload))
		return false, err
	}
	log.Printf("published drift event monitor=%s crossed=%t", monitorID, crossed)
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}

final case class Monitor(monitorId: String, modelVersion: String, metric: String, threshold: Double, windowS: Long)

object DriftEvents {
  val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")

  val producer = new KafkaProducer[String, String](props)

  def publishEvaluation(monitor: Monitor, window: Long, distance: Double, overThreshold: Boolean): Unit = {
    // TODO: this draft keys by model version, publishes every evaluation including no-drift ticks at
    // full volume, carries no window boundaries, configures no idempotence, and has no outbox for a
    // rejected produce. Review all five.
    val payload =
      "{\\"monitor_id\\":\\"" + monitor.monitorId + "\\",\\"metric\\":\\"" + monitor.metric +
        "\\",\\"distance\\":" + distance + ",\\"threshold\\":" + monitor.threshold + "}"
    producer.send(new ProducerRecord[String, String]("drift.evaluated", monitor.modelVersion, payload))
    producer.flush()
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class Monitor(monitorId: String, metric: String, threshold: Double, windowS: Long)
final case class DriftEvent(
    monitor_id: String,
    metric: String,
    distance: Double,
    threshold: Double,
    window_start: Long,
    window_end: Long,
    crossed: Boolean,
)

object DriftEvents {
  val SummaryEvery = 60

  implicit val eventFormat: RootJsonFormat[DriftEvent] = jsonFormat7(DriftEvent)

  val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")

  val producer = new KafkaProducer[String, String](props)
  val jedis = new Jedis("redis", 6379)

  /** Record the event for replay when the broker rejects the produce. */
  def insertOutbox(monitorId: String, payload: String): Unit = {
    jedis.lpush("outbox:drift.evaluated", payload)
  }

  def publishEvaluation(
      monitor: Monitor,
      window: Long,
      distance: Double,
      crossed: Boolean,
      summary: Boolean = false,
  ): Boolean = {
    if (!crossed) {
      val quiet = jedis.hincrBy("quiet:" + monitor.monitorId, "ticks", 1)
      if (!summary && quiet % SummaryEvery != 0) {
        return false
      }
    }
    val windowStart = window
    val windowEnd = window + monitor.windowS
    val payload = DriftEvent(
      monitor_id = monitor.monitorId,
      metric = monitor.metric,
      distance = distance,
      threshold = monitor.threshold,
      window_start = windowStart,
      window_end = windowEnd,
      crossed = crossed,
    ).toJson.compactPrint
    try {
      producer.send(new ProducerRecord[String, String]("drift.evaluated", monitor.monitorId, payload)).get(5, TimeUnit.SECONDS)
    } catch {
      case _: Exception =>
        insertOutbox(monitor.monitorId, payload)
        return false
    }
    true
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <string>

struct Monitor {
  const std::string& monitor_id() const;
  const std::string& model_version() const;
  const std::string& metric() const;
  double threshold() const;
  long window_s() const;
};

RdKafka::Producer* producer = nullptr;

void publishEvaluation(const Monitor& monitor, long window, double distance, bool overThreshold) {
  // TODO: this draft keys by model version, publishes every evaluation including no-drift ticks at
  // full volume, carries no window boundaries, configures no idempotence, and has no outbox for a
  // rejected produce. Review all five.
  const std::string payload = "{\\"monitor_id\\":\\"" + monitor.monitor_id() + "\\",\\"metric\\":\\"" +
                              monitor.metric() + "\\",\\"distance\\":" + std::to_string(distance) +
                              ",\\"threshold\\":" + std::to_string(monitor.threshold()) + "}";
  const std::string key = monitor.model_version();
  producer->produce("drift.evaluated", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), key.c_str(), key.size(), 0, nullptr);
  producer->poll(0);
  std::cerr << "published drift evaluation monitor=" << monitor.monitor_id() << "\\n";
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <string>

struct Monitor {
  const std::string& monitor_id() const;
  const std::string& metric() const;
  double threshold() const;
  long window_s() const;
};

constexpr int kSummaryEvery = 60;

long quietTicks(const std::string& monitorId);

RdKafka::Producer* createProducer() {
  std::string errstr;
  RdKafka::Conf* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("enable.idempotence", "true", errstr);
  conf->set("acks", "all", errstr);
  RdKafka::Producer* created = RdKafka::Producer::create(conf, errstr);
  delete conf;
  return created;
}

RdKafka::Producer* producer = createProducer();

/** Record the event for replay when the broker rejects the produce. */
void insertOutbox(const std::string& monitorId, const std::string& payload);

bool publishEvaluation(const Monitor& monitor, long window, double distance, bool crossed, bool summary) {
  if (!crossed) {
    const long quiet = quietTicks(monitor.monitor_id());
    if (!summary && quiet % kSummaryEvery != 0) return false;
  }
  const long window_start = window;
  const long window_end = window + monitor.window_s();
  const std::string payload = "{\\"monitor_id\\":\\"" + monitor.monitor_id() + "\\",\\"metric\\":\\"" +
                              monitor.metric() + "\\",\\"distance\\":" + std::to_string(distance) +
                              ",\\"threshold\\":" + std::to_string(monitor.threshold()) +
                              ",\\"window_start\\":" + std::to_string(window_start) +
                              ",\\"window_end\\":" + std::to_string(window_end) + ",\\"crossed\\":" +
                              (crossed ? "true" : "false") + "}";
  const std::string monitorId = monitor.monitor_id();
  const RdKafka::ErrorCode err =
      producer->produce("drift.evaluated", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                        const_cast<char*>(payload.data()), payload.size(), monitorId.c_str(), monitorId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    insertOutbox(monitorId, payload);
    return false;
  }
  producer->poll(0);
  return true;
}
`,
    },
  },
  hints: [
    'The key is the partition selector, so it must name the entity whose order matters: the monitor. `key=monitor_id` keeps one monitor’s crossings, summaries and reports in order; keying by model version interleaves every monitor watching that version.',
    'A topic that carries every tick is a bill and a haystack. Publish on a crossing, count the quiet ticks in Redis and publish one summary every `SUMMARY_EVERY` evaluations — then the one event that mattered is still findable.',
    'Configure the producer once: `enable.idempotence` with `acks=all` (or `idempotent: true`, `acks: -1`). Then wrap the produce so a broker rejection calls `insert_outbox` instead of vanishing; the outbox row is what lets a replay restore the missing history.',
  ],
  debrief: `This step is about the audit trail behind the alert. Three habits are being tested: choose the
partition key from the question you will ask later ("show me this monitor's history"), not from the
record's shape; publish the signal and summarize the noise, so volume does not bury the crossing; and
treat a produce error as data loss that must be recorded, not logged. Idempotence plus \`acks=all\` is what
lets a retry be safe, and the outbox is what closes the gap when the broker is unreachable. The consumer
side follows the same habit as any exactly-once-adjacent pipeline: update the Redis counters first, then
commit the offset, so a crash replays rather than loses. Real systems add a compacted topic for the
latest state per monitor, schema registry enforcement so no producer smuggles feature values in, and a
replay tool that drains the outbox in order.`,
};
