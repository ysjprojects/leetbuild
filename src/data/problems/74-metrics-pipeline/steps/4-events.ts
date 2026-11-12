import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Rollup events: after the shard accepted, keyed by series, with an outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['shards', 'kafka'],
  task: `## Task

**Starting point.** The starter is \`publish_rollups(windows)\`, the second half of the rollup tick:
for each closed window it produces a \`metrics.rolled\` event keyed by the window's shard
(\`shard_for\`) carrying \`{window_id, series, start, sum}\`, counts it as published unless \`produce\`
raises, then calls \`flush_windows\` (step 3, provided as \`metrics.flush\`). The stream fills during
the demo, and it hides 5 flaws.

**Failure mode the checks target.** A consumer folding one series reads its windows from several
partitions out of order; an event announces a window no shard stored; the payload does not say
which window it covers or how many samples it holds; a delivery that fails after \`produce\` returned
leaves nothing behind; and a lost acknowledgement writes the event twice.

- The key is \`event_key(w)\` = \`{tenant}/{series}\`.
- Call \`flush_windows(windows)\` first; produce only for the ids in its \`accepted\` (pending
  windows go out with the next tick).
- The payload is \`{window_id, tenant, series, window_start, window_end, count, sum}\` with
  \`window_end = window_start + WINDOW_SECONDS\`.
- Wait for the delivery reports at most \`ACK_TIMEOUT_S\` (2 s); every event not acknowledged goes to
  \`outbox.insert(TOPIC, key, payload)\` (\`metrics.outbox\`). Return how many were acknowledged.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent: true\` and \`acks: -1\`; the Go
  version uses confluent-kafka-go, since kafka-go has no idempotent producer).`,
  sequence: {
    participants: ['Rollup tick', 'Shard writers', 'metrics.rolled', 'Outbox'],
    messages: [
      {from: 'Rollup tick', to: 'Shard writers', label: 'flush_windows(windows)', kind: 'sync'},
      {from: 'Shard writers', to: 'Rollup tick', label: 'accepted ids · pending ids', kind: 'reply'},
      {
        from: 'Rollup tick',
        to: 'metrics.rolled',
        label: 'produce accepted · key tenant/series · acks=all',
        kind: 'sync',
      },
      {from: 'metrics.rolled', to: 'Rollup tick', label: 'delivery reports (≤ 2 s)', kind: 'reply'},
      {from: 'Rollup tick', to: 'Outbox', label: 'insert every event not acknowledged', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'key-by-series',
      title: 'Keys every event by tenant and series',
      detail:
        "The record key is `event_key(w)` (`{tenant}/{series}`), so one series' windows share a partition and arrive in order. The starter keys by the shard target, which holds many series, so a consumer can't rely on partition order for any of them.",
      match: {
        python: {all: [/def event_key\(/, /key=event_key\(/], none: [/key=shard_for\(/]},
        typescript: {all: [/eventKey\s*=|function eventKey/, /key:\s*eventKey\(/], none: [/key:\s*shardFor\(/]},
        go: {all: [/func eventKey\(/, /Key:\s*\[\]byte\(eventKey\(w\)\)/], none: [/Key:\s*\[\]byte\(model\.ShardFor/]},
        scala: {
          all: [/def eventKey\(/, /ProducerRecord\[String, String\]\(Topic,\s*eventKey\(w\)/],
          none: [/Topic,\s*shardFor\(/],
        },
        cpp: {all: [/std::string eventKey\(/, /key = eventKey\(w\)/], none: [/key = metrics::shardFor\(/]},
      },
    },
    {
      id: 'publish-after-confirm',
      title: 'Publishes only the windows a shard accepted',
      detail:
        '`flush_windows` runs first and only the ids in its `accepted` get an event; a window still pending is resent by the next tick, not announced. The starter produces every window before it flushes, so consumers fold rollups no shard stored.',
      match: {
        python: {all: [/["']accepted["']/], order: [/flush_windows\(windows\)/, /producer\.produce\(/]},
        typescript: {all: [/\.accepted\b/], order: [/flushWindows\(windows\)/, /producer\.send\(/]},
        go: {all: [/\.Accepted\b/], order: [/flush\.FlushWindows\(/, /producer\.Produce\(/]},
        scala: {all: [/\.accepted\b/], order: [/Flush\.flushWindows\(/, /producer\.send\(/]},
        cpp: {all: [/\.accepted\b/], order: [/metrics::flushWindows\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'window-boundaries',
      title: 'Carries the window boundaries and the count',
      detail:
        'The payload is `{window_id, tenant, series, window_start, window_end, count, sum}`, so a consumer knows which window it folds and how many samples it holds. The starter sends `start` and `sum` only.',
      match: {
        python: {all: [/["']window_start["']/, /["']window_end["']/, /["']count["']/]},
        typescript: {all: [/window_start:/, /window_end:/, /count:/]},
        go: {all: [/"window_start"/, /"window_end"/, /"count"/]},
        scala: {all: [/"window_start"/, /"window_end"/, /"count"/]},
        cpp: {all: [/"window_start"/, /"window_end"/, /"count"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'Every event whose delivery report fails, or does not arrive within `ACK_TIMEOUT_S` (2 s), becomes an outbox row with the topic, the key and the payload, and is not counted as published. The starter only catches errors `produce` raises locally, so a failed delivery vanishes.',
      match: {
        python: {
          all: [/on_delivery\s*=/, /producer\.flush\(\s*ACK_TIMEOUT_S/, /outbox\.insert\(/],
          none: [/except KafkaException/],
        },
        typescript: {
          all: [/await producer\.send\(/, /timeout:\s*ACK_TIMEOUT_MS/, /outbox\.insert\(|\binsert\(/],
          none: [/void producer\.send\(/],
        },
        go: {all: [/TopicPartition\.Error/, /time\.After\(\s*ackTimeout/, /outbox\.Insert\(/]},
        scala: {all: [/Outbox\.insert\(/, /\.get\([^\n]*TimeUnit/], none: [/case _: KafkaException/]},
        cpp: {all: [/dr_cb/, /->flush\(\s*kAckTimeoutMs/, /metrics::outboxInsert\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured with idempotence and `acks=all`, so a retry after a lost acknowledgement writes the event once and a leader failover cannot drop an acknowledged one. The starter uses `acks=1` without idempotence.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from metrics import outbox  # outbox.insert(topic, key, payload)
from metrics.flush import flush_windows  # flush_windows(windows) -> {"accepted": [ids], "pending": {...}}
from metrics.model import WINDOW_SECONDS, shard_for, window_id

TOPIC = "metrics.rolled"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def rollup_event(w: dict) -> dict:
    return {"window_id": window_id(w), "series": w["series"], "start": w["start"], "sum": w["sum"]}


def publish_rollups(windows: list) -> int:
    """Flush the closed windows to the shard writers and announce each rollup; the events published."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    published = 0
    for w in windows:
        event = rollup_event(w)
        try:
            producer.produce(TOPIC, key=shard_for(w["series"]), value=json.dumps(event))
            producer.poll(0)
            published += 1
        except KafkaException:
            outbox.insert(TOPIC, shard_for(w["series"]), event)
    flush_windows(windows)
    return published
`,
      solution: `import json

from confluent_kafka import Producer

from metrics import outbox  # outbox.insert(topic, key, payload)
from metrics.flush import flush_windows  # flush_windows(windows) -> {"accepted": [ids], "pending": {...}}
from metrics.model import WINDOW_SECONDS, window_id

TOPIC = "metrics.rolled"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the event before the broker answers
    "enable.idempotence": True,  # a retry after a lost acknowledgement writes the event once
})


def event_key(w: dict) -> str:
    return f"{w['tenant']}/{w['series']}"


def rollup_event(w: dict) -> dict:
    return {
        "window_id": window_id(w),
        "tenant": w["tenant"],
        "series": w["series"],
        "window_start": w["start"],
        "window_end": w["start"] + WINDOW_SECONDS,
        "count": w["count"],
        "sum": w["sum"],
    }


def publish_rollups(windows: list) -> int:
    """Flush the closed windows, then announce the ones a shard accepted; the events the broker acknowledged."""
    accepted = set(flush_windows(windows)["accepted"])
    confirmed = [w for w in windows if window_id(w) in accepted]  # pending windows go out with the next tick
    outcome = {}
    for w in confirmed:
        def on_delivery(err, msg, wid=window_id(w)):
            outcome[wid] = err

        producer.produce(TOPIC, key=event_key(w), value=json.dumps(rollup_event(w)), on_delivery=on_delivery)
    producer.flush(ACK_TIMEOUT_S)  # serves the delivery reports, or gives up after the window
    published = 0
    for w in confirmed:
        if window_id(w) in outcome and outcome[window_id(w)] is None:
            published += 1
        else:
            # Failed or not acknowledged in time: the relay publishes the row once the broker is back.
            outbox.insert(TOPIC, event_key(w), rollup_event(w))
    return published
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {flushWindows} from 'metrics/flush'; // flushWindows(windows): Promise<FlushResult>
import {type Window, WINDOW_SECONDS, shardFor, windowId} from 'metrics/model';
import {insert} from 'metrics/outbox'; // insert(topic, key, payload)

export const TOPIC = 'metrics.rolled';

const kafka = new Kafka({clientId: 'metricsd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export const rollupEvent = (w: Window) => ({window_id: windowId(w), series: w.series, start: w.start, sum: w.sum});

/** Flush the closed windows to the shard writers and announce each rollup; the events published. */
export async function publishRollups(windows: Window[]): Promise<number> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  let published = 0;
  for (const w of windows) {
    const event = rollupEvent(w);
    try {
      void producer.send({topic: TOPIC, messages: [{key: shardFor(w.series), value: JSON.stringify(event)}], acks: 1});
      published += 1;
    } catch {
      await insert(TOPIC, shardFor(w.series), event);
    }
  }
  await flushWindows(windows);
  return published;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {flushWindows} from 'metrics/flush'; // flushWindows(windows): Promise<FlushResult>
import {type Window, WINDOW_SECONDS, windowId} from 'metrics/model';
import {insert} from 'metrics/outbox'; // insert(topic, key, payload)

export const TOPIC = 'metrics.rolled';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'metricsd', brokers: ['kafka:9092']});
// Idempotent: a retry after a lost acknowledgement writes the event once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

export const eventKey = (w: Window): string => \`\${w.tenant}/\${w.series}\`;

export const rollupEvent = (w: Window) => ({
  window_id: windowId(w),
  tenant: w.tenant,
  series: w.series,
  window_start: w.start,
  window_end: w.start + WINDOW_SECONDS,
  count: w.count,
  sum: w.sum,
});

/** Flush the closed windows, then announce the ones a shard accepted; the events the broker acknowledged. */
export async function publishRollups(windows: Window[]): Promise<number> {
  const accepted = new Set((await flushWindows(windows)).accepted);
  const confirmed = windows.filter(w => accepted.has(windowId(w))); // pending windows go out with the next tick
  if (confirmed.length === 0) return 0;
  try {
    // acks: -1 (all): every in-sync replica has the events before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: confirmed.map(w => ({key: eventKey(w), value: JSON.stringify(rollupEvent(w))})),
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return confirmed.length;
  } catch {
    // Failed or not acknowledged in time: the relay publishes the rows once the broker is back.
    for (const w of confirmed) await insert(TOPIC, eventKey(w), rollupEvent(w));
    return 0;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"metrics/flush"  // flush.FlushWindows(ctx, windows) model.FlushResult
	"metrics/model"  // model.Window, WindowSeconds, ShardFor, WindowID
	"metrics/outbox" // outbox.Insert(ctx, topic, key, payload) error
)

const topic = "metrics.rolled"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func rollupEvent(w model.Window) map[string]any {
	return map[string]any{"window_id": model.WindowID(w), "series": w.Series, "start": w.Start, "sum": w.Sum}
}

// publishRollups flushes the closed windows to the shard writers and announces each rollup; the events published.
func publishRollups(ctx context.Context, windows []model.Window) (int, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	published := 0
	for _, w := range windows {
		event := rollupEvent(w)
		value, _ := json.Marshal(event)
		t := topic
		msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(model.ShardFor(w.Series)), Value: value}
		if err := producer.Produce(msg, nil); err != nil {
			if err := outbox.Insert(ctx, topic, model.ShardFor(w.Series), event); err != nil {
				return published, err
			}
			continue
		}
		published++
	}
	flush.FlushWindows(ctx, windows)
	return published, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"metrics/flush"  // flush.FlushWindows(ctx, windows) model.FlushResult
	"metrics/model"  // model.Window, WindowSeconds, ShardFor, WindowID
	"metrics/outbox" // outbox.Insert(ctx, topic, key, payload) error
)

const (
	topic      = "metrics.rolled"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the event before the broker answers
		"enable.idempotence": true,  // a retry after a lost acknowledgement writes the event once
	})
	if err != nil {
		panic(err)
	}
	return p
}

func eventKey(w model.Window) string { return w.Tenant + "/" + w.Series }

func rollupEvent(w model.Window) map[string]any {
	return map[string]any{
		"window_id":    model.WindowID(w),
		"tenant":       w.Tenant,
		"series":       w.Series,
		"window_start": w.Start,
		"window_end":   w.Start + model.WindowSeconds,
		"count":        w.Count,
		"sum":          w.Sum,
	}
}

// publishRollups flushes the closed windows, then announces the ones a shard accepted; the events the broker acknowledged.
func publishRollups(ctx context.Context, windows []model.Window) (int, error) {
	accepted := map[string]bool{}
	for _, id := range flush.FlushWindows(ctx, windows).Accepted {
		accepted[id] = true
	}
	confirmed := []model.Window{} // pending windows go out with the next tick
	for _, w := range windows {
		if accepted[model.WindowID(w)] {
			confirmed = append(confirmed, w)
		}
	}
	deliveries := make(chan kafka.Event, len(confirmed))
	delivered := make([]bool, len(confirmed))
	waiting := 0
	for i, w := range confirmed {
		value, _ := json.Marshal(rollupEvent(w))
		t := topic
		msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(eventKey(w)), Value: value, Opaque: i}
		if err := producer.Produce(msg, deliveries); err == nil {
			waiting++
		}
	}
	timeout := time.After(ackTimeout)
	for waiting > 0 {
		select {
		case e := <-deliveries:
			waiting--
			if m, ok := e.(*kafka.Message); ok && m.TopicPartition.Error == nil {
				delivered[m.Opaque.(int)] = true
			}
		case <-timeout:
			waiting = 0 // no acknowledgement within the window
		}
	}
	published := 0
	for i, w := range confirmed {
		if delivered[i] {
			published++
			continue
		}
		// Failed or not acknowledged in time: the relay publishes the row once the broker is back.
		if err := outbox.Insert(ctx, topic, eventKey(w), rollupEvent(w)); err != nil {
			return published, err
		}
	}
	return published, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import metrics.Model.{Window, WindowSeconds, shardFor, windowId}
import metrics.{Flush, Outbox} // Flush.flushWindows(windows): FlushResult · Outbox.insert(topic, key, payload)

object Events {
  val Topic = "metrics.rolled"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def rollupEvent(w: Window): JsObject =
    JsObject("window_id" -> JsString(windowId(w)), "series" -> JsString(w.series), "start" -> JsNumber(w.start), "sum" -> JsNumber(w.sum))

  /** Flush the closed windows to the shard writers and announce each rollup; the events published. */
  def publishRollups(windows: Seq[Window]): Int = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    var published = 0
    windows.foreach { w =>
      val event = rollupEvent(w)
      try {
        producer.send(new ProducerRecord[String, String](Topic, shardFor(w.series), event.compactPrint))
        published += 1
      } catch { case _: KafkaException => Outbox.insert(Topic, shardFor(w.series), event) }
    }
    Flush.flushWindows(windows)
    published
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import metrics.Model.{Window, WindowSeconds, windowId}
import metrics.{Flush, Outbox} // Flush.flushWindows(windows): FlushResult · Outbox.insert(topic, key, payload)

object Events {
  val Topic = "metrics.rolled"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the event before the broker answers
    props.put("enable.idempotence", "true") // a retry after a lost acknowledgement writes the event once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventKey(w: Window): String = s"\${w.tenant}/\${w.series}"

  def rollupEvent(w: Window): JsObject = JsObject(
    "window_id" -> JsString(windowId(w)),
    "tenant" -> JsString(w.tenant),
    "series" -> JsString(w.series),
    "window_start" -> JsNumber(w.start),
    "window_end" -> JsNumber(w.start + WindowSeconds),
    "count" -> JsNumber(w.count),
    "sum" -> JsNumber(w.sum)
  )

  /** Flush the closed windows, then announce the ones a shard accepted; the events the broker acknowledged. */
  def publishRollups(windows: Seq[Window]): Int = {
    val accepted = Flush.flushWindows(windows).accepted.toSet
    val confirmed = windows.filter(w => accepted(windowId(w))) // pending windows go out with the next tick
    val sends = confirmed.map(w => w -> producer.send(new ProducerRecord[String, String](Topic, eventKey(w), rollupEvent(w).compactPrint)))
    val deadline = System.currentTimeMillis() + AckTimeoutMs
    sends.count { case (w, ack) =>
      val delivered = Try(ack.get(math.max(0L, deadline - System.currentTimeMillis()), TimeUnit.MILLISECONDS)).isSuccess
      // Failed or not acknowledged in time: the relay publishes the row once the broker is back.
      if (!delivered) Outbox.insert(Topic, eventKey(w), rollupEvent(w))
      delivered
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

#include "metrics/flush.h"   // metrics::flushWindows(windows) -> FlushResult
#include "metrics/model.h"   // metrics::Window, kWindowSeconds, shardFor, windowId
#include "metrics/outbox.h"  // metrics::outboxInsert(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "metrics.rolled";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json rollupEvent(const metrics::Window& w) {
  return json{{"window_id", metrics::windowId(w)}, {"series", w.series}, {"start", w.start}, {"sum", w.sum}};
}

// Flush the closed windows to the shard writers and announce each rollup; the events published.
int publishRollups(const std::vector<metrics::Window>& windows) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  int published = 0;
  for (const metrics::Window& w : windows) {
    const json event = rollupEvent(w);
    const std::string value = event.dump();
    const std::string key = metrics::shardFor(w.series);
    const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                     const_cast<char*>(value.data()), value.size(), key.c_str(), key.size(), 0, nullptr);
    producer->poll(0);
    if (err != RdKafka::ERR_NO_ERROR) {
      metrics::outboxInsert(kTopic, key, event);
      continue;
    }
    published++;
  }
  metrics::flushWindows(windows);
  return published;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "metrics/flush.h"   // metrics::flushWindows(windows) -> FlushResult
#include "metrics/model.h"   // metrics::Window, kWindowSeconds, shardFor, windowId
#include "metrics/outbox.h"  // metrics::outboxInsert(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "metrics.rolled";
constexpr int kAckTimeoutMs = 2000;

// Delivery reports by message tag: publishRollups tags each event it produces and reads its outcome.
class DeliveryReports : public RdKafka::DeliveryReportCb {
 public:
  std::map<uintptr_t, RdKafka::ErrorCode> outcome;
  void dr_cb(RdKafka::Message& message) override { outcome[reinterpret_cast<uintptr_t>(message.msg_opaque())] = message.err(); }
};

DeliveryReports reports;
uintptr_t nextTag = 1;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the event before the broker answers
  conf->set("enable.idempotence", "true", err);  // a retry after a lost acknowledgement writes the event once
  conf->set("dr_cb", &reports, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

std::string eventKey(const metrics::Window& w) { return w.tenant + "/" + w.series; }

json rollupEvent(const metrics::Window& w) {
  return json{{"window_id", metrics::windowId(w)}, {"tenant", w.tenant}, {"series", w.series}, {"window_start", w.start},
              {"window_end", w.start + metrics::kWindowSeconds}, {"count", w.count}, {"sum", w.sum}};
}

// Flush the closed windows, then announce the ones a shard accepted; the events the broker acknowledged.
int publishRollups(const std::vector<metrics::Window>& windows) {
  const metrics::FlushResult result = metrics::flushWindows(windows);
  const std::set<std::string> accepted(result.accepted.begin(), result.accepted.end());
  std::vector<std::pair<metrics::Window, uintptr_t>> sent;  // pending windows go out with the next tick
  for (const metrics::Window& w : windows) {
    if (accepted.count(metrics::windowId(w)) == 0) continue;
    const std::string value = rollupEvent(w).dump();
    const std::string key = eventKey(w);
    const uintptr_t tag = nextTag++;
    const RdKafka::ErrorCode err =
        producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                          value.size(), key.c_str(), key.size(), 0, reinterpret_cast<void*>(tag));
    if (err != RdKafka::ERR_NO_ERROR) reports.outcome[tag] = err;
    sent.emplace_back(w, tag);
  }
  producer->flush(kAckTimeoutMs);  // serves the delivery reports, or gives up after the window
  int published = 0;
  for (const auto& [w, tag] : sent) {
    const auto found = reports.outcome.find(tag);
    if (found != reports.outcome.end() && found->second == RdKafka::ERR_NO_ERROR) {
      published++;
    } else {
      // Failed or not acknowledged in time: the relay publishes the row once the broker is back.
      metrics::outboxInsert(kTopic, eventKey(w), rollupEvent(w));
    }
    if (found != reports.outcome.end()) reports.outcome.erase(found);
  }
  return published;
}
`,
    },
  },
  harness: {
    python: `import json

import metrics_pipeline_pb2 as pb
import metrics_pipeline_pb2_grpc as pb_grpc
from metrics.model import SHARDS, shard_for, window_id

TOPIC = "metrics.rolled"
START = 1793747840


class Shard(pb_grpc.MetricsWriterServicer):
    """A shard writer that accepts every window; it notes how many events were on the topic when it was asked."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.on_topic = []

    def WriteWindows(self, request, context):
        self.on_topic.append(len(self.ctx.kafka.records(TOPIC)))
        return pb.WriteReply(accepted=[w.window_id for w in request.windows])


def _setup(ctx):
    shards = {target: Shard(ctx) for target in SHARDS}
    for target, shard in shards.items():
        ctx.grpc.serve(pb_grpc.add_MetricsWriterServicer_to_server, shard, target)
    return ctx.load("events"), shards


def _window(tenant="acme", host="a", start=START, count=3):
    return {"tenant": tenant, "series": f"cpu_seconds{{host={host}}}", "start": start, "count": count, "sum": count * 0.5}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_key_by_series(ctx):
    m, _ = _setup(ctx)
    windows = [_window(host="a"), _window(host="b"), _window(host="a", start=START + 10), _window(tenant="globex", host="a")]
    m.publish_rollups(windows)
    records = ctx.kafka.records(TOPIC)
    keys = sorted((r.key or b"").decode() for r in records)
    want = sorted(f"{w['tenant']}/{w['series']}" for w in windows)
    assert keys == want, f"the events are keyed {keys}, expected {want}: one series' windows must share a key, and so a partition"
    same = {r.partition for r in records if r.key == b"acme/cpu_seconds{host=a}"}
    assert len(same) == 1, f"the two windows of acme/cpu_seconds{{host=a}} landed on partitions {sorted(same)}"


def check_publish_after_confirm(ctx):
    m, shards = _setup(ctx)
    windows = [_window(host=f"h{i}") for i in range(12)]
    down = SHARDS[2]
    ctx.grpc.stop(down)
    m.publish_rollups(windows)
    seen = [n for shard in shards.values() for n in shard.on_topic]
    assert seen, "publish_rollups never asked the shard writers (flush_windows)"
    assert max(seen) == 0, f"when the shards were asked the topic already held {max(seen)} events: an event must follow the shard's acceptance, not precede it"
    published = sorted(json.loads(r.value).get("window_id", "?") for r in ctx.kafka.records(TOPIC))
    want = sorted(window_id(w) for w in windows if shard_for(w["series"]) != down)
    assert published == want, f"with {down} down the topic holds events for {len(published)} windows, expected the {len(want)} the other shards accepted: its windows are pending, not rolled up"
    assert _outbox(ctx) == [], f"pending windows are resent by the next tick, not written to the outbox: {_outbox(ctx)[:1]}"


def check_window_boundaries(ctx):
    m, _ = _setup(ctx)
    w = _window(count=4)
    m.publish_rollups([w])
    values = ctx.kafka.values(TOPIC)
    assert len(values) == 1, f"one accepted window produced {len(values)} events"
    event = json.loads(values[0])
    want = {"window_id": window_id(w), "tenant": "acme", "series": w["series"], "window_start": START, "window_end": START + 10, "count": 4, "sum": 2.0}
    assert event == want, f"the event is {event}, expected {want}: a consumer needs both boundaries and the count to fold the window"


def check_outbox_on_failure(ctx):
    m, _ = _setup(ctx)
    w = _window()
    ctx.kafka.fail_next(TOPIC, 1)
    n = m.publish_rollups([w])
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the rollup is lost"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "acme/cpu_seconds{host=a}" and row.get("payload", {}).get("window_id") == window_id(w), f"the outbox row is {row}, expected the topic, the key acme/cpu_seconds{{host=a}} and the event"
    assert n == 0, f"publish_rollups counted {n} published after a failed delivery, expected 0"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    n = m.publish_rollups([_window(start=START + 10)])
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_rollups waited {waited:.0f} s for a broker that does not answer: wait at most ACK_TIMEOUT_S, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("window_start") == START + 10, f"no acknowledgement within the window and the outbox holds {rows}"
    assert n == 0, f"publish_rollups counted {n} published without an acknowledgement, expected 0"


def check_idempotent_producer(ctx):
    m, _ = _setup(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_rollups([_window()])
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} events: the retry wrote the rollup twice. Enable idempotence"
    m.publish_rollups([_window(start=START + 10)])
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost an event the leader alone had acknowledged: acks=all waits for every in-sync replica"
`,
    typescript: `const TOPIC = 'metrics.rolled';
const START = 1793747840;

function setup(ctx) {
  const pkg = ctx.proto('metrics_pipeline.proto');
  const model = ctx.load('/support/metrics/model.ts');
  const onTopic: number[] = [];
  for (const target of model.SHARDS) {
    ctx.grpc.serve(
      pkg.metricsd.MetricsWriter.service,
      {
        WriteWindows(call, callback) {
          onTopic.push(ctx.kafka.records(TOPIC).length);
          callback(null, {accepted: call.request.windows.map(w => w.window_id)});
        },
      },
      target,
    );
  }
  return {m: ctx.load('events'), model, onTopic};
}

const windowOf = (tenant = 'acme', host = 'a', start = START, count = 3) => ({tenant, series: \`cpu_seconds{host=\${host}}\`, start, count, sum: count * 0.5});

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_key_by_series(ctx) {
  const {m} = setup(ctx);
  const windows = [windowOf('acme', 'a'), windowOf('acme', 'b'), windowOf('acme', 'a', START + 10), windowOf('globex', 'a')];
  await m.publishRollups(windows);
  await settle();
  const keys = [...(ctx.kafka.keys(TOPIC) as string[])].sort();
  const want = windows.map(w => \`\${w.tenant}/\${w.series}\`).sort();
  assert.deepStrictEqual(keys, want, \`the events are keyed \${JSON.stringify(keys)}: one series' windows must share a key, and so a partition\`);
  const same = new Set(ctx.kafka.records(TOPIC).filter(r => String(r.key) === 'acme/cpu_seconds{host=a}').map(r => r.partition));
  assert.equal(same.size, 1, \`the two windows of acme/cpu_seconds{host=a} landed on \${same.size} partitions\`);
}

export async function check_publish_after_confirm(ctx) {
  const {m, model, onTopic} = setup(ctx);
  const windows = Array.from({length: 12}, (_, i) => windowOf('acme', \`h\${i}\`));
  const down = model.SHARDS[2];
  ctx.grpc.stop(down);
  await m.publishRollups(windows);
  await settle();
  assert(onTopic.length > 0, 'publishRollups never asked the shard writers (flushWindows)');
  assert.equal(Math.max(...onTopic), 0, \`when the shards were asked the topic already held \${Math.max(...onTopic)} events: an event must follow the shard's acceptance, not precede it\`);
  const published = (ctx.kafka.values(TOPIC) as string[]).map(v => JSON.parse(v).window_id ?? '?').sort();
  const want = windows.filter(w => model.shardFor(w.series) !== down).map(w => model.windowId(w)).sort();
  assert.deepStrictEqual(published, want, \`with \${down} down the topic holds events for \${published.length} windows, expected the \${want.length} the other shards accepted: its windows are pending, not rolled up\`);
  assert.deepStrictEqual(outboxRows(ctx), [], 'pending windows are resent by the next tick, not written to the outbox');
}

export async function check_window_boundaries(ctx) {
  const {m, model} = setup(ctx);
  const w = windowOf('acme', 'a', START, 4);
  await m.publishRollups([w]);
  await settle();
  const values = ctx.kafka.values(TOPIC) as string[];
  assert.equal(values.length, 1, \`one accepted window produced \${values.length} events\`);
  const want = {window_id: model.windowId(w), tenant: 'acme', series: w.series, window_start: START, window_end: START + 10, count: 4, sum: 2};
  assert.deepStrictEqual(JSON.parse(values[0]), want, \`the event is \${values[0]}: a consumer needs both boundaries and the count to fold the window\`);
}

export async function check_outbox_on_failure(ctx) {
  const {m, model} = setup(ctx);
  const w = windowOf();
  ctx.kafka.failNext(TOPIC, 1);
  let n = await m.publishRollups([w]);
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the rollup is lost\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'acme/cpu_seconds{host=a}' && rows[0].payload?.window_id === model.windowId(w), \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key acme/cpu_seconds{host=a} and the event\`);
  assert.equal(n, 0, \`publishRollups counted \${n} published after a failed delivery, expected 0\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  n = await m.publishRollups([windowOf('acme', 'a', START + 10)]);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishRollups waited \${waited.toFixed(0)} s for a broker that does not answer: wait at most ACK_TIMEOUT_MS, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.window_start === START + 10, \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(n, 0, \`publishRollups counted \${n} published without an acknowledgement, expected 0\`);
}

export async function check_idempotent_producer(ctx) {
  const {m} = setup(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishRollups([windowOf()]);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} events: the retry wrote the rollup twice. Enable idempotence\`);
  await m.publishRollups([windowOf('acme', 'a', START + 10)]);
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost an event the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	pb "metrics/gen/metrics_pipeline"
	"metrics/model"

	"leetbuild/harness"
)

const (
	eventsTopic = "metrics.rolled"
	eventsStart = 1793747840
)

var eventsBg = context.Background()

// eventsShard accepts every window; it notes how many events were on the topic when it was asked.
type eventsShard struct {
	pb.UnimplementedMetricsWriterServer
	ctx     *harness.Ctx
	onTopic *[]int
}

func (s *eventsShard) WriteWindows(_ context.Context, req *pb.WriteRequest) (*pb.WriteReply, error) {
	*s.onTopic = append(*s.onTopic, len(s.ctx.Kafka.Records(eventsTopic)))
	accepted := []string{}
	for _, w := range req.GetWindows() {
		accepted = append(accepted, w.GetWindowId())
	}
	return &pb.WriteReply{Accepted: accepted}, nil
}

func eventsSetup(ctx *harness.Ctx) *[]int {
	onTopic := &[]int{}
	for _, target := range model.Shards {
		pb.RegisterMetricsWriterServer(ctx.GRPC.Server(target), &eventsShard{ctx: ctx, onTopic: onTopic})
	}
	return onTopic
}

func eventsWindow(tenant, host string, start, count int64) model.Window {
	return model.Window{Tenant: tenant, Series: fmt.Sprintf("cpu_seconds{host=%s}", host), Start: start, Count: count, Sum: float64(count) * 0.5}
}

func eventsPublish(ctx *harness.Ctx, windows ...model.Window) int {
	n, err := publishRollups(eventsBg, windows)
	ctx.NoError(err, "publishRollups")
	return n
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	rows := []eventsRow{}
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row eventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckKeyBySeries(ctx *harness.Ctx) {
	eventsSetup(ctx)
	windows := []model.Window{eventsWindow("acme", "a", eventsStart, 3), eventsWindow("acme", "b", eventsStart, 3), eventsWindow("acme", "a", eventsStart+10, 3), eventsWindow("globex", "a", eventsStart, 3)}
	eventsPublish(ctx, windows...)
	ctx.Settle()
	keys := ctx.Kafka.Keys(eventsTopic)
	sort.Strings(keys)
	want := []string{}
	for _, w := range windows {
		want = append(want, w.Tenant+"/"+w.Series)
	}
	sort.Strings(want)
	ctx.Equal(keys, want, "one series' windows must share a key, and so a partition; the event keys")
	partitions := map[int]bool{}
	for _, r := range ctx.Kafka.Records(eventsTopic) {
		if string(r.Key) == "acme/cpu_seconds{host=a}" {
			partitions[int(r.Partition)] = true
		}
	}
	ctx.Equal(len(partitions), 1, "the two windows of acme/cpu_seconds{host=a} must land on one partition; the partitions")
}

func CheckPublishAfterConfirm(ctx *harness.Ctx) {
	onTopic := eventsSetup(ctx)
	windows := []model.Window{}
	want := []string{}
	down := model.Shards[2]
	for i := 0; i < 12; i++ {
		w := eventsWindow("acme", fmt.Sprintf("h%d", i), eventsStart, 3)
		windows = append(windows, w)
		if model.ShardFor(w.Series) != down {
			want = append(want, model.WindowID(w))
		}
	}
	ctx.GRPC.Stop(down)
	eventsPublish(ctx, windows...)
	ctx.Settle()
	ctx.Assert(len(*onTopic) > 0, "publishRollups never asked the shard writers (flush.FlushWindows)")
	for _, n := range *onTopic {
		ctx.Assert(n == 0, "when the shards were asked the topic already held %d events: an event must follow the shard's acceptance, not precede it", n)
	}
	published := []string{}
	for _, v := range ctx.Kafka.Values(eventsTopic) {
		var event map[string]any
		json.Unmarshal([]byte(v), &event)
		published = append(published, fmt.Sprint(event["window_id"]))
	}
	sort.Strings(published)
	sort.Strings(want)
	ctx.Equal(published, want, "with %s down only the windows the other shards accepted are rolled up; its windows are pending. The events' window ids", down)
	ctx.Equal(len(eventsOutbox(ctx)), 0, "pending windows are resent by the next tick, not written to the outbox; the outbox rows")
}

func CheckWindowBoundaries(ctx *harness.Ctx) {
	eventsSetup(ctx)
	w := eventsWindow("acme", "a", eventsStart, 4)
	eventsPublish(ctx, w)
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one accepted window must produce one event; the events")
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the event must be JSON")
	want := map[string]any{"window_id": model.WindowID(w), "tenant": "acme", "series": w.Series, "window_start": eventsStart, "window_end": eventsStart + 10, "count": 4, "sum": 2}
	ctx.Equal(event, want, "a consumer needs both boundaries and the count to fold the window; the event")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	eventsSetup(ctx)
	w := eventsWindow("acme", "a", eventsStart, 3)
	ctx.Kafka.FailNext(eventsTopic, 1)
	n := eventsPublish(ctx, w)
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the rollup is lost; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "acme/cpu_seconds{host=a}" && rows[0].Payload["window_id"] == model.WindowID(w), "the outbox row is %+v, expected the topic, the key acme/cpu_seconds{host=a} and the event", rows[0])
	ctx.Equal(n, 0, "publishRollups' count after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	n = eventsPublish(ctx, eventsWindow("acme", "a", eventsStart+10, 3))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishRollups waited %.0f s for a broker that does not answer: wait at most ackTimeout, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["window_id"] == model.WindowID(eventsWindow("acme", "a", eventsStart+10, 3)), "no acknowledgement within the window and the outbox holds %+v", rows)
	ctx.Equal(n, 0, "publishRollups' count without an acknowledgement")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	eventsSetup(ctx)
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsWindow("acme", "a", eventsStart, 3))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the retry must not write the rollup twice (enable.idempotence); the events")
	eventsPublish(ctx, eventsWindow("acme", "a", eventsStart+10, 3))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose an acknowledged event (acks=all); the events")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <set>
#include <string>
#include <vector>

#include "metrics/flush.h"
#include "metrics/model.h"

namespace {

const std::string kEventsTopic = "metrics.rolled";
constexpr long long kEventsStart = 1793747840;

// Accepts every window; notes how many events were on the topic when it was asked.
class EventsShard final : public metricsd::MetricsWriter::Service {
 public:
  harness::Ctx* ctx = nullptr;
  std::vector<size_t>* onTopic = nullptr;
  grpc::Status WriteWindows(grpc::ServerContext*, const metricsd::WriteRequest* req, metricsd::WriteReply* out) override {
    onTopic->push_back(ctx->Kafka.Records(kEventsTopic).size());
    for (const auto& w : req->windows()) out->add_accepted(w.window_id());
    return grpc::Status::OK;
  }
};

std::vector<size_t>& eventsSetup(harness::Ctx& ctx) {
  static std::array<EventsShard, 3>* peers = nullptr;
  static std::vector<size_t>* onTopic = nullptr;
  delete peers;
  delete onTopic;
  peers = new std::array<EventsShard, 3>;
  onTopic = new std::vector<size_t>;
  for (size_t i = 0; i < metrics::kShards.size(); i++) {
    (*peers)[i].ctx = &ctx;
    (*peers)[i].onTopic = onTopic;
    ctx.GRPC.Server(metrics::kShards[i])->RegisterService(&(*peers)[i]);
  }
  return *onTopic;
}

metrics::Window eventsWindow(const std::string& tenant = "acme", const std::string& host = "a", long long start = kEventsStart, long long count = 3) {
  return metrics::Window{tenant, "cpu_seconds{host=" + host + "}", start, count, count * 0.5};
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckKeyBySeries(harness::Ctx& ctx) {
  eventsSetup(ctx);
  const std::vector<metrics::Window> windows = {eventsWindow("acme", "a"), eventsWindow("acme", "b"), eventsWindow("acme", "a", kEventsStart + 10),
                                                eventsWindow("globex", "a")};
  publishRollups(windows);
  ctx.Settle();
  auto keys = ctx.Kafka.Keys(kEventsTopic);
  std::sort(keys.begin(), keys.end());
  std::vector<std::string> want;
  for (const auto& w : windows) want.push_back(w.tenant + "/" + w.series);
  std::sort(want.begin(), want.end());
  ctx.Equal(keys, want, "one series' windows must share a key, and so a partition; the event keys");
  std::set<int> partitions;
  for (const auto& r : ctx.Kafka.Records(kEventsTopic)) {
    if (r.Key && *r.Key == "acme/cpu_seconds{host=a}") partitions.insert(r.Partition);
  }
  ctx.Equal(partitions.size(), 1, "the two windows of acme/cpu_seconds{host=a} must land on one partition; the partitions");
}

void CheckPublishAfterConfirm(harness::Ctx& ctx) {
  auto& onTopic = eventsSetup(ctx);
  const std::string down = metrics::kShards[2];
  std::vector<metrics::Window> windows;
  std::vector<std::string> want;
  for (int i = 0; i < 12; i++) {
    const auto w = eventsWindow("acme", "h" + std::to_string(i));
    windows.push_back(w);
    if (metrics::shardFor(w.series) != down) want.push_back(metrics::windowId(w));
  }
  ctx.GRPC.Stop(down);
  publishRollups(windows);
  ctx.Settle();
  ctx.Assert(!onTopic.empty(), "publishRollups never asked the shard writers (metrics::flushWindows)");
  for (size_t n : onTopic) ctx.Assert(n == 0, "when the shards were asked the topic already held %d events: an event must follow the shard's acceptance, not precede it", n);
  std::vector<std::string> published;
  for (const auto& v : ctx.Kafka.Values(kEventsTopic)) published.push_back(field(nlohmann::json::parse(v, nullptr, false), "window_id"));
  std::sort(published.begin(), published.end());
  std::sort(want.begin(), want.end());
  ctx.Equal(published, want, "with %s down only the windows the other shards accepted are rolled up; its windows are pending. The events' window ids", down);
  ctx.Equal(eventsOutbox(ctx).size(), 0, "pending windows are resent by the next tick, not written to the outbox; the outbox rows");
}

void CheckWindowBoundaries(harness::Ctx& ctx) {
  eventsSetup(ctx);
  const auto w = eventsWindow("acme", "a", kEventsStart, 4);
  publishRollups({w});
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one accepted window must produce one event; the events");
  const auto event = nlohmann::json::parse(values[0], nullptr, false);
  const nlohmann::json want = {{"window_id", metrics::windowId(w)}, {"tenant", "acme"}, {"series", w.series}, {"window_start", kEventsStart},
                               {"window_end", kEventsStart + 10}, {"count", 4}, {"sum", 2.0}};
  ctx.Assert(event == want, "the event is %s, expected %s: a consumer needs both boundaries and the count to fold the window", values[0], want.dump());
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  eventsSetup(ctx);
  const auto w = eventsWindow();
  ctx.Kafka.FailNext(kEventsTopic, 1);
  int n = publishRollups({w});
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the rollup is lost; the rows");
  ctx.Assert(field(rows[0], "topic") == kEventsTopic && field(rows[0], "key") == "acme/cpu_seconds{host=a}" && rows[0].contains("payload") &&
                 field(rows[0]["payload"], "window_id") == metrics::windowId(w),
             "the outbox row is %s, expected the topic, the key acme/cpu_seconds{host=a} and the event", rows[0].dump());
  ctx.Equal(n, 0, "publishRollups' count after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  n = publishRollups({eventsWindow("acme", "a", kEventsStart + 10)});
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishRollups waited %.0f s for a broker that does not answer: wait at most kAckTimeoutMs, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && rows[1]["payload"].value("window_start", 0LL) == kEventsStart + 10,
             "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(n, 0, "publishRollups' count without an acknowledgement");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  eventsSetup(ctx);
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishRollups({eventsWindow()});
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the retry must not write the rollup twice (enable.idempotence); the events");
  publishRollups({eventsWindow("acme", "a", kEventsStart + 10)});
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose an acknowledged event (acks=all); the events");
}
`,
  },
  hints: [
    'A consumer folding one series sees its windows out of order and sometimes folds a window the shard store never got; after a broker restart some rollups are simply missing, and after a retry one appears twice.',
    'The events are produced before the flush, keyed by shard, and counted when `produce` returns; a delivery report that fails later has nowhere to go, and the producer neither retries safely nor waits for every replica.',
    'Flush first and keep the windows whose id is in `accepted`. Produce each with `key=event_key(w)`, the full payload and an `on_delivery` callback, `flush(ACK_TIMEOUT_S)`, insert the outbox row for every event without a clean report; use `acks=all` with `enable.idempotence`.',
  ],
  debrief: `The event is a claim that a shard holds the window, so it can only follow the shard's acceptance; producing first announces state the store may never get. The key decides what a consumer can rely on, and \`{tenant}/{series}\` is the unit it folds. Waiting for the delivery report is what gives the published count a meaning, and the outbox makes a broker outage a delay rather than a loss; idempotence closes the duplicate a retry after a lost acknowledgement would write. A delivery that lands after the timeout can still reach the topic as well as the outbox, which is why consumers deduplicate by \`window_id\`. Production systems write the outbox row in the same transaction as the state change and run the relay as its own process.`,
};
