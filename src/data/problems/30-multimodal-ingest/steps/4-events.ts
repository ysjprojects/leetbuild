import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Asset events keyed by asset, never public URLs',
  concept: 'kafka',
  file: 'events',
  focus: ['ingest', 'kafka', 'consumer', 'indexer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it builds the event, publishes it
to \`asset.indexed\` and the consumer reacts. It hides a partition key that is not the asset, a payload
that carries a permanent URL, and a publish that happens before anything is readable. Find them, fix
them, and prove the fix.

Implement the \`asset.indexed\` producer used after an asset is embedded.

- The event is keyed by **asset id** (\`key = asset_id\`), so every event about one asset lands on one
  partition and a consumer sees them in order. Keying by uploader scatters one asset's events across
  partitions and orders them against every other asset of that user.
- The payload carries **facts**: \`asset_id\`, \`tenant\`, \`checksum\`, \`embedding_ids\`, \`mime\`,
  \`degraded\`. It never carries a **URL** — a permanent object URL in a retained topic is a read
  credential that outlives the asset, the tenant and the retention policy.
- Publish **after** the index write confirms: a consumer that reacts to an event must be able to read
  the asset it names. The draft produces first and indexes second, so the consumer races the writer.
- The producer is idempotent and waits for the leader: \`acks=all\` with \`enable.idempotence\`
  (\`idempotent: true\` in kafkajs, \`RequiredAcks: RequireAll\` in kafka-go). A retry after a timeout
  must not duplicate an event, and a broker that has not acknowledged must not look like success.
- When the produce is **rejected**, write an **outbox row** (\`asset_events_outbox\`) with the topic,
  key, payload and error, and let the relay republish it. The draft drops the event on the floor.

**Failure mode the checks target.** The URL is the subtle one: the demo works, the consumer works, and
the payload looks helpful. What it actually does is hand a durable, replayable pointer to the original
bytes to every consumer of a topic that is retained for weeks — the signed-access design of the read
path bypassed by an event. The key and the ordering are the next two: an uploader key merges unrelated
assets into one ordering, and publishing before the index write turns Kafka into a race the consumer
usually loses.`,
  sequence: {
    participants: ['Ingest API', 'Indexer', 'asset.indexed', 'Event consumer'],
    messages: [
      {from: 'Ingest API', to: 'Indexer', label: 'upsert vectors', kind: 'sync'},
      {from: 'Indexer', to: 'Ingest API', label: 'embedding ids', kind: 'reply'},
      {
        from: 'Ingest API',
        to: 'asset.indexed',
        label: 'produce key = asset_id · checksum · embedding_ids',
        kind: 'async',
      },
      {from: 'Ingest API', to: 'asset.indexed', label: 'rejected → outbox row', kind: 'async'},
      {from: 'asset.indexed', to: 'Event consumer', label: 'consume (per-asset order)', kind: 'async'},
      {from: 'Event consumer', to: 'Indexer', label: 'verify + backfill captions', kind: 'sync'},
    ],
  },
  hints: [
    'The key decides the partition, and the partition decides the order. Key by `asset_id` so everything about one asset is serialized; never key by the uploader, which is a different ordering question the consumer did not ask.',
    'Publish only after the index write returns. The event is a promise that the data is readable, so producing it first makes the consumer race the writer for the same asset.',
    '`acks=all` plus idempotence makes a retry safe, but it does not make a rejected produce disappear: catch it and insert an outbox row (topic, key, payload, error) so a relay can republish it and the consumer can dedupe on the asset id.',
  ],
  checks: [
    {
      id: 'topic-key',
      title: 'Publishes asset.indexed keyed by asset id',
      detail:
        'The record goes to the `asset.indexed` topic with the asset id as its key, so one asset’s events share a partition. The draft keys by uploader, which orders unrelated assets against each other.',
      match: {
        python: {all: [/asset\.indexed/, /key=asset_id/]},
        typescript: {all: [/asset\.indexed/, /key: assetId/]},
        go: {all: [/asset\.indexed/, /Key: \[\]byte\(assetID\)/]},
        scala: {all: [/asset\.indexed/, /ProducerRecord\[String, String\]\(Topic, event\.asset_id/]},
        cpp: {all: [/asset\.indexed/, /asset_id\.c_str\(\)/, /asset_id\.size\(\)/]},
      },
    },
    {
      id: 'checksums',
      title: 'Payload carries checksums and embedding ids, never a URL',
      detail:
        'The event carries the `checksum` and the `embedding_ids` the index assigned. No `object_url` and no `https://` object address ever enters the retained topic, because that URL bypasses the signed read path.',
      match: {
        python: {all: [/checksum/, /embedding_ids/], none: [/https:\/\//, /object_url/]},
        typescript: {all: [/checksum/, /embedding_ids/], none: [/https:\/\//, /object_url/]},
        go: {all: [/checksum/, /embedding_ids/], none: [/https:\/\//, /object_url/]},
        scala: {all: [/checksum/, /embedding_ids/], none: [/https:\/\//, /object_url/]},
        cpp: {all: [/checksum/, /embedding_ids/], none: [/https:\/\//, /object_url/]},
      },
    },
    {
      id: 'publish-after-index',
      title: 'Publishes only after the index write confirms',
      detail:
        'The index upsert comes first and the produce second, in both the source order and the call order. The draft produces first, so a consumer can react to an asset it cannot read yet.',
      match: {
        python: {order: [/\.upsert\(/, /\.produce\(/]},
        typescript: {order: [/\.upsert\(/, /\.send\(/]},
        go: {order: [/\bUpsert\(/, /\.WriteMessages\(/]},
        scala: {order: [/\.upsert\(/, /\.send\(/]},
        cpp: {order: [/\bUpsert\(/, /->produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce leaves an outbox row',
      detail:
        'When the broker rejects the record, the event is inserted into `asset_events_outbox` (topic, key, payload, error) with `record_outbox` / `recordOutbox` instead of being dropped, so a relay can republish it.',
      match: {
        python: {all: [/OUTBOX_TABLE/, /record_outbox/]},
        typescript: {all: [/OUTBOX_TABLE/, /recordOutbox/]},
        go: {all: [/outboxTable/, /recordOutbox/]},
        scala: {all: [/OutboxTable/, /recordOutbox/]},
        cpp: {all: [/kOutboxTable/, /record_outbox/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Producer waits for the leader and never duplicates',
      detail:
        'The producer is idempotent and requires the leader ack — `enable.idempotence` with `acks=all` (Java, confluent-kafka, librdkafka), `idempotent: true` (kafkajs) or `RequiredAcks: RequireAll` (kafka-go) — so a retry after a timeout cannot duplicate an event.',
      match: {
        python: {all: [/enable\.idempotence/, /acks/]},
        typescript: {all: [/idempotent: true/]},
        go: {all: [/RequireAll/]},
        scala: {all: [/enable\.idempotence/, /acks/]},
        cpp: {all: [/enable\.idempotence/, /acks/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""events.py — the asset.indexed event. A model-generated draft."""

import json

from confluent_kafka import Producer

TOPIC = "asset.indexed"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_indexed(event: dict) -> None:
    # TODO: this draft keys by uploader instead of the asset, ships the permanent object URL into a
    # retained topic, publishes before the index write confirms, and drops the event when the
    # broker rejects it.
    payload = json.dumps(
        {
            "asset_id": event["asset_id"],
            "uploader": event["uploader"],
            "object_url": "https://objects.internal/" + event["asset_id"] + ".png",
        }
    )
    producer.produce(topic=TOPIC, key=event["uploader"], value=payload)


def index_asset(index, event: dict) -> list:
    return index.upsert(event)


def ingest(index, asset: dict) -> dict:
    publish_indexed(asset)
    index_asset(index, asset)
    return asset
`,
      solution: `"""events.py — the asset.indexed event: facts keyed by asset, published after the index confirms."""

import json
import logging

from confluent_kafka import KafkaException, Producer

logger = logging.getLogger("ingest")

TOPIC = "asset.indexed"
OUTBOX_TABLE = "asset_events_outbox"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
        "client.id": "ingest",
    }
)


def record_outbox(store, event: dict, error: str) -> None:
    """One row per rejected produce; the relay republishes it and consumers dedupe on the asset id."""
    row = {
        "asset_id": event["asset_id"],
        "topic": TOPIC,
        "payload": json.dumps(event),
        "error": error,
    }
    store.insert(OUTBOX_TABLE, row)


def index_asset(index, event: dict) -> list:
    """Upsert the vectors and return the embedding ids the index assigned."""
    return index.upsert(event)


def publish_indexed(store, event: dict) -> dict:
    """Publish only what the index confirmed: checksums and embedding ids, never an object URL."""
    asset_id = event["asset_id"]
    payload = json.dumps(
        {
            "asset_id": asset_id,
            "tenant": event["tenant"],
            "checksum": event["checksum"],
            "embedding_ids": event["embedding_ids"],
            "mime": event["mime"],
            "degraded": event["degraded"],
        }
    )
    try:
        producer.produce(topic=TOPIC, key=asset_id, value=payload)
        producer.flush(5)
    except KafkaException as exc:
        logger.warning("asset.indexed rejected asset=%s", asset_id)
        record_outbox(store, event, str(exc))
    return event


def ingest(index, store, asset: dict) -> dict:
    event = {**asset, "embedding_ids": index_asset(index, asset)}
    return publish_indexed(store, event)
`,
    },
    typescript: {
      starter: `/** events.ts — the asset.indexed event. A model-generated draft. */
import {Kafka} from 'kafkajs';

export const TOPIC = 'asset.indexed';

const kafka = new Kafka({clientId: 'ingest', brokers: ['kafka:9092']});
const producer = kafka.producer();

interface AssetEvent {
  asset_id: string;
  uploader: string;
}

export async function publishIndexed(event: AssetEvent): Promise<void> {
  // TODO: this draft keys by uploader instead of the asset, ships the permanent object URL into a
  // retained topic, publishes before the index write confirms, and drops the event when the broker
  // rejects it.
  await producer.send({
    topic: TOPIC,
    messages: [
      {
        key: event.uploader,
        value: JSON.stringify({
          asset_id: event.asset_id,
          uploader: event.uploader,
          object_url: 'https://objects.internal/' + event.asset_id + '.png',
        }),
      },
    ],
  });
}

export async function indexAsset(index: {upsert: (event: unknown) => Promise<string[]>}, event: unknown): Promise<string[]> {
  return index.upsert(event);
}

export async function ingest(index: {upsert: (event: unknown) => Promise<string[]>}, asset: AssetEvent): Promise<AssetEvent> {
  await publishIndexed(asset);
  await indexAsset(index, asset);
  return asset;
}
`,
      solution: `/** events.ts — the asset.indexed event: facts keyed by asset, published after the index confirms. */
import {Kafka} from 'kafkajs';

export const TOPIC = 'asset.indexed';
export const OUTBOX_TABLE = 'asset_events_outbox';

const kafka = new Kafka({clientId: 'ingest', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});

interface IndexedEvent {
  asset_id: string;
  tenant: string;
  checksum: string;
  embedding_ids: string[];
  mime: string;
  degraded: boolean;
}

interface Outbox {
  insert: (table: string, row: unknown) => Promise<unknown>;
}

export async function recordOutbox(db: Outbox, event: IndexedEvent, reason: string): Promise<void> {
  await db.insert(OUTBOX_TABLE, {topic: TOPIC, key: event.asset_id, payload: event, error: reason});
}

export async function indexAsset(
  index: {upsert: (event: IndexedEvent) => Promise<string[]>},
  event: IndexedEvent,
): Promise<IndexedEvent> {
  return {...event, embedding_ids: await index.upsert(event)};
}

export async function publishIndexed(db: Outbox, event: IndexedEvent): Promise<IndexedEvent> {
  const assetId = event.asset_id;
  const value = JSON.stringify({
    asset_id: assetId,
    tenant: event.tenant,
    checksum: event.checksum,
    embedding_ids: event.embedding_ids,
    mime: event.mime,
    degraded: event.degraded,
  });
  try {
    await producer.send({topic: TOPIC, messages: [{key: assetId, value}]});
  } catch (error) {
    await recordOutbox(db, event, String(error));
  }
  return event;
}

export async function ingest(
  index: {upsert: (event: IndexedEvent) => Promise<string[]>},
  db: Outbox,
  asset: Omit<IndexedEvent, 'embedding_ids'>,
): Promise<IndexedEvent> {
  const indexed = await indexAsset(index, {...asset, embedding_ids: []});
  return publishIndexed(db, indexed);
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

type IndexedEvent struct {
	AssetID  string \`json:"asset_id"\`
	Uploader string \`json:"uploader"\`
}

var writer = &kafka.Writer{
	Addr:  kafka.TCP("kafka:9092"),
	Topic: "asset.indexed",
}

func publishIndexed(ctx context.Context, event IndexedEvent) error {
	// TODO: this draft keys by uploader instead of the asset, ships the permanent object URL into a
	// retained topic, publishes before the index write confirms, and drops the event when the
	// broker rejects it.
	payload, err := json.Marshal(map[string]any{
		"asset_id":   event.AssetID,
		"uploader":   event.Uploader,
		"object_url": "https://objects.internal/" + event.AssetID + ".png",
	})
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Topic: "asset.indexed", Key: []byte(event.Uploader), Value: payload})
}

func indexAsset(ctx context.Context, index IndexClient, event IndexedEvent) ([]string, error) {
	return index.Upsert(ctx, event.AssetID)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const (
	topic       = "asset.indexed"
	outboxTable = "asset_events_outbox"
)

type IndexedEvent struct {
	AssetID      string   \`json:"asset_id"\`
	Tenant       string   \`json:"tenant"\`
	Checksum     string   \`json:"checksum"\`
	EmbeddingIDs []string \`json:"embedding_ids"\`
	Mime         string   \`json:"mime"\`
	Degraded     bool     \`json:"degraded"\`
}

type Outbox interface {
	Insert(ctx context.Context, table string, row any) error
}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

func recordOutbox(ctx context.Context, db Outbox, event IndexedEvent, reason string) error {
	return db.Insert(ctx, outboxTable, map[string]any{
		"topic":   topic,
		"key":     event.AssetID,
		"payload": event,
		"error":   reason,
	})
}

func indexAsset(ctx context.Context, index IndexClient, event IndexedEvent) (IndexedEvent, error) {
	embeddingIDs, err := index.Upsert(ctx, event.AssetID)
	if err != nil {
		return event, err
	}
	event.EmbeddingIDs = embeddingIDs
	return event, nil
}

func publishIndexed(ctx context.Context, db Outbox, event IndexedEvent) error {
	assetID := event.AssetID
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Topic: topic, Key: []byte(assetID), Value: payload}); err != nil {
		return recordOutbox(ctx, db, event, err.Error())
	}
	return nil
}

func ingest(ctx context.Context, index IndexClient, db Outbox, event IndexedEvent) error {
	indexed, err := indexAsset(ctx, index, event)
	if err != nil {
		return err
	}
	return publishIndexed(ctx, db, indexed)
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import java.util.Properties

final case class IndexedEvent(asset_id: String, uploader: String)

object Events {
  val Topic = "asset.indexed"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def publishIndexed(event: IndexedEvent): Unit = {
    // TODO: this draft keys by uploader instead of the asset, ships the permanent object URL into a
    // retained topic, publishes before the index write confirms, and drops the event when the
    // broker rejects it.
    val payload = s"""{"asset_id":"\${event.asset_id}","uploader":"\${event.uploader}","object_url":"https://objects.internal/\${event.asset_id}.png"}"""
    producer.send(new ProducerRecord[String, String](Topic, event.uploader, payload))
  }

  def indexAsset(index: Index, event: IndexedEvent): IndexedEvent =
    event.copy()

  def ingest(index: Index, event: IndexedEvent): Unit = {
    publishIndexed(event)
    indexAsset(index, event)
  }
}
`,
      solution: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import java.util.Properties
import scala.util.{Failure, Success, Try}

final case class IndexedEvent(asset_id: String, tenant: String, checksum: String, embedding_ids: List[String], mime: String, degraded: Boolean)
final case class OutboxRow(topic: String, key: String, payload: String, error: String)

object Events {
  val Topic = "asset.indexed"
  val OutboxTable = "asset_events_outbox"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def recordOutbox(row: OutboxRow): Unit = {
    // one row per rejected produce; the relay republishes it and consumers dedupe on the asset id
    Outbox.insert(OutboxTable, row)
  }

  def indexAsset(index: Index, event: IndexedEvent): IndexedEvent =
    event.copy(embedding_ids = index.upsert(event))

  def publishIndexed(event: IndexedEvent): Unit = {
    val embeddingIds = event.embedding_ids.map(id => "\\"" + id + "\\"").mkString(",")
    val payload =
      s"""{"asset_id":"\${event.asset_id}","tenant":"\${event.tenant}","checksum":"\${event.checksum}","embedding_ids":[$embeddingIds],"mime":"\${event.mime}","degraded":\${event.degraded}}"""
    Try(producer.send(new ProducerRecord[String, String](Topic, event.asset_id, payload))) match {
      case Success(_) => ()
      case Failure(e) => recordOutbox(OutboxRow(Topic, event.asset_id, payload, e.getMessage))
    }
  }

  def ingest(index: Index, event: IndexedEvent): Unit = {
    val indexed = indexAsset(index, event)
    publishIndexed(indexed)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "asset.indexed";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void publish_indexed(const json& event) {
  // TODO: this draft keys by uploader instead of the asset, ships the permanent object URL into a
  // retained topic, publishes before the index write confirms, and drops the event when the broker
  // rejects it.
  const auto uploader = event.at("uploader").get<std::string>();
  const std::string payload =
      json{{"asset_id", event.at("asset_id")}, {"object_url", "https://objects.internal/" + uploader + ".png"}}.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), uploader.c_str(), uploader.size(), 0, nullptr);
}

std::vector<std::string> index_asset(IndexClient& index, const json& event) {
  return index.Upsert(event);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "asset.indexed";
const std::string kOutboxTable = "asset_events_outbox";

struct Asset {
  std::string id;
  std::string tenant;
  std::string checksum;
  std::string mime;
  bool degraded = false;
};

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One row per rejected produce; the relay republishes it and consumers dedupe on the asset id.
void record_outbox(const json& event, const std::string& reason) {
  const json row = {
      {"topic", kTopic},
      {"key", event.at("asset_id")},
      {"payload", event},
      {"error", reason},
  };
  db_insert(kOutboxTable, row);
}

// Facts only: the checksum and the embedding ids the index assigned — never an object URL.
json make_event(const Asset& asset, const std::vector<std::string>& embedding_ids) {
  return json{
      {"asset_id", asset.id},
      {"tenant", asset.tenant},
      {"checksum", asset.checksum},
      {"embedding_ids", embedding_ids},
      {"mime", asset.mime},
      {"degraded", asset.degraded},
  };
}

std::vector<std::string> index_asset(IndexClient& index, const json& event) {
  return index.Upsert(event);
}

void publish_indexed(const json& event) {
  const std::string payload = event.dump();
  const std::string asset_id = event.at("asset_id").get<std::string>();
  const RdKafka::ErrorCode outcome =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                        const_cast<char*>(payload.data()), payload.size(), asset_id.c_str(), asset_id.size(), 0, nullptr);
  producer->poll(0);
  if (outcome != RdKafka::ERR_NO_ERROR) record_outbox(event, RdKafka::err2str(outcome));
}

void ingest(IndexClient& index, const Asset& asset) {
  json event = make_event(asset, {});
  event["embedding_ids"] = index_asset(index, event);
  publish_indexed(event);
}
`,
    },
  },
  debrief: `The interviewer is testing what an event is allowed to contain. The draft's payload is the shape a
model reaches for when it is asked to "notify the rest of the platform": the id, who did it, and where
the file is. That last field is the bug — a URL that lives for weeks in a retained, replicated topic is
a read credential nobody signed, and the read endpoint's 15-minute expiry is bypassed by whoever reads
the topic.

The key and the order are the next two. A partition key is a promise about ordering: keyed by asset,
every event about the asset is serialized; keyed by uploader, two assets of the same user interleave
and the consumer throttles work it does not need to. Publishing before the index write is a promise
that the data is there. Real systems also carry a schema version and an event id in the payload so a
consumer can dedupe on replay, and drive the relay from the outbox with the same idempotent producer,
so a broker outage costs latency instead of data.`,
};
