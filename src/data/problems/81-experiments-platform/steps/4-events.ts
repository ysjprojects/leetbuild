import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Exposure events: once per unit, keyed by experiment',
  concept: 'kafka',
  guides: ['consuming-events', 'producing-events'],
  file: 'events',
  focus: ['api', 'redis', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter's \`record_exposure(experiment_id, unit_id, variant)\` produces
\`{experiment_id, unit_id, variant, ts}\` to \`experiment.exposure\` keyed by the unit, skipping units
its process has already seen, and \`consume_exposures()\` (group \`exposure-stats\`, auto-commit off)
commits each record, then counts it with \`store.add_exposure\`. It serves the demo and hides four
flaws.

**Failure mode the checks target.** The stream the report is built from drifts: one experiment's
exposures spread over every partition, a second replica publishes the same unit again, an exposure
the broker refused is not retried because the process remembers it as sent, and a consumer crash
between commit and count loses it.

- Key every record by the **experiment id**.
- Claim \`exp:{experiment_id}:seen:{unit_id}\` with \`SET NX\` and \`EXPOSURE_TTL_S\` (7 days) before
  producing; a held claim returns \`False\` without producing.
- Read the delivery result where it arrives (the delivery callback, a rejected \`send\`,
  \`WriteMessages\`' error) and delete the claim when the delivery failed.
- Count, then commit; a count that fails is not committed.`,
  sequence: {
    participants: ['Experiment API', 'Redis', 'experiment.exposure', 'Analysis consumer'],
    messages: [
      {from: 'Experiment API', to: 'Redis', label: 'SET exp:{id}:seen:{unit} variant NX EX 604800', kind: 'sync'},
      {from: 'Redis', to: 'Experiment API', label: 'nil → already recorded, return False', kind: 'reply'},
      {from: 'Experiment API', to: 'experiment.exposure', label: 'produce key = experiment id', kind: 'async'},
      {
        from: 'experiment.exposure',
        to: 'Experiment API',
        label: 'delivery report: error → DEL the claim',
        kind: 'reply',
      },
      {from: 'experiment.exposure', to: 'Analysis consumer', label: 'consume · group exposure-stats', kind: 'async'},
      {from: 'Analysis consumer', to: 'Redis', label: 'HINCRBY exp:{id}:exposures {variant} 1', kind: 'sync'},
      {from: 'Analysis consumer', to: 'experiment.exposure', label: 'commit the offset after the count', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'experiment-key',
      title: 'Exposures are keyed by experiment id',
      detail:
        "The record key is the experiment id, so one experiment's exposures land on one partition in order; the starter keys by the unit.",
      match: {
        python: {all: [/produce\([\s\S]{0,120}?key\s*=\s*experiment_id/], none: [/key\s*=\s*unit_id/]},
        typescript: {all: [/key:\s*experimentId\b/], none: [/key:\s*unitId\b/]},
        go: {all: [/Key:\s*\[\]byte\(experimentID\)/], none: [/Key:\s*\[\]byte\(unitID\)/]},
        cpp: {
          all: [/experiment_id\.c_str\(\),\s*experiment_id\.size\(\)/],
          none: [/unit_id\.c_str\(\),\s*unit_id\.size\(\)/],
        },
      },
    },
    {
      id: 'shared-dedupe',
      title: 'One exposure per unit across replicas',
      detail:
        'The dedupe is a Redis claim, `exp:{experiment_id}:seen:{unit_id}` taken by one `SET NX` that carries the 7-day TTL, so every replica sees it and only the replica that took it publishes; the starter keeps a set in its own process.',
      match: {
        python: {all: [/nx\s*=\s*True/, /:seen:/], none: [/\b_seen\b/]},
        typescript: {all: [/['"]NX['"]/, /:seen:/], none: [/new Set</]},
        go: {all: [/\.SetNX\(/, /":seen:"/], none: [/seen\s*=\s*map\[/]},
        cpp: {all: [/UpdateType::NOT_EXIST/, /":seen:"/], none: [/std::set<std::string>\s+seen/]},
      },
    },
    {
      id: 'delivery-release',
      title: 'A refused delivery releases the claim',
      detail:
        'The delivery result is read where it arrives (`on_delivery`, the rejected `send`, the error `WriteMessages` returns, `dr_cb`) and a failure deletes the claim, so the next render publishes the exposure again.',
      match: {
        python: {all: [/on_delivery\s*=/, /\.delete\(/], none: [/except KafkaException/]},
        typescript: {all: [/redis\.del\(/]},
        go: {all: [/rdb\.Del\(/]},
        cpp: {all: [/dr_cb/, /redis\.del\(/]},
      },
    },
    {
      id: 'count-before-commit',
      title: 'The consumer counts, then commits',
      detail:
        'The consumer adds the exposure to `exp:{id}:exposures` and only then commits its offset; a crash in between redelivers instead of losing the unit, and a count that fails is never committed past.',
      match: {
        python: {order: [/store\.add_exposure\(/, /consumer\.commit\(/]},
        typescript: {order: [/addExposure\(/, /commitOffsets\(/]},
        go: {order: [/store\.AddExposure\(/, /\.CommitMessages\(/]},
        cpp: {order: [/store::addExposure\(/, /->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

import redis
from confluent_kafka import Consumer, KafkaException, Producer

from expd import store  # add_exposure

TOPIC = "experiment.exposure"
EXPOSURE_TTL_S = 7 * 24 * 3600
log = logging.getLogger("exposures")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)

_seen: set[tuple[str, str]] = set()


def record_exposure(experiment_id: str, unit_id: str, variant: str) -> bool:
    """Publish the unit's first exposure to the experiment; False when it was already recorded."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if (experiment_id, unit_id) in _seen:
        return False
    _seen.add((experiment_id, unit_id))
    event = {"experiment_id": experiment_id, "unit_id": unit_id, "variant": variant, "ts": int(time.time())}
    try:
        producer.produce(TOPIC, key=unit_id, value=json.dumps(event))
        producer.poll(0)
    except KafkaException as exc:
        log.warning("exposure of %s to %s not produced: %s", unit_id, experiment_id, exc)
    return True


def consume_exposures() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "exposure-stats", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(msg, asynchronous=False)
        event = json.loads(msg.value())
        store.add_exposure(event["experiment_id"], event["variant"])
`,
      solution: `import json
import logging
import time

import redis
from confluent_kafka import Consumer, Producer

from expd import store  # add_exposure

TOPIC = "experiment.exposure"
EXPOSURE_TTL_S = 7 * 24 * 3600
log = logging.getLogger("exposures")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def record_exposure(experiment_id: str, unit_id: str, variant: str) -> bool:
    """Publish the unit's first exposure to the experiment; False when it was already recorded."""
    claim = f"exp:{experiment_id}:seen:{unit_id}"
    # One event per (experiment, unit) across every replica: the claim lives in Redis, not in the process.
    if not r.set(claim, variant, nx=True, ex=EXPOSURE_TTL_S):
        return False
    event = {"experiment_id": experiment_id, "unit_id": unit_id, "variant": variant, "ts": int(time.time())}

    def on_delivery(err, msg) -> None:
        if err is not None:
            log.warning("exposure to %s not delivered: %s", experiment_id, err)
            r.delete(claim)  # not on the topic: the next render publishes it again

    producer.produce(TOPIC, key=experiment_id, value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery reports; returns at once
    return True


def consume_exposures() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "exposure-stats", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        store.add_exposure(event["experiment_id"], event["variant"])
        consumer.commit(msg, asynchronous=False)  # after the count: a crash before this point redelivers
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {addExposure} from 'expd/store';

export const TOPIC = 'experiment.exposure';
export const EXPOSURE_TTL_S = 7 * 24 * 3600;

const kafka = new Kafka({clientId: 'expd', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

const seen = new Set<string>();

/** Publish the unit's first exposure to the experiment; false when it was already recorded. */
export async function recordExposure(experimentId: string, unitId: string, variant: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (seen.has(\`\${experimentId}/\${unitId}\`)) return false;
  seen.add(\`\${experimentId}/\${unitId}\`);
  const event = {experiment_id: experimentId, unit_id: unitId, variant, ts: Math.floor(Date.now() / 1000)};
  try {
    await producer.send({topic: TOPIC, messages: [{key: unitId, value: JSON.stringify(event)}]});
  } catch (err) {
    console.warn(\`exposure to \${experimentId} not produced: \${(err as Error).message}\`);
  }
  return true;
}

export async function consumeExposures(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'exposure-stats'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {experiment_id: string; variant: string};
      await addExposure(event.experiment_id, event.variant);
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {addExposure} from 'expd/store';

export const TOPIC = 'experiment.exposure';
export const EXPOSURE_TTL_S = 7 * 24 * 3600;

const kafka = new Kafka({clientId: 'expd', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

/** Publish the unit's first exposure to the experiment; false when it was already recorded. */
export async function recordExposure(experimentId: string, unitId: string, variant: string): Promise<boolean> {
  const claim = \`exp:\${experimentId}:seen:\${unitId}\`;
  // One event per (experiment, unit) across every replica: the claim lives in Redis, not in the process.
  if ((await redis.set(claim, variant, 'EX', EXPOSURE_TTL_S, 'NX')) !== 'OK') return false;
  const event = {experiment_id: experimentId, unit_id: unitId, variant, ts: Math.floor(Date.now() / 1000)};
  // The rejected send is the delivery report: the exposure is not on the topic, so the claim goes too.
  await producer.send({topic: TOPIC, messages: [{key: experimentId, value: JSON.stringify(event)}]}).catch(async (err: Error) => {
    console.warn(\`exposure to \${experimentId} not delivered: \${err.message}\`);
    await redis.del(claim);
  });
  return true;
}

export async function consumeExposures(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'exposure-stats'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {experiment_id: string; variant: string};
      await addExposure(event.experiment_id, event.variant);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]); // after the count
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
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"expd/store" // store.AddExposure
)

const topic = "experiment.exposure"

const exposureTTL = 7 * 24 * time.Hour

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var seen = map[string]bool{}

type exposure struct {
	ExperimentID string \`json:"experiment_id"\`
	UnitID       string \`json:"unit_id"\`
	Variant      string \`json:"variant"\`
	TS           int64  \`json:"ts"\`
}

// recordExposure publishes the unit's first exposure to the experiment; false when it was already recorded.
func recordExposure(ctx context.Context, experimentID, unitID, variant string) bool {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if seen[experimentID+"/"+unitID] {
		return false
	}
	seen[experimentID+"/"+unitID] = true
	value, _ := json.Marshal(exposure{ExperimentID: experimentID, UnitID: unitID, Variant: variant, TS: time.Now().Unix()})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(unitID), Value: value}); err != nil {
		log.Printf("exposure to %s not produced: %v", experimentID, err)
	}
	return true
}

func consumeExposures(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "exposure-stats", Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event exposure
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed exposure at offset %d", msg.Offset)
			continue
		}
		store.AddExposure(ctx, event.ExperimentID, event.Variant)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"expd/store" // store.AddExposure
)

const topic = "experiment.exposure"

const exposureTTL = 7 * 24 * time.Hour

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type exposure struct {
	ExperimentID string \`json:"experiment_id"\`
	UnitID       string \`json:"unit_id"\`
	Variant      string \`json:"variant"\`
	TS           int64  \`json:"ts"\`
}

// recordExposure publishes the unit's first exposure to the experiment; false when it was already recorded.
func recordExposure(ctx context.Context, experimentID, unitID, variant string) bool {
	claim := "exp:" + experimentID + ":seen:" + unitID
	// One event per (experiment, unit) across every replica: the claim lives in Redis, not in the process.
	won, err := rdb.SetNX(ctx, claim, variant, exposureTTL).Result()
	if err != nil || !won {
		return false
	}
	value, _ := json.Marshal(exposure{ExperimentID: experimentID, UnitID: unitID, Variant: variant, TS: time.Now().Unix()})
	// A synchronous writer returns the broker's answer: an error means the exposure is not on the topic.
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(experimentID), Value: value}); err != nil {
		log.Printf("exposure to %s not delivered: %v", experimentID, err)
		rdb.Del(ctx, claim) // the next render publishes it again
	}
	return true
}

func consumeExposures(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "exposure-stats", Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event exposure
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed exposure at offset %d", msg.Offset)
			continue
		}
		if _, err := store.AddExposure(ctx, event.ExperimentID, event.Variant); err != nil {
			return err // not committed: the record is redelivered
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <set>
#include <string>

#include "expd/store.h"  // store::addExposure

using json = nlohmann::json;

const std::string kTopic = "experiment.exposure";
constexpr std::chrono::seconds kExposureTtl{7 * 24 * 3600};

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

std::set<std::string> seen;

// Publish the unit's first exposure to the experiment; false when it was already recorded.
bool record_exposure(const std::string& experiment_id, const std::string& unit_id, const std::string& variant) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (!seen.insert(experiment_id + "/" + unit_id).second) return false;
  const long long ts = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string value = json{{"experiment_id", experiment_id}, {"unit_id", unit_id}, {"variant", variant}, {"ts", ts}}.dump();
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                                   value.size(), unit_id.c_str(), unit_id.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) std::cerr << "exposure to " << experiment_id << " not produced: " << RdKafka::err2str(err) << "\\n";
  producer->poll(0);
  return true;
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "exposure-stats", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

void consume_exposures() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) continue;
    store::addExposure(event.value("experiment_id", ""), event.value("variant", ""));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

#include "expd/store.h"  // store::addExposure

using json = nlohmann::json;

const std::string kTopic = "experiment.exposure";
constexpr std::chrono::seconds kExposureTtl{7 * 24 * 3600};

sw::redis::Redis redis("tcp://redis:6379");

std::string claim_key(const std::string& experiment_id, const std::string& unit_id) { return "exp:" + experiment_id + ":seen:" + unit_id; }

// The delivery report: an exposure the broker refused is not on the topic, so its claim goes too.
class ReleaseClaim : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    const auto event = json::parse(std::string(static_cast<const char*>(message.payload()), message.len()), nullptr, false);
    if (!event.is_object()) return;
    std::cerr << "exposure to " << event.value("experiment_id", "") << " not delivered: " << message.errstr() << "\\n";
    redis.del(claim_key(event.value("experiment_id", ""), event.value("unit_id", "")));
  }
};

ReleaseClaim delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Publish the unit's first exposure to the experiment; false when it was already recorded.
bool record_exposure(const std::string& experiment_id, const std::string& unit_id, const std::string& variant) {
  const std::string claim = claim_key(experiment_id, unit_id);
  // One event per (experiment, unit) across every replica: the claim lives in Redis, not in the process.
  if (!redis.set(claim, variant, kExposureTtl, sw::redis::UpdateType::NOT_EXIST)) return false;
  const long long ts = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string value = json{{"experiment_id", experiment_id}, {"unit_id", unit_id}, {"variant", variant}, {"ts", ts}}.dump();
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                                   value.size(), experiment_id.c_str(), experiment_id.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) redis.del(claim);  // refused before it was queued
  producer->poll(0);  // serve delivery reports; returns at once
  return true;
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "exposure-stats", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

void consume_exposures() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) continue;
    store::addExposure(event.value("experiment_id", ""), event.value("variant", ""));
    consumer->commitSync(msg.get());  // after the count: a crash before this point redelivers
  }
}
`,
    },
  },
  harness: {
    python: `import json

from expd import store

TOPIC = "experiment.exposure"
WEEK = 7 * 24 * 3600


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def check_experiment_key(ctx):
    m = ctx.load("events")
    m.record_exposure("exp-1", "u-1", "control")
    m.record_exposure("exp-2", "u-2", "treatment")
    m.record_exposure("exp-1", "u-3", "treatment")
    m.producer.poll(0)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three first exposures produced {len(records)} records on {TOPIC}"
    keys = sorted(r.key for r in records)
    assert keys == [b"exp-1", b"exp-1", b"exp-2"], f"exposures must be keyed by the experiment id, got {keys}"
    partitions = {r.partition for r in records if r.key == b"exp-1"}
    assert len(partitions) == 1, f"exp-1's exposures landed on partitions {sorted(partitions)}: one experiment's stream must stay on one partition"
    event = next((e for e in _events(ctx) if e.get("unit_id") == "u-1"), None)
    assert event is not None, f"no event carries unit_id u-1: {_events(ctx)}"
    for field in ("experiment_id", "unit_id", "variant", "ts"):
        assert field in event, f"the exposure event is missing {field}: {event}"


def check_shared_dedupe(ctx):
    m = ctx.load("events")
    claim = "exp:exp-1:seen:u-1"
    ttls = []

    def snapshot():
        ttl = ctx.redis.ttl(claim)
        if ttl == -2:  # not claimed yet: wait for the next command on the key
            ctx.redis_after(claim, snapshot)
        else:
            ttls.append(ttl)

    ctx.redis_after(claim, snapshot)
    assert m.record_exposure("exp-1", "u-1", "treatment") is True, "the first exposure of u-1 must be recorded"
    assert ttls, f"nothing claimed {claim}: the dedupe must be a Redis claim every replica sees"
    assert WEEK - 60 <= ttls[0] <= WEEK, f"right after {claim} was claimed its TTL was {ttls[0]} s (-1: none), expected EXPOSURE_TTL_S (7 days): claim with SET NX and the TTL in one command"
    assert m.record_exposure("exp-1", "u-1", "treatment") is False, "a re-render of the same page must not record a second exposure"
    m.producer.poll(0)
    replica = ctx.reload("events")
    again = replica.record_exposure("exp-1", "u-1", "treatment")
    replica.producer.poll(0)
    records = ctx.kafka.records(TOPIC)
    assert again is False and len(records) == 1, f"a second replica recorded u-1 again ({len(records)} records on the topic): the dedupe must be shared, a Redis claim, not a set in one process"
    # Another replica claims u-9 between this replica's first command on the claim and its next.
    rival_claim = "exp:exp-1:seen:u-9"
    rival = ctx.redis_after(rival_claim, lambda: bool(ctx.redis.set(rival_claim, "treatment", nx=True, ex=WEEK)))
    got = m.record_exposure("exp-1", "u-9", "treatment")
    m.producer.poll(0)
    assert rival.fired, f"nothing touched {rival_claim}: the claim must be taken there"
    published = sum(1 for e in _events(ctx) if e.get("unit_id") == "u-9") + (1 if rival.result else 0)
    assert published == 1 and got is not rival.result, f"another replica claimed u-9 ({rival.result}) while this one answered {got}: u-9 was published {published} times; take the claim with SET NX and produce only when it is yours"


def check_delivery_release(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.record_exposure("exp-1", "u-1", "control")
        m.producer.poll(0)
    except Exception as exc:  # noqa: BLE001 - whatever it raised is the verdict
        raise AssertionError(f"record_exposure failed the page render when the broker refused the record: {exc!r}") from None
    assert not ctx.kafka.records(TOPIC), "the broker refused the record, yet it is on the topic"
    m.record_exposure("exp-1", "u-1", "control")  # the page renders again
    m.producer.poll(0)
    units = [e.get("unit_id") for e in _events(ctx)]
    assert units == ["u-1"], f"after a refused delivery and a second render the topic holds {units}: delete the claim in the delivery callback so the exposure is published again"


def check_count_before_commit(ctx):
    for unit, variant in (("u-1", "control"), ("u-2", "treatment"), ("u-3", "control")):
        ctx.kafka.seed(TOPIC, key="exp-1", value=json.dumps({"experiment_id": "exp-1", "unit_id": unit, "variant": variant, "ts": 0}))
    # A count that fails: exp-2's counts are not a hash.
    ctx.redis.set("exp:exp-2:exposures", "corrupt")
    ctx.kafka.seed(TOPIC, key="exp-1", value=json.dumps({"experiment_id": "exp-2", "unit_id": "u-4", "variant": "control", "ts": 0}))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(sum(int(v) for v in ctx.redis.hvals("exp:exp-1:exposures"))))
    m = ctx.load("events")
    try:
        ctx.drain(m.consume_exposures)
    except Exception:  # noqa: BLE001 - a consumer may stop on the count it could not make
        pass
    assert at_commit, "the consumer never committed an offset"
    assert at_commit[0] >= 1, f"at the first commit exp:exp-1:exposures counted {at_commit[0]} units: count before committing, or a crash in between loses the exposure"
    counts = store.exposures("exp-1")
    assert counts == {"control": 2, "treatment": 1}, f"exp:exp-1:exposures holds {counts}, expected control 2, treatment 1"
    lag = ctx.kafka.lag("exposure-stats", TOPIC)
    assert lag <= 1, f"{lag} counted records are not committed: every counted record must be committed"
    assert lag == 1, "the consumer committed past an exposure it failed to count: a count that fails must not be committed"
`,
    typescript: `const TOPIC = 'experiment.exposure';
const WEEK = 7 * 24 * 3600;

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const events = (ctx): Record<string, unknown>[] => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));

export async function check_experiment_key(ctx) {
  const m = ctx.load('events');
  await m.recordExposure('exp-1', 'u-1', 'control');
  await m.recordExposure('exp-2', 'u-2', 'treatment');
  await m.recordExposure('exp-1', 'u-3', 'treatment');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three first exposures produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null).sort();
  assert.deepStrictEqual(keys, ['exp-1', 'exp-1', 'exp-2'], \`exposures must be keyed by the experiment id, got \${JSON.stringify(keys)}\`);
  const partitions = new Set(records.filter(r => r.key?.toString() === 'exp-1').map(r => r.partition));
  assert.equal(partitions.size, 1, "exp-1's exposures landed on more than one partition: one experiment's stream must stay on one partition");
  const event = events(ctx).find(e => e.unit_id === 'u-1');
  assert(event !== undefined, \`no event carries unit_id u-1: \${JSON.stringify(events(ctx))}\`);
  for (const field of ['experiment_id', 'unit_id', 'variant', 'ts']) assert(field in event, \`the exposure event is missing \${field}: \${JSON.stringify(event)}\`);
}

export async function check_shared_dedupe(ctx) {
  const m = ctx.load('events');
  const claim = 'exp:exp-1:seen:u-1';
  const ttls: number[] = [];
  const snapshot = () => {
    const ttl = ctx.redis.ttl(claim);
    if (ttl === -2) ctx.redisAfter(claim, snapshot); // not claimed yet: wait for the next command on the key
    else ttls.push(ttl);
  };
  ctx.redisAfter(claim, snapshot);
  assert.equal(await m.recordExposure('exp-1', 'u-1', 'treatment'), true, 'the first exposure of u-1 must be recorded');
  assert(ttls.length > 0, \`nothing claimed \${claim}: the dedupe must be a Redis claim every replica sees\`);
  assert(
    ttls[0] >= WEEK - 60 && ttls[0] <= WEEK,
    \`right after \${claim} was claimed its TTL was \${ttls[0]} s (-1: none), expected EXPOSURE_TTL_S (7 days): claim with SET NX and the TTL in one command\`,
  );
  assert.equal(await m.recordExposure('exp-1', 'u-1', 'treatment'), false, 'a re-render of the same page must not record a second exposure');
  const replica = ctx.reload('events');
  const again = await replica.recordExposure('exp-1', 'u-1', 'treatment');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert(again === false && records.length === 1, \`a second replica recorded u-1 again (\${records.length} records on the topic): the dedupe must be shared, a Redis claim, not a set in one process\`);
  // Another replica claims u-9 between this replica's first command on the claim and its next.
  const rivalClaim = 'exp:exp-1:seen:u-9';
  const rival = ctx.redisAfter(rivalClaim, () => ctx.redis.set(rivalClaim, 'treatment', 'NX', 'EX', WEEK) === 'OK');
  const got = await m.recordExposure('exp-1', 'u-9', 'treatment');
  await settle();
  assert(rival.fired, \`nothing touched \${rivalClaim}: the claim must be taken there\`);
  if (rival.error !== undefined) throw rival.error;
  const published = events(ctx).filter(e => e.unit_id === 'u-9').length + (rival.result ? 1 : 0);
  assert(
    published === 1 && got !== rival.result,
    \`another replica claimed u-9 (\${rival.result}) while this one answered \${got}: u-9 was published \${published} times; take the claim with SET NX and produce only when it is yours\`,
  );
}

export async function check_delivery_release(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await m.recordExposure('exp-1', 'u-1', 'control');
  } catch (e) {
    assert.fail(\`recordExposure failed the page render when the broker refused the record: \${e}\`);
  }
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'the broker refused the record, yet it is on the topic');
  await m.recordExposure('exp-1', 'u-1', 'control'); // the page renders again
  await settle();
  const units = events(ctx).map(e => e.unit_id);
  assert.deepStrictEqual(units, ['u-1'], \`after a refused delivery and a second render the topic holds \${JSON.stringify(units)}: delete the claim when the send is rejected so the exposure is published again\`);
}

export async function check_count_before_commit(ctx) {
  for (const [unit, variant] of [['u-1', 'control'], ['u-2', 'treatment'], ['u-3', 'control']]) {
    ctx.kafka.seed(TOPIC, {key: 'exp-1', value: JSON.stringify({experiment_id: 'exp-1', unit_id: unit, variant, ts: 0})});
  }
  // A count that fails: exp-2's counts are not a hash.
  ctx.redis.set('exp:exp-2:exposures', 'corrupt');
  ctx.kafka.seed(TOPIC, {key: 'exp-1', value: JSON.stringify({experiment_id: 'exp-2', unit_id: 'u-4', variant: 'control', ts: 0})});
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push((ctx.redis.hvals('exp:exp-1:exposures') as string[]).reduce((sum, v) => sum + Number(v), 0)));
  const m = ctx.load('events');
  try {
    await ctx.drain(m.consumeExposures());
  } catch {
    // a consumer may stop on the count it could not make
  }
  assert(atCommit.length > 0, 'the consumer never committed an offset');
  assert(atCommit[0] >= 1, \`at the first commit exp:exp-1:exposures counted \${atCommit[0]} units: count before committing, or a crash in between loses the exposure\`);
  const counts = ctx.redis.hgetall('exp:exp-1:exposures');
  assert.deepStrictEqual(counts, {control: '2', treatment: '1'}, \`exp:exp-1:exposures holds \${JSON.stringify(counts)}, expected control 2, treatment 1\`);
  const lag = ctx.kafka.lag('exposure-stats', TOPIC);
  assert(lag <= 1, \`\${lag} counted records are not committed: every counted record must be committed\`);
  assert.equal(lag, 1, 'the consumer committed past an exposure it failed to count: a count that fails must not be committed');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"

	"expd/store"

	"leetbuild/harness"
)

var hEventsBg = context.Background()

func hExposureUnits(ctx *harness.Ctx) []string {
	units := []string{}
	for _, r := range ctx.Kafka.Records(topic) {
		var e map[string]any
		json.Unmarshal(r.Value, &e)
		u, _ := e["unit_id"].(string)
		units = append(units, u)
	}
	return units
}

func CheckExperimentKey(ctx *harness.Ctx) {
	recordExposure(hEventsBg, "exp-1", "u-1", "control")
	recordExposure(hEventsBg, "exp-2", "u-2", "treatment")
	recordExposure(hEventsBg, "exp-1", "u-3", "treatment")
	ctx.Settle()
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 3, "three first exposures must produce three records on %s; the records", topic)
	keys := ctx.Kafka.Keys(topic)
	sort.Strings(keys)
	ctx.Equal(keys, []string{"exp-1", "exp-1", "exp-2"}, "exposures must be keyed by the experiment id (kafka-go batches per partition, so the order across keys is free); the keys")
	partitions := map[int]bool{}
	var first map[string]any
	for _, r := range records {
		if string(r.Key) == "exp-1" {
			partitions[r.Partition] = true
		}
		var e map[string]any
		json.Unmarshal(r.Value, &e)
		if e["unit_id"] == "u-1" {
			first = e
		}
	}
	ctx.Assert(len(partitions) == 1, "exp-1's exposures landed on partitions %v: one experiment's stream must stay on one partition", partitions)
	ctx.Assert(first != nil, "no event carries unit_id u-1")
	for _, field := range []string{"experiment_id", "unit_id", "variant", "ts"} {
		_, ok := first[field]
		ctx.Assert(ok, "the exposure event is missing %s: %v", field, first)
	}
}

func CheckSharedDedupe(ctx *harness.Ctx) {
	claim := "exp:exp-1:seen:u-1"
	var ttls []int64
	var snapshot func() any
	snapshot = func() any {
		ttl := ctx.Redis.TTL(claim)
		if ttl == -2 { // not claimed yet: wait for the next command on the key
			ctx.Redis.After(claim, snapshot)
		} else {
			ttls = append(ttls, ttl)
		}
		return nil
	}
	ctx.Redis.After(claim, snapshot)
	ctx.Assert(recordExposure(hEventsBg, "exp-1", "u-1", "treatment"), "the first exposure of u-1 must be recorded")
	ctx.Assert(len(ttls) > 0, "nothing claimed %s: the dedupe must be a Redis claim every replica sees (SET NX), not a map in one process", claim)
	ctx.Assert(ttls[0] >= 7*24*3600-60 && ttls[0] <= 7*24*3600, "right after %s was claimed its TTL was %d s (-1: none), expected 7 days: claim with SET NX and the TTL in one command", claim, ttls[0])
	ctx.Assert(!recordExposure(hEventsBg, "exp-1", "u-1", "treatment"), "a re-render of the same page must not record a second exposure")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "one unit, one exposure; the records")
	// Another replica claims u-9 between this replica's first command on the claim and its next.
	rivalClaim := "exp:exp-1:seen:u-9"
	rival := ctx.Redis.After(rivalClaim, func() any { return ctx.Redis.Set(rivalClaim, "treatment", "NX", "EX", 7*24*3600) })
	got := recordExposure(hEventsBg, "exp-1", "u-9", "treatment")
	ctx.Settle()
	ctx.Assert(rival.Fired, "nothing touched %s: the claim must be taken there", rivalClaim)
	rivalWon := rival.Result == true
	published := 0
	for _, u := range hExposureUnits(ctx) {
		if u == "u-9" {
			published++
		}
	}
	if rivalWon {
		published++
	}
	ctx.Assert(published == 1 && got != rivalWon, "another replica claimed u-9 (%t) while this one answered %t: u-9 was published %d times; take the claim with SET NX and produce only when it is yours", rivalWon, got, published)
}

func CheckDeliveryRelease(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(topic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("recordExposure failed the page render when the broker refused the record: %v", e)
			}
		}()
		recordExposure(hEventsBg, "exp-1", "u-1", "control")
	}()
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 0, "the broker refused the record; the records on the topic")
	recordExposure(hEventsBg, "exp-1", "u-1", "control") // the page renders again
	ctx.Settle()
	ctx.Equal(hExposureUnits(ctx), []string{"u-1"}, "after a refused delivery and a second render the exposure must be on the topic (delete the claim when WriteMessages fails); the units")
}

func CheckCountBeforeCommit(ctx *harness.Ctx) {
	for _, s := range [][2]string{{"u-1", "control"}, {"u-2", "treatment"}, {"u-3", "control"}} {
		value, _ := json.Marshal(map[string]any{"experiment_id": "exp-1", "unit_id": s[0], "variant": s[1], "ts": 0})
		ctx.Kafka.Seed(topic, "exp-1", string(value))
	}
	// A count that fails: exp-2's counts are not a hash.
	ctx.Redis.Set("exp:exp-2:exposures", "corrupt")
	bad, _ := json.Marshal(map[string]any{"experiment_id": "exp-2", "unit_id": "u-4", "variant": "control", "ts": 0})
	ctx.Kafka.Seed(topic, "exp-1", string(bad))
	var atCommit []int
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		total := 0
		for _, v := range ctx.Redis.HGetAll("exp:exp-1:exposures") {
			n, _ := strconv.Atoi(v)
			total += n
		}
		atCommit = append(atCommit, total)
	})
	ctx.Drain(func() { consumeExposures(hEventsBg) })
	ctx.Assert(len(atCommit) > 0, "the consumer never committed an offset")
	ctx.Assert(atCommit[0] >= 1, "at the first commit exp:exp-1:exposures counted %d units: count before committing, or a crash in between loses the exposure", atCommit[0])
	ctx.Equal(store.Exposures(hEventsBg, "exp-1"), map[string]int64{"control": 2, "treatment": 1}, "exp:exp-1:exposures")
	lag := ctx.Kafka.Lag("exposure-stats", topic)
	ctx.Assert(lag <= 1, "%d counted records are not committed: every counted record must be committed", lag)
	ctx.Assert(lag == 1, "the consumer committed past an exposure it failed to count: a count that fails must not be committed")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "expd/store.h"

namespace {

std::vector<std::string> hExposureUnits(harness::Ctx& ctx) {
  std::vector<std::string> units;
  for (const auto& r : ctx.Kafka.Records(kTopic)) {
    const auto e = nlohmann::json::parse(r.Value.value_or(""), nullptr, false);
    units.push_back(e.is_object() ? e.value("unit_id", "") : "");
  }
  return units;
}

}  // namespace

void CheckExperimentKey(harness::Ctx& ctx) {
  record_exposure("exp-1", "u-1", "control");
  record_exposure("exp-2", "u-2", "treatment");
  record_exposure("exp-1", "u-3", "treatment");
  producer->poll(0);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three first exposures must produce three records on %s; the records", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"exp-1", "exp-2", "exp-1"}, "exposures must be keyed by the experiment id; the keys");
  ctx.Equal(records[0].Partition, records[2].Partition, "one experiment's stream must stay on one partition; exp-1's partitions");
  const auto event = nlohmann::json::parse(records[0].Value.value_or(""), nullptr, false);
  for (const std::string field : {"experiment_id", "unit_id", "variant", "ts"}) {
    ctx.Assert(event.is_object() && event.contains(field), "the exposure event is missing %s: %s", field, records[0].Value.value_or(""));
  }
}

void CheckSharedDedupe(harness::Ctx& ctx) {
  const std::string claim = "exp:exp-1:seen:u-1";
  auto ttls = std::make_shared<std::vector<long long>>();
  auto snapshot = std::make_shared<std::function<void()>>();
  *snapshot = [&ctx, claim, ttls, snapshot] {
    const long long ttl = ctx.Redis.TTL(claim);
    if (ttl == -2) {
      ctx.Redis.After(claim, *snapshot);  // not claimed yet: wait for the next command on the key
    } else {
      ttls->push_back(ttl);
    }
  };
  ctx.Redis.After(claim, *snapshot);
  ctx.Assert(record_exposure("exp-1", "u-1", "treatment"), "the first exposure of u-1 must be recorded");
  ctx.Assert(!ttls->empty(), "nothing claimed %s: the dedupe must be a Redis claim every replica sees (SET NX), not a set in one process", claim);
  ctx.Assert(ttls->front() >= 7LL * 24 * 3600 - 60 && ttls->front() <= 7LL * 24 * 3600, "right after %s was claimed its TTL was %d s (-1: none), expected 7 days: claim with SET NX and the TTL in one command", claim, ttls->front());
  ctx.Assert(!record_exposure("exp-1", "u-1", "treatment"), "a re-render of the same page must not record a second exposure");
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one unit, one exposure; the records");
  // Another replica claims u-9 between this replica's first command on the claim and its next.
  const std::string rival_claim = "exp:exp-1:seen:u-9";
  auto rival = std::make_shared<std::optional<bool>>();
  ctx.Redis.After(rival_claim, [&ctx, rival, rival_claim] { *rival = ctx.Redis.Set(rival_claim, "treatment", "NX", "EX", 7 * 24 * 3600); });
  const bool got = record_exposure("exp-1", "u-9", "treatment");
  producer->poll(0);
  ctx.Settle();
  ctx.Assert(rival->has_value(), "nothing touched %s: the claim must be taken there", rival_claim);
  const bool rival_won = rival->value_or(false);
  int published = rival_won ? 1 : 0;
  for (const auto& u : hExposureUnits(ctx)) published += u == "u-9" ? 1 : 0;
  ctx.Assert(published == 1 && got != rival_won, "another replica claimed u-9 (%t) while this one answered %t: u-9 was published %d times; take the claim with SET NX and produce only when it is yours", rival_won, got, published);
}

void CheckDeliveryRelease(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  try {
    record_exposure("exp-1", "u-1", "control");
  } catch (const std::exception& e) {
    ctx.Fatalf("record_exposure failed the page render when the broker refused the record: %s", e.what());
  }
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "the broker refused the record; the records on the topic");
  record_exposure("exp-1", "u-1", "control");  // the page renders again
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(hExposureUnits(ctx), {"u-1"}, "after a refused delivery and a second render the exposure must be on the topic (delete the claim in dr_cb); the units");
}

void CheckCountBeforeCommit(harness::Ctx& ctx) {
  for (const auto& [unit, variant] : std::vector<std::pair<std::string, std::string>>{{"u-1", "control"}, {"u-2", "treatment"}, {"u-3", "control"}}) {
    ctx.Kafka.Seed(kTopic, "exp-1", nlohmann::json{{"experiment_id", "exp-1"}, {"unit_id", unit}, {"variant", variant}, {"ts", 0}}.dump());
  }
  // A count that fails: exp-2's counts are not a hash.
  ctx.Redis.Set("exp:exp-2:exposures", "corrupt");
  ctx.Kafka.Seed(kTopic, "exp-1", nlohmann::json{{"experiment_id", "exp-2"}, {"unit_id", "u-4"}, {"variant", "control"}, {"ts", 0}}.dump());
  std::vector<long long> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) {
    long long total = 0;
    for (const auto& [k, v] : ctx.Redis.HGetAll("exp:exp-1:exposures")) total += std::stoll(v);
    atCommit.push_back(total);
  });
  try {
    ctx.Drain([] { consume_exposures(); });
  } catch (const std::exception&) {
    // a consumer may stop on the count it could not make
  }
  ctx.Assert(!atCommit.empty(), "the consumer never committed an offset");
  ctx.Assert(atCommit[0] >= 1, "at the first commit exp:exp-1:exposures counted %d units: count before committing, or a crash in between loses the exposure", atCommit[0]);
  ctx.Equal(store::exposures("exp-1"), std::map<std::string, long long>{{"control", 2}, {"treatment", 1}}, "exp:exp-1:exposures");
  const auto lag = ctx.Kafka.Lag("exposure-stats", kTopic);
  ctx.Assert(lag <= 1, "%d counted records are not committed: every counted record must be committed", lag);
  ctx.Assert(lag == 1, "the consumer committed past an exposure it failed to count: a count that fails must not be committed");
}
`,
  },
  hints: [
    'Render the same page on two app servers: the report counts the user twice. Refuse one delivery at the broker and render again: that user does not get counted at all.',
    'The dedupe is a set inside one process, so every replica has its own, and it keeps a unit whose delivery failed; the `except` around `produce` does not see delivery failures. The consumer commits, then counts.',
    'Key by `experiment_id`; `r.set(claim, variant, nx=True, ex=EXPOSURE_TTL_S)` before producing and return False when it fails; pass an `on_delivery` that deletes the claim on error and serve it with `poll(0)`; call `store.add_exposure` before `consumer.commit`.',
  ],
  debrief: `Exposures are the denominator of every number in the report, so the stream has to count each unit once and lose none. The claim in Redis is what makes "once" hold across replicas, and releasing it in the delivery callback is what keeps "once" from turning into "never": a claim only stands for an exposure the broker accepted. Keying by experiment keeps one experiment's stream on one partition, so the consumer reads it in order and its lag means something per experiment. Counting before committing turns a crash into a redelivery, which the claim upstream does not cover; production pipelines make the counter idempotent as well, storing the offset or event id with the count in one transaction, and join exposures to conversions by unit downstream instead of incrementing counters.`,
};
