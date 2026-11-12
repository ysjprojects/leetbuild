import type {Step} from '@/lib/types';

// ---- 4. Position events on fleet.position ---------------------------------------------------------
export const eventsStep: Step = {
  id: 'events',
  title: 'A position event per applied position, keyed by vehicle',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'redis', 'kafka', 'map'],
  task: `## Task

**Starting point.** The starter's \`record_position(vehicle_id, position)\` builds the event
(vehicle id, timestamp, sequence, coordinates and the driver assigned to the vehicle, read from
\`vehicle:{id}:driver\`), produces it to \`fleet.position\` with \`acks=1\` and no key, then calls
\`update_latest\` (step 2) and returns what it returned. It serves the demo and hides four flaws.

**Failure mode the checks target.** Consumers of \`fleet.position\` (ETA, trip history, a
dispatcher's map in another region) key their state by vehicle and read each partition in order.
The topic is retained and replicated far beyond fleetd, and the broker's leader for a partition can
fail right after it acknowledges a write.

- The event carries \`vehicle_id\`, \`device_timestamp_ms\`, \`sequence\`, \`lat\`, \`lon\`, nothing
  about the driver.
- The record key is the vehicle id, so one vehicle's track stays on one partition, in order.
- The event is produced **after** \`update_latest\` applied the position, and only then: an ignored
  position is not an event.
- The producer uses \`acks=all\`.

:::widget kafka-partitions {"partitions": 3}`,
  sequence: {
    participants: ['fleetd', 'Redis', 'fleet.position', 'Consumer'],
    messages: [
      {from: 'fleetd', to: 'Redis', label: 'update_latest(v-1, ts 2000 seq 2) → applied', kind: 'sync'},
      {
        from: 'fleetd',
        to: 'fleet.position',
        label: 'produce key=v-1 {vehicle_id, ts, seq, lat, lon} · acks=all',
        kind: 'async',
      },
      {from: 'fleet.position', to: 'Consumer', label: 'partition hash(v-1): v-1 seq 1, seq 2 …', kind: 'async'},
      {from: 'fleetd', to: 'Redis', label: 'update_latest(v-1, ts 1500 seq 3) → ignored', kind: 'sync'},
      {from: 'fleetd', to: 'fleetd', label: 'no event', kind: 'sync'},
    ],
  },
  hints: [
    'The trip-history consumer draws a vehicle zig-zagging because its events arrive in any order; a privacy review finds driver ids in a topic retained for a year; after a broker failover an event is gone.',
    'Without a key the producer round-robins partitions; the starter enriches the event with the driver assignment; it produces before the state decided, so an ignored position becomes an event; `acks=1` is the leader alone.',
    'Call `update_latest` first and return false when it did; then produce `{vehicle_id, device_timestamp_ms, sequence, lat, lon}` with `key=vehicle_id` on a producer configured with `acks=all`.',
  ],
  checks: [
    {
      id: 'payload',
      title: 'An applied position becomes one event with the position',
      detail:
        'The event on `fleet.position` carries vehicle_id, device_timestamp_ms, sequence, lat and lon as received, and the latest record is written.',
      match: {
        python: {all: [/fleet\.position/, /update_latest\(/, /producer\.produce\(/]},
        typescript: {all: [/fleet\.position/, /updateLatest\(/, /producer\.send\(/]},
        go: {all: [/fleet\.position/, /updateLatest\(/, /WriteMessages\(/]},
        scala: {all: [/fleet\.position/, /State\.updateLatest\(/, /producer\.send\(/]},
        cpp: {all: [/fleet\.position/, /update_latest\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'topic-and-key',
      title: 'Keyed by vehicle id',
      detail:
        'Every record of a vehicle carries its id as the key and lands on one partition, so consumers read its track in order. The starter produces without a key.',
      match: {
        python: {all: [/producer\.produce\(\s*(TOPIC|["']fleet\.position["'])\s*,[\s\S]{0,200}?key\s*=\s*vehicle_id/]},
        typescript: {all: [/messages:\s*\[\s*\{\s*key:\s*vehicleId/]},
        go: {all: [/Key:\s*\[\]byte\(\s*vehicleID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[String, String\])?\(\s*(Topic|"fleet\.position")\s*,\s*vehicleId\s*,/]},
        cpp: {all: [/vehicle_id\.c_str\(\)\s*,\s*vehicle_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'no-driver-id',
      title: 'Nothing about the driver in the event',
      detail:
        'A retained, replicated position topic must not be joinable to a person: the event names the vehicle only. The starter reads the driver assignment into it.',
      match: {
        python: {none: [/driver/i]},
        typescript: {none: [/driver/i]},
        go: {none: [/driver/i]},
        scala: {none: [/driver/i]},
        cpp: {none: [/driver/i]},
      },
    },
    {
      id: 'publish-after-write',
      title: 'Produced after the write, and only for applied positions',
      detail:
        'When the latest record is written no event exists yet, and an ignored position produces nothing. The starter produces first and asks the state second.',
      match: {
        python: {
          order: [/[=(] ?not update_latest\(|= update_latest\(|if not update_latest\(/, /producer\.produce\(/],
          none: [/return update_latest\(/],
        },
        typescript: {order: [/await updateLatest\(/, /producer\.send\(/], none: [/return updateLatest\(/]},
        go: {order: [/:?= updateLatest\(/, /WriteMessages\(/], none: [/return updateLatest\(/]},
        scala: {
          order: [/[!(=] ?State\.updateLatest\(/, /producer\.send\(/],
          none: [/\n\s*State\.updateLatest\(vehicleId, p\)\s*\n\s*\}/],
        },
        cpp: {order: [/[!=(] ?update_latest\(/, /producer->produce\(/], none: [/return update_latest\(/]},
      },
    },
    {
      id: 'acks-all',
      title: 'acks=all: the event survives a leader failover',
      detail:
        'A partition leader that fails right after acknowledging the event loses it unless the followers had it too. The starter produces with acks=1.',
      match: {
        python: {all: [/["']acks["']\s*:\s*(["']all["']|-1)/]},
        typescript: {all: [/acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"acks"\s*,\s*"(all|-1)"/]},
        cpp: {all: [/"acks"\s*,\s*"(all|-1)"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Producer

from state import update_latest  # built in step 2: the compare-and-set on vehicle:{id}:latest

TOPIC = "fleet.position"
log = logging.getLogger("fleet")

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 5})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("position event not delivered: %s", err)


def record_position(vehicle_id: str, position: dict) -> bool:
    """Write the position as the vehicle's latest and publish it; True when the state applied it."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    event = {
        "vehicle_id": vehicle_id,
        "device_timestamp_ms": position["device_timestamp_ms"],
        "sequence": position["sequence"],
        "lat": position["lat"],
        "lon": position["lon"],
        "driver_id": r.get(f"vehicle:{vehicle_id}:driver"),
    }
    producer.produce(TOPIC, value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)
    return update_latest(vehicle_id, position)
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from state import update_latest  # built in step 2: the compare-and-set on vehicle:{id}:latest

TOPIC = "fleet.position"
log = logging.getLogger("fleet")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "linger.ms": 5})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("position event not delivered: %s", err)


def record_position(vehicle_id: str, position: dict) -> bool:
    """Write the position as the vehicle's latest and, when it was applied, publish it; True when applied."""
    if not update_latest(vehicle_id, position):
        return False  # an ignored position is not an event
    event = {
        "vehicle_id": vehicle_id,
        "device_timestamp_ms": position["device_timestamp_ms"],
        "sequence": position["sequence"],
        "lat": position["lat"],
        "lon": position["lon"],
    }
    producer.produce(TOPIC, key=vehicle_id, value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery callbacks; returns immediately
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import type {Position} from 'fleet/position';

import {redis, updateLatest} from './state'; // built in step 2: the compare-and-set on vehicle:{id}:latest

export const TOPIC = 'fleet.position';

const kafka = new Kafka({clientId: 'fleetd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Write the position as the vehicle's latest and publish it; true when the state applied it. */
export async function recordPosition(vehicleId: string, position: Position): Promise<boolean> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const value = JSON.stringify({
    vehicle_id: vehicleId,
    device_timestamp_ms: position.device_timestamp_ms,
    sequence: position.sequence,
    lat: position.lat,
    lon: position.lon,
    driver_id: await redis.get(\`vehicle:\${vehicleId}:driver\`),
  });
  await producer.send({topic: TOPIC, messages: [{value}], acks: 1});
  return updateLatest(vehicleId, position);
}
`,
      solution: `import {Kafka} from 'kafkajs';

import type {Position} from 'fleet/position';

import {updateLatest} from './state'; // built in step 2: the compare-and-set on vehicle:{id}:latest

export const TOPIC = 'fleet.position';

const kafka = new Kafka({clientId: 'fleetd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Write the position as the vehicle's latest and, when it was applied, publish it; true when applied. */
export async function recordPosition(vehicleId: string, position: Position): Promise<boolean> {
  if (!(await updateLatest(vehicleId, position))) return false; // an ignored position is not an event
  const value = JSON.stringify({
    vehicle_id: vehicleId,
    device_timestamp_ms: position.device_timestamp_ms,
    sequence: position.sequence,
    lat: position.lat,
    lon: position.lon,
  });
  await producer.send({topic: TOPIC, messages: [{key: vehicleId, value}], acks: -1});
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"fleet/position"
)

const topic = "fleet.position"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
}

// Built in step 2 (state.go): the compare-and-set on vehicle:{id}:latest; true when applied.
var updateLatest = func(ctx context.Context, vehicleID string, p position.Position) (bool, error) {
	panic("built in step 2")
}

type positionEvent struct {
	VehicleID         string  \`json:"vehicle_id"\`
	DeviceTimestampMs int64   \`json:"device_timestamp_ms"\`
	Sequence          int64   \`json:"sequence"\`
	Lat               float64 \`json:"lat"\`
	Lon               float64 \`json:"lon"\`
	DriverID          string  \`json:"driver_id"\`
}

// recordPosition writes the position as the vehicle's latest and publishes it; true when the state applied it.
func recordPosition(ctx context.Context, vehicleID string, p position.Position) (bool, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	driver, _ := rdb.Get(ctx, "vehicle:"+vehicleID+":driver").Result()
	value, _ := json.Marshal(positionEvent{vehicleID, p.DeviceTimestampMs, p.Sequence, p.Lat, p.Lon, driver})
	if err := writer.WriteMessages(ctx, kafka.Message{Value: value}); err != nil {
		log.Printf("position event for %s not delivered: %v", vehicleID, err)
	}
	return updateLatest(ctx, vehicleID, p)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"

	"fleet/position"
)

const topic = "fleet.position"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

// Built in step 2 (state.go): the compare-and-set on vehicle:{id}:latest; true when applied.
var updateLatest = func(ctx context.Context, vehicleID string, p position.Position) (bool, error) {
	panic("built in step 2")
}

// recordPosition writes the position as the vehicle's latest and, when it was applied, publishes it; true when applied.
func recordPosition(ctx context.Context, vehicleID string, p position.Position) (bool, error) {
	applied, err := updateLatest(ctx, vehicleID, p)
	if err != nil || !applied {
		return false, err // an ignored position is not an event
	}
	value, _ := json.Marshal(p) // vehicle_id, device_timestamp_ms, sequence, lat, lon
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(vehicleID), Value: value}); err != nil {
		log.Printf("position event for %s not delivered: %v", vehicleID, err)
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import fleet.Position

object Events {
  val Topic = "fleet.position"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"position event not delivered: \${exception.getMessage}")
  }

  /** Write the position as the vehicle's latest (step 2) and publish it; true when the state applied it. */
  def recordPosition(vehicleId: String, p: Position): Boolean = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val driver = Option(State.jedis.get(s"vehicle:$vehicleId:driver")).getOrElse("")
    val event  = JsObject(p.toJson.asJsObject.fields + ("driver_id" -> JsString(driver)))
    producer.send(new ProducerRecord[String, String](Topic, event.compactPrint), onDelivery)
    State.updateLatest(vehicleId, p)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import fleet.Position

object Events {
  val Topic = "fleet.position"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"position event not delivered: \${exception.getMessage}")
  }

  /** Write the position as the vehicle's latest (step 2) and, when it was applied, publish it; true when applied. */
  def recordPosition(vehicleId: String, p: Position): Boolean = {
    if (!State.updateLatest(vehicleId, p)) return false // an ignored position is not an event
    producer.send(new ProducerRecord[String, String](Topic, vehicleId, p.toJson.compactPrint), onDelivery)
    true
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "position.h"

const std::string kTopic = "fleet.position";

sw::redis::Redis redis("tcp://redis:6379");

// Built in step 2 (state.cpp): the compare-and-set on vehicle:{id}:latest; true when applied.
bool update_latest(const std::string& vehicle_id, const Position& p);

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "position event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "5", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Write the position as the vehicle's latest and publish it; true when the state applied it.
bool record_position(const std::string& vehicle_id, const Position& p) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const auto driver = redis.get("vehicle:" + vehicle_id + ":driver");
  std::string value = nlohmann::json{{"vehicle_id", vehicle_id},
                                     {"device_timestamp_ms", p.device_timestamp_ms},
                                     {"sequence", p.sequence},
                                     {"lat", p.lat},
                                     {"lon", p.lon},
                                     {"driver_id", driver.value_or("")}}
                          .dump();
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   value.data(), value.size(), nullptr, 0, 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) std::cerr << "position event produce failed: " << RdKafka::err2str(err) << "\\n";
  producer->poll(0);
  return update_latest(vehicle_id, p);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "position.h"

const std::string kTopic = "fleet.position";

// Built in step 2 (state.cpp): the compare-and-set on vehicle:{id}:latest; true when applied.
bool update_latest(const std::string& vehicle_id, const Position& p);

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "position event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("linger.ms", "5", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Write the position as the vehicle's latest and, when it was applied, publish it; true when applied.
bool record_position(const std::string& vehicle_id, const Position& p) {
  if (!update_latest(vehicle_id, p)) return false;  // an ignored position is not an event
  std::string value = nlohmann::json{{"vehicle_id", vehicle_id},
                                     {"device_timestamp_ms", p.device_timestamp_ms},
                                     {"sequence", p.sequence},
                                     {"lat", p.lat},
                                     {"lon", p.lon}}
                          .dump();
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   value.data(), value.size(), vehicle_id.c_str(), vehicle_id.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) std::cerr << "position event produce failed: " << RdKafka::err2str(err) << "\\n";
  producer->poll(0);  // serve delivery callbacks; returns immediately
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "fleet.position"
V1 = "vehicle:v-1:latest"


def pos(ts, seq, lat=47.6, lon=-122.3, vehicle_id="v-1"):
    return {"vehicle_id": vehicle_id, "device_timestamp_ms": ts, "sequence": seq, "lat": lat, "lon": lon}


def check_payload(ctx):
    m = ctx.load("events")
    assert m.record_position("v-1", pos(1000, 42)) is True, "a new position must be applied (True)"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one applied position produced {len(records)} records on fleet.position (topics: {sorted(ctx.kafka.topics)})"
    event = json.loads(records[0].value)
    expected = {"vehicle_id": "v-1", "device_timestamp_ms": 1000, "sequence": 42, "lat": 47.6, "lon": -122.3}
    missing = {k: v for k, v in expected.items() if event.get(k) != v}
    assert not missing, f"the event is {event}, expected it to carry {missing} as received"
    assert ctx.redis.exists(V1), "record_position must write the latest record (update_latest) as well as publish: vehicle:v-1:latest is missing"


def check_topic_and_key(ctx):
    m = ctx.load("events")
    for ts, seq in ((1000, 1), (2000, 2), (3000, 3)):
        m.record_position("v-1", pos(ts, seq))
    m.record_position("v-2", pos(1000, 1, vehicle_id="v-2"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 4, f"four applied positions produced {len(records)} records"
    keys = [r.key for r in records]
    assert keys == [b"v-1", b"v-1", b"v-1", b"v-2"], f"records must be keyed by the vehicle id, got keys {keys}: without the key the producer spreads one vehicle's track over every partition and consumers read it out of order"
    assert len({r.partition for r in records[:3]}) == 1, f"v-1's three events landed on partitions {[r.partition for r in records[:3]]}: one vehicle must stay on one partition"
    assert [json.loads(r.value)["sequence"] for r in records[:3]] == [1, 2, 3], "v-1's events must be in production order"


def check_no_driver_id(ctx):
    ctx.redis.set("vehicle:v-1:driver", "d-77")
    m = ctx.load("events")
    m.record_position("v-1", pos(1000, 42))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one applied position produced {len(records)} records"
    value = records[0].value.decode()
    assert "d-77" not in value and "driver" not in value.lower(), f"the event {value} names the driver: a retained, replicated position topic must not be joinable to a person. Carry the vehicle, not who drives it"


def check_publish_after_write(ctx):
    m = ctx.load("events")
    probe = ctx.redis_after(V1, lambda: len(ctx.kafka.records(TOPIC)))
    assert m.record_position("v-1", pos(1000, 42)) is True, "a new position must be applied (True)"
    assert probe.fired, "record_position touched no vehicle:v-1:latest: the position was not written"
    assert probe.result == 0, f"when the latest record was written, {probe.result} event(s) were already on fleet.position: a consumer could act on a position the state did not have yet. Write first, publish second"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"one applied position produced {len(ctx.kafka.records(TOPIC))} records"
    assert m.record_position("v-1", pos(500, 41)) is False, "an older position is ignored by the state and record_position returns False"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"an ignored (older) position was published: fleet.position holds {len(ctx.kafka.records(TOPIC))} events, expected 1. Only an applied position is an event"


def check_acks_all(ctx):
    m = ctx.load("events")
    m.record_position("v-1", pos(1000, 42))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"one applied position produced {len(ctx.kafka.records(TOPIC))} records"
    ctx.kafka.failover(TOPIC)  # the partition leader fails right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 1, "the partition leader failed right after acknowledging the event and the event is gone: with acks=1 the leader answers before the followers have it. Produce with acks=all"
`,
    typescript: `const TOPIC = 'fleet.position';
const V1 = 'vehicle:v-1:latest';

const pos = (ts: number, seq: number, lat = 47.6, lon = -122.3, vehicle_id = 'v-1') => ({vehicle_id, device_timestamp_ms: ts, sequence: seq, lat, lon});

export async function check_payload(ctx) {
  const m = ctx.load('events');
  assert.strictEqual(await m.recordPosition('v-1', pos(1000, 42)), true, 'a new position must be applied (true)');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one applied position produced \${records.length} records on fleet.position\`);
  const event = JSON.parse(records[0].value.toString());
  const expected = {vehicle_id: 'v-1', device_timestamp_ms: 1000, sequence: 42, lat: 47.6, lon: -122.3};
  const missing = Object.entries(expected).filter(([k, v]) => event[k] !== v);
  assert.equal(missing.length, 0, \`the event is \${records[0].value.toString()}, expected it to carry \${JSON.stringify(Object.fromEntries(missing))} as received\`);
  assert.equal(ctx.redis.exists(V1), 1, 'recordPosition must write the latest record (updateLatest) as well as publish: vehicle:v-1:latest is missing');
}

export async function check_topic_and_key(ctx) {
  const m = ctx.load('events');
  for (const [ts, seq] of [[1000, 1], [2000, 2], [3000, 3]]) await m.recordPosition('v-1', pos(ts, seq));
  await m.recordPosition('v-2', pos(1000, 1, 47.6, -122.3, 'v-2'));
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 4, \`four applied positions produced \${records.length} records\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['v-1', 'v-1', 'v-1', 'v-2'], \`records must be keyed by the vehicle id, got keys \${JSON.stringify(keys)}: without the key the producer spreads one vehicle's track over every partition and consumers read it out of order\`);
  const partitions = records.slice(0, 3).map(r => r.partition);
  assert.equal(new Set(partitions).size, 1, \`v-1's three events landed on partitions \${JSON.stringify(partitions)}: one vehicle must stay on one partition\`);
  assert.deepStrictEqual(records.slice(0, 3).map(r => JSON.parse(r.value.toString()).sequence), [1, 2, 3], "v-1's events must be in production order");
}

export async function check_no_driver_id(ctx) {
  ctx.redis.set('vehicle:v-1:driver', 'd-77');
  const m = ctx.load('events');
  await m.recordPosition('v-1', pos(1000, 42));
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one applied position produced \${records.length} records\`);
  const value = records[0].value.toString();
  assert(!value.includes('d-77') && !value.toLowerCase().includes('driver'), \`the event \${value} names the driver: a retained, replicated position topic must not be joinable to a person. Carry the vehicle, not who drives it\`);
}

export async function check_publish_after_write(ctx) {
  const m = ctx.load('events');
  const probe = ctx.redisAfter(V1, () => ctx.kafka.records(TOPIC).length);
  assert.strictEqual(await m.recordPosition('v-1', pos(1000, 42)), true, 'a new position must be applied (true)');
  assert(probe.fired, 'recordPosition touched no vehicle:v-1:latest: the position was not written');
  assert.equal(probe.result, 0, \`when the latest record was written, \${probe.result} event(s) were already on fleet.position: a consumer could act on a position the state did not have yet. Write first, publish second\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`one applied position produced \${ctx.kafka.records(TOPIC).length} records\`);
  assert.strictEqual(await m.recordPosition('v-1', pos(500, 41)), false, 'an older position is ignored by the state and recordPosition returns false');
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`an ignored (older) position was published: fleet.position holds \${ctx.kafka.records(TOPIC).length} events, expected 1. Only an applied position is an event\`);
}

export async function check_acks_all(ctx) {
  const m = ctx.load('events');
  await m.recordPosition('v-1', pos(1000, 42));
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`one applied position produced \${ctx.kafka.records(TOPIC).length} records\`);
  ctx.kafka.failover(TOPIC); // the partition leader fails right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the partition leader failed right after acknowledging the event and the event is gone: with acks=1 the leader answers before the followers have it. Produce with acks: -1 (all)');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"leetbuild/harness"

	"fleet/position"
)

const positionTopic = "fleet.position"

// eventsState stands in for step 2's updateLatest: the compare-and-set on vehicle:{id}:latest,
// noting how many events were on the topic each time a position was written.
type eventsState struct {
	eventsAtWrite []int
}

func newEvents(ctx *harness.Ctx) *eventsState {
	s := &eventsState{}
	updateLatest = func(_ context.Context, vehicleID string, p position.Position) (bool, error) {
		key := "vehicle:" + vehicleID + ":latest"
		cur := ctx.Redis.HGetAll(key)
		if len(cur) > 0 {
			ts, _ := strconv.ParseInt(cur["ts"], 10, 64)
			seq, _ := strconv.ParseInt(cur["seq"], 10, 64)
			if p.DeviceTimestampMs < ts || (p.DeviceTimestampMs == ts && p.Sequence <= seq) {
				return false, nil
			}
		}
		s.eventsAtWrite = append(s.eventsAtWrite, len(ctx.Kafka.Records(positionTopic)))
		ctx.Redis.Do("HSET", key, "ts", p.DeviceTimestampMs, "seq", p.Sequence, "lat", p.Lat, "lon", p.Lon)
		return true, nil
	}
	return s
}

func eventsPos(ts, seq int64, vehicleID string) position.Position {
	return position.Position{VehicleID: vehicleID, DeviceTimestampMs: ts, Sequence: seq, Lat: 47.6, Lon: -122.3}
}

func eventsRecord(ctx *harness.Ctx, vehicleID string, p position.Position) bool {
	applied, err := recordPosition(context.Background(), vehicleID, p)
	ctx.NoError(err, "recordPosition(%s, %v)", vehicleID, p)
	return applied
}

func CheckPayload(ctx *harness.Ctx) {
	newEvents(ctx)
	ctx.Equal(eventsRecord(ctx, "v-1", eventsPos(1000, 42, "v-1")), true, "a new position must be applied; applied")
	records := ctx.Kafka.Records(positionTopic)
	ctx.Equal(len(records), 1, "one applied position must produce one record on fleet.position; the records")
	var event map[string]any
	ctx.NoError(json.Unmarshal(records[0].Value, &event), "the event must be JSON: %s", records[0].Value)
	for k, v := range map[string]any{"vehicle_id": "v-1", "device_timestamp_ms": 1000, "sequence": 42, "lat": 47.6, "lon": -122.3} {
		ctx.Equal(event[k], v, "the event %s must carry %s as received", records[0].Value, k)
	}
	ctx.Equal(ctx.Redis.Exists("vehicle:v-1:latest"), 1, "recordPosition must write the latest record (updateLatest) as well as publish; vehicle:v-1:latest exists")
}

func CheckTopicAndKey(ctx *harness.Ctx) {
	newEvents(ctx)
	for i, ts := range []int64{1000, 2000, 3000} {
		eventsRecord(ctx, "v-1", eventsPos(ts, int64(i+1), "v-1"))
	}
	eventsRecord(ctx, "v-2", eventsPos(1000, 1, "v-2"))
	records := ctx.Kafka.Records(positionTopic)
	ctx.Equal(len(records), 4, "four applied positions; the records")
	ctx.Equal(ctx.Kafka.Keys(positionTopic), []string{"v-1", "v-1", "v-1", "v-2"}, "records must be keyed by the vehicle id: without the key the producer spreads one vehicle's track over every partition and consumers read it out of order")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "v-1's three events landed on partitions %d, %d, %d: one vehicle must stay on one partition", records[0].Partition, records[1].Partition, records[2].Partition)
	var seqs []int64
	for _, r := range records[:3] {
		var e struct {
			Sequence int64 \`json:"sequence"\`
		}
		json.Unmarshal(r.Value, &e)
		seqs = append(seqs, e.Sequence)
	}
	ctx.Equal(seqs, []int64{1, 2, 3}, "v-1's events must be in production order")
}

func CheckNoDriverId(ctx *harness.Ctx) {
	ctx.Redis.Set("vehicle:v-1:driver", "d-77")
	newEvents(ctx)
	eventsRecord(ctx, "v-1", eventsPos(1000, 42, "v-1"))
	records := ctx.Kafka.Records(positionTopic)
	ctx.Equal(len(records), 1, "one applied position; the records")
	value := string(records[0].Value)
	ctx.Assert(!strings.Contains(value, "d-77") && !strings.Contains(strings.ToLower(value), "driver"), "the event %s names the driver: a retained, replicated position topic must not be joinable to a person. Carry the vehicle, not who drives it", value)
}

func CheckPublishAfterWrite(ctx *harness.Ctx) {
	s := newEvents(ctx)
	ctx.Equal(eventsRecord(ctx, "v-1", eventsPos(1000, 42, "v-1")), true, "a new position must be applied; applied")
	ctx.Assert(len(s.eventsAtWrite) == 1, "recordPosition wrote no latest record: updateLatest was called %d times", len(s.eventsAtWrite))
	ctx.Equal(s.eventsAtWrite[0], 0, "when the latest record was written, events were already on fleet.position: a consumer could act on a position the state did not have yet. Write first, publish second; the events at the write")
	ctx.Equal(len(ctx.Kafka.Records(positionTopic)), 1, "one applied position; the records")
	ctx.Equal(eventsRecord(ctx, "v-1", eventsPos(500, 41, "v-1")), false, "an older position is ignored by the state and recordPosition returns false; applied")
	ctx.Equal(len(ctx.Kafka.Records(positionTopic)), 1, "an ignored (older) position was published: only an applied position is an event; the records")
}

func CheckAcksAll(ctx *harness.Ctx) {
	newEvents(ctx)
	eventsRecord(ctx, "v-1", eventsPos(1000, 42, "v-1"))
	ctx.Equal(len(ctx.Kafka.Records(positionTopic)), 1, "one applied position; the records")
	ctx.Kafka.Failover(positionTopic) // the partition leader fails right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(positionTopic)), 1, "the partition leader failed right after acknowledging the event and the event is gone: with RequireOne the leader answers before the followers have it. Produce with RequireAll; the records")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

const std::string kPositionTopic = "fleet.position";

// Stands in for step 2's update_latest: the compare-and-set on vehicle:{id}:latest, noting how many
// events were on the topic each time a position was written.
harness::Ctx* eventsCtx = nullptr;
std::vector<int> eventsAtWrite;

Position eventsPos(long long ts, long long seq, const std::string& vehicle_id = "v-1") {
  return Position{vehicle_id, ts, seq, 47.6, -122.3};
}

std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
  return s;
}

}  // namespace

bool update_latest(const std::string& vehicle_id, const Position& p) {
  const std::string key = "vehicle:" + vehicle_id + ":latest";
  const auto cur = eventsCtx->Redis.HGetAll(key);
  if (!cur.empty()) {
    const long long ts = std::atoll(cur.at("ts").c_str());
    const long long seq = std::atoll(cur.at("seq").c_str());
    if (p.device_timestamp_ms < ts || (p.device_timestamp_ms == ts && p.sequence <= seq)) return false;
  }
  eventsAtWrite.push_back(static_cast<int>(eventsCtx->Kafka.Records(kPositionTopic).size()));
  eventsCtx->Redis.Do("HSET", key, "ts", p.device_timestamp_ms, "seq", p.sequence, "lat", p.lat, "lon", p.lon);
  return true;
}

void CheckPayload(harness::Ctx& ctx) {
  eventsCtx = &ctx;
  ctx.Equal(record_position("v-1", eventsPos(1000, 42)), true, "a new position must be applied; applied");
  const auto records = ctx.Kafka.Records(kPositionTopic);
  ctx.Equal(records.size(), 1, "one applied position must produce one record on fleet.position; the records");
  const std::string value = records[0].Value.value_or("");
  nlohmann::json event;
  try {
    event = nlohmann::json::parse(value);
  } catch (const std::exception&) {
  }
  ctx.Assert(event.is_object(), "the event must be JSON: %s", value);
  const nlohmann::json expected = {{"vehicle_id", "v-1"}, {"device_timestamp_ms", 1000}, {"sequence", 42}, {"lat", 47.6}, {"lon", -122.3}};
  for (const auto& [k, v] : expected.items()) {
    ctx.Assert(event.contains(k) && event[k] == v, "the event %s must carry %s as received (%s)", value, k, v.dump());
  }
  ctx.Equal(ctx.Redis.Exists("vehicle:v-1:latest"), 1,
            "record_position must write the latest record (update_latest) as well as publish; vehicle:v-1:latest exists");
}

void CheckTopicAndKey(harness::Ctx& ctx) {
  eventsCtx = &ctx;
  long long seq = 1;
  for (const long long ts : {1000, 2000, 3000}) record_position("v-1", eventsPos(ts, seq++));
  record_position("v-2", eventsPos(1000, 1, "v-2"));
  const auto records = ctx.Kafka.Records(kPositionTopic);
  ctx.Equal(records.size(), 4, "four applied positions; the records");
  ctx.Equal(ctx.Kafka.Keys(kPositionTopic), {"v-1", "v-1", "v-1", "v-2"},
            "records must be keyed by the vehicle id: without the key the producer spreads one vehicle's track over "
            "every partition and consumers read it out of order");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
             "v-1's three events landed on partitions %d, %d, %d: one vehicle must stay on one partition", records[0].Partition,
             records[1].Partition, records[2].Partition);
  std::vector<long long> seqs;
  for (int i = 0; i < 3; i++) seqs.push_back(nlohmann::json::parse(records[i].Value.value_or("{}")).value("sequence", -1LL));
  ctx.Equal(seqs, {1LL, 2LL, 3LL}, "v-1's events must be in production order");
}

void CheckNoDriverId(harness::Ctx& ctx) {
  eventsCtx = &ctx;
  ctx.Redis.Set("vehicle:v-1:driver", "d-77");
  record_position("v-1", eventsPos(1000, 42));
  const auto records = ctx.Kafka.Records(kPositionTopic);
  ctx.Equal(records.size(), 1, "one applied position; the records");
  const std::string value = records[0].Value.value_or("");
  ctx.Assert(value.find("d-77") == std::string::npos && lower(value).find("driver") == std::string::npos,
             "the event %s names the driver: a retained, replicated position topic must not be joinable to a person. "
             "Carry the vehicle, not who drives it",
             value);
}

void CheckPublishAfterWrite(harness::Ctx& ctx) {
  eventsCtx = &ctx;
  ctx.Equal(record_position("v-1", eventsPos(1000, 42)), true, "a new position must be applied; applied");
  ctx.Assert(eventsAtWrite.size() == 1, "record_position wrote no latest record: update_latest was called %d times",
             static_cast<int>(eventsAtWrite.size()));
  ctx.Equal(eventsAtWrite[0], 0,
            "when the latest record was written, events were already on fleet.position: a consumer could act on a "
            "position the state did not have yet. Write first, publish second; the events at the write");
  ctx.Equal(ctx.Kafka.Records(kPositionTopic).size(), 1, "one applied position; the records");
  ctx.Equal(record_position("v-1", eventsPos(500, 41)), false,
            "an older position is ignored by the state and record_position returns false; applied");
  ctx.Equal(ctx.Kafka.Records(kPositionTopic).size(), 1,
            "an ignored (older) position was published: only an applied position is an event; the records");
}

void CheckAcksAll(harness::Ctx& ctx) {
  eventsCtx = &ctx;
  record_position("v-1", eventsPos(1000, 42));
  ctx.Equal(ctx.Kafka.Records(kPositionTopic).size(), 1, "one applied position; the records");
  ctx.Kafka.Failover(kPositionTopic);  // the partition leader fails right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kPositionTopic).size(), 1,
            "the partition leader failed right after acknowledging the event and the event is gone: with acks=1 the "
            "leader answers before the followers have it. Produce with acks=all; the records");
}
`,
  },
  debrief: `Asking the state first makes the topic a record of what the map accepted rather than of what devices sent: a consumer that keys by vehicle and applies events in partition order converges on the latest position fleetd holds, which is only true if ignored positions produce nothing and each vehicle's events share a partition. The driver stays out because a topic outlives the request and is copied to places the privacy review does not see; the join to a person belongs behind its own access control. \`acks=all\` costs a follower round trip per batch and buys the only durability the broker offers. Production pipelines write the event through an outbox or a transactional producer so a crash between the Redis write and the produce cannot lose it, and version the payload.`,
};
