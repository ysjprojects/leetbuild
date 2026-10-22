import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Catalog events keyed by product for storefront sync',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: publish a product and an event
shows up on \`catalog.event\`, so the demo passes. Three production contracts are broken. Find them,
fix them, and prove the fix.

Implement \`record_event(kind, …)\` — the function the publish, hold and rollback paths call after
they commit a version.

- **Key by product id.** Every event goes to \`catalog.event\` with the **product id** as the message
  key, so one product's history stays ordered in one partition. Keying by category scatters a
  product's publish, hold and rollback across partitions and the storefront applies them out of
  order.
- **Carry version ids and the names of the changed fields — never draft values.** The event type is
  one of \`catalog.publish\`, \`catalog.hold\`, \`catalog.rollback\`; the payload carries the
  \`version\`, the \`published_version\` and \`changed_fields\` (names). Publishing the draft *content*
  so downstream "can preview" ships unpublished prices into a retained topic.
- **The snapshot commits before the event is acknowledged.** An event may lag the state it
  describes; it must never describe a version the catalog has not committed. The draft acks first,
  so a crash between the two leaves the storefront synced to a version that does not exist.
- **The producer is idempotent with \`acks=all\`** (or the stack's equivalent: required acks \`all\`
  plus a stable hash balancer), so a retried produce cannot duplicate a record, and a rejected
  produce writes an **outbox** row instead of being dropped.

**Failure mode the checks target.** Keying by category destroys per-product ordering; shipping the
draft content both leaks unpublished data and makes downstream preview a draft it was never meant
to see; an unconfigured producer duplicates on retry; and acking before the commit inverts the
dependency, so the storefront can learn about a version before the catalog has it.`,
  sequence: {
    participants: ['Catalog API', 'catalog.event', 'Storefront sync', 'outbox'],
    messages: [
      {from: 'Catalog API', to: 'Catalog API', label: 'commit snapshot · version 42', kind: 'sync'},
      {from: 'Catalog API', to: 'catalog.event', label: 'produce · key = product_id · acks = all', kind: 'sync'},
      {from: 'catalog.event', to: 'Catalog API', label: 'ack / broker error', kind: 'reply'},
      {from: 'Catalog API', to: 'outbox', label: 'insert_outbox(product_id, event) on failure', kind: 'sync'},
      {from: 'catalog.event', to: 'Storefront sync', label: 'consume · group catalog-sync', kind: 'async'},
      {
        from: 'Storefront sync',
        to: 'Storefront sync',
        label: 'apply in order: one partition per product',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'product-key',
      title: 'Keyed by product id',
      detail:
        "The message key is the product id (`key=product_id`, `key: productId`, `[]byte(productID)`, `ProducerRecord(topic, productId, …)`), so one product's events land in one partition and stay ordered. The draft keys by category.",
      match: {
        python: {all: [/key=product_id/, /catalog\.event/]},
        typescript: {all: [/key:\s*productId\b/, /catalog\.event/]},
        go: {all: [/Key:\s*\[\]byte\(productID\)/, /catalog\.event/]},
        scala: {all: [/ProducerRecord\(EventTopic,\s*productId/, /catalog\.event/]},
        cpp: {all: [/produce\([^;\n]*productId/, /catalog\.event/]},
      },
    },
    {
      id: 'event-types',
      title: 'Publish, hold and rollback events with version ids',
      detail:
        'All three lifecycle events are emitted as `catalog.publish`, `catalog.hold` and `catalog.rollback`, carrying the `version` they refer to. The draft forwards whatever `kind` the caller sent.',
      match: {
        python: {all: [/catalog\.publish/, /catalog\.hold/, /catalog\.rollback/, /version/]},
        typescript: {all: [/catalog\.publish/, /catalog\.hold/, /catalog\.rollback/, /version/]},
        go: {all: [/catalog\.publish/, /catalog\.hold/, /catalog\.rollback/, /version/]},
        scala: {all: [/catalog\.publish/, /catalog\.hold/, /catalog\.rollback/, /version/]},
        cpp: {all: [/catalog\.publish/, /catalog\.hold/, /catalog\.rollback/, /version/]},
      },
    },
    {
      id: 'no-draft-values',
      title: 'Carries changed field names, never draft values',
      detail:
        'The payload carries the **names** of the fields that changed (`changed_fields`); no field value from the draft (a price, a description) reaches the event. The topic is retained and replicated, so draft content written there outlives every retention policy the publish path has.',
      match: {
        python: {all: [/changed_fields/i], none: [/price_cents/i, /description/i]},
        typescript: {all: [/changed_fields|changedFields/i], none: [/price_cents|priceCents/i, /description/i]},
        go: {all: [/changed_fields|ChangedFields/i], none: [/price_cents/i, /description/i]},
        scala: {all: [/changed_fields|changedFields/i], none: [/price_cents|priceCents/i, /description/i]},
        cpp: {all: [/changed_fields|changedFields/i], none: [/price_cents/i, /description/i]},
      },
    },
    {
      id: 'commit-before-produce',
      title: 'Commits the snapshot before producing the event',
      detail:
        'The snapshot commit runs before the produce, so the event can never describe a version the catalog has not committed. The draft acks first and commits afterwards.',
      match: {
        python: {order: [/commit_snapshot\(/, /\.produce\(/]},
        typescript: {order: [/commitSnapshot\(/, /producer\.send\(/]},
        go: {order: [/CommitSnapshot\(/, /WriteMessages\(/]},
        scala: {order: [/commitSnapshot\(/, /producer\.send\(/]},
        cpp: {order: [/commitSnapshot\(productId/, /produce\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` plus `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer — so a retried produce cannot duplicate the record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from confluent_kafka import Producer
from catalog_store import commit_snapshot
from fastapi import FastAPI

app = FastAPI()

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def record_event(kind: str, product_id: str, category: str, draft: dict) -> dict:
    # TODO: this draft keys by category, publishes the draft content so downstream can preview,
    # and acks before the snapshot commits. Review all three.
    event = {
        "type": kind,
        "category": category,
        "price_cents": draft["price_cents"],
        "description": draft["description"],
        "draft": draft,
    }
    producer.produce("catalog.event", key=category, value=json.dumps(event))
    producer.flush(2.0)
    commit_snapshot(product_id, draft["version"])
    return event
`,
      solution: `import json

import redis
from confluent_kafka import KafkaException, Producer
from catalog_store import commit_snapshot

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)

EVENT_TOPIC = "catalog.event"
EVENT_TYPES = {
    "publish": "catalog.publish",
    "hold": "catalog.hold",
    "rollback": "catalog.rollback",
}


class OutboxStore:
    def insert_outbox(self, product_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it when the broker recovers."""
        raise NotImplementedError


store = OutboxStore()


def record_event(
    kind: str,
    product_id: str,
    version: int,
    changed_fields: list[str],
    published_version: int | None = None,
) -> dict:
    # The snapshot commits first: an event may lag the state, it may never precede it.
    commit_snapshot(product_id, version)
    payload = {
        "type": EVENT_TYPES[kind],
        "product_id": product_id,
        "version": version,
        "published_version": published_version,
        # The names of the fields that changed — never the values from the draft.
        "changed_fields": sorted(changed_fields),
    }
    try:
        producer.produce(EVENT_TOPIC, key=product_id, value=json.dumps(payload))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(product_id, payload)
    return payload
`,
    },
    typescript: {
      starter: `/** catalog.event: a model-generated draft that keys by category and ships the draft. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {commitSnapshot} from './catalog-store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'product-catalog', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface CatalogEventBody {
  version: number;
  price_cents: number;
  description: string;
  changed_fields: string[];
}

export async function recordEvent(
  kind: string,
  productId: string,
  category: string,
  body: CatalogEventBody,
): Promise<Record<string, unknown>> {
  // TODO: this draft keys by category, publishes the draft content so downstream can preview,
  // and acks before the snapshot commits. Review all three.
  const payload = {
    type: kind,
    category,
    price_cents: body.price_cents,
    description: body.description,
    draft: body,
  };
  await producer.send({
    topic: 'catalog.event',
    messages: [{key: category, value: JSON.stringify(payload)}],
  });
  await commitSnapshot(productId, body.version);
  return payload;
}
`,
      solution: `/** catalog.event: product-keyed lifecycle events, produced after the snapshot commits. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {commitSnapshot} from './catalog-store';
import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'product-catalog', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const EVENT_TOPIC = 'catalog.event';
const EVENT_TYPES = {
  publish: 'catalog.publish',
  hold: 'catalog.hold',
  rollback: 'catalog.rollback',
} as const;

type EventKind = keyof typeof EVENT_TYPES;

interface CatalogEventBody {
  version: number;
  changed_fields: string[];
  published_version?: number;
}

export async function recordEvent(
  kind: EventKind,
  productId: string,
  body: CatalogEventBody,
): Promise<Record<string, unknown>> {
  // The snapshot commits first: an event may lag the state, it may never precede it.
  await commitSnapshot(productId, body.version);
  const payload = {
    type: EVENT_TYPES[kind],
    product_id: productId,
    version: body.version,
    published_version: body.published_version ?? null,
    // The names of the fields that changed — never the values from the draft.
    changed_fields: [...body.changed_fields].sort(),
  };
  try {
    await producer.send({
      topic: EVENT_TOPIC,
      acks: -1,
      messages: [{key: productId, value: JSON.stringify(payload)}],
    });
  } catch {
    await store.insertOutbox(productId, payload);
  }
  return payload;
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

var catalogWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "catalog.event"}

func recordEvent(ctx context.Context, kind, productID, category string, draft map[string]any) (map[string]any, error) {
	// TODO: this draft keys by category, publishes the draft content so downstream can preview,
	// and acks before the snapshot commits. Review all three.
	payload := map[string]any{
		"type":        kind,
		"category":    category,
		"price_cents": draft["price_cents"],
		"description": draft["description"],
		"draft":       draft,
	}
	encoded, _ := json.Marshal(payload)
	_ = catalogWriter.WriteMessages(ctx, kafka.Message{Key: []byte(category), Value: encoded})
	_ = CommitSnapshot(ctx, productID, 1)
	return payload, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: retries of the same key land on the same partition instead of duplicating across them.
var catalogWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "catalog.event",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var eventTypes = map[string]string{
	"publish":  "catalog.publish",
	"hold":     "catalog.hold",
	"rollback": "catalog.rollback",
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, productID string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

func recordEvent(
	ctx context.Context,
	kind, productID string,
	version, publishedVersion int,
	changedFields []string,
) (map[string]any, error) {
	// The snapshot commits first: an event may lag the state, it may never precede it.
	if err := CommitSnapshot(ctx, productID, version); err != nil {
		return nil, err
	}
	sort.Strings(changedFields)
	payload := map[string]any{
		"type":              eventTypes[kind],
		"product_id":        productID,
		"version":           version,
		"published_version": publishedVersion,
		// The names of the fields that changed — never the values from the draft.
		"changed_fields": changedFields,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	if err := catalogWriter.WriteMessages(ctx, kafka.Message{Key: []byte(productID), Value: encoded}); err != nil {
		if outboxErr := store.InsertOutbox(ctx, productID, payload); outboxErr != nil {
			return nil, outboxErr
		}
	}
	return payload, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object CatalogEvents {
  val EventTopic = "catalog.event"
  val producer = new KafkaProducer[String, String](new Properties())

  // TODO: this draft keys by category, publishes the draft content so downstream can preview,
  // and acks before the snapshot commits. Review all three.
  def recordEvent(kind: String, productId: String, category: String, draft: Map[String, String]): String = {
    val payload = Map(
      "type" -> kind,
      "category" -> category,
      "price_cents" -> draft("price_cents"),
      "description" -> draft("description"),
      "draft" -> draft.toJson.compactPrint
    ).toJson.compactPrint
    producer.send(new ProducerRecord(EventTopic, category, payload))
    commitSnapshot(productId, draft("version").toInt)
    payload
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object CatalogEvents {
  val EventTopic = "catalog.event"
  val EventTypes = Map(
    "publish" -> "catalog.publish",
    "hold" -> "catalog.hold",
    "rollback" -> "catalog.rollback"
  )

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  def recordEvent(
      kind: String,
      productId: String,
      version: Int,
      publishedVersion: Int,
      changedFields: List[String]
  ): String = {
    // The snapshot commits first: an event may lag the state, it may never precede it.
    commitSnapshot(productId, version)
    val payload = Map(
      "type" -> EventTypes(kind),
      "product_id" -> productId,
      "version" -> version.toString,
      "published_version" -> publishedVersion.toString,
      "changed_fields" -> changedFields.sorted.mkString(",")
    ).toJson.compactPrint
    try {
      producer.send(new ProducerRecord(EventTopic, productId, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        OutboxStore.insertOutbox(productId, payload)
    }
    payload
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kEventTopic = "catalog.event";

std::unique_ptr<RdKafka::Producer> producer;

void initProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  producer = std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

void commitSnapshot(const std::string& productId, int version);

json recordEvent(const std::string& kind, const std::string& productId, const std::string& category, const json& draft) {
  // TODO: this draft keys by category, publishes the draft content so downstream can preview,
  // and acks before the snapshot commits. Review all three.
  const json payload = {
      {"type", kind},
      {"category", category},
      {"price_cents", draft["price_cents"]},
      {"description", draft["description"]},
      {"draft", draft},
  };
  const auto encoded = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(encoded.data()), encoded.size(), category.data(), category.size(), 0, nullptr);
  producer->flush(2000);
  commitSnapshot(productId, draft["version"].get<int>());
  return payload;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <algorithm>
#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kEventTopic = "catalog.event";

const std::map<std::string, std::string> kEventTypes = {
    {"publish", "catalog.publish"},
    {"hold", "catalog.hold"},
    {"rollback", "catalog.rollback"},
};

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

struct OutboxStore {
  void insertOutbox(const std::string& productId, const json& event);
};

OutboxStore store;

void commitSnapshot(const std::string& productId, int version);

json recordEvent(const std::string& kind, const std::string& productId, int version, int publishedVersion,
                 std::vector<std::string> changedFields) {
  // The snapshot commits first: an event may lag the state, it may never precede it.
  commitSnapshot(productId, version);
  std::sort(changedFields.begin(), changedFields.end());
  const json payload = {
      {"type", kEventTypes.at(kind)},
      {"product_id", productId},
      {"version", version},
      {"published_version", publishedVersion},
      {"changed_fields", changedFields},
  };
  const auto encoded = payload.dump();
  const auto err = producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(encoded.data()), encoded.size(), productId.data(), productId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(productId, payload);
  }
  producer->flush(2000);
  return payload;
}
`,
    },
  },
  hints: [
    "The message key is the partition key, and it is an ordering contract: `key=product_id`, `key: productId`, `[]byte(productID)`, `ProducerRecord(EventTopic, productId, …)`. Keyed by category, one product's publish and rollback land in different partitions and the storefront can apply them in the wrong order.",
    'An event describes state, it does not carry it. Pass the changed field **names** (`changed_fields`) and the version ids; anything else is tenant data in a retained, replicated topic. If downstream needs the content, it reads the published snapshot — that is what the pointer is for.',
    'Order the two writes: commit the snapshot, then produce the event. The other order makes the broker the source of truth for a version the catalog has not committed, so a crash in between leaves the storefront ahead of the catalog. The producer side is configuration: `enable.idempotence` plus `acks=all`, and an outbox row when the broker rejects the produce.',
  ],
  debrief: `The interviewer is checking the contract between state and its event stream, which generated Kafka code gets wrong in the same three ways every time. First, the key is an ordering contract: partition by product, and a product's publish, hold and rollback arrive in the order they happened. Second, an event is a *description* of a change, not a copy of the data: field names and version ids in, values out — the topic is retained, replicated and read by services that were never meant to see an unpublished price. Third, the dependency direction: commit first, then announce, and make the announce idempotent (idempotent producer, outbox on rejection). Real platforms add a schema registry so a future producer cannot smuggle content in, a consumer group per downstream system, and an ordered replay of outbox rows keyed by product so a broker outage cannot reorder a product's history.`,
};
