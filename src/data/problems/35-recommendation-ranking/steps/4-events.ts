import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Impression events keyed by user, with positions and an outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'analytics'],
  task: `## Task

**Starting point.** The starter is \`publish_impression(tenant, user_id, surface, ranked)\`, the record
offline evaluation reads for every served list (\`ranked\` is the \`rank\` result): it builds
\`{tenant, user_id, surface, model_version, items}\` from the ranked items, produces it to
\`recsys.impression\` keyed by surface, and writes an outbox row (\`store.outbox_insert\`) when
\`produce\` raises. It serves the demo and hides four flaws.

**Failure mode the checks target.** Every impression of a surface lands on one partition; the event
says what scored the list but not where each item sat or whether the list was the fallback; a lost
acknowledgement writes the impression twice and a failover loses one only the leader had; and a
broker that rejects the record, or never answers, loses the impression, because only a local enqueue
error reaches the outbox.

- Key the record by the **user id**.
- The payload is \`{tenant, user_id, surface, model_version, fallback, items: [{id, position}]}\`:
  positions zero-based in served order, no scores.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent: true\` with \`acks: -1\`; the Go
  code uses confluent-kafka-go, whose producer supports \`enable.idempotence\`).
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` = 2 s; a failed delivery or no report writes
  the outbox row and returns false.`,
  sequence: {
    participants: ['Recommendation API', 'recsys.impression', 'Outbox', 'Offline evaluation'],
    messages: [
      {
        from: 'Recommendation API',
        to: 'recsys.impression',
        label: 'produce · key = user_id · acks = all · idempotent',
        kind: 'sync',
      },
      {from: 'recsys.impression', to: 'Recommendation API', label: 'delivery report within 2 s', kind: 'reply'},
      {from: 'Recommendation API', to: 'Outbox', label: 'failed or no report → RPUSH outbox', kind: 'sync'},
      {
        from: 'recsys.impression',
        to: 'Offline evaluation',
        label: '{items [{id, position}], model_version, fallback}',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'user-key',
      title: 'Keyed by user id',
      detail:
        "The record key is the user id (`key=user_id`, `key: userId`, `[]byte(userID)`, `ProducerRecord(topic, userId, …)`), so one user's impressions stay in order on one partition and the traffic spreads; the starter keys by surface.",
      match: {
        python: {all: [/key=user_id/], none: [/key=surface/]},
        typescript: {all: [/key:\s*userId\b/], none: [/key:\s*surface\b/]},
        go: {all: [/Key:\s*\[\]byte\(userID\)/], none: [/Key:\s*\[\]byte\(surface\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*userId/], none: [/Topic,\s*surface/]},
        cpp: {all: [/user_id\.c_str\(\),\s*user_id\.size\(\)/], none: [/surface\.c_str\(\)/]},
      },
    },
    {
      id: 'impression-payload',
      title: 'Carries positions, the version and the fallback flag',
      detail:
        'Each item is `{id, position}` with its zero-based position in the served list, and the event carries `model_version` and `fallback`; the starter copies the scored items and drops the flag, so a click cannot be credited to a slot or a degraded list told apart.',
      match: {
        python: {
          all: [/"position":\s*position/, /"fallback":\s*ranked\["fallback"\]/],
          none: [/"items":\s*ranked\["items"\]/],
        },
        typescript: {all: [/position\b/, /fallback:\s*ranked\.fallback/], none: [/items:\s*ranked\.items\s*[,}]/]},
        go: {all: [/"position":\s*position/, /"fallback":\s*ranked\.Fallback/], none: [/"items":\s*ranked\.Items/]},
        scala: {all: [/"position"\s*->/, /"fallback"\s*->\s*JsBoolean\(ranked\.fallback\)/], none: [/"score"\s*->/]},
        cpp: {all: [/\{"position",\s*position\}/, /\{"fallback",\s*ranked\.fallback\}/], none: [/\{"score",/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer has idempotence on and `acks=all`, so a retry after a lost acknowledgement writes the impression once and a leader failover cannot lose one; the starter acknowledges on the leader alone.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'The outcome comes from the request’s own delivery report (`on_delivery`, an awaited `send`, the delivery channel, `dr_cb`, the send future), waited for at most 2 s; a failure or no report writes the outbox row. A report that arrives after its request gave up must neither be read as a later request’s outcome nor hold up the reports after it. The starter catches only the local enqueue error, which a broker rejection never raises.',
      match: {
        python: {
          all: [/store\.outbox_insert\(/, /on_delivery\s*=/, /producer\.flush\(/],
          none: [/except KafkaException/],
        },
        typescript: {all: [/await producer\.send\(/, /outboxInsert\(/], none: [/void producer\.send\(/]},
        go: {
          all: [/TopicPartition\.Error/, /store\.OutboxInsert\(/, /time\.After\(/],
          none: [/Produce\([^\n]*,\s*nil\)/],
        },
        scala: {all: [/\.get\(\s*AckTimeoutMs/, /Store\.outboxInsert\(/], none: [/case _: KafkaException/]},
        cpp: {all: [/dr_cb/, /store::outboxInsert\(/, /->flush\(/], none: [/->poll\(0\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from recs import store  # outbox_insert(topic, key, payload)

TOPIC = "recsys.impression"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_impression(tenant: str, user_id: str, surface: str, ranked: dict) -> bool:
    """Record what the user was shown; True once the broker has the impression."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = {
        "tenant": tenant,
        "user_id": user_id,
        "surface": surface,
        "model_version": ranked["model_version"],
        "items": ranked["items"],
    }
    try:
        producer.produce(TOPIC, key=surface, value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        store.outbox_insert(TOPIC, surface, payload)
        return False
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from recs import store  # outbox_insert(topic, key, payload)

TOPIC = "recsys.impression"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the impression before the broker answers
    "enable.idempotence": True,  # a send retried after a lost acknowledgement lands once
})


def impression_payload(tenant: str, user_id: str, surface: str, ranked: dict) -> dict:
    """What the user saw: each item at its slot, the version that ordered them, and whether that was the fallback."""
    return {
        "tenant": tenant,
        "user_id": user_id,
        "surface": surface,
        "model_version": ranked["model_version"],
        "fallback": ranked["fallback"],
        "items": [{"id": item["id"], "position": position} for position, item in enumerate(ranked["items"])],
    }


def publish_impression(tenant: str, user_id: str, surface: str, ranked: dict) -> bool:
    """Record what the user was shown; True once the broker has the impression."""
    payload = impression_payload(tenant, user_id, surface, ranked)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=user_id, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so the impression is late, not lost.
        store.outbox_insert(TOPIC, user_id, payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {outboxInsert} from 'recs/store';
import type {Ranked} from 'recs/types';

export const TOPIC = 'recsys.impression';

const kafka = new Kafka({clientId: 'recsvc', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Record what the user was shown; true once the broker has the impression. */
export async function publishImpression(tenant: string, userId: string, surface: string, ranked: Ranked): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = {tenant, user_id: userId, surface, model_version: ranked.model_version, items: ranked.items};
  try {
    void producer.send({topic: TOPIC, messages: [{key: surface, value: JSON.stringify(payload)}], acks: 1});
  } catch {
    await outboxInsert(TOPIC, surface, payload);
    return false;
  }
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {outboxInsert} from 'recs/store';
import type {Ranked} from 'recs/types';

export const TOPIC = 'recsys.impression';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'recsvc', brokers: ['kafka:9092']});
// Idempotent: a send retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What the user saw: each item at its slot, the version that ordered them, and whether that was the fallback. */
export function impressionPayload(tenant: string, userId: string, surface: string, ranked: Ranked) {
  return {
    tenant,
    user_id: userId,
    surface,
    model_version: ranked.model_version,
    fallback: ranked.fallback,
    items: ranked.items.map(({id}, position) => ({id, position})),
  };
}

/** Record what the user was shown; true once the broker has the impression. */
export async function publishImpression(tenant: string, userId: string, surface: string, ranked: Ranked): Promise<boolean> {
  const payload = impressionPayload(tenant, userId, surface, ranked);
  try {
    // acks: -1 (all): every in-sync replica has the impression before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: userId, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay produces the row later, so the impression is late, not lost.
    await outboxInsert(TOPIC, userId, payload);
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"recs/store" // store.OutboxInsert(ctx, topic, key, payload)
	"recs/types"
)

const topic = "recsys.impression"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// publishImpression records what the user was shown; true once the broker has the impression.
func publishImpression(ctx context.Context, tenant, userID, surface string, ranked types.Ranked) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload := map[string]any{
		"tenant":        tenant,
		"user_id":       userID,
		"surface":       surface,
		"model_version": ranked.ModelVersion,
		"items":         ranked.Items,
	}
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(surface), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, store.OutboxInsert(ctx, topic, surface, payload)
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

	"recs/store" // store.OutboxInsert(ctx, topic, key, payload)
	"recs/types"
)

const (
	topic      = "recsys.impression"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the impression before the broker answers
		"enable.idempotence": true,  // a send retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// impressionPayload is what the user saw: each item at its slot, the version that ordered them, and whether that was the fallback.
func impressionPayload(tenant, userID, surface string, ranked types.Ranked) map[string]any {
	items := make([]map[string]any, 0, len(ranked.Items))
	for position, item := range ranked.Items {
		items = append(items, map[string]any{"id": item.ID, "position": position})
	}
	return map[string]any{
		"tenant":        tenant,
		"user_id":       userID,
		"surface":       surface,
		"model_version": ranked.ModelVersion,
		"fallback":      ranked.Fallback,
		"items":         items,
	}
}

// publishImpression records what the user was shown; true once the broker has the impression.
func publishImpression(ctx context.Context, tenant, userID, surface string, ranked types.Ranked) (bool, error) {
	payload := impressionPayload(tenant, userID, surface, ranked)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(userID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay produces the row later, so the impression is late, not lost.
		return false, store.OutboxInsert(ctx, topic, userID, payload)
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import recs.{Ranked, Store}

object Events {
  val Topic = "recsys.impression"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Record what the user was shown; true once the broker has the impression. */
  def publishImpression(tenant: String, userId: String, surface: String, ranked: Ranked): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val items = JsArray(ranked.items.map(item => JsObject("id" -> JsString(item.id), "score" -> JsNumber(item.score))).toVector)
    val payload = JsObject(
      "tenant" -> JsString(tenant),
      "user_id" -> JsString(userId),
      "surface" -> JsString(surface),
      "model_version" -> JsString(ranked.modelVersion),
      "items" -> items
    )
    try {
      producer.send(new ProducerRecord[String, String](Topic, surface, payload.compactPrint))
      true
    } catch {
      case _: KafkaException =>
        Store.outboxInsert(Topic, surface, payload)
        false
    }
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import recs.{Ranked, Store}

object Events {
  val Topic = "recsys.impression"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the impression before the broker answers
    props.put("enable.idempotence", "true") // a send retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What the user saw: each item at its slot, the version that ordered them, and whether that was the fallback. */
  def impressionPayload(tenant: String, userId: String, surface: String, ranked: Ranked): JsObject = {
    val items = ranked.items.zipWithIndex.map { case (item, position) => JsObject("id" -> JsString(item.id), "position" -> JsNumber(position)) }
    JsObject(
      "tenant" -> JsString(tenant),
      "user_id" -> JsString(userId),
      "surface" -> JsString(surface),
      "model_version" -> JsString(ranked.modelVersion),
      "fallback" -> JsBoolean(ranked.fallback),
      "items" -> JsArray(items.toVector)
    )
  }

  /** Record what the user was shown; true once the broker has the impression. */
  def publishImpression(tenant: String, userId: String, surface: String, ranked: Ranked): Boolean = {
    val payload = impressionPayload(tenant, userId, surface, ranked)
    val record = new ProducerRecord[String, String](Topic, userId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay produces the row later, so the impression is late, not lost.
      Store.outboxInsert(Topic, userId, payload)
    }
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "recs/store.h"  // store::outboxInsert(topic, key, payload)
#include "recs/types.h"

using json = nlohmann::json;

const std::string kTopic = "recsys.impression";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Record what the user was shown; true once the broker has the impression.
bool publishImpression(const std::string& tenant, const std::string& user_id, const std::string& surface, const recs::Ranked& ranked) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  json items = json::array();
  for (const auto& item : ranked.items) items.push_back(json{{"id", item.id}, {"score", item.score}});
  const json payload{{"tenant", tenant}, {"user_id", user_id}, {"surface", surface}, {"model_version", ranked.model_version}, {"items", items}};
  const std::string value = payload.dump();
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                                   value.size(), surface.c_str(), surface.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store::outboxInsert(kTopic, surface, payload);
    return false;
  }
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <memory>
#include <string>

#include "recs/store.h"  // store::outboxInsert(topic, key, payload)
#include "recs/types.h"

using json = nlohmann::json;

const std::string kTopic = "recsys.impression";
constexpr int kAckTimeoutMs = 2000;

// One record's delivery outcome. Its report may be served by another publisher's flush, or arrive
// after this publisher gave up waiting.
struct Delivery {
  std::atomic<bool> reported{false};
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
};

// Hands each delivery report to its own record: the record's msg_opaque owns a reference to its outcome.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    auto* delivery = static_cast<std::shared_ptr<Delivery>*>(message.msg_opaque());
    (*delivery)->error = message.err();
    (*delivery)->reported.store(true, std::memory_order_release);
    delete delivery;
  }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the impression before the broker answers
  conf->set("enable.idempotence", "true", err);  // a send retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What the user saw: each item at its slot, the version that ordered them, and whether that was the fallback.
json impressionPayload(const std::string& tenant, const std::string& user_id, const std::string& surface, const recs::Ranked& ranked) {
  json items = json::array();
  for (size_t position = 0; position < ranked.items.size(); position++) {
    items.push_back(json{{"id", ranked.items[position].id}, {"position", position}});
  }
  return json{{"tenant", tenant},   {"user_id", user_id},           {"surface", surface},
              {"model_version", ranked.model_version}, {"fallback", ranked.fallback}, {"items", items}};
}

// Record what the user was shown; true once the broker has the impression.
bool publishImpression(const std::string& tenant, const std::string& user_id, const std::string& surface, const recs::Ranked& ranked) {
  const json payload = impressionPayload(tenant, user_id, surface, ranked);
  const std::string value = payload.dump();
  auto outcome = std::make_shared<Delivery>();
  auto* opaque = new std::shared_ptr<Delivery>(outcome);
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), user_id.c_str(), user_id.size(), 0, opaque);
  if (err != RdKafka::ERR_NO_ERROR) {
    delete opaque;  // never enqueued: no report will come for it
  } else {
    producer->flush(kAckTimeoutMs);  // serves the delivery reports, or gives up after the window
    err = outcome->reported.load(std::memory_order_acquire) ? outcome->error : RdKafka::ERR__TIMED_OUT;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so the impression is late, not lost.
    store::outboxInsert(kTopic, user_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "recsys.impression"
RANKED = {
    "items": [{"id": "c-2", "score": 0.74}, {"id": "c-4", "score": 0.47}, {"id": "c-1", "score": 0.37}],
    "model_version": "ranker-v7",
    "fallback": False,
}
DEGRADED = {"items": [{"id": "c-3", "score": 40.0}, {"id": "c-1", "score": 25.0}], "model_version": "popularity-v1", "fallback": True}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_user_key(ctx):
    m = ctx.load("events")
    m.publish_impression("t1", "u-1", "home", RANKED)
    m.publish_impression("t1", "u-2", "home", RANKED)
    m.publish_impression("t1", "u-1", "home", RANKED)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_impression calls produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"u-1", b"u-2", b"u-1"], f"the impressions are keyed {keys}, expected the user ids u-1, u-2, u-1: keyed by surface, every home impression lands on one partition"
    assert records[0].partition == records[2].partition, "both impressions of u-1 must land on one partition, or a consumer reads the user's history out of order"


def check_impression_payload(ctx):
    m = ctx.load("events")
    m.publish_impression("t1", "u-1", "home", DEGRADED)
    values = ctx.kafka.values(TOPIC)
    assert len(values) == 1, f"one publish_impression produced {len(values)} records"
    event = json.loads(values[0])
    assert event.get("tenant") == "t1" and event.get("user_id") == "u-1" and event.get("surface") == "home", f"the impression is {event}, expected tenant, user_id and surface"
    items = event.get("items")
    assert items == [{"id": "c-3", "position": 0}, {"id": "c-1", "position": 1}], f"the impression's items are {items}: each must be {{id, position}}, the zero-based slot the user saw it in, with no score"
    assert event.get("model_version") == "popularity-v1" and event.get("fallback") is True, f"the impression says model_version {event.get('model_version')!r}, fallback {event.get('fallback')!r}: offline evaluation must be able to leave the popularity order out of the model's numbers"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_impression("t1", "u-1", "home", RANKED)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the impression twice. Enable idempotence"
    m.publish_impression("t1", "u-2", "home", RANKED)
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost an impression only the leader had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_impression("t1", "u-1", "home", RANKED)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the impression is lost and the list never reaches offline evaluation"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "u-1" and rows[0].get("payload", {}).get("user_id") == "u-1", f"the outbox row is {rows[0]}, expected the topic, the key u-1 and the payload"
    assert ok is False, f"publish_impression returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_impression("t1", "u-2", "home", RANKED)
    waited = ctx.clock.time() - before
    assert waited <= 2.5, f"publish_impression waited {waited:.1f} s for a broker that does not answer: wait for the report at most ACK_TIMEOUT_S = 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("user_id") == "u-2", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_impression returned {ok!r} without a delivery report, expected False"
    # The broker answers again: the abandoned delivery report arrives, and must neither stall the
    # producer nor be read as another request's outcome.
    ctx.kafka.resume(TOPIC)
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_impression("t1", "u-3", "home", RANKED)
    rows = _outbox(ctx)
    assert len(rows) == 3 and rows[2].get("payload", {}).get("user_id") == "u-3" and ok is False, f"after the broker came back, u-3's delivery failed and publish_impression returned {ok!r} with the outbox holding {rows}: each request must read its own delivery report, not one left over from an earlier request"
    before = ctx.clock.time()
    ok = m.publish_impression("t1", "u-4", "home", RANKED)
    waited = ctx.clock.time() - before
    assert ok is True and len(_outbox(ctx)) == 3, f"after the broker came back, a healthy delivery of u-4 returned {ok!r} after {waited:.1f} s: an earlier request's abandoned delivery report must not block the producer's later reports"
`,
    typescript: `const TOPIC = 'recsys.impression';
const RANKED = {
  items: [
    {id: 'c-2', score: 0.74},
    {id: 'c-4', score: 0.47},
    {id: 'c-1', score: 0.37},
  ],
  model_version: 'ranker-v7',
  fallback: false,
};
const DEGRADED = {
  items: [
    {id: 'c-3', score: 40},
    {id: 'c-1', score: 25},
  ],
  model_version: 'popularity-v1',
  fallback: true,
};

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_user_key(ctx) {
  const m = ctx.load('events');
  await m.publishImpression('t1', 'u-1', 'home', RANKED);
  await m.publishImpression('t1', 'u-2', 'home', RANKED);
  await m.publishImpression('t1', 'u-1', 'home', RANKED);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishImpression calls produced \${records.length} records on \${TOPIC}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['u-1', 'u-2', 'u-1'], \`the impressions are keyed \${JSON.stringify(keys)}, expected the user ids u-1, u-2, u-1: keyed by surface, every home impression lands on one partition\`);
  assert.equal(records[0].partition, records[2].partition, "both impressions of u-1 must land on one partition, or a consumer reads the user's history out of order");
}

export async function check_impression_payload(ctx) {
  const m = ctx.load('events');
  await m.publishImpression('t1', 'u-1', 'home', DEGRADED);
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publishImpression produced \${values.length} records\`);
  const event = JSON.parse(values[0]);
  assert(event.tenant === 't1' && event.user_id === 'u-1' && event.surface === 'home', \`the impression is \${values[0]}, expected tenant, user_id and surface\`);
  assert.deepStrictEqual(event.items, [{id: 'c-3', position: 0}, {id: 'c-1', position: 1}], \`the impression's items are \${JSON.stringify(event.items)}: each must be {id, position}, the zero-based slot the user saw it in, with no score\`);
  assert(event.model_version === 'popularity-v1' && event.fallback === true, \`the impression says model_version \${JSON.stringify(event.model_version)}, fallback \${JSON.stringify(event.fallback)}: offline evaluation must be able to leave the popularity order out of the model's numbers\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishImpression('t1', 'u-1', 'home', RANKED);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the impression twice. Enable idempotence\`);
  await m.publishImpression('t1', 'u-2', 'home', RANKED);
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost an impression only the leader had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishImpression('t1', 'u-1', 'home', RANKED);
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the impression is lost and the list never reaches offline evaluation\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'u-1' && rows[0].payload?.user_id === 'u-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key u-1 and the payload\`);
  assert.equal(ok, false, \`publishImpression resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishImpression('t1', 'u-2', 'home', RANKED);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 2.5, \`publishImpression waited \${waited.toFixed(1)} s for a broker that does not answer: wait for the report at most ACK_TIMEOUT_MS = 2000, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.user_id === 'u-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishImpression resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
  // The broker answers again: the abandoned delivery report arrives, and must neither stall the
  // producer nor be read as another request's outcome.
  ctx.kafka.resume(TOPIC);
  await settle();
  ctx.kafka.failNext(TOPIC, 1);
  ok = await m.publishImpression('t1', 'u-3', 'home', RANKED);
  await settle();
  rows = outboxRows(ctx);
  assert(rows.length === 3 && rows[2].payload?.user_id === 'u-3' && ok === false, \`after the broker came back, u-3's delivery failed and publishImpression resolved \${JSON.stringify(ok)} with the outbox holding \${JSON.stringify(rows)}: each request must read its own delivery report, not one left over from an earlier request\`);
  const resumed = ctx.clock.now();
  ok = await m.publishImpression('t1', 'u-4', 'home', RANKED);
  await settle();
  assert(ok === true && outboxRows(ctx).length === 3, \`after the broker came back, a healthy delivery of u-4 resolved \${JSON.stringify(ok)} after \${((ctx.clock.now() - resumed) / 1000).toFixed(1)} s: an earlier request's abandoned delivery report must not block the producer's later reports\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"recs/types"

	"leetbuild/harness"
)

const eventsTopic = "recsys.impression"

var (
	eventsBg = context.Background()
	ranked   = types.Ranked{Items: []types.Item{{ID: "c-2", Score: 0.74}, {ID: "c-4", Score: 0.47}, {ID: "c-1", Score: 0.37}}, ModelVersion: "ranker-v7"}
	degraded = types.Ranked{Items: []types.Item{{ID: "c-3", Score: 40}, {ID: "c-1", Score: 25}}, ModelVersion: "popularity-v1", Fallback: true}
)

func publish(ctx *harness.Ctx, userID string, r types.Ranked) bool {
	ok, err := publishImpression(eventsBg, "t1", userID, "home", r)
	ctx.NoError(err, "publishImpression")
	return ok
}

type outboxRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func outboxRows(ctx *harness.Ctx) []outboxRow {
	var rows []outboxRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row outboxRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckUserKey(ctx *harness.Ctx) {
	publish(ctx, "u-1", ranked)
	publish(ctx, "u-2", ranked)
	publish(ctx, "u-1", ranked)
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three publishImpression calls must produce three records on recsys.impression; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"u-1", "u-2", "u-1"}, "the impressions must be keyed by the user ids (keyed by surface, every home impression lands on one partition)")
	ctx.Equal(records[0].Partition, records[2].Partition, "both impressions of u-1 must land on one partition, or a consumer reads the user's history out of order; the partitions")
}

func CheckImpressionPayload(ctx *harness.Ctx) {
	publish(ctx, "u-1", degraded)
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one publishImpression must produce one record; the records")
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the impression must be JSON")
	ctx.Assert(event["tenant"] == "t1" && event["user_id"] == "u-1" && event["surface"] == "home", "the impression is %s, expected tenant, user_id and surface", values[0])
	want := []any{map[string]any{"id": "c-3", "position": float64(0)}, map[string]any{"id": "c-1", "position": float64(1)}}
	ctx.Equal(event["items"], want, "each item must be {id, position}, the zero-based slot the user saw it in, with no score; the impression's items")
	ctx.Assert(event["model_version"] == "popularity-v1" && event["fallback"] == true, "the impression says model_version %v, fallback %v: offline evaluation must be able to leave the popularity order out of the model's numbers", event["model_version"], event["fallback"])
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	publish(ctx, "u-1", ranked)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the impression twice (enable.idempotence); the records")
	publish(ctx, "u-2", ranked)
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose an impression (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := publish(ctx, "u-1", ranked)
	ctx.Settle()
	rows := outboxRows(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the impression is lost and the list never reaches offline evaluation; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "u-1" && rows[0].Payload["user_id"] == "u-1", "the outbox row is %v, expected the topic, the key u-1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishImpression's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = publish(ctx, "u-2", ranked)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 2.5, "publishImpression waited %.1f s for a broker that does not answer: wait for the report at most ackTimeout = 2 s, then write the outbox row", waited)
	rows = outboxRows(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["user_id"] == "u-2", "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishImpression's result without a delivery report")
	// The broker answers again: the abandoned delivery report arrives, and must neither stall the
	// producer nor be read as another request's outcome.
	ctx.Kafka.Resume(eventsTopic)
	ctx.Settle()
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok = publish(ctx, "u-3", ranked)
	rows = outboxRows(ctx)
	ctx.Assert(len(rows) == 3 && rows[2].Payload["user_id"] == "u-3" && !ok, "after the broker came back, u-3's delivery failed and publishImpression answered %t with the outbox holding %v: each request must read its own delivery report, not one left over from an earlier request", ok, rows)
	before = ctx.Clock.Now()
	ok = publish(ctx, "u-4", ranked)
	waited = float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(ok && len(outboxRows(ctx)) == 3, "after the broker came back, a healthy delivery of u-4 answered %t after %.1f s: an earlier request's abandoned delivery report must not block the producer's later reports", ok, waited)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "recsys.impression";
const recs::Ranked kRanked{{{"c-2", 0.74}, {"c-4", 0.47}, {"c-1", 0.37}}, "ranker-v7", false};
const recs::Ranked kDegraded{{{"c-3", 40}, {"c-1", 25}}, "popularity-v1", true};

std::vector<nlohmann::json> outboxRows(harness::Ctx& ctx) {
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

void CheckUserKey(harness::Ctx& ctx) {
  publishImpression("t1", "u-1", "home", kRanked);
  publishImpression("t1", "u-2", "home", kRanked);
  publishImpression("t1", "u-1", "home", kRanked);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three publishImpression calls must produce three records on recsys.impression; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"u-1", "u-2", "u-1"}, "the impressions must be keyed by the user ids (keyed by surface, every home impression lands on one partition)");
  ctx.Equal(records[0].Partition, records[2].Partition, "both impressions of u-1 must land on one partition, or a consumer reads the user's history out of order; the partitions");
}

void CheckImpressionPayload(harness::Ctx& ctx) {
  publishImpression("t1", "u-1", "home", kDegraded);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one publishImpression must produce one record; the records");
  const auto event = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(field(event, "tenant") == "t1" && field(event, "user_id") == "u-1" && field(event, "surface") == "home", "the impression is %s, expected tenant, user_id and surface", values[0]);
  const nlohmann::json want = nlohmann::json::array({{{"id", "c-3"}, {"position", 0}}, {{"id", "c-1"}, {"position", 1}}});
  const nlohmann::json items = event.is_object() && event.contains("items") ? event["items"] : nlohmann::json();
  ctx.Assert(items == want, "the impression's items are %s: each must be {id, position}, the zero-based slot the user saw it in, with no score", items.dump());
  const bool fallback = event.is_object() && event.contains("fallback") && event["fallback"] == true;
  ctx.Assert(field(event, "model_version") == "popularity-v1" && fallback, "the impression is %s: offline evaluation needs model_version popularity-v1 and fallback true to leave the popularity order out of the model's numbers", values[0]);
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishImpression("t1", "u-1", "home", kRanked);
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the impression twice (enable.idempotence); the records");
  publishImpression("t1", "u-2", "home", kRanked);
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose an impression (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishImpression("t1", "u-1", "home", kRanked);
  ctx.Settle();
  auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the impression is lost and the list never reaches offline evaluation; the rows");
  ctx.Assert(field(rows[0], "topic") == kEventsTopic && field(rows[0], "key") == "u-1" && rows[0].contains("payload") && field(rows[0]["payload"], "user_id") == "u-1",
             "the outbox row is %s, expected the topic, the key u-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishImpression's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishImpression("t1", "u-2", "home", kRanked);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 2.5, "publishImpression waited %.1f s for a broker that does not answer: wait for the report at most kAckTimeout = 2 s, then write the outbox row", waited);
  rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && field(rows[1]["payload"], "user_id") == "u-2", "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishImpression's result without a delivery report");
  // The broker answers again: the abandoned delivery report arrives, and must neither stall the
  // producer nor be read as another request's outcome.
  ctx.Kafka.Resume(kEventsTopic);
  ctx.Settle();
  ctx.Kafka.FailNext(kEventsTopic, 1);
  ok = publishImpression("t1", "u-3", "home", kRanked);
  ctx.Settle();
  rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 3 && rows[2].contains("payload") && field(rows[2]["payload"], "user_id") == "u-3" && !ok,
             "after the broker came back, u-3's delivery failed and publishImpression answered %t with the outbox holding %d rows: each request must read its own delivery report, not one left over from an earlier request", ok, rows.size());
  const int64_t resumed = ctx.Clock.Now();
  ok = publishImpression("t1", "u-4", "home", kRanked);
  ctx.Settle();
  ctx.Assert(ok && outboxRows(ctx).size() == 3, "after the broker came back, a healthy delivery of u-4 answered %t after %.1f s: an earlier request's abandoned delivery report must not block the producer's later reports", ok,
             static_cast<double>(ctx.Clock.Now() - resumed) / 1000);
}
`,
  },
  hints: [
    'Watch the partitions while two users load the home page: every impression lands on one of them. Then fail one delivery: the call returns true and the impression is gone.',
    'The key is the surface, the payload copies the scored items and drops the flag, the producer acknowledges on the leader alone, and the try/except only sees an error raised before the record leaves the client.',
    'Key by `user_id`; build `items` as `{id, position}` with `fallback`; set `enable.idempotence` and `acks=all`; pass `on_delivery`, `flush(ACK_TIMEOUT_S)`, and on an error or a record still in flight call `store.outbox_insert` and return False.',
  ],
  debrief: `An impression is evidence for an experiment, so its shape follows what the analysis needs: the slot each item sat in, because position explains clicks as much as relevance does, and the fallback flag, because a list the model did not produce must not count for it. Keying by user spreads load and keeps one user's history in order for the jobs that join impressions to clicks. Only the delivery report says whether the broker took the record, which is why the outbox hangs off the report and not off \`produce\`. Production pipelines add an impression id the click event carries, sample logging on high-traffic surfaces, and run the outbox relay with its own retries and alerting on its lag.`,
};
