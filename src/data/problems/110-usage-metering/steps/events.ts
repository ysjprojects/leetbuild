import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Rollup events keyed by account, after the count',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'redis', 'kafka', 'analytics'],
  task: `## Task

**Starting point.** The starter is the reporting path the rollup consumers read:
\`report_usage(account, request_id, route, units, gateway)\` produces
\`{account, gateway, units}\` on \`usage.rollup\` keyed by the gateway with \`acks=1\`, then counts
the report with \`apply_usage\` (\`metering.usage\`, provided) and returns its answer. It publishes the
demo event and hides three flaws.

**Failure mode the checks target.** One account's events are spread over partitions by gateway, so a
consumer sees its hour out of order. The event goes out before the count, so a gateway's retry, which
\`apply_usage\` refuses to count, still adds a second event and the rollup no longer ties out with the
window. And a leader failover loses events the leader alone acknowledged.

- Key every event by **account**.
- Call \`apply_usage\` first; produce only when it answers \`counted\`, with
  \`{account, window, units, total, over}\` from that answer.
- Produce with \`acks=all\` (kafkajs \`acks: -1\`, kafka-go \`RequireAll\`), keeping the delivery
  callback that logs a failed delivery.`,
  sequence: {
    participants: ['usaged', 'Redis', 'usage.rollup', 'Rollup consumers'],
    messages: [
      {from: 'usaged', to: 'Redis', label: 'apply_usage(account, request_id, …)', kind: 'sync'},
      {from: 'Redis', to: 'usaged', label: '{counted, total, cap, over, window}', kind: 'reply'},
      {from: 'usaged', to: 'usage.rollup', label: 'counted → produce key=account · acks=all', kind: 'async'},
      {from: 'usage.rollup', to: 'Rollup consumers', label: "one account's hour, in order", kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'topic',
      title: 'Publishes a rollup event on usage.rollup',
      detail: 'A counted report produces one JSON event on `usage.rollup` naming the account and the units.',
      match: {
        python: {all: [/usage\.rollup/, /producer\.produce\(/]},
        typescript: {all: [/usage\.rollup/, /producer\.send\(/]},
        go: {all: [/usage\.rollup/, /WriteMessages\(/]},
        scala: {all: [/usage\.rollup/, /producer\.send\(/]},
        cpp: {all: [/usage\.rollup/, /producer->produce\(/]},
      },
    },
    {
      id: 'account-key',
      title: 'Keys events by account',
      detail:
        "Every event is keyed by the account, so one account's events share a partition and arrive in order whatever gateway reported them. The starter keys by the gateway.",
      match: {
        python: {all: [/key\s*=\s*account\b/], none: [/key\s*=\s*gateway\b/]},
        typescript: {all: [/key:\s*account\b/], none: [/key:\s*gateway\b/]},
        go: {all: [/Key:\s*\[\]byte\(account\)/], none: [/Key:\s*\[\]byte\(gateway\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(RollupTopic,\s*account\b/],
          none: [/RollupTopic,\s*gateway\b/],
        },
        cpp: {all: [/account\.c_str\(\),\s*account\.size\(\)/], none: [/gateway\.c_str\(\),\s*gateway\.size\(\)/]},
      },
    },
    {
      id: 'after-commit',
      title: 'Publishes only what the count committed',
      detail:
        '`apply_usage`/`applyUsage` runs before the produce, and only a report it answers `counted` produces an event, carrying the window, the total and `over`. The starter produces first, for retries too.',
      match: {
        python: {order: [/apply_usage\(/, /producer\.produce\(/], all: [/\[["']counted["']\]/]},
        typescript: {order: [/applyUsage\(/, /producer\.send\(/], all: [/\.counted\b/]},
        go: {order: [/usage\.ApplyUsage\(/, /WriteMessages\(/], all: [/\.Counted\b/]},
        scala: {order: [/Usage\.applyUsage\(/, /producer\.send\(/], all: [/\.counted\b/]},
        cpp: {order: [/usage::applyUsage\(/, /producer->produce\(/], all: [/\.counted\b/]},
      },
    },
    {
      id: 'acks-all',
      title: 'Waits for every in-sync replica',
      detail:
        'The producer uses `acks=all` (kafkajs `acks: -1`, kafka-go `RequireAll`), so a leader failover cannot lose an event the leader alone acknowledged. The starter uses `acks=1`.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"acks",\s*"all"/]},
        cpp: {all: [/"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from metering.usage import apply_usage

ROLLUP_TOPIC = "usage.rollup"
log = logging.getLogger("usaged")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("rollup event not delivered: %s", err)


def report_usage(account: str, request_id: str, route: str, units: int, gateway: str) -> dict:
    """Count one report and publish its rollup event; returns apply_usage's answer."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    event = {"account": account, "gateway": gateway, "units": units}
    producer.produce(ROLLUP_TOPIC, key=gateway, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    return apply_usage(account, request_id, route, units, gateway)
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from metering.usage import apply_usage

ROLLUP_TOPIC = "usage.rollup"
log = logging.getLogger("usaged")

# acks=all: an event is acknowledged once every in-sync replica holds it.
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("rollup event not delivered: %s", err)


def report_usage(account: str, request_id: str, route: str, units: int, gateway: str) -> dict:
    """Count one report and publish its rollup event; returns apply_usage's answer."""
    # The count commits first: an event may lag the window, it may never describe uncounted usage.
    applied = apply_usage(account, request_id, route, units, gateway)
    if not applied["counted"]:
        return applied  # a retry: its first delivery already published the event
    event = {"account": account, "window": applied["window"], "units": units, "total": applied["total"], "over": applied["over"]}
    producer.produce(ROLLUP_TOPIC, key=account, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    return applied
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import type {Applied} from 'metering/ledger';
import {applyUsage} from 'metering/usage';

export const ROLLUP_TOPIC = 'usage.rollup';

const kafka = new Kafka({clientId: 'usaged', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Count one report and publish its rollup event; returns applyUsage's answer. */
export async function reportUsage(account: string, requestId: string, route: string, units: number, gateway: string): Promise<Applied> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const event = {account, gateway, units};
  try {
    await producer.send({topic: ROLLUP_TOPIC, messages: [{key: gateway, value: JSON.stringify(event)}], acks: 1});
  } catch (e) {
    console.warn(\`rollup event not delivered: \${(e as Error).message}\`);
  }
  return applyUsage(account, requestId, route, units, gateway);
}
`,
      solution: `import {Kafka} from 'kafkajs';

import type {Applied} from 'metering/ledger';
import {applyUsage} from 'metering/usage';

export const ROLLUP_TOPIC = 'usage.rollup';

const kafka = new Kafka({clientId: 'usaged', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Count one report and publish its rollup event; returns applyUsage's answer. */
export async function reportUsage(account: string, requestId: string, route: string, units: number, gateway: string): Promise<Applied> {
  // The count commits first: an event may lag the window, it may never describe uncounted usage.
  const applied = await applyUsage(account, requestId, route, units, gateway);
  if (!applied.counted) return applied; // a retry: its first delivery already published the event
  const event = {account, window: applied.window, units, total: applied.total, over: applied.over};
  try {
    // acks -1 (all): an event is acknowledged once every in-sync replica holds it.
    await producer.send({topic: ROLLUP_TOPIC, messages: [{key: account, value: JSON.stringify(event)}], acks: -1});
  } catch (e) {
    console.warn(\`rollup event not delivered: \${(e as Error).message}\`);
  }
  return applied;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"

	"metering/ledger" // ledger.Applied
	"metering/usage"  // usage.ApplyUsage(ctx, account, requestID, route, units, gateway) (ledger.Applied, error)
)

const rollupTopic = "usage.rollup"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        rollupTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// reportUsage counts one report and publishes its rollup event; it returns ApplyUsage's answer.
func reportUsage(ctx context.Context, account, requestID, route string, units int64, gateway string) (ledger.Applied, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(map[string]any{"account": account, "gateway": gateway, "units": units})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(gateway), Value: value}); err != nil {
		log.Printf("rollup event not delivered: %v", err)
	}
	return usage.ApplyUsage(ctx, account, requestID, route, units, gateway)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"

	"metering/ledger" // ledger.Applied
	"metering/usage"  // usage.ApplyUsage(ctx, account, requestID, route, units, gateway) (ledger.Applied, error)
)

const rollupTopic = "usage.rollup"

// RequireAll: the write returns once every in-sync replica holds the event.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        rollupTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// reportUsage counts one report and publishes its rollup event; it returns ApplyUsage's answer.
func reportUsage(ctx context.Context, account, requestID, route string, units int64, gateway string) (ledger.Applied, error) {
	// The count commits first: an event may lag the window, it may never describe uncounted usage.
	applied, err := usage.ApplyUsage(ctx, account, requestID, route, units, gateway)
	if err != nil || !applied.Counted {
		return applied, err // a retry: its first delivery already published the event
	}
	value, _ := json.Marshal(map[string]any{"account": account, "window": applied.Window, "units": units, "total": applied.Total, "over": applied.Over})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(account), Value: value}); err != nil {
		log.Printf("rollup event not delivered: %v", err)
	}
	return applied, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import metering.{Ledger, Usage} // Usage.applyUsage(account, requestId, route, units, gateway): Ledger.Applied

object Events {
  val RollupTopic = "usage.rollup"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"rollup event not delivered: \${exception.getMessage}")
  }

  /** Count one report and publish its rollup event; returns applyUsage's answer. */
  def reportUsage(account: String, requestId: String, route: String, units: Long, gateway: String): Ledger.Applied = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val event = JsObject("account" -> JsString(account), "gateway" -> JsString(gateway), "units" -> JsNumber(units))
    producer.send(new ProducerRecord[String, String](RollupTopic, gateway, event.compactPrint), onDelivery).get()
    Usage.applyUsage(account, requestId, route, units, gateway)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import metering.{Ledger, Usage} // Usage.applyUsage(account, requestId, route, units, gateway): Ledger.Applied

object Events {
  val RollupTopic = "usage.rollup"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // acks=all: an event is acknowledged once every in-sync replica holds it.
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"rollup event not delivered: \${exception.getMessage}")
  }

  /** Count one report and publish its rollup event; returns applyUsage's answer. */
  def reportUsage(account: String, requestId: String, route: String, units: Long, gateway: String): Ledger.Applied = {
    // The count commits first: an event may lag the window, it may never describe uncounted usage.
    val applied = Usage.applyUsage(account, requestId, route, units, gateway)
    if (applied.counted) {
      val event = JsObject("account" -> JsString(account), "window" -> JsNumber(applied.window), "units" -> JsNumber(units),
        "total" -> JsNumber(applied.total), "over" -> JsBoolean(applied.over))
      producer.send(new ProducerRecord[String, String](RollupTopic, account, event.compactPrint), onDelivery).get()
    }
    applied
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

#include "metering/ledger.h"  // ledger::Applied
#include "metering/usage.h"   // usage::applyUsage(account, request_id, route, units, gateway) -> ledger::Applied

using json = nlohmann::json;

const std::string kRollupTopic = "usage.rollup";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "rollup event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Count one report and publish its rollup event; returns applyUsage's answer.
ledger::Applied reportUsage(const std::string& account, const std::string& request_id, const std::string& route, long long units,
                            const std::string& gateway) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string value = json{{"account", account}, {"gateway", gateway}, {"units", units}}.dump();
  producer->produce(kRollupTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    gateway.c_str(), gateway.size(), 0, nullptr);
  producer->flush(2000);
  return usage::applyUsage(account, request_id, route, units, gateway);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "metering/ledger.h"  // ledger::Applied
#include "metering/usage.h"   // usage::applyUsage(account, request_id, route, units, gateway) -> ledger::Applied

using json = nlohmann::json;

const std::string kRollupTopic = "usage.rollup";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "rollup event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // acks=all: an event is acknowledged once every in-sync replica holds it.
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Count one report and publish its rollup event; returns applyUsage's answer.
ledger::Applied reportUsage(const std::string& account, const std::string& request_id, const std::string& route, long long units,
                            const std::string& gateway) {
  // The count commits first: an event may lag the window, it may never describe uncounted usage.
  const ledger::Applied applied = usage::applyUsage(account, request_id, route, units, gateway);
  if (!applied.counted) return applied;  // a retry: its first delivery already published the event
  const std::string value =
      json{{"account", account}, {"window", applied.window}, {"units", units}, {"total", applied.total}, {"over", applied.over}}.dump();
  producer->produce(kRollupTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    account.c_str(), account.size(), 0, nullptr);
  producer->flush(2000);
  return applied;
}
`,
    },
  },
  harness: {
    python: `import json

from metering import ledger

TOPIC = "usage.rollup"


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def check_topic(ctx):
    m = ctx.load("events")
    m.report_usage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one counted report left {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    event = _payload(records[0])
    assert event.get("account") == "acct_1" and event.get("units") == 1200, f"the event must name the account and its 1200 units, got {event}"


def check_account_key(ctx):
    m = ctx.load("events")
    m.report_usage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1")
    m.report_usage("acct_1", "req_2", "/v1/generate", 300, "gw-us-2")
    records = ctx.kafka.records(TOPIC)
    keys = [r.key for r in records]
    assert keys == [b"acct_1", b"acct_1"], f"two reports of acct_1 through two gateways were keyed {keys}: keyed by anything but the account, one account's hour scatters across partitions"
    partitions = {r.partition for r in records}
    assert len(partitions) == 1, f"acct_1's events landed on partitions {sorted(partitions)}: one account's events must stay on one partition, in order"


def check_after_commit(ctx):
    m = ctx.load("events")
    w = ledger.current_window()
    # The moment the count commits, what is already on the topic.
    at_commit = ctx.redis_after(ledger.window_key("acct_1", w), lambda: len(ctx.kafka.records(TOPIC)))
    m.report_usage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1")
    assert at_commit.fired, "report_usage never counted the report in the window"
    assert at_commit.result == 0, f"when the count ran the topic already held {at_commit.result} event(s): an event went out for usage the window had not counted. Count, then produce"
    m.report_usage("acct_1", "req_1", "/v1/generate", 1200, "gw-us-2")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one request id reported twice left {len(records)} events: a retry apply_usage did not count must publish nothing, or the rollup reads double"
    event = _payload(records[0])
    assert event.get("window") == w and event.get("total") == 1200 and event.get("over") is False, f"the event must carry the window {w}, the window total 1200 and over false from the count, got {event}"


def check_acks_all(ctx):
    m = ctx.load("events")
    m.report_usage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1")
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 1, "a leader failover lost the rollup event: with acks=1 the leader alone acknowledged it. Use acks=all"
`,
    typescript: `const TOPIC = 'usage.rollup';

function events(ctx) {
  return {m: ctx.load('events'), ledger: ctx.load('/support/metering/ledger.ts')};
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

export async function check_topic(ctx) {
  const {m} = events(ctx);
  await m.reportUsage('acct_1', 'req_1', '/v1/generate', 1200, 'gw-eu-1');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one counted report left \${records.length} records on \${TOPIC}\`);
  const event = payload(records[0]);
  assert(event.account === 'acct_1' && event.units === 1200, \`the event must name the account and its 1200 units, got \${JSON.stringify(event)}\`);
}

export async function check_account_key(ctx) {
  const {m} = events(ctx);
  await m.reportUsage('acct_1', 'req_1', '/v1/generate', 1200, 'gw-eu-1');
  await m.reportUsage('acct_1', 'req_2', '/v1/generate', 300, 'gw-us-2');
  const records = ctx.kafka.records(TOPIC);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['acct_1', 'acct_1'], \`two reports of acct_1 through two gateways were keyed \${JSON.stringify(keys)}: keyed by anything but the account, one account's hour scatters across partitions\`);
  const partitions = [...new Set(records.map(r => r.partition))];
  assert.equal(partitions.length, 1, \`acct_1's events landed on partitions \${JSON.stringify(partitions)}: one account's events must stay on one partition, in order\`);
}

export async function check_after_commit(ctx) {
  const {m, ledger} = events(ctx);
  const w = ledger.currentWindow();
  // The moment the count commits, what is already on the topic.
  const atCommit = ctx.redisAfter(ledger.windowKey('acct_1', w), () => ctx.kafka.records(TOPIC).length);
  await m.reportUsage('acct_1', 'req_1', '/v1/generate', 1200, 'gw-eu-1');
  assert(atCommit.fired, 'reportUsage never counted the report in the window');
  assert.equal(atCommit.result, 0, \`when the count ran the topic already held \${atCommit.result} event(s): an event went out for usage the window had not counted. Count, then produce\`);
  await m.reportUsage('acct_1', 'req_1', '/v1/generate', 1200, 'gw-us-2');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one request id reported twice left \${records.length} events: a retry applyUsage did not count must publish nothing, or the rollup reads double\`);
  const event = payload(records[0]);
  assert(event.window === w && event.total === 1200 && event.over === false, \`the event must carry the window \${w}, the window total 1200 and over false from the count, got \${JSON.stringify(event)}\`);
}

export async function check_acks_all(ctx) {
  const {m} = events(ctx);
  await m.reportUsage('acct_1', 'req_1', '/v1/generate', 1200, 'gw-eu-1');
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'a leader failover lost the rollup event: with acks 1 the leader alone acknowledged it. Use acks -1 (all)');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"metering/ledger"

	"leetbuild/harness"
)

const topic = "usage.rollup"

var eventsBg = context.Background()

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func mustReport(ctx *harness.Ctx, requestID string, units int64, gateway string) ledger.Applied {
	applied, err := reportUsage(eventsBg, "acct_1", requestID, "/v1/generate", units, gateway)
	ctx.NoError(err, "reportUsage(acct_1, %s) failed", requestID)
	return applied
}

func CheckTopic(ctx *harness.Ctx) {
	mustReport(ctx, "req_1", 1200, "gw-eu-1")
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 1, "one counted report; the records on %s", topic)
	event := payloadOf(ctx, records[0].Value)
	ctx.Assert(event["account"] == "acct_1" && event["units"] == float64(1200), "the event must name the account and its 1200 units, got %v", event)
}

func CheckAccountKey(ctx *harness.Ctx) {
	mustReport(ctx, "req_1", 1200, "gw-eu-1")
	mustReport(ctx, "req_2", 300, "gw-us-2")
	records := ctx.Kafka.Records(topic)
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"acct_1", "acct_1"}, "two reports of acct_1 through two gateways must be keyed by the account (keyed by anything else, one account's hour scatters across partitions); the keys")
	ctx.Assert(len(records) == 2 && records[0].Partition == records[1].Partition, "acct_1's events must stay on one partition, in order; they landed on %v", records)
}

func CheckAfterCommit(ctx *harness.Ctx) {
	w := ledger.CurrentWindow()
	// The moment the count commits, what is already on the topic.
	atCommit := ctx.Redis.After(ledger.WindowKey("acct_1", w), func() any { return len(ctx.Kafka.Records(topic)) })
	mustReport(ctx, "req_1", 1200, "gw-eu-1")
	ctx.Assert(atCommit.Fired, "reportUsage never counted the report in the window")
	ctx.Equal(atCommit.Result, 0, "when the count ran the topic already held events: an event went out for usage the window had not counted. Count, then produce; events at the count")
	mustReport(ctx, "req_1", 1200, "gw-us-2")
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 1, "one request id reported twice: a retry ApplyUsage did not count must publish nothing, or the rollup reads double; the events")
	event := payloadOf(ctx, records[0].Value)
	ctx.Assert(event["window"] == float64(w) && event["total"] == float64(1200) && event["over"] == false, "the event must carry the window %d, the window total 1200 and over false from the count, got %v", w, event)
}

func CheckAcksAll(ctx *harness.Ctx) {
	mustReport(ctx, "req_1", 1200, "gw-eu-1")
	lost := ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "a leader failover lost %d rollup event(s): with RequireOne the leader alone acknowledged it. Use RequireAll; the events", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "metering/ledger.h"

using json = nlohmann::json;

namespace {

const std::string kTopic = "usage.rollup";

json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  try {
    return json::parse(record.Value.value_or(""));
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", record.Value.value_or(""), e.what());
  }
}

}  // namespace

void CheckTopic(harness::Ctx& ctx) {
  reportUsage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 1, "one counted report; the records on %s", kTopic);
  const json event = payloadOf(ctx, records[0]);
  ctx.Assert(event.value("account", "") == "acct_1" && event.value("units", 0LL) == 1200, "the event must name the account and its 1200 units, got %s", event.dump());
}

void CheckAccountKey(harness::Ctx& ctx) {
  reportUsage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1");
  reportUsage("acct_1", "req_2", "/v1/generate", 300, "gw-us-2");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"acct_1", "acct_1"}, "two reports of acct_1 through two gateways must be keyed by the account (keyed by anything else, one account's hour scatters across partitions); the keys");
  ctx.Assert(records.size() == 2 && records[0].Partition == records[1].Partition, "acct_1's events must stay on one partition, in order");
}

void CheckAfterCommit(harness::Ctx& ctx) {
  const long long w = ledger::currentWindow();
  // The moment the count commits, what is already on the topic.
  int atCommit = -1;
  ctx.Redis.After(ledger::windowKey("acct_1", w), [&] { atCommit = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  reportUsage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1");
  ctx.Assert(atCommit >= 0, "reportUsage never counted the report in the window");
  ctx.Equal(atCommit, 0, "when the count ran the topic already held events: an event went out for usage the window had not counted. Count, then produce; events at the count");
  reportUsage("acct_1", "req_1", "/v1/generate", 1200, "gw-us-2");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 1, "one request id reported twice: a retry applyUsage did not count must publish nothing, or the rollup reads double; the events");
  const json event = payloadOf(ctx, records[0]);
  ctx.Assert(event.value("window", 0LL) == w && event.value("total", 0LL) == 1200 && event.contains("over") && event["over"] == false,
             "the event must carry the window %d, the window total 1200 and over false from the count, got %s", w, event.dump());
}

void CheckAcksAll(harness::Ctx& ctx) {
  reportUsage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1");
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "a leader failover lost %d rollup event(s): with acks=1 the leader alone acknowledged it. Use acks=all; the events", lost);
}
`,
  },
  hints: [
    'Report one request twice, as a retrying gateway does: the window counts it once but the topic holds two events. Report one account through two gateways: its events sit on two partitions.',
    'The event is produced before `apply_usage` runs, so nothing knows whether the report was counted, and its key is the gateway. With `acks=1` the leader alone acknowledges it.',
    'Call `apply_usage` first and return early unless `counted`; produce `{account, window, units, total, over}` from its answer with `key=account`, and set `acks` to `all`.',
  ],
  debrief: `An event is a statement about state that already exists, so the count commits first and only a counted report produces one: the dedupe in the script then protects the topic as well as the window. The key is the account because order only matters per account, and a rollup consumer summing an hour needs that account's events on one partition. acks=all makes the acknowledgement mean every in-sync replica has the event, which is what survives a leader failover. A crash between the count and the produce still loses an event here; production meters close that gap with a transactional outbox written in the same commit as the count, and consumers dedupe on the request id.`,
};
