import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Impression events keyed by campaign, counted at render',
  concept: 'kafka',
  file: 'events',
  focus: ['server', 'kafka', 'counter', 'redis'],
  task: `## Task

**Starting point.** The starter is \`record_impression(beacon)\`, called when a page reports that an
ad rendered (\`{"beacon_id", "campaign_id", "creative_id", "user_hash", "price_micros"}\`): it
produces \`{"beacon_id", "campaign_id", "creative_id", "price_micros"}\` to \`ads.impression\` keyed
by \`user_hash\` on a producer with \`acks=1\`, then counts the render with \`store.count_render\` and
returns \`True\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** One campaign's impressions land on every partition, a page that
retries its beacon is billed twice, a consumer reads an impression the counters do not hold yet, a
lost acknowledgement or a leader failover duplicates or drops the event, and a broker that does not
answer loses it.

- The record key is the **campaign id**.
- Claim \`beacon:{beacon_id}\` with \`SET NX EX DEDUPE_TTL_S\` first; a duplicate counts and produces
  nothing and returns \`True\`.
- **Count first**: \`store.count_render\` before the produce.
- The producer is **idempotent** with **\`acks=all\`** (confluent-kafka-go in Go).
- **Wait for the ack**, at most 2 s; if it does not come or the delivery fails, call
  \`store.insert_outbox(topic, key, payload)\` and return \`False\`.`,
  sequence: {
    participants: ['Page', 'Ad Server', 'Redis', 'ads.impression', 'Outbox'],
    messages: [
      {from: 'Page', to: 'Ad Server', label: 'render beacon · beacon_id · campaign_id', kind: 'sync'},
      {from: 'Ad Server', to: 'Redis', label: 'SET beacon:{id} NX EX 86400 · duplicate → done', kind: 'sync'},
      {from: 'Ad Server', to: 'Redis', label: 'count_render: HINCRBY render:{campaign}', kind: 'sync'},
      {
        from: 'Ad Server',
        to: 'ads.impression',
        label: 'produce key = campaign_id · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'ads.impression', to: 'Ad Server', label: 'ack within 2 s → True', kind: 'reply'},
      {from: 'Ad Server', to: 'Outbox', label: 'no ack / failed → insert_outbox · False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'campaign-key',
      title: 'Keys ads.impression by the campaign id',
      detail:
        'Three impressions for c-1, c-2, c-1 carry those keys and the two c-1 events share a partition, so a per-campaign consumer sees them in order. The starter keys by user, which spreads one campaign over every partition.',
      match: {
        python: {all: [/producer\.produce\(\s*[^\n]*key\s*=\s*beacon\[["']campaign_id["']\]/]},
        typescript: {all: [/key:\s*beacon\.campaign_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*b\.CampaignID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"ads\.impression")\s*,\s*beacon\.campaignId\s*,/]},
        cpp: {all: [/b\.campaign_id\.c_str\(\)\s*,\s*b\.campaign_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'dedupe-beacon',
      title: 'Counts a retried beacon once',
      detail:
        'The beacon id is claimed with a set-if-absent write that expires after `DEDUPE_TTL_S`; a second delivery of the same beacon counts nothing, produces nothing and returns true. The starter counts every delivery.',
      match: {
        python: {all: [/\.set\([^\n]*nx\s*=\s*True/, /ex\s*=\s*DEDUPE_TTL_S/]},
        typescript: {all: [/['"]NX['"]/, /['"]EX['"],\s*DEDUPE_TTL_S/]},
        go: {all: [/rdb\.SetNX\(|SetArgs\{[^}]*Mode:\s*"NX"/, /dedupeTTL/]},
        scala: {all: [/\.nx\(\)/, /\.ex\(\s*DedupeTtlS/]},
        cpp: {all: [/UpdateType::NOT_EXIST/, /kDedupeTtl/]},
      },
    },
    {
      id: 'commit-before-produce',
      title: 'Counts the render before producing its event',
      detail:
        'When `render:{campaign_id}` is written the topic is still empty: a consumer that reads the event finds the counters already holding it. The starter produces first.',
      match: {
        python: {order: [/store\.count_render\(/, /producer\.produce\(/]},
        typescript: {order: [/await countRender\(/, /producer\.send\(/]},
        go: {order: [/store\.CountRender\(/, /producer\.Produce\(/]},
        scala: {order: [/Store\.countRender\(/, /producer\.send\(/]},
        cpp: {order: [/store::countRender\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the ack and falls back to the outbox',
      detail:
        'A failed delivery, or no acknowledgement within 2 s, leaves an outbox row with the topic, the campaign key and the payload, and the call returns false; the render stays counted. The starter fires and forgets.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /producer\.flush\(/, /on_delivery\s*=/]},
        typescript: {all: [/await insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/, /Failure|catch|isFailure/]},
        cpp: {all: [/store::insertOutbox\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from confluent_kafka import Producer

from ads import store  # store.count_render, store.insert_outbox

TOPIC = "ads.impression"
DEDUPE_TTL_S = 86_400

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def beacon_key(beacon_id: str) -> str:
    return f"beacon:{beacon_id}"


def impression_payload(beacon: dict) -> dict:
    return {key: beacon[key] for key in ("beacon_id", "campaign_id", "creative_id", "price_micros")}


def record_impression(beacon: dict) -> bool:
    """Count a rendered impression and publish it; True once the event is on ads.impression."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = impression_payload(beacon)
    producer.produce(TOPIC, key=beacon["user_hash"], value=json.dumps(payload))
    producer.poll(0)
    store.count_render(beacon["campaign_id"], beacon["price_micros"])
    return True
`,
      solution: `import json

import redis
from confluent_kafka import Producer

from ads import store  # store.count_render, store.insert_outbox

TOPIC = "ads.impression"
DEDUPE_TTL_S = 86_400
ACK_TIMEOUT_S = 2

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def beacon_key(beacon_id: str) -> str:
    return f"beacon:{beacon_id}"


def impression_payload(beacon: dict) -> dict:
    return {key: beacon[key] for key in ("beacon_id", "campaign_id", "creative_id", "price_micros")}


def record_impression(beacon: dict) -> bool:
    """Count a rendered impression and publish it; True once the event is on ads.impression."""
    # The first delivery of a beacon claims it; a page that retries its beacon is billed once.
    if not r.set(beacon_key(beacon["beacon_id"]), 1, nx=True, ex=DEDUPE_TTL_S):
        return True
    # The count is committed before its event exists: a consumer never reads an impression the counters lack.
    store.count_render(beacon["campaign_id"], beacon["price_micros"])
    payload = impression_payload(beacon)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=beacon["campaign_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the report is late, not wrong.
        store.insert_outbox(TOPIC, beacon["campaign_id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {type Beacon, countRender, insertOutbox} from 'ads/store';

export const TOPIC = 'ads.impression';
export const DEDUPE_TTL_S = 86400;

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'adserved', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export const beaconKey = (beaconId: string): string => \`beacon:\${beaconId}\`;

export function impressionPayload(beacon: Beacon) {
  return {beacon_id: beacon.beacon_id, campaign_id: beacon.campaign_id, creative_id: beacon.creative_id, price_micros: beacon.price_micros};
}

/** Count a rendered impression and publish it; true once the event is on ads.impression. */
export async function recordImpression(beacon: Beacon): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = impressionPayload(beacon);
  void producer.send({topic: TOPIC, messages: [{key: beacon.user_hash, value: JSON.stringify(payload)}], acks: 1});
  await countRender(beacon.campaign_id, beacon.price_micros);
  return true;
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {type Beacon, countRender, insertOutbox} from 'ads/store';

export const TOPIC = 'ads.impression';
export const DEDUPE_TTL_S = 86400;
export const ACK_TIMEOUT_MS = 2000;

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'adserved', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

export const beaconKey = (beaconId: string): string => \`beacon:\${beaconId}\`;

export function impressionPayload(beacon: Beacon) {
  return {beacon_id: beacon.beacon_id, campaign_id: beacon.campaign_id, creative_id: beacon.creative_id, price_micros: beacon.price_micros};
}

/** Count a rendered impression and publish it; true once the event is on ads.impression. */
export async function recordImpression(beacon: Beacon): Promise<boolean> {
  // The first delivery of a beacon claims it; a page that retries its beacon is billed once.
  const claimed = await redis.set(beaconKey(beacon.beacon_id), '1', 'EX', DEDUPE_TTL_S, 'NX');
  if (claimed === null) return true;
  // The count is committed before its event exists: a consumer never reads an impression the counters lack.
  await countRender(beacon.campaign_id, beacon.price_micros);
  const payload = impressionPayload(beacon);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: beacon.campaign_id, value: JSON.stringify(payload)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the report is late, not wrong.
    await insertOutbox(TOPIC, beacon.campaign_id, payload);
    return false;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"

	"ads/store" // store.Beacon, store.CountRender, store.InsertOutbox
)

const (
	topic     = "ads.impression"
	dedupeTTL = 24 * time.Hour
)

var (
	rdb      = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	producer = newProducer()
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func beaconKey(beaconID string) string { return "beacon:" + beaconID }

func impressionPayload(b store.Beacon) map[string]any {
	return map[string]any{"beacon_id": b.BeaconID, "campaign_id": b.CampaignID, "creative_id": b.CreativeID, "price_micros": b.PriceMicros}
}

// recordImpression counts a rendered impression and publishes it; true once the event is on ads.impression.
func recordImpression(ctx context.Context, b store.Beacon) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(impressionPayload(b))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(b.UserHash), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	if err := store.CountRender(ctx, b.CampaignID, b.PriceMicros); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"

	"ads/store" // store.Beacon, store.CountRender, store.InsertOutbox
)

const (
	topic      = "ads.impression"
	dedupeTTL  = 24 * time.Hour
	ackTimeout = 2 * time.Second
)

var (
	rdb      = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	producer = newProducer()
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

func beaconKey(beaconID string) string { return "beacon:" + beaconID }

func impressionPayload(b store.Beacon) map[string]any {
	return map[string]any{"beacon_id": b.BeaconID, "campaign_id": b.CampaignID, "creative_id": b.CreativeID, "price_micros": b.PriceMicros}
}

// recordImpression counts a rendered impression and publishes it; true once the event is on ads.impression.
func recordImpression(ctx context.Context, b store.Beacon) (bool, error) {
	// The first delivery of a beacon claims it; a page that retries its beacon is billed once.
	first, err := rdb.SetNX(ctx, beaconKey(b.BeaconID), 1, dedupeTTL).Result()
	if err != nil {
		return false, err
	}
	if !first {
		return true, nil
	}
	// The count is committed before its event exists: a consumer never reads an impression the counters lack.
	if err := store.CountRender(ctx, b.CampaignID, b.PriceMicros); err != nil {
		return false, err
	}
	payload := impressionPayload(b)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(b.CampaignID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err = producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no acknowledgement within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the report is late, not wrong.
		if err := store.InsertOutbox(ctx, topic, b.CampaignID, payload); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._

import ads.Store // Store.Beacon, Store.countRender, Store.insertOutbox

object Events {
  val Topic = "ads.impression"
  val DedupeTtlS = 86400L

  private val jedis = new JedisPooled("redis", 6379)

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def beaconKey(beaconId: String): String = s"beacon:$beaconId"

  def impressionPayload(beacon: Store.Beacon): JsObject =
    JsObject(
      "beacon_id" -> JsString(beacon.beaconId),
      "campaign_id" -> JsString(beacon.campaignId),
      "creative_id" -> JsString(beacon.creativeId),
      "price_micros" -> JsNumber(beacon.priceMicros)
    )

  /** Count a rendered impression and publish it; true once the event is on ads.impression. */
  def recordImpression(beacon: Store.Beacon): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = impressionPayload(beacon)
    producer.send(new ProducerRecord[String, String](Topic, beacon.userHash, payload.compactPrint))
    Store.countRender(beacon.campaignId, beacon.priceMicros)
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import ads.Store // Store.Beacon, Store.countRender, Store.insertOutbox

object Events {
  val Topic = "ads.impression"
  val DedupeTtlS = 86400L
  val AckTimeoutMs = 2000L

  private val jedis = new JedisPooled("redis", 6379)

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def beaconKey(beaconId: String): String = s"beacon:$beaconId"

  def impressionPayload(beacon: Store.Beacon): JsObject =
    JsObject(
      "beacon_id" -> JsString(beacon.beaconId),
      "campaign_id" -> JsString(beacon.campaignId),
      "creative_id" -> JsString(beacon.creativeId),
      "price_micros" -> JsNumber(beacon.priceMicros)
    )

  /** Count a rendered impression and publish it; true once the event is on ads.impression. */
  def recordImpression(beacon: Store.Beacon): Boolean = {
    // The first delivery of a beacon claims it; a page that retries its beacon is billed once.
    val first = jedis.set(beaconKey(beacon.beaconId), "1", SetParams.setParams().nx().ex(DedupeTtlS)) != null
    if (!first) true
    else {
      // The count is committed before its event exists: a consumer never reads an impression the counters lack.
      Store.countRender(beacon.campaignId, beacon.priceMicros)
      val payload = impressionPayload(beacon)
      val record = new ProducerRecord[String, String](Topic, beacon.campaignId, payload.compactPrint)
      val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
      if (acked.isFailure) {
        // The broker did not take it: the relay publishes the row later, so the report is late, not wrong.
        Store.insertOutbox(Topic, beacon.campaignId, payload)
      }
      acked.isSuccess
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <string>

#include "ads/store.h"  // store::Beacon, store::countRender, store::insertOutbox

using json = nlohmann::json;

const std::string kTopic = "ads.impression";
constexpr long long kDedupeTtlS = 86400;

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

std::string beaconKey(const std::string& beacon_id) { return "beacon:" + beacon_id; }

json impressionPayload(const store::Beacon& b) {
  return json{{"beacon_id", b.beacon_id}, {"campaign_id", b.campaign_id}, {"creative_id", b.creative_id}, {"price_micros", b.price_micros}};
}

// Count a rendered impression and publish it; true once the event is on ads.impression.
bool recordImpression(const store::Beacon& b) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string value = impressionPayload(b).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    b.user_hash.c_str(), b.user_hash.size(), 0, nullptr);
  producer->poll(0);
  store::countRender(b.campaign_id, b.price_micros);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <memory>
#include <string>

#include "ads/store.h"  // store::Beacon, store::countRender, store::insertOutbox

using json = nlohmann::json;

const std::string kTopic = "ads.impression";
constexpr long long kDedupeTtlS = 86400;
constexpr int kAckTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report of the record in flight: recordImpression produces one record and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

std::string beaconKey(const std::string& beacon_id) { return "beacon:" + beacon_id; }

json impressionPayload(const store::Beacon& b) {
  return json{{"beacon_id", b.beacon_id}, {"campaign_id", b.campaign_id}, {"creative_id", b.creative_id}, {"price_micros", b.price_micros}};
}

// Count a rendered impression and publish it; true once the event is on ads.impression.
bool recordImpression(const store::Beacon& b) {
  // The first delivery of a beacon claims it; a page that retries its beacon is billed once.
  if (!redis.set(beaconKey(b.beacon_id), "1", std::chrono::seconds(kDedupeTtlS), sw::redis::UpdateType::NOT_EXIST)) return true;
  // The count is committed before its event exists: a consumer never reads an impression the counters lack.
  store::countRender(b.campaign_id, b.price_micros);
  const json payload = impressionPayload(b);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), b.campaign_id.c_str(), b.campaign_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the report is late, not wrong.
    store::insertOutbox(kTopic, b.campaign_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "ads.impression"


def _beacon(n, campaign="c-1"):
    return {"beacon_id": f"b-{n}", "campaign_id": campaign, "creative_id": f"cr-{campaign}", "user_hash": f"u-{n}", "price_micros": 1500}


def _rendered(ctx, campaign="c-1"):
    raw = ctx.redis.hgetall(f"render:{campaign}")
    return {"impressions": int(raw.get("impressions", 0)), "spend_micros": int(raw.get("spend_micros", 0))}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_campaign_key(ctx):
    m = ctx.load("events")
    m.record_impression(_beacon(1, "c-1"))
    m.record_impression(_beacon(2, "c-2"))
    m.record_impression(_beacon(3, "c-1"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three rendered beacons produced {len(records)} records on ads.impression (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"c-1", b"c-2", b"c-1"], f"the records are keyed {keys}, expected the campaign ids c-1, c-2, c-1"
    assert records[0].partition == records[2].partition, "both c-1 impressions must land on one partition, or a per-campaign consumer sees them out of order"


def check_dedupe_beacon(ctx):
    m = ctx.load("events")
    assert m.record_impression(_beacon(1)) is True, "the first delivery of beacon b-1 must be recorded"
    again = m.record_impression(_beacon(1))  # the page retried its beacon
    assert again is True, f"a retried beacon answered {again!r}, expected True: it was already recorded"
    assert _rendered(ctx) == {"impressions": 1, "spend_micros": 1500}, f"one beacon delivered twice left render:c-1 at {_rendered(ctx)}: the advertiser is billed twice for one impression"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"one beacon delivered twice produced {len(ctx.kafka.records(TOPIC))} events"
    ttl = ctx.redis.ttl("beacon:b-1")
    assert 86000 <= ttl <= 86400, f"beacon:b-1 has TTL {ttl}, expected DEDUPE_TTL_S = 86400: a claim with no expiry grows Redis forever"


def check_commit_before_produce(ctx):
    m = ctx.load("events")
    probe = ctx.redis_after("render:c-1", lambda: len(ctx.kafka.records(TOPIC)))
    m.record_impression(_beacon(1))
    assert probe.fired, "record_impression never counted the render (no write to render:c-1)"
    assert probe.result == 0, f"when the render was counted the topic already held {probe.result} event(s): a consumer read an impression the counters did not hold. Count first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the count"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.record_impression(_beacon(1))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the impression twice. Enable idempotence"
    m.record_impression(_beacon(2))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.record_impression(_beacon(1))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the impression never reaches the delivery report"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "c-1" and rows[0].get("payload", {}).get("beacon_id") == "b-1", f"the outbox row is {rows[0]}, expected the topic, the key c-1 and the payload"
    assert ok is False, f"record_impression returned {ok!r} after a failed delivery, expected False"
    assert _rendered(ctx)["impressions"] == 1, "the render must stay counted when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.record_impression(_beacon(2))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"record_impression waited {waited:.0f} s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("beacon_id") == "b-2", f"no acknowledgement within the window and the outbox holds {rows}"
    assert ok is False, f"record_impression returned {ok!r} without an acknowledgement, expected False"
`,
    typescript: `const TOPIC = 'ads.impression';

const beacon = (n: number, campaign = 'c-1') => ({
  beacon_id: \`b-\${n}\`,
  campaign_id: campaign,
  creative_id: \`cr-\${campaign}\`,
  user_hash: \`u-\${n}\`,
  price_micros: 1500,
});

function rendered(ctx, campaign = 'c-1') {
  const raw = ctx.redis.hgetall(\`render:\${campaign}\`);
  return {impressions: Number(raw.impressions ?? 0), spend_micros: Number(raw.spend_micros ?? 0)};
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_campaign_key(ctx) {
  const m = ctx.load('events');
  await m.recordImpression(beacon(1, 'c-1'));
  await m.recordImpression(beacon(2, 'c-2'));
  await m.recordImpression(beacon(3, 'c-1'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three rendered beacons produced \${records.length} records on ads.impression\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['c-1', 'c-2', 'c-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the campaign ids c-1, c-2, c-1\`);
  assert.equal(records[0].partition, records[2].partition, 'both c-1 impressions must land on one partition, or a per-campaign consumer sees them out of order');
}

export async function check_dedupe_beacon(ctx) {
  const m = ctx.load('events');
  assert.equal(await m.recordImpression(beacon(1)), true, 'the first delivery of beacon b-1 must be recorded');
  const again = await m.recordImpression(beacon(1)); // the page retried its beacon
  await settle();
  assert.equal(again, true, \`a retried beacon answered \${JSON.stringify(again)}, expected true: it was already recorded\`);
  assert.deepStrictEqual(rendered(ctx), {impressions: 1, spend_micros: 1500}, \`one beacon delivered twice left render:c-1 at \${JSON.stringify(rendered(ctx))}: the advertiser is billed twice for one impression\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`one beacon delivered twice produced \${ctx.kafka.records(TOPIC).length} events\`);
  const ttl = ctx.redis.ttl('beacon:b-1');
  assert(86000 <= ttl && ttl <= 86400, \`beacon:b-1 has TTL \${ttl}, expected DEDUPE_TTL_S = 86400: a claim with no expiry grows Redis forever\`);
}

export async function check_commit_before_produce(ctx) {
  const m = ctx.load('events');
  const probe = ctx.redisAfter('render:c-1', () => ctx.kafka.records(TOPIC).length);
  await m.recordImpression(beacon(1));
  await settle();
  assert(probe.fired, 'recordImpression never counted the render (no write to render:c-1)');
  assert.equal(probe.result, 0, \`when the render was counted the topic already held \${probe.result} event(s): a consumer read an impression the counters did not hold. Count first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the count');
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.recordImpression(beacon(1));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the impression twice. Enable idempotence\`);
  await m.recordImpression(beacon(2));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.recordImpression(beacon(1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the impression never reaches the delivery report\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'c-1' && rows[0].payload?.beacon_id === 'b-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key c-1 and the payload\`);
  assert.equal(ok, false, \`recordImpression resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert.equal(rendered(ctx).impressions, 1, 'the render must stay counted when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.recordImpression(beacon(2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`recordImpression waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.beacon_id === 'b-2', \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`recordImpression resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"ads/store"

	"leetbuild/harness"
)

const eventsTopic = "ads.impression"

func eventsBeacon(n int, campaign string) store.Beacon {
	return store.Beacon{BeaconID: fmt.Sprintf("b-%d", n), CampaignID: campaign, CreativeID: "cr-" + campaign, UserHash: fmt.Sprintf("u-%d", n), PriceMicros: 1500}
}

func eventsRecord(ctx *harness.Ctx, b store.Beacon) bool {
	ok, err := recordImpression(context.Background(), b)
	ctx.NoError(err, "recordImpression(%s)", b.BeaconID)
	return ok
}

func eventsRendered(ctx *harness.Ctx) store.Rendered {
	raw := ctx.Redis.HGetAll("render:c-1")
	impressions, _ := strconv.ParseInt(raw["impressions"], 10, 64)
	spend, _ := strconv.ParseInt(raw["spend_micros"], 10, 64)
	return store.Rendered{Impressions: impressions, SpendMicros: spend}
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	var rows []eventsRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row eventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckCampaignKey(ctx *harness.Ctx) {
	eventsRecord(ctx, eventsBeacon(1, "c-1"))
	eventsRecord(ctx, eventsBeacon(2, "c-2"))
	eventsRecord(ctx, eventsBeacon(3, "c-1"))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three rendered beacons must produce three records on ads.impression; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"c-1", "c-2", "c-1"}, "the records must be keyed by the campaign ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both c-1 impressions must land on one partition, or a per-campaign consumer sees them out of order; the partitions")
}

func CheckDedupeBeacon(ctx *harness.Ctx) {
	ctx.Equal(eventsRecord(ctx, eventsBeacon(1, "c-1")), true, "the first delivery of beacon b-1 must be recorded")
	again := eventsRecord(ctx, eventsBeacon(1, "c-1")) // the page retried its beacon
	ctx.Settle()
	ctx.Equal(again, true, "a retried beacon was already recorded; its result")
	ctx.Equal(eventsRendered(ctx), store.Rendered{Impressions: 1, SpendMicros: 1500}, "one beacon delivered twice must be billed once; render:c-1")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "one beacon delivered twice must produce one event; the records")
	ttl := ctx.Redis.TTL("beacon:b-1")
	ctx.Assert(86000 <= ttl && ttl <= 86400, "beacon:b-1 has TTL %d, expected 24 h: a claim with no expiry grows Redis forever", ttl)
}

func CheckCommitBeforeProduce(ctx *harness.Ctx) {
	probe := ctx.Redis.After("render:c-1", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	eventsRecord(ctx, eventsBeacon(1, "c-1"))
	ctx.Settle()
	ctx.Assert(probe.Fired, "recordImpression never counted the render (no write to render:c-1)")
	ctx.Equal(probe.Result, 0, "when the render was counted the topic already held events: a consumer read an impression the counters did not hold. Count first, then produce; the records at count time")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the count; the records")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsRecord(ctx, eventsBeacon(1, "c-1"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the impression twice (enable.idempotence); the records")
	eventsRecord(ctx, eventsBeacon(2, "c-1"))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsRecord(ctx, eventsBeacon(1, "c-1"))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the impression never reaches the delivery report; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "c-1" && rows[0].Payload["beacon_id"] == "b-1", "the outbox row is %v, expected the topic, the key c-1 and the payload", rows[0])
	ctx.Equal(ok, false, "recordImpression's result after a failed delivery")
	ctx.Equal(eventsRendered(ctx).Impressions, 1, "the render must stay counted when only the produce failed; the impressions")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsRecord(ctx, eventsBeacon(2, "c-1"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "recordImpression waited %.0f s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["beacon_id"] == "b-2", "no acknowledgement within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "recordImpression's result without an acknowledgement")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "ads/store.h"

namespace {

const std::string kEventsTopic = "ads.impression";

store::Beacon eventsBeacon(int n, const std::string& campaign = "c-1") {
  return store::Beacon{"b-" + std::to_string(n), campaign, "cr-" + campaign, "u-" + std::to_string(n), 1500};
}

long long eventsImpressions(harness::Ctx& ctx) {
  const auto value = ctx.Redis.HGet("render:c-1", "impressions");
  return value ? std::stoll(*value) : 0;
}

long long eventsSpend(harness::Ctx& ctx) {
  const auto value = ctx.Redis.HGet("render:c-1", "spend_micros");
  return value ? std::stoll(*value) : 0;
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

std::string eventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckCampaignKey(harness::Ctx& ctx) {
  recordImpression(eventsBeacon(1, "c-1"));
  recordImpression(eventsBeacon(2, "c-2"));
  recordImpression(eventsBeacon(3, "c-1"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three rendered beacons must produce three records on ads.impression; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"c-1", "c-2", "c-1"}, "the records must be keyed by the campaign ids");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "both c-1 impressions must land on one partition, or a per-campaign consumer sees them out of order; the partitions");
}

void CheckDedupeBeacon(harness::Ctx& ctx) {
  ctx.Equal(recordImpression(eventsBeacon(1)), true, "the first delivery of beacon b-1 must be recorded");
  const bool again = recordImpression(eventsBeacon(1));  // the page retried its beacon
  ctx.Settle();
  ctx.Equal(again, true, "a retried beacon was already recorded; its result");
  ctx.Equal(eventsImpressions(ctx), 1, "one beacon delivered twice must be billed once; render:c-1 impressions");
  ctx.Equal(eventsSpend(ctx), 1500, "one beacon delivered twice must be billed once; render:c-1 spend_micros");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "one beacon delivered twice must produce one event; the records");
  const long long ttl = ctx.Redis.TTL("beacon:b-1");
  ctx.Assert(86000 <= ttl && ttl <= 86400, "beacon:b-1 has TTL %d, expected kDedupeTtlS = 86400: a claim with no expiry grows Redis forever", ttl);
}

void CheckCommitBeforeProduce(harness::Ctx& ctx) {
  size_t atCount = 999;
  bool fired = false;
  ctx.Redis.After("render:c-1", [&] {
    fired = true;
    atCount = ctx.Kafka.Records(kEventsTopic).size();
  });
  recordImpression(eventsBeacon(1));
  ctx.Settle();
  ctx.Assert(fired, "recordImpression never counted the render (no write to render:c-1)");
  ctx.Equal(atCount, 0,
            "when the render was counted the topic already held events: a consumer read an impression the counters did not hold. "
            "Count first, then produce; the records at count time");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "the event must still be produced after the count; the records");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  recordImpression(eventsBeacon(1));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the impression twice (enable.idempotence); the records");
  recordImpression(eventsBeacon(2));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = recordImpression(eventsBeacon(1));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the impression never reaches the delivery report; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == "c-1" && rows[0].contains("payload") &&
                 eventsField(rows[0]["payload"], "beacon_id") == "b-1",
             "the outbox row is %s, expected the topic, the key c-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "recordImpression's result after a failed delivery");
  ctx.Equal(eventsImpressions(ctx), 1, "the render must stay counted when only the produce failed; the impressions");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = recordImpression(eventsBeacon(2));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "recordImpression waited %.0f s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "beacon_id") == "b-2",
             "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "recordImpression's result without an acknowledgement");
}
`,
  },
  hints: [
    'Send the same beacon twice and the campaign is billed for two impressions; a per-campaign consumer sees its impressions out of order; stall the broker and the impression is gone from every report.',
    'Partition order holds per key, so whatever is the key stays ordered; nothing remembers a beacon id; the produce is fired and forgotten before the count, on a producer that waits for one replica.',
    'Key by `campaign_id`; `SET beacon:{id} NX EX DEDUPE_TTL_S` and return on a duplicate; `count_render` first; idempotent producer with `acks=all`; wait for the delivery report at most 2 s, else `insert_outbox` and return `False`.',
  ],
  debrief: `Counting at render is what an advertiser pays for, and a beacon is an at-least-once message from a browser: the set-if-absent claim is what turns its retries into one impression. The count commits before the event so the topic never says more than the counters, and the outbox turns a broker outage into a delay instead of a hole in the bill. The campaign key is an ordering contract for every consumer that aggregates per campaign. Production pipelines write the outbox row in the same transaction as the count and let a relay do every produce, sign beacons so a client cannot forge one, and keep the dedupe window at least as long as a page can retry.`,
};
