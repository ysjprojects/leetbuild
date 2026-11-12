/**
 * Hand-written support modules the telemetry-ingest steps import but no step builds: the `ingestd`
 * package. `ingestd.registry` is the device registry (provisioning writes it, the ingest path and the
 * series read only look devices up), `ingestd.wal` the ingest write-ahead log an accepted batch is
 * appended to, `ingestd.outbox` the rows a relay republishes when the broker refused a rollup. The
 * five languages keep the same Redis keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'ingestd/__init__.py': '',
  'ingestd/registry.py': `"""
The device registry (provided): a device is the Redis hash device:{id} with its fleet and its
declared metrics, a JSON object {name: [low, high]}. Provisioning registers devices; the ingest path
and the series read only look them up.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def lookup(device_id: str) -> dict | None:
    """The device row {"id", "fleet", "metrics": {name: [low, high]}}, or None when the registry does not know it."""
    raw = r.hgetall(f"device:{device_id}")
    if not raw:
        return None
    return {"id": device_id, "fleet": raw["fleet"], "metrics": json.loads(raw.get("metrics") or "{}")}


def register_device(device_id: str, fleet: str, metrics: dict) -> dict:
    """Provisioning: create (or replace) the device row and return it."""
    r.hset(f"device:{device_id}", mapping={"fleet": fleet, "metrics": json.dumps(metrics)})
    return lookup(device_id)
`,
  'ingestd/wal.py': `"""
The ingest write-ahead log (provided): the Redis list wal:ingest of accepted batches, oldest first,
each a JSON object {"batch_id", "device_id", "samples": [{"metric", "value", "ts"}]}. The writer
drains it into the time-series store (step 3) and the rollups (step 4).
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def append(batch: dict) -> None:
    """Append one accepted batch; ts is epoch seconds."""
    samples = [{"metric": s["metric"], "value": s["value"], "ts": s["ts"]} for s in batch["samples"]]
    r.rpush("wal:ingest", json.dumps({"batch_id": batch["batch_id"], "device_id": batch["device_id"], "samples": samples}))
`,
  'ingestd/outbox.py': `"""
The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} a relay
produces later, when the broker is back.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(topic: str, key: str, payload: dict) -> None:
    """Queue a record for the relay."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'ingestd/registry.ts': `/**
 * The device registry (provided): a device is the Redis hash device:{id} with its fleet and its
 * declared metrics, a JSON object {name: [low, high]}. Provisioning registers devices; the ingest
 * path and the series read only look them up.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Device {
  id: string;
  fleet: string;
  metrics: Record<string, [number, number]>;
}

/** The device row, or null when the registry does not know it. */
export async function lookup(deviceId: string): Promise<Device | null> {
  const raw = await redis.hgetall(\`device:\${deviceId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {id: deviceId, fleet: raw.fleet, metrics: JSON.parse(raw.metrics ?? '{}') as Device['metrics']};
}

/** Provisioning: create (or replace) the device row and return it. */
export async function registerDevice(deviceId: string, fleet: string, metrics: Device['metrics']): Promise<Device> {
  await redis.hset(\`device:\${deviceId}\`, {fleet, metrics: JSON.stringify(metrics)});
  return (await lookup(deviceId)) as Device;
}
`,
  'ingestd/wal.ts': `/**
 * The ingest write-ahead log (provided): the Redis list wal:ingest of accepted batches, oldest first,
 * each a JSON object {batch_id, device_id, samples: [{metric, value, ts}]}. The writer drains it into
 * the time-series store (step 3) and the rollups (step 4).
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** One reading; ts is epoch seconds. */
export interface Sample {
  metric: string;
  value: number;
  ts: number;
}

export interface Batch {
  batch_id: string;
  device_id: string;
  samples: Sample[];
}

/** Append one accepted batch. */
export async function append(batch: Batch): Promise<void> {
  const samples = batch.samples.map(({metric, value, ts}) => ({metric, value, ts}));
  await redis.rpush('wal:ingest', JSON.stringify({batch_id: batch.batch_id, device_id: batch.device_id, samples}));
}
`,
  'ingestd/outbox.ts': `/**
 * The outbox (provided): the Redis list outbox of JSON rows {topic, key, payload} a relay produces
 * later, when the broker is back.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Queue a record for the relay. */
export async function insert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'ingestd/registry/registry.go': `// Package registry is the device registry (provided): a device is the Redis hash device:{id} with
// its fleet and its declared metrics, a JSON object {name: [low, high]}. Provisioning registers
// devices; the ingest path and the series read only look them up.
package registry

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Device is one registry row; Metrics maps a declared metric to its [low, high] range.
type Device struct {
	ID      string
	Fleet   string
	Metrics map[string][2]float64
}

// Lookup is the device row, or nil when the registry does not know it.
func Lookup(ctx context.Context, deviceID string) (*Device, error) {
	raw, err := rdb.HGetAll(ctx, "device:"+deviceID).Result()
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, nil
	}
	device := &Device{ID: deviceID, Fleet: raw["fleet"], Metrics: map[string][2]float64{}}
	if text := raw["metrics"]; text != "" {
		if err := json.Unmarshal([]byte(text), &device.Metrics); err != nil {
			return nil, err
		}
	}
	return device, nil
}

// RegisterDevice is provisioning: it creates (or replaces) the device row and returns it.
func RegisterDevice(ctx context.Context, deviceID, fleet string, metrics map[string][2]float64) (*Device, error) {
	text, _ := json.Marshal(metrics)
	if err := rdb.HSet(ctx, "device:"+deviceID, "fleet", fleet, "metrics", string(text)).Err(); err != nil {
		return nil, err
	}
	return Lookup(ctx, deviceID)
}
`,
  'ingestd/wal/wal.go': `// Package wal is the ingest write-ahead log (provided): the Redis list wal:ingest of accepted
// batches, oldest first, each a JSON object {"batch_id", "device_id", "samples": [{"metric",
// "value", "ts"}]}. The writer drains it into the time-series store (step 3) and the rollups (step 4).
package wal

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Sample is one reading; TS is epoch seconds.
type Sample struct {
	Metric string  \`json:"metric"\`
	Value  float64 \`json:"value"\`
	TS     int64   \`json:"ts"\`
}

// Batch is what a device sends in one POST /v1/telemetry.
type Batch struct {
	BatchID  string   \`json:"batch_id"\`
	DeviceID string   \`json:"device_id"\`
	Samples  []Sample \`json:"samples"\`
}

// Append appends one accepted batch.
func Append(ctx context.Context, batch Batch) error {
	raw, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "wal:ingest", string(raw)).Err()
}
`,
  'ingestd/outbox/outbox.go': `// Package outbox is the outbox (provided): the Redis list outbox of JSON rows {"topic", "key",
// "payload"} a relay produces later, when the broker is back.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Row is one queued record.
type Row struct {
	Topic   string          \`json:"topic"\`
	Key     string          \`json:"key"\`
	Payload json.RawMessage \`json:"payload"\`
}

// Insert queues a record for the relay.
func Insert(ctx context.Context, topic, key string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	row, _ := json.Marshal(Row{Topic: topic, Key: key, Payload: raw})
	return rdb.RPush(ctx, "outbox", string(row)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'ingestd/registry.h': `// The device registry (provided): a device is the Redis hash device:{id} with its fleet and its
// declared metrics, a JSON object {name: [low, high]}. Provisioning registers devices; the ingest
// path and the series read only look them up.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>

namespace registry {

// Metric name → its declared [low, high] range.
using Ranges = std::map<std::string, std::pair<double, double>>;

struct Device {
  std::string id;
  std::string fleet;
  Ranges metrics;
};

inline sw::redis::Redis& client() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The device row, or none when the registry does not know it.
inline std::optional<Device> lookup(const std::string& device_id) {
  std::unordered_map<std::string, std::string> raw = client().hgetall("device:" + device_id);
  if (raw.empty()) return std::nullopt;
  Device device{device_id, raw["fleet"], {}};
  const nlohmann::json metrics = nlohmann::json::parse(raw.count("metrics") ? raw["metrics"] : std::string("{}"));
  for (const auto& [name, range] : metrics.items()) device.metrics[name] = {range[0].get<double>(), range[1].get<double>()};
  return device;
}

// Provisioning: create (or replace) the device row and return it.
inline Device registerDevice(const std::string& device_id, const std::string& fleet, const Ranges& metrics) {
  nlohmann::json ranges = nlohmann::json::object();
  for (const auto& [name, range] : metrics) ranges[name] = nlohmann::json::array({range.first, range.second});
  client().hset("device:" + device_id, "fleet", fleet, "metrics", ranges.dump());
  return *lookup(device_id);
}

}  // namespace registry
`,
  'ingestd/wal.h': `// The ingest write-ahead log (provided): the Redis list wal:ingest of accepted batches, oldest
// first, each a JSON object {"batch_id", "device_id", "samples": [{"metric", "value", "ts"}]}. The
// writer drains it into the time-series store (step 3) and the rollups (step 4).
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

namespace wal {

// One reading; ts is epoch seconds.
struct Sample {
  std::string metric;
  double value = 0;
  long long ts = 0;
};

// What a device sends in one POST /v1/telemetry.
struct Batch {
  std::string batch_id;
  std::string device_id;
  std::vector<Sample> samples;
};

inline sw::redis::Redis& client() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Append one accepted batch.
inline void append(const Batch& batch) {
  nlohmann::json samples = nlohmann::json::array();
  for (const Sample& s : batch.samples) samples.push_back({{"metric", s.metric}, {"value", s.value}, {"ts", s.ts}});
  client().rpush("wal:ingest", nlohmann::json{{"batch_id", batch.batch_id}, {"device_id", batch.device_id}, {"samples", samples}}.dump());
}

}  // namespace wal
`,
  'ingestd/outbox.h': `// The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} a relay
// produces later, when the broker is back.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace outbox {

inline sw::redis::Redis& client() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Queue a record for the relay.
inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  client().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('ingestd', 'Registry')]: `package ingestd

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/** One registry row; metrics maps a declared metric to its (low, high) range. */
final case class Device(id: String, fleet: String, metrics: Map[String, (Double, Double)])

/**
 * The device registry (provided): a device is the Redis hash device:{id} with its fleet and its
 * declared metrics, a JSON object {name: [low, high]}. Provisioning registers devices; the ingest
 * path and the series read only look them up.
 */
object Registry {
  val jedis = new JedisPooled("redis", 6379)

  /** The device row, or None when the registry does not know it. */
  def lookup(deviceId: String): Option[Device] = {
    val raw = jedis.hgetAll(s"device:$deviceId").asScala.toMap
    if (raw.isEmpty) None
    else {
      val metrics = raw.get("metrics").map(_.parseJson.asJsObject.fields).getOrElse(Map.empty[String, JsValue]).collect {
        case (name, JsArray(Seq(JsNumber(low), JsNumber(high)))) => name -> (low.toDouble, high.toDouble)
      }
      Some(Device(deviceId, raw.getOrElse("fleet", ""), metrics))
    }
  }

  /** Provisioning: create (or replace) the device row and return it. */
  def registerDevice(deviceId: String, fleet: String, metrics: Map[String, (Double, Double)]): Device = {
    val ranges = JsObject(metrics.map { case (name, (low, high)) => name -> JsArray(JsNumber(low), JsNumber(high)) })
    jedis.hset(s"device:$deviceId", Map("fleet" -> fleet, "metrics" -> ranges.compactPrint).asJava)
    lookup(deviceId).get
  }
}
`,
  [scalaPath('ingestd', 'Wal')]: `package ingestd

import redis.clients.jedis.JedisPooled
import spray.json._

/** One reading; ts is epoch seconds. */
final case class Sample(metric: String, value: Double, ts: Long)

/** What a device sends in one POST /v1/telemetry. */
final case class Batch(batchId: String, deviceId: String, samples: Seq[Sample])

/**
 * The ingest write-ahead log (provided): the Redis list wal:ingest of accepted batches, oldest first,
 * each a JSON object {"batch_id", "device_id", "samples": [{"metric", "value", "ts"}]}. The writer
 * drains it into the time-series store (step 3) and the rollups (step 4).
 */
object Wal {
  val jedis = new JedisPooled("redis", 6379)

  /** Append one accepted batch. */
  def append(batch: Batch): Unit = {
    val samples = JsArray(batch.samples.map(s => JsObject("metric" -> JsString(s.metric), "value" -> JsNumber(s.value), "ts" -> JsNumber(s.ts))).toVector)
    jedis.rpush("wal:ingest", JsObject("batch_id" -> JsString(batch.batchId), "device_id" -> JsString(batch.deviceId), "samples" -> samples).compactPrint)
  }
}
`,
  [scalaPath('ingestd', 'Outbox')]: `package ingestd

import redis.clients.jedis.JedisPooled
import spray.json._

/** The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} a relay produces later, when the broker is back. */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  /** Queue a record for the relay. */
  def insert(topic: String, key: String, payload: JsValue): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
