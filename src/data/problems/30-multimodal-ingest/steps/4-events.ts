import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Asset events keyed by asset, with no way to the bytes',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['ingest', 'indexer', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter's \`index_and_publish(asset, captioned)\` runs once an asset is
captioned. It produces an \`asset.indexed\` event keyed by the tenant, carrying the mime, the caption
and a permanent \`object_url\`, from a producer with \`acks=1\`, then writes the index with
\`vectors.upsert\` (provided; it returns the embedding ids), and returns \`True\` whatever the broker
did. It serves the demo and hides five flaws.

**Failure mode the checks target.** A busy tenant's events pile onto one partition; the topic, kept
for weeks and replayed to every consumer, hands out a link to the original bytes that skips the
signed read path; a consumer reacting to the event looks the vectors up before they exist; a lost
acknowledgement writes the event twice and a leader failover loses it; a rejected delivery is
dropped with nothing to replay.

- Key by \`asset_id\`.
- The payload is \`asset_id\`, \`tenant\`, \`checksum\`, \`mime\`, \`embedding_ids\` (what
  \`vectors.upsert\` returned) and \`degraded\`; no URL.
- \`vectors.upsert\` first, then produce.
- An idempotent producer with \`acks=all\` (kafkajs: \`idempotent: true\`, \`acks: -1\`; Go uses
  confluent-kafka-go, since kafka-go has no idempotent producer).
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` = 2 s; on an error or no report, call
  \`assets.insert_outbox(topic, key, payload)\` and return \`False\`.`,
  sequence: {
    participants: ['Ingest pipeline', 'Index', 'asset.indexed', 'Outbox'],
    messages: [
      {from: 'Ingest pipeline', to: 'Index', label: 'vectors.upsert(asset, captioned)', kind: 'sync'},
      {from: 'Index', to: 'Ingest pipeline', label: 'embedding ids a-7:image, a-7:caption', kind: 'reply'},
      {
        from: 'Ingest pipeline',
        to: 'asset.indexed',
        label: 'produce key a-7 · checksum · embedding_ids · acks=all',
        kind: 'sync',
      },
      {from: 'asset.indexed', to: 'Ingest pipeline', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'Ingest pipeline', to: 'Outbox', label: 'error or no report → insert_outbox · False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'asset-key',
      title: 'Keys asset.indexed by the asset id',
      detail:
        "Events for a-1, a-2 and a-1 again carry those keys and a-1's two events share a partition; the starter keys by tenant, which piles a busy tenant onto one partition.",
      match: {
        python: {all: [/producer\.produce\([^\n]*key\s*=\s*asset\[["']asset_id["']\]/]},
        typescript: {all: [/key:\s*asset\.asset_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*a\.AssetID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"asset\.indexed")\s*,\s*asset\.assetId\s*,/]},
        cpp: {all: [/asset\.asset_id\.c_str\(\)\s*,\s*asset\.asset_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'payload-facts',
      title: 'Carries checksum and embedding ids, and no URL',
      detail:
        'The value holds `asset_id`, `tenant`, `checksum`, `mime`, `embedding_ids` and `degraded`; the starter sends a permanent `object_url` and no checksum or embedding ids.',
      match: {
        python: {all: [/["']checksum["']\s*:/, /["']embedding_ids["']\s*:/], none: [/object_url|https?:\/\//]},
        typescript: {all: [/checksum:/, /embedding_ids:/], none: [/object_url|https?:\/\//]},
        go: {all: [/"checksum"/, /"embedding_ids"/], none: [/object_url|https?:\/\//]},
        scala: {all: [/"checksum"/, /"embedding_ids"/], none: [/object_url|https?:\/\//]},
        cpp: {all: [/"checksum"/, /"embedding_ids"/], none: [/object_url|https?:\/\//]},
      },
    },
    {
      id: 'index-before-publish',
      title: 'Writes the index before producing the event',
      detail:
        'When `index:{asset_id}` is written the topic is still empty: the event follows the index write. The starter produces first.',
      match: {
        python: {order: [/vectors\.upsert\(/, /producer\.produce\(/]},
        typescript: {order: [/await upsert\(/, /producer\.send\(/]},
        go: {order: [/vectors\.Upsert\(/, /producer\.Produce\(/]},
        scala: {order: [/Vectors\.upsert\(/, /producer\.send\(/]},
        cpp: {order: [/vectors::upsert\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or none within 2 s, leaves an outbox row with the topic, the key and the payload, and the call returns false. The starter fires and forgets.',
      match: {
        python: {all: [/assets\.insert_outbox\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/assets\.InsertOutbox\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Assets\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/, /isFailure|isSuccess|Failure|catch/]},
        cpp: {all: [/assets::insertOutbox\(/, /->flush\(/, /dr_cb/]},
      },
    },
    {
      id: 'idempotent-producer',
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
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from ingest import assets, vectors  # assets.insert_outbox(topic, key, payload), vectors.upsert(asset, captioned)

TOPIC = "asset.indexed"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(asset: dict, captioned: dict, embedding_ids: list[str]) -> dict:
    """What the asset.indexed consumers read about an indexed asset."""
    return {
        "asset_id": asset["asset_id"],
        "tenant": asset["tenant"],
        "mime": asset["mime"],
        "caption": captioned["caption"],
        "object_url": f"https://objects.ingest.internal/{asset['checksum']}",
    }


def index_and_publish(asset: dict, captioned: dict) -> bool:
    """Index the captioned asset and tell the platform; True once the event is out."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = event_payload(asset, captioned, [])
    producer.produce(TOPIC, key=asset["tenant"], value=json.dumps(payload))
    producer.poll(0)
    vectors.upsert(asset, captioned)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from ingest import assets, vectors  # assets.insert_outbox(topic, key, payload), vectors.upsert(asset, captioned)

TOPIC = "asset.indexed"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def event_payload(asset: dict, captioned: dict, embedding_ids: list[str]) -> dict:
    """What the asset.indexed consumers read about an indexed asset: facts, and no way to the bytes."""
    return {
        "asset_id": asset["asset_id"],
        "tenant": asset["tenant"],
        "checksum": asset["checksum"],
        "mime": asset["mime"],
        "embedding_ids": embedding_ids,
        "degraded": captioned["degraded"],
    }


def index_and_publish(asset: dict, captioned: dict) -> bool:
    """Index the captioned asset and tell the platform; True once the broker acknowledged the event."""
    # The index exists before its event: a consumer that reacts finds the vectors.
    embedding_ids = vectors.upsert(asset, captioned)
    payload = event_payload(asset, captioned, embedding_ids)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=asset["asset_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the event is late, not lost.
        assets.insert_outbox(TOPIC, asset["asset_id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Asset, type Captioned, insertOutbox} from 'ingest/assets';
import {upsert} from 'ingest/vectors';

export const TOPIC = 'asset.indexed';

const kafka = new Kafka({clientId: 'ingestd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** What the asset.indexed consumers read about an indexed asset. */
export function eventPayload(asset: Asset, captioned: Captioned, embeddingIds: string[]): Record<string, unknown> {
  return {
    asset_id: asset.asset_id,
    tenant: asset.tenant,
    mime: asset.mime,
    caption: captioned.caption,
    object_url: \`https://objects.ingest.internal/\${asset.checksum}\`,
  };
}

/** Index the captioned asset and tell the platform; true once the event is out. */
export async function indexAndPublish(asset: Asset, captioned: Captioned): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = eventPayload(asset, captioned, []);
  await producer.send({topic: TOPIC, messages: [{key: asset.tenant, value: JSON.stringify(payload)}], acks: 1});
  await upsert(asset, captioned);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Asset, type Captioned, insertOutbox} from 'ingest/assets';
import {upsert} from 'ingest/vectors';

export const TOPIC = 'asset.indexed';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'ingestd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What the asset.indexed consumers read about an indexed asset: facts, and no way to the bytes. */
export function eventPayload(asset: Asset, captioned: Captioned, embeddingIds: string[]): Record<string, unknown> {
  return {
    asset_id: asset.asset_id,
    tenant: asset.tenant,
    checksum: asset.checksum,
    mime: asset.mime,
    embedding_ids: embeddingIds,
    degraded: captioned.degraded,
  };
}

/** Index the captioned asset and tell the platform; true once the broker acknowledged the event. */
export async function indexAndPublish(asset: Asset, captioned: Captioned): Promise<boolean> {
  // The index exists before its event: a consumer that reacts finds the vectors.
  const embeddingIds = await upsert(asset, captioned);
  const payload = eventPayload(asset, captioned, embeddingIds);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: asset.asset_id, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the event is late, not lost.
    await insertOutbox(TOPIC, asset.asset_id, payload);
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

	"ingest/assets"  // assets.Asset, assets.Captioned, assets.InsertOutbox(ctx, topic, key, payload)
	"ingest/vectors" // vectors.Upsert(ctx, asset, captioned) ([]string, error)
)

const topic = "asset.indexed"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// eventPayload is what the asset.indexed consumers read about an indexed asset.
func eventPayload(a assets.Asset, c assets.Captioned, embeddingIDs []string) map[string]any {
	return map[string]any{
		"asset_id":   a.AssetID,
		"tenant":     a.Tenant,
		"mime":       a.Mime,
		"caption":    c.Caption,
		"object_url": "https://objects.ingest.internal/" + a.Checksum,
	}
}

// indexAndPublish indexes the captioned asset and tells the platform; true once the event is out.
func indexAndPublish(ctx context.Context, a assets.Asset, c assets.Captioned) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(eventPayload(a, c, nil))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(a.Tenant), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	if _, err := vectors.Upsert(ctx, a, c); err != nil {
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

	"ingest/assets"  // assets.Asset, assets.Captioned, assets.InsertOutbox(ctx, topic, key, payload)
	"ingest/vectors" // vectors.Upsert(ctx, asset, captioned) ([]string, error)
)

const (
	topic      = "asset.indexed"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

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

// eventPayload is what the asset.indexed consumers read about an indexed asset: facts, and no way to the bytes.
func eventPayload(a assets.Asset, c assets.Captioned, embeddingIDs []string) map[string]any {
	return map[string]any{
		"asset_id":      a.AssetID,
		"tenant":        a.Tenant,
		"checksum":      a.Checksum,
		"mime":          a.Mime,
		"embedding_ids": embeddingIDs,
		"degraded":      c.Degraded,
	}
}

// indexAndPublish indexes the captioned asset and tells the platform; true once the broker acknowledged the event.
func indexAndPublish(ctx context.Context, a assets.Asset, c assets.Captioned) (bool, error) {
	// The index exists before its event: a consumer that reacts finds the vectors.
	embeddingIDs, err := vectors.Upsert(ctx, a, c)
	if err != nil {
		return false, err
	}
	payload := eventPayload(a, c, embeddingIDs)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(a.AssetID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err = producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the event is late, not lost.
		if err := assets.InsertOutbox(ctx, topic, a.AssetID, payload); err != nil {
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
import spray.json._

import ingest.{Assets, Vectors} // Assets.insertOutbox(topic, key, payload), Vectors.upsert(asset, captioned)

object Events {
  val Topic = "asset.indexed"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What the asset.indexed consumers read about an indexed asset. */
  def eventPayload(asset: Assets.Asset, captioned: Assets.Captioned, embeddingIds: Seq[String]): JsObject =
    JsObject(
      "asset_id" -> JsString(asset.assetId),
      "tenant" -> JsString(asset.tenant),
      "mime" -> JsString(asset.mime),
      "caption" -> captioned.caption.map(JsString(_)).getOrElse(JsNull),
      "object_url" -> JsString(s"https://objects.ingest.internal/\${asset.checksum}"))

  /** Index the captioned asset and tell the platform; true once the event is out. */
  def indexAndPublish(asset: Assets.Asset, captioned: Assets.Captioned): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = eventPayload(asset, captioned, Seq.empty)
    producer.send(new ProducerRecord[String, String](Topic, asset.tenant, payload.compactPrint))
    Vectors.upsert(asset, captioned)
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import ingest.{Assets, Vectors} // Assets.insertOutbox(topic, key, payload), Vectors.upsert(asset, captioned)

object Events {
  val Topic = "asset.indexed"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What the asset.indexed consumers read about an indexed asset: facts, and no way to the bytes. */
  def eventPayload(asset: Assets.Asset, captioned: Assets.Captioned, embeddingIds: Seq[String]): JsObject =
    JsObject(
      "asset_id" -> JsString(asset.assetId),
      "tenant" -> JsString(asset.tenant),
      "checksum" -> JsString(asset.checksum),
      "mime" -> JsString(asset.mime),
      "embedding_ids" -> JsArray(embeddingIds.map(JsString(_)).toVector),
      "degraded" -> JsBoolean(captioned.degraded))

  /** Index the captioned asset and tell the platform; true once the broker acknowledged the event. */
  def indexAndPublish(asset: Assets.Asset, captioned: Assets.Captioned): Boolean = {
    // The index exists before its event: a consumer that reacts finds the vectors.
    val embeddingIds = Vectors.upsert(asset, captioned)
    val payload = eventPayload(asset, captioned, embeddingIds)
    val record = new ProducerRecord[String, String](Topic, asset.assetId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the event is late, not lost.
      Assets.insertOutbox(Topic, asset.assetId, payload)
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
#include <vector>

#include "ingest/assets.h"   // assets::Asset, assets::Captioned, assets::insertOutbox(topic, key, payload)
#include "ingest/vectors.h"  // vectors::upsert(asset, captioned) -> embedding ids

using json = nlohmann::json;

const std::string kTopic = "asset.indexed";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What the asset.indexed consumers read about an indexed asset.
json eventPayload(const assets::Asset& asset, const assets::Captioned& captioned, const std::vector<std::string>& embedding_ids) {
  return json{{"asset_id", asset.asset_id},
              {"tenant", asset.tenant},
              {"mime", asset.mime},
              {"caption", captioned.caption},
              {"object_url", "https://objects.ingest.internal/" + asset.checksum}};
}

// Index the captioned asset and tell the platform; true once the event is out.
bool indexAndPublish(const assets::Asset& asset, const assets::Captioned& captioned) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string value = eventPayload(asset, captioned, {}).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    asset.tenant.c_str(), asset.tenant.size(), 0, nullptr);
  producer->poll(0);
  vectors::upsert(asset, captioned);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

#include "ingest/assets.h"   // assets::Asset, assets::Captioned, assets::insertOutbox(topic, key, payload)
#include "ingest/vectors.h"  // vectors::upsert(asset, captioned) -> embedding ids

using json = nlohmann::json;

const std::string kTopic = "asset.indexed";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: indexAndPublish produces one record and waits for it.
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

// What the asset.indexed consumers read about an indexed asset: facts, and no way to the bytes.
json eventPayload(const assets::Asset& asset, const assets::Captioned& captioned, const std::vector<std::string>& embedding_ids) {
  return json{{"asset_id", asset.asset_id}, {"tenant", asset.tenant},   {"checksum", asset.checksum},
              {"mime", asset.mime},         {"embedding_ids", embedding_ids}, {"degraded", captioned.degraded}};
}

// Index the captioned asset and tell the platform; true once the broker acknowledged the event.
bool indexAndPublish(const assets::Asset& asset, const assets::Captioned& captioned) {
  // The index exists before its event: a consumer that reacts finds the vectors.
  const std::vector<std::string> embedding_ids = vectors::upsert(asset, captioned);
  const json payload = eventPayload(asset, captioned, embedding_ids);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                        asset.asset_id.c_str(), asset.asset_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the event is late, not lost.
    assets::insertOutbox(kTopic, asset.asset_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from ingest import assets

TOPIC = "asset.indexed"
CAPTIONED = {"caption": "a red kettle on a stove", "caption_source": "vision", "degraded": False}


def _asset(n):
    return assets.create("t1", "sha256:" + str(n) * 64, "image/png", 48213, None)


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_asset_key(ctx):
    m = ctx.load("events")
    a1, a2 = _asset(1), _asset(2)
    m.index_and_publish(a1, CAPTIONED)
    m.index_and_publish(a2, CAPTIONED)
    m.index_and_publish(a1, {**CAPTIONED, "caption": "a red kettle, recaptioned"})
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three calls produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"a-1", b"a-2", b"a-1"], f"the records are keyed {keys}, expected the asset ids a-1, a-2, a-1: keyed by tenant, a busy tenant's events pile onto one partition"
    assert records[0].partition == records[2].partition, "a-1's two events must land on one partition, in order"


def check_payload_facts(ctx):
    m = ctx.load("events")
    a1 = _asset(1)
    m.index_and_publish(a1, CAPTIONED)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one call produced {len(records)} records"
    text = records[0].value.decode()
    assert "http" not in text, f"the event carries a URL: {text}. The topic is kept and replayed to every consumer; a link to the original bytes there skips the signed, expiring read path"
    p = _payload(records[0])
    want = {"asset_id": "a-1", "tenant": "t1", "checksum": a1["checksum"], "mime": "image/png", "embedding_ids": ["a-1:image", "a-1:caption"], "degraded": False}
    got = {k: p.get(k) for k in want}
    assert got == want, f"the event carries {got}, expected {want}: a consumer needs the checksum to verify the bytes and the embedding ids to find the vectors"


def check_index_before_publish(ctx):
    m = ctx.load("events")
    a1 = _asset(1)
    probe = ctx.redis_after("index:a-1", lambda: len(ctx.kafka.records(TOPIC)))
    m.index_and_publish(a1, CAPTIONED)
    assert probe.fired, "index_and_publish never wrote the index (index:a-1)"
    assert probe.result == 0, f"when the index was written the topic already held {probe.result} event(s): a consumer reacting to asset.indexed looks the vectors up before they exist. Write the index, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after the call the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 1"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.index_and_publish(_asset(1), CAPTIONED)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row nothing ever tells the platform a-1 is searchable"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "a-1" and rows[0].get("payload", {}).get("asset_id") == "a-1", f"the outbox row is {rows[0]}, expected the topic, the key a-1 and the payload"
    assert ok is False, f"index_and_publish returned {ok!r} after a failed delivery, expected False"
    assert ctx.redis.exists("index:a-1") == 1, "the index write must stand when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.index_and_publish(_asset(2), CAPTIONED)
    waited = ctx.clock.time() - before
    assert waited <= 5, f"index_and_publish waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("asset_id") == "a-2", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"index_and_publish returned {ok!r} without a delivery report, expected False"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    m.index_and_publish(_asset(1), CAPTIONED)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one event whose acknowledgement was lost left {len(records)} records on the topic: the producer's retry wrote it twice. Enable idempotence (with acks=all)"
    m.index_and_publish(_asset(2), CAPTIONED)
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the event and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'asset.indexed';
const CAPTIONED = {caption: 'a red kettle on a stove', caption_source: 'vision', degraded: false};

function events(ctx) {
  return {m: ctx.load('events'), assets: ctx.load('/support/ingest/assets.ts')};
}

const asset = (assets, n: number) => assets.create('t1', 'sha256:' + String(n).repeat(64), 'image/png', 48213, null);

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

async function publish(m, a, captioned = CAPTIONED): Promise<unknown> {
  try {
    return await m.indexAndPublish(a, captioned);
  } catch (e) {
    return assert.fail(\`indexAndPublish(\${a.asset_id}) threw \${(e as Error).message}: a failed delivery is answered with an outbox row and false\`);
  }
}

export async function check_asset_key(ctx) {
  const {m, assets} = events(ctx);
  const a1 = await asset(assets, 1);
  const a2 = await asset(assets, 2);
  await publish(m, a1);
  await publish(m, a2);
  await publish(m, a1, {...CAPTIONED, caption: 'a red kettle, recaptioned'});
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three calls produced \${records.length} records on \${TOPIC}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['a-1', 'a-2', 'a-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the asset ids a-1, a-2, a-1: keyed by tenant, a busy tenant's events pile onto one partition\`);
  assert.equal(records[0].partition, records[2].partition, "a-1's two events must land on one partition, in order");
}

export async function check_payload_facts(ctx) {
  const {m, assets} = events(ctx);
  const a1 = await asset(assets, 1);
  await publish(m, a1);
  await settle();
  const values = ctx.kafka.values(TOPIC).map(v => v.toString());
  assert.equal(values.length, 1, \`one call produced \${values.length} records\`);
  assert(!values[0].includes('http'), \`the event carries a URL: \${values[0]}. The topic is kept and replayed to every consumer; a link to the original bytes there skips the signed, expiring read path\`);
  const p = JSON.parse(values[0]);
  const want = {asset_id: 'a-1', tenant: 't1', checksum: a1.checksum, mime: 'image/png', embedding_ids: ['a-1:image', 'a-1:caption'], degraded: false};
  const got = Object.fromEntries(Object.keys(want).map(k => [k, p[k]]));
  assert.deepStrictEqual(got, want, \`the event carries \${JSON.stringify(got)}, expected \${JSON.stringify(want)}: a consumer needs the checksum to verify the bytes and the embedding ids to find the vectors\`);
}

export async function check_index_before_publish(ctx) {
  const {m, assets} = events(ctx);
  const a1 = await asset(assets, 1);
  const probe = ctx.redisAfter('index:a-1', () => ctx.kafka.records(TOPIC).length);
  await publish(m, a1);
  await settle();
  assert(probe.fired, 'indexAndPublish never wrote the index (index:a-1)');
  assert.equal(probe.result, 0, \`when the index was written the topic already held \${probe.result} event(s): a consumer reacting to asset.indexed looks the vectors up before they exist. Write the index, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after the call the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 1\`);
}

export async function check_outbox_on_failure(ctx) {
  const {m, assets} = events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await publish(m, await asset(assets, 1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row nothing ever tells the platform a-1 is searchable\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'a-1' && rows[0].payload?.asset_id === 'a-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key a-1 and the payload\`);
  assert.equal(ok, false, \`indexAndPublish resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert.equal(ctx.redis.exists('index:a-1'), 1, 'the index write must stand when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await publish(m, await asset(assets, 2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`indexAndPublish waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.asset_id === 'a-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`indexAndPublish resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}

export async function check_idempotent_producer(ctx) {
  const {m, assets} = events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await publish(m, await asset(assets, 1));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one event whose acknowledgement was lost left \${records.length} records on the topic: the producer's retry wrote it twice. Make the producer idempotent (acks -1)\`);
  await publish(m, await asset(assets, 2));
  await settle();
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"ingest/assets"

	"leetbuild/harness"
)

const indexedTopic = "asset.indexed"

var (
	eventsBg        = context.Background()
	eventsCaptioned = assets.Captioned{Caption: "a red kettle on a stove", Source: "vision"}
)

func eventsAsset(ctx *harness.Ctx, n int) assets.Asset {
	a, err := assets.Create(eventsBg, "t1", "sha256:"+strings.Repeat(string(rune('0'+n)), 64), "image/png", 48213, "")
	ctx.NoError(err, "creating asset %d failed", n)
	return *a
}

func eventsPublish(ctx *harness.Ctx, a assets.Asset, c assets.Captioned) bool {
	ok, err := indexAndPublish(eventsBg, a, c)
	ctx.NoError(err, "indexAndPublish(%s) failed (a failed delivery is answered with an outbox row and false)", a.AssetID)
	return ok
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

func CheckAssetKey(ctx *harness.Ctx) {
	a1, a2 := eventsAsset(ctx, 1), eventsAsset(ctx, 2)
	eventsPublish(ctx, a1, eventsCaptioned)
	eventsPublish(ctx, a2, eventsCaptioned)
	eventsPublish(ctx, a1, assets.Captioned{Caption: "a red kettle, recaptioned", Source: "vision"})
	ctx.Settle()
	records := ctx.Kafka.Records(indexedTopic)
	ctx.Equal(len(records), 3, "three calls must produce three records on asset.indexed; the records")
	ctx.Equal(ctx.Kafka.Keys(indexedTopic), []string{"a-1", "a-2", "a-1"}, "the records must be keyed by the asset ids (keyed by tenant, a busy tenant's events pile onto one partition)")
	ctx.Equal(records[0].Partition, records[2].Partition, "a-1's two events must land on one partition, in order; the partitions")
}

func CheckPayloadFacts(ctx *harness.Ctx) {
	a1 := eventsAsset(ctx, 1)
	eventsPublish(ctx, a1, eventsCaptioned)
	ctx.Settle()
	values := ctx.Kafka.Values(indexedTopic)
	ctx.Equal(len(values), 1, "one call must produce one record; the records")
	ctx.Assert(!strings.Contains(values[0], "http"), "the event carries a URL: %s. The topic is kept and replayed to every consumer; a link to the original bytes there skips the signed, expiring read path", values[0])
	var p map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &p), "the payload must be JSON")
	got := map[string]any{}
	for _, k := range []string{"asset_id", "tenant", "checksum", "mime", "embedding_ids", "degraded"} {
		got[k] = p[k]
	}
	want := map[string]any{"asset_id": "a-1", "tenant": "t1", "checksum": a1.Checksum, "mime": "image/png", "embedding_ids": []any{"a-1:image", "a-1:caption"}, "degraded": false}
	ctx.Equal(got, want, "the event's facts (a consumer needs the checksum to verify the bytes and the embedding ids to find the vectors)")
}

func CheckIndexBeforePublish(ctx *harness.Ctx) {
	a1 := eventsAsset(ctx, 1)
	probe := ctx.Redis.After("index:a-1", func() any { return len(ctx.Kafka.Records(indexedTopic)) })
	eventsPublish(ctx, a1, eventsCaptioned)
	ctx.Settle()
	ctx.Assert(probe.Fired, "indexAndPublish never wrote the index (index:a-1)")
	ctx.Equal(probe.Result, 0, "when the index was written the topic already held events: a consumer reacting to asset.indexed looks the vectors up before they exist. Write the index, then produce; the records at the index write")
	ctx.Equal(len(ctx.Kafka.Records(indexedTopic)), 1, "the event must still be produced after the index write; the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(indexedTopic, 1)
	ok := eventsPublish(ctx, eventsAsset(ctx, 1), eventsCaptioned)
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row nothing ever tells the platform a-1 is searchable; the rows")
	ctx.Assert(rows[0].Topic == indexedTopic && rows[0].Key == "a-1" && rows[0].Payload["asset_id"] == "a-1", "the outbox row is %+v, expected the topic, the key a-1 and the payload", rows[0])
	ctx.Equal(ok, false, "indexAndPublish's result after a failed delivery")
	ctx.Equal(ctx.Redis.Exists("index:a-1"), int64(1), "the index write must stand when only the produce failed")
	ctx.Kafka.Stall(indexedTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsAsset(ctx, 2), eventsCaptioned)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "indexAndPublish waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["asset_id"] == "a-2", "no delivery report within the window and the outbox holds %+v", rows)
	ctx.Equal(ok, false, "indexAndPublish's result without a delivery report")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(indexedTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsAsset(ctx, 1), eventsCaptioned)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(indexedTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsAsset(ctx, 2), eventsCaptioned)
	ctx.Settle()
	lost := ctx.Kafka.Failover(indexedTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(indexedTopic)), 2, "a leader failover lost %d record(s): with acks=1 the leader alone acknowledged them. Use acks=all; the records", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kIndexedTopic = "asset.indexed";

assets::Captioned captioned(const std::string& caption = "a red kettle on a stove") { return assets::Captioned{caption, "vision", false}; }

assets::Asset eventsAsset(int n) { return assets::create("t1", "sha256:" + std::string(64, static_cast<char>('0' + n)), "image/png", 48213, ""); }

bool eventsPublish(harness::Ctx& ctx, const assets::Asset& a, const assets::Captioned& c) {
  try {
    return indexAndPublish(a, c);
  } catch (const std::exception& e) {
    ctx.Fatalf("indexAndPublish(%s) threw %s: %s (a failed delivery is answered with an outbox row and false)", a.asset_id,
               harness::CurrentExceptionType(), e.what());
  }
  return false;
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

void CheckAssetKey(harness::Ctx& ctx) {
  const assets::Asset a1 = eventsAsset(1);
  const assets::Asset a2 = eventsAsset(2);
  eventsPublish(ctx, a1, captioned());
  eventsPublish(ctx, a2, captioned());
  eventsPublish(ctx, a1, captioned("a red kettle, recaptioned"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kIndexedTopic);
  ctx.Equal(records.size(), 3, "three calls must produce three records on asset.indexed; the records");
  ctx.Equal(ctx.Kafka.Keys(kIndexedTopic), {"a-1", "a-2", "a-1"}, "the records must be keyed by the asset ids (keyed by tenant, a busy tenant's events pile onto one partition)");
  ctx.Equal(records[0].Partition, records[2].Partition, "a-1's two events must land on one partition, in order; the partitions");
}

void CheckPayloadFacts(harness::Ctx& ctx) {
  const assets::Asset a1 = eventsAsset(1);
  eventsPublish(ctx, a1, captioned());
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kIndexedTopic);
  ctx.Equal(values.size(), 1, "one call must produce one record; the records");
  ctx.Assert(values[0].find("http") == std::string::npos,
             "the event carries a URL: %s. The topic is kept and replayed to every consumer; a link to the original bytes there skips the signed, expiring read path", values[0]);
  const auto p = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(p.is_object(), "the payload must be JSON, got %s", values[0]);
  nlohmann::json got = nlohmann::json::object();
  for (const std::string k : {"asset_id", "tenant", "checksum", "mime", "embedding_ids", "degraded"}) got[k] = p.contains(k) ? p[k] : nlohmann::json();
  const nlohmann::json want = {{"asset_id", "a-1"}, {"tenant", "t1"}, {"checksum", a1.checksum}, {"mime", "image/png"},
                               {"embedding_ids", {"a-1:image", "a-1:caption"}}, {"degraded", false}};
  ctx.Equal(got, want, "the event's facts (a consumer needs the checksum to verify the bytes and the embedding ids to find the vectors)");
}

void CheckIndexBeforePublish(harness::Ctx& ctx) {
  const assets::Asset a1 = eventsAsset(1);
  size_t atIndex = 999;
  bool fired = false;
  ctx.Redis.After("index:a-1", [&] {
    fired = true;
    atIndex = ctx.Kafka.Records(kIndexedTopic).size();
  });
  eventsPublish(ctx, a1, captioned());
  ctx.Settle();
  ctx.Assert(fired, "indexAndPublish never wrote the index (index:a-1)");
  ctx.Equal(atIndex, 0,
            "when the index was written the topic already held events: a consumer reacting to asset.indexed looks the vectors up before they exist. Write the index, then produce; the records at the index write");
  ctx.Equal(ctx.Kafka.Records(kIndexedTopic).size(), 1, "the event must still be produced after the index write; the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kIndexedTopic, 1);
  bool ok = eventsPublish(ctx, eventsAsset(1), captioned());
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row nothing ever tells the platform a-1 is searchable; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kIndexedTopic && eventsField(rows[0], "key") == "a-1" && rows[0].contains("payload") &&
                 eventsField(rows[0]["payload"], "asset_id") == "a-1",
             "the outbox row is %s, expected the topic, the key a-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "indexAndPublish's result after a failed delivery");
  ctx.Equal(ctx.Redis.Exists("index:a-1"), 1, "the index write must stand when only the produce failed");
  ctx.Kafka.Stall(kIndexedTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = eventsPublish(ctx, eventsAsset(2), captioned());
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "indexAndPublish waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "asset_id") == "a-2",
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "indexAndPublish's result without a delivery report");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kIndexedTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  eventsPublish(ctx, eventsAsset(1), captioned());
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kIndexedTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  eventsPublish(ctx, eventsAsset(2), captioned());
  ctx.Settle();
  const int lost = ctx.Kafka.Failover(kIndexedTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kIndexedTopic).size(), 2, "a leader failover lost %d record(s): with acks=1 the leader alone acknowledged them. Use acks=all; the records", lost);
}
`,
  },
  hints: [
    'Index two images of one tenant: both events carry the key t1. Read an event: it holds a link to the original image and no embedding ids. Fail the next delivery: the call still answers true and nothing keeps the event.',
    'The payload is built before the index exists, so it cannot carry embedding ids, and the produce comes first. The producer runs with `acks=1` and no idempotence, and nothing waits for the delivery report or acts on it.',
    'Call `vectors.upsert` first, key by `asset_id`, send the six facts, set `acks=all` with `enable.idempotence`, wait for the report with `flush(ACK_TIMEOUT_S)`; on an error or a message still in flight, `assets.insert_outbox` and return False.',
  ],
  debrief: `An event promises that the state it describes already exists, so the index write comes first and the payload carries the embedding ids a consumer will look up. The key is the asset because ordering matters per asset: a re-index after a caption backfill must not overtake the first index event. The URL had to go because a topic is retained and replayed: whatever it carries reaches every present and future consumer, outside the signed, expiring read of step 5. Waiting for the delivery report gives the return value a meaning, and the outbox turns a broker outage into a delay instead of a loss. Production systems write the outbox row in the same transaction as the asset's state, so the two cannot disagree, and relay it with the same idempotent producer.`,
};
