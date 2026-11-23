import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Catalog events keyed by product for storefront sync',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter produces the \`catalog.event\` stream the storefront sync consumes:
\`record_event(kind, product_id, category, draft, changed_fields, published_version)\` produces one
record per publish, hold or rollback, and \`publish(product_id, draft, category, expected,
changed_fields)\` records the event, then calls \`publish_snapshot\` (step 2, provided as
\`catalog.snapshot\`). Publish a product and an event shows up; it hides five flaws.

**Failure mode the checks target.** Two events of one product land on two partitions and the sync
applies them out of order; the event carries the draft's price and title into a retained topic;
the sync learns about a version before the catalog has committed it; and a broker that loses an
acknowledgement gets the record twice.

- The record key is the **product id**.
- \`type\` is \`catalog.publish\`, \`catalog.hold\` or \`catalog.rollback\` (\`EVENT_TYPES\`); the payload
  carries \`product_id\`, \`category\`, \`version\`, \`published_version\` and the sorted names in
  \`changed_fields\`, and no field value of the draft.
- \`publish\` calls \`publish_snapshot\` first and produces only once the pointer moved.
- The producer is idempotent with \`acks=all\` (the stack's equivalent: kafkajs \`idempotent\`,
  librdkafka \`enable.idempotence\`, kafka-go \`RequireAll\`).`,
  sequence: {
    participants: ['Catalog API', 'Redis pointer', 'catalog.event', 'Storefront sync'],
    messages: [
      {from: 'Catalog API', to: 'Redis pointer', label: 'publish_snapshot(id, 42, snapshot, 41)', kind: 'sync'},
      {from: 'Redis pointer', to: 'Catalog API', label: 'moved', kind: 'reply'},
      {from: 'Catalog API', to: 'catalog.event', label: 'produce · key = product_id · acks = all', kind: 'sync'},
      {from: 'catalog.event', to: 'Catalog API', label: 'ack (once, idempotent on retry)', kind: 'reply'},
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
        "The record key is the product id (`key=product_id`, `key: productId`, `[]byte(productID)`), so one product's events land on one partition and stay ordered; the starter keys by category.",
      match: {
        python: {all: [/key=product_id/, /catalog\.event/], none: [/key=category/]},
        typescript: {all: [/key:\s*productId\b/, /catalog\.event/], none: [/key:\s*category\b/]},
        go: {all: [/Key:\s*\[\]byte\(productID\)/, /catalog\.event/], none: [/Key:\s*\[\]byte\(category\)/]},
        cpp: {
          all: [/product_id\.c_str\(\),\s*product_id\.(size|length)\(\)/, /catalog\.event/],
          none: [/category\.c_str\(\)/],
        },
      },
    },
    {
      id: 'event-types',
      title: 'Publish, hold and rollback events with version ids',
      detail:
        'The three lifecycle kinds map to `catalog.publish`, `catalog.hold` and `catalog.rollback` through `EVENT_TYPES`, and the payload carries `version` and `published_version`; the starter forwards whatever `kind` the caller sent.',
      match: {
        python: {
          all: [/EVENT_TYPES\s*=/, /catalog\.publish/, /catalog\.hold/, /catalog\.rollback/, /published_version/],
        },
        typescript: {
          all: [/EVENT_TYPES\s*[:=]/, /catalog\.publish/, /catalog\.hold/, /catalog\.rollback/, /published_version/],
        },
        go: {all: [/eventTypes\s*=/, /catalog\.publish/, /catalog\.hold/, /catalog\.rollback/, /published_version/]},
        cpp: {all: [/kEventTypes\s*=/, /catalog\.publish/, /catalog\.hold/, /catalog\.rollback/, /published_version/]},
      },
    },
    {
      id: 'no-draft-values',
      title: 'Carries changed field names, never draft values',
      detail:
        'The payload carries the sorted names of the fields that changed (`changed_fields`, whatever order the caller passed) and no value from the draft anywhere in the record, nested or under another name: the topic is retained and replicated, so a price written there outlives every retention rule the draft has.',
      match: {
        python: {
          all: [/changed_fields/],
          none: [/def record_event(?:(?!\ndef )[\s\S])*?(price_cents|tax_class|draft\[["']title["']\])/],
        },
        typescript: {
          all: [/changed_fields/],
          none: [/function recordEvent(?:(?!\nexport )[\s\S])*?(price_cents|tax_class|draft\.title)/],
        },
        go: {all: [/changed_fields/], none: [/func recordEvent(?:(?!\n\})[\s\S])*?(PriceCents|TaxClass|draft\.Title)/]},
        cpp: {
          all: [/changed_fields/],
          none: [/json record_event(?:(?!\n\})[\s\S])*?(price_cents|tax_class|draft\.title)/],
        },
      },
    },
    {
      id: 'commit-before-produce',
      title: 'Commits the snapshot before producing the event',
      detail:
        '`publish` calls `publish_snapshot`/`publishSnapshot` and produces the event only afterwards, so the event can never describe a version the catalog has not committed; the starter produces first.',
      match: {
        python: {order: [/def publish\(/, /publish_snapshot\(/, /record_event\(/]},
        typescript: {order: [/function publish\(/, /publishSnapshot\(/, /recordEvent\(/]},
        go: {order: [/func publish\(/, /snapshot\.PublishSnapshot\(/, /recordEvent\(/]},
        cpp: {order: [/std::optional<json> publish\(/, /snapshot::publishSnapshot\(/, /record_event\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` plus `acks`, kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the record once; kafka-go has no idempotent producer, so its writer uses `RequireAll` and the sync deduplicates by `(product_id, version, type)`.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from catalog.snapshot import publish_snapshot

EVENT_TOPIC = "catalog.event"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("catalog event not delivered: %s", err)


def record_event(kind: str, product_id: str, category: str, draft: dict, changed_fields: list[str], published_version: int | None = None) -> dict:
    """One record on catalog.event for a publish, hold or rollback of the draft."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = {
        "type": kind,
        "product_id": product_id,
        "category": category,
        "version": draft["version"],
        "title": draft["title"],
        "price_cents": draft["price_cents"],  # downstream can preview the price before it is live
        "changed_fields": list(changed_fields),
    }
    producer.produce(EVENT_TOPIC, key=category, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload


def publish(product_id: str, draft: dict, category: str, expected: int | None, changed_fields: list[str]) -> dict | None:
    """Make the draft the published version and tell the storefront sync; None when the pointer did not move."""
    event = record_event("publish", product_id, category, draft, changed_fields, published_version=draft["version"])
    snapshot = {name: draft[name] for name in ("product_id", "version", "title", "price_cents", "tax_class")}
    if not publish_snapshot(product_id, draft["version"], snapshot, expected):
        return None
    return event
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from catalog.snapshot import publish_snapshot

EVENT_TOPIC = "catalog.event"
EVENT_TYPES = {"publish": "catalog.publish", "hold": "catalog.hold", "rollback": "catalog.rollback"}
log = logging.getLogger("events")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("catalog event not delivered: %s", err)


def record_event(kind: str, product_id: str, category: str, draft: dict, changed_fields: list[str], published_version: int | None = None) -> dict:
    """One record on catalog.event for a publish, hold or rollback of the draft."""
    payload = {
        "type": EVENT_TYPES[kind],
        "product_id": product_id,
        "category": category,
        "version": draft["version"],
        "published_version": published_version,
        # The names of the fields that changed; the values stay in the catalog.
        "changed_fields": sorted(changed_fields),
    }
    producer.produce(EVENT_TOPIC, key=product_id, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload


def publish(product_id: str, draft: dict, category: str, expected: int | None, changed_fields: list[str]) -> dict | None:
    """Make the draft the published version and tell the storefront sync; None when the pointer did not move."""
    snapshot = {name: draft[name] for name in ("product_id", "version", "title", "price_cents", "tax_class")}
    # The snapshot commits first: an event may lag the state, it may never precede it.
    if not publish_snapshot(product_id, draft["version"], snapshot, expected):
        return None
    return record_event("publish", product_id, category, draft, changed_fields, published_version=draft["version"])
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {publishSnapshot} from 'catalog/snapshot';

export const EVENT_TOPIC = 'catalog.event';

export interface Draft {
  product_id: string;
  version: number;
  title: string | null;
  price_cents: number | null;
  tax_class: string | null;
}

const kafka = new Kafka({clientId: 'catalogd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One record on catalog.event for a publish, hold or rollback of the draft. */
export async function recordEvent(
  kind: string,
  productId: string,
  category: string,
  draft: Draft,
  changedFields: string[],
  publishedVersion: number | null = null,
): Promise<Record<string, unknown>> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = {
    type: kind,
    product_id: productId,
    category,
    version: draft.version,
    title: draft.title,
    price_cents: draft.price_cents, // downstream can preview the price before it is live
    changed_fields: [...changedFields],
  };
  await producer.send({topic: EVENT_TOPIC, messages: [{key: category, value: JSON.stringify(payload)}], acks: 1});
  return payload;
}

/** Make the draft the published version and tell the storefront sync; null when the pointer did not move. */
export async function publish(productId: string, draft: Draft, category: string, expected: number | null, changedFields: string[]): Promise<Record<string, unknown> | null> {
  const event = await recordEvent('publish', productId, category, draft, changedFields, draft.version);
  const {product_id, version, title, price_cents, tax_class} = draft;
  if (!(await publishSnapshot(productId, draft.version, {product_id, version, title, price_cents, tax_class}, expected))) return null;
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {publishSnapshot} from 'catalog/snapshot';

export const EVENT_TOPIC = 'catalog.event';
export const EVENT_TYPES: Record<string, string> = {publish: 'catalog.publish', hold: 'catalog.hold', rollback: 'catalog.rollback'};

export interface Draft {
  product_id: string;
  version: number;
  title: string | null;
  price_cents: number | null;
  tax_class: string | null;
}

const kafka = new Kafka({clientId: 'catalogd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the record once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One record on catalog.event for a publish, hold or rollback of the draft. */
export async function recordEvent(
  kind: string,
  productId: string,
  category: string,
  draft: Draft,
  changedFields: string[],
  publishedVersion: number | null = null,
): Promise<Record<string, unknown>> {
  const type = EVENT_TYPES[kind];
  if (type === undefined) throw new Error(\`unknown event kind \${kind}\`);
  const payload = {
    type,
    product_id: productId,
    category,
    version: draft.version,
    published_version: publishedVersion,
    // The names of the fields that changed; the values stay in the catalog.
    changed_fields: [...changedFields].sort(),
  };
  await producer.send({topic: EVENT_TOPIC, messages: [{key: productId, value: JSON.stringify(payload)}], acks: -1});
  return payload;
}

/** Make the draft the published version and tell the storefront sync; null when the pointer did not move. */
export async function publish(productId: string, draft: Draft, category: string, expected: number | null, changedFields: string[]): Promise<Record<string, unknown> | null> {
  const {product_id, version, title, price_cents, tax_class} = draft;
  // The snapshot commits first: an event may lag the state, it may never precede it.
  if (!(await publishSnapshot(productId, draft.version, {product_id, version, title, price_cents, tax_class}, expected))) return null;
  return recordEvent('publish', productId, category, draft, changedFields, draft.version);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/segmentio/kafka-go"

	"catalog/snapshot" // snapshot.PublishSnapshot(ctx, productID, version, snapshot, expected) (bool, error)
	"catalog/store"    // store.Row
)

const eventTopic = "catalog.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// recordEvent produces one record on catalog.event for a publish, hold or rollback of the draft.
func recordEvent(ctx context.Context, kind, productID, category string, draft store.Row, changedFields []string, publishedVersion int) (map[string]any, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	fields := append([]string{}, changedFields...)
	sort.Strings(fields)
	payload := map[string]any{
		"type":           kind,
		"product_id":     productID,
		"category":       category,
		"version":        draft.Version,
		"title":          draft.Title,
		"price_cents":    draft.PriceCents, // downstream can preview the price before it is live
		"changed_fields": fields,
	}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(category), Value: value}); err != nil {
		return nil, err
	}
	return payload, nil
}

// publish makes the draft the published version and tells the storefront sync; nil when the pointer did not move.
func publish(ctx context.Context, productID string, draft store.Row, category string, expected int, changedFields []string) (map[string]any, error) {
	event, err := recordEvent(ctx, "publish", productID, category, draft, changedFields, draft.Version)
	if err != nil {
		return nil, err
	}
	doc := map[string]any{"product_id": draft.ProductID, "version": draft.Version, "title": draft.Title, "price_cents": draft.PriceCents, "tax_class": draft.TaxClass}
	moved, err := snapshot.PublishSnapshot(ctx, productID, draft.Version, doc, expected)
	if err != nil || !moved {
		return nil, err
	}
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/segmentio/kafka-go"

	"catalog/snapshot" // snapshot.PublishSnapshot(ctx, productID, version, snapshot, expected) (bool, error)
	"catalog/store"    // store.Row
)

const eventTopic = "catalog.event"

var eventTypes = map[string]string{"publish": "catalog.publish", "hold": "catalog.hold", "rollback": "catalog.rollback"}

// RequireAll: the record is on every replica before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate; the sync deduplicates by
// (product_id, version, type).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// recordEvent produces one record on catalog.event for a publish, hold or rollback of the draft.
func recordEvent(ctx context.Context, kind, productID, category string, draft store.Row, changedFields []string, publishedVersion int) (map[string]any, error) {
	eventType, known := eventTypes[kind]
	if !known {
		return nil, fmt.Errorf("unknown event kind %q", kind)
	}
	fields := append([]string{}, changedFields...)
	sort.Strings(fields)
	payload := map[string]any{
		"type":              eventType,
		"product_id":        productID,
		"category":          category,
		"version":           draft.Version,
		"published_version": publishedVersion,
		// The names of the fields that changed; the values stay in the catalog.
		"changed_fields": fields,
	}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(productID), Value: value}); err != nil {
		return nil, err
	}
	return payload, nil
}

// publish makes the draft the published version and tells the storefront sync; nil when the pointer did not move.
func publish(ctx context.Context, productID string, draft store.Row, category string, expected int, changedFields []string) (map[string]any, error) {
	doc := map[string]any{"product_id": draft.ProductID, "version": draft.Version, "title": draft.Title, "price_cents": draft.PriceCents, "tax_class": draft.TaxClass}
	// The snapshot commits first: an event may lag the state, it may never precede it.
	moved, err := snapshot.PublishSnapshot(ctx, productID, draft.Version, doc, expected)
	if err != nil || !moved {
		return nil, err
	}
	return recordEvent(ctx, "publish", productID, category, draft, changedFields, draft.Version)
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "catalog/snapshot.h"  // snapshot::publishSnapshot(product_id, version, snapshot, expected) -> bool
#include "catalog/store.h"     // store::Row

using json = nlohmann::json;

const std::string kEventTopic = "catalog.event";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "catalog event not delivered: " << message.errstr() << "\\n";
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

json snapshotOf(const store::Row& draft) {
  return json{{"product_id", draft.product_id}, {"version", draft.version}, {"title", draft.title},
              {"price_cents", draft.price_cents}, {"tax_class", draft.tax_class}};
}

// One record on catalog.event for a publish, hold or rollback of the draft.
json record_event(const std::string& kind, const std::string& product_id, const std::string& category, const store::Row& draft,
                  std::vector<std::string> changed_fields, long published_version = 0) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  json payload = {{"type", kind},
                  {"product_id", product_id},
                  {"category", category},
                  {"version", draft.version},
                  {"title", draft.title},
                  {"price_cents", draft.price_cents},  // downstream can preview the price before it is live
                  {"changed_fields", changed_fields}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), category.c_str(), category.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}

// Make the draft the published version and tell the storefront sync; none when the pointer did not move.
std::optional<json> publish(const std::string& product_id, const store::Row& draft, const std::string& category, long expected,
                            const std::vector<std::string>& changed_fields) {
  const json event = record_event("publish", product_id, category, draft, changed_fields, draft.version);
  if (!snapshot::publishSnapshot(product_id, draft.version, snapshotOf(draft), expected)) return std::nullopt;
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "catalog/snapshot.h"  // snapshot::publishSnapshot(product_id, version, snapshot, expected) -> bool
#include "catalog/store.h"     // store::Row

using json = nlohmann::json;

const std::string kEventTopic = "catalog.event";
const std::map<std::string, std::string> kEventTypes = {
    {"publish", "catalog.publish"}, {"hold", "catalog.hold"}, {"rollback", "catalog.rollback"}};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "catalog event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

json snapshotOf(const store::Row& draft) {
  return json{{"product_id", draft.product_id}, {"version", draft.version}, {"title", draft.title},
              {"price_cents", draft.price_cents}, {"tax_class", draft.tax_class}};
}

// One record on catalog.event for a publish, hold or rollback of the draft.
json record_event(const std::string& kind, const std::string& product_id, const std::string& category, const store::Row& draft,
                  std::vector<std::string> changed_fields, long published_version = 0) {
  const auto type = kEventTypes.find(kind);
  if (type == kEventTypes.end()) throw std::invalid_argument("unknown event kind " + kind);
  std::sort(changed_fields.begin(), changed_fields.end());
  json payload = {{"type", type->second},
                  {"product_id", product_id},
                  {"category", category},
                  {"version", draft.version},
                  {"published_version", published_version > 0 ? json(published_version) : json(nullptr)},
                  // The names of the fields that changed; the values stay in the catalog.
                  {"changed_fields", changed_fields}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), product_id.c_str(), product_id.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}

// Make the draft the published version and tell the storefront sync; none when the pointer did not move.
std::optional<json> publish(const std::string& product_id, const store::Row& draft, const std::string& category, long expected,
                            const std::vector<std::string>& changed_fields) {
  // The snapshot commits first: an event may lag the state, it may never precede it.
  if (!snapshot::publishSnapshot(product_id, draft.version, snapshotOf(draft), expected)) return std::nullopt;
  return record_event("publish", product_id, category, draft, changed_fields, draft.version);
}
`,
    },
  },
  harness: {
    python: `import json

from catalog.snapshot import read_published

TOPIC = "catalog.event"
DRAFT = {"product_id": "p-1", "version": 1, "title": "Kettle", "price_cents": 3499, "tax_class": "standard"}
V2 = {**DRAFT, "version": 2, "title": "Kettle, 2 L"}


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def _publish(m, draft, expected, changed):
    event = m.publish(draft["product_id"], draft, "kitchen", expected, changed)
    assert event is not None, f"publishing version {draft['version']} (expected {expected}) must move the pointer and answer the event"
    return event


def check_product_key(ctx):
    m = ctx.load("events")
    _publish(m, DRAFT, None, ["title", "price_cents", "tax_class"])
    _publish(m, V2, 1, ["title"])
    m.record_event("rollback", "p-1", "kitchen", DRAFT, [], published_version=1)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three events produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"p-1"] * 3, f"records must be keyed by the product id, got {keys}: keyed by anything else, one product's events scatter across partitions"
    partitions = {r.partition for r in records}
    assert len(partitions) == 1, f"p-1's events landed on partitions {sorted(partitions)}: one product's history must stay on one partition, in order"


def check_event_types(ctx):
    m = ctx.load("events")
    published = _publish(m, DRAFT, None, ["title"])
    held = m.record_event("hold", "p-1", "kitchen", V2, ["title"], published_version=1)
    rolled = m.record_event("rollback", "p-1", "kitchen", DRAFT, [], published_version=2)
    types = [_payload(r).get("type") for r in ctx.kafka.records(TOPIC)]
    assert types == ["catalog.publish", "catalog.hold", "catalog.rollback"], f"the three events carry types {types}, expected catalog.publish, catalog.hold, catalog.rollback"
    assert published.get("version") == 1 and published.get("published_version") == 1, f"the publish event must carry version 1 as version and published_version, got {published}"
    assert held.get("version") == 2 and held.get("published_version") == 1, f"a hold of version 2 while 1 is live must carry version 2 and published_version 1, got {held}"
    assert rolled.get("product_id") == "p-1" and rolled.get("category") == "kitchen", f"the event must carry product_id and category, got {rolled}"
    try:
        m.record_event("archive", "p-1", "kitchen", DRAFT, [])
    except Exception:
        pass
    else:
        raise AssertionError("an unknown kind (archive) must be refused, not forwarded as the event type")


def check_no_draft_values(ctx):
    m = ctx.load("events")
    _publish(m, DRAFT, None, ["title", "price_cents"])
    m.record_event("hold", "p-1", "kitchen", V2, ["title", "tax_class"], published_version=1)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 2, f"a publish and a hold produced {len(records)} records on {TOPIC}, expected 2"
    payload = _payload(records[0])
    for name, value in (("price_cents", 3499), ("title", "Kettle"), ("tax_class", "standard")):
        assert name not in payload, f"the event carries the draft's {name}: {payload}. The topic is retained and replicated; carry the names of the changed fields, not their values"
        assert value not in payload.values(), f"the event carries the draft's {name} ({value!r}) under another name: {payload}"
    for record in records:
        text = record.value.decode() if isinstance(record.value, bytes) else str(record.value)
        for value in ("3499", "Kettle", "standard"):
            assert value not in text, f"the record {text} carries a value of the draft ({value}), nested or under another name: carry the names of the changed fields only"
    assert payload.get("changed_fields") == ["price_cents", "title"], f"changed_fields must be the sorted names of the changed fields (given title, price_cents), got {payload.get('changed_fields')!r}"
    held = _payload(records[1]).get("changed_fields")
    assert held == ["tax_class", "title"], f"the hold's changed_fields must be the sorted names (given title, tax_class), got {held!r}"


def check_commit_before_produce(ctx):
    m = ctx.load("events")
    # The moment the pointer moves, what is already on the topic.
    at_commit = ctx.redis_after("catalog:p-1:published", lambda: len(ctx.kafka.records(TOPIC)))
    _publish(m, DRAFT, None, ["title"])
    assert at_commit.fired, "publish never moved catalog:p-1:published"
    assert at_commit.result == 0, f"when the pointer moved the topic already held {at_commit.result} record(s): the event described a version the catalog had not committed. Commit the snapshot, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after the publish the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 1"
    assert read_published("p-1") == DRAFT, f"the storefront serves {read_published('p-1')}"
    before = len(ctx.kafka.records(TOPIC))
    stale = m.publish("p-1", V2, "kitchen", 7, ["title"])
    assert stale is None, "a publish whose expected version is stale must not move the pointer and must answer None"
    assert len(ctx.kafka.records(TOPIC)) == before, "a publish that did not move the pointer must not produce an event"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    _publish(m, DRAFT, None, ["title"])
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish whose acknowledgement was lost left {len(records)} records on the topic: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    _publish(m, V2, 1, ["title"])
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the second event and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'catalog.event';
const DRAFT = {product_id: 'p-1', version: 1, title: 'Kettle', price_cents: 3499, tax_class: 'standard'};
const V2 = {...DRAFT, version: 2, title: 'Kettle, 2 L'};

function events(ctx) {
  const m = ctx.load('events');
  const {readPublished} = ctx.load('/support/catalog/snapshot.ts');
  return {m, readPublished};
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

async function publish(m, draft, expected: number | null, changed: string[]) {
  const event = await m.publish(draft.product_id, draft, 'kitchen', expected, changed);
  assert(event !== null, \`publishing version \${draft.version} (expected \${expected}) must move the pointer and answer the event\`);
  return event;
}

export async function check_product_key(ctx) {
  const {m} = events(ctx);
  await publish(m, DRAFT, null, ['title', 'price_cents', 'tax_class']);
  await publish(m, V2, 1, ['title']);
  await m.recordEvent('rollback', 'p-1', 'kitchen', DRAFT, [], 1);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three events produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['p-1', 'p-1', 'p-1'], \`records must be keyed by the product id, got \${JSON.stringify(keys)}: keyed by anything else, one product's events scatter across partitions\`);
  const partitions = [...new Set(records.map(r => r.partition))];
  assert.equal(partitions.length, 1, \`p-1's events landed on partitions \${JSON.stringify(partitions)}: one product's history must stay on one partition, in order\`);
}

export async function check_event_types(ctx) {
  const {m} = events(ctx);
  const published = await publish(m, DRAFT, null, ['title']);
  const held = await m.recordEvent('hold', 'p-1', 'kitchen', V2, ['title'], 1);
  const rolled = await m.recordEvent('rollback', 'p-1', 'kitchen', DRAFT, [], 2);
  const types = ctx.kafka.records(TOPIC).map(r => payload(r).type);
  assert.deepStrictEqual(types, ['catalog.publish', 'catalog.hold', 'catalog.rollback'], \`the three events carry types \${JSON.stringify(types)}, expected catalog.publish, catalog.hold, catalog.rollback\`);
  assert(published.version === 1 && published.published_version === 1, \`the publish event must carry version 1 as version and published_version, got \${JSON.stringify(published)}\`);
  assert(held.version === 2 && held.published_version === 1, \`a hold of version 2 while 1 is live must carry version 2 and published_version 1, got \${JSON.stringify(held)}\`);
  assert(rolled.product_id === 'p-1' && rolled.category === 'kitchen', \`the event must carry product_id and category, got \${JSON.stringify(rolled)}\`);
  await assert.rejects(m.recordEvent('archive', 'p-1', 'kitchen', DRAFT, []), 'an unknown kind (archive) must be refused, not forwarded as the event type');
}

export async function check_no_draft_values(ctx) {
  const {m} = events(ctx);
  await publish(m, DRAFT, null, ['title', 'price_cents']);
  await m.recordEvent('hold', 'p-1', 'kitchen', V2, ['title', 'tax_class'], 1);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 2, \`a publish and a hold produced \${records.length} records on \${TOPIC}, expected 2\`);
  const p = payload(records[0]);
  for (const [name, value] of [['price_cents', 3499], ['title', 'Kettle'], ['tax_class', 'standard']] as const) {
    assert(!(name in p), \`the event carries the draft's \${name}: \${JSON.stringify(p)}. The topic is retained and replicated; carry the names of the changed fields, not their values\`);
    assert(!Object.values(p).includes(value), \`the event carries the draft's \${name} (\${JSON.stringify(value)}) under another name: \${JSON.stringify(p)}\`);
  }
  for (const record of records) {
    const text = record.value.toString();
    for (const value of ['3499', 'Kettle', 'standard'])
      assert(!text.includes(value), \`the record \${text} carries a value of the draft (\${value}), nested or under another name: carry the names of the changed fields only\`);
  }
  assert.deepStrictEqual(p.changed_fields, ['price_cents', 'title'], \`changed_fields must be the sorted names of the changed fields (given title, price_cents), got \${JSON.stringify(p.changed_fields)}\`);
  const held = payload(records[1]).changed_fields;
  assert.deepStrictEqual(held, ['tax_class', 'title'], \`the hold's changed_fields must be the sorted names (given title, tax_class), got \${JSON.stringify(held)}\`);
}

export async function check_commit_before_produce(ctx) {
  const {m, readPublished} = events(ctx);
  // The moment the pointer moves, what is already on the topic.
  const atCommit = ctx.redisAfter('catalog:p-1:published', () => ctx.kafka.records(TOPIC).length);
  await publish(m, DRAFT, null, ['title']);
  assert(atCommit.fired, 'publish never moved catalog:p-1:published');
  assert.equal(atCommit.result, 0, \`when the pointer moved the topic already held \${atCommit.result} record(s): the event described a version the catalog had not committed. Commit the snapshot, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after the publish the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 1\`);
  assert.deepStrictEqual(await readPublished('p-1'), DRAFT, 'the storefront must serve version 1');
  const before = ctx.kafka.records(TOPIC).length;
  const stale = await m.publish('p-1', V2, 'kitchen', 7, ['title']);
  assert.equal(stale, null, 'a publish whose expected version is stale must not move the pointer and must answer null');
  assert.equal(ctx.kafka.records(TOPIC).length, before, 'a publish that did not move the pointer must not produce an event');
}

export async function check_idempotent_producer(ctx) {
  const {m} = events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await publish(m, DRAFT, null, ['title']);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one publish whose acknowledgement was lost left \${records.length} records on the topic: the producer's retry wrote the event twice. Make the producer idempotent (acks all)\`);
  await publish(m, V2, 1, ['title']);
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the second event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"catalog/snapshot"
	"catalog/store"

	"leetbuild/harness"
)

const hTopic = "catalog.event"

var (
	hEventsBg = context.Background()
	hDraft1   = store.Row{ProductID: "p-1", Version: 1, Status: "draft", Title: "Kettle", PriceCents: 3499, TaxClass: "standard"}
	hDraft2   = store.Row{ProductID: "p-1", Version: 2, Status: "draft", Title: "Kettle, 2 L", PriceCents: 3499, TaxClass: "standard"}
)

func hPayloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func hMustPublish(ctx *harness.Ctx, d store.Row, expected int, changed []string) map[string]any {
	event, err := publish(hEventsBg, d.ProductID, d, "kitchen", expected, changed)
	ctx.NoError(err, "publishing version %d (expected %d) failed", d.Version, expected)
	ctx.Assert(event != nil, "publishing version %d (expected %d) must move the pointer and answer the event", d.Version, expected)
	return event
}

func hMustRecord(ctx *harness.Ctx, kind string, d store.Row, changed []string, publishedVersion int) map[string]any {
	event, err := recordEvent(hEventsBg, kind, "p-1", "kitchen", d, changed, publishedVersion)
	ctx.NoError(err, "recordEvent(%q) failed", kind)
	return event
}

func CheckProductKey(ctx *harness.Ctx) {
	hMustPublish(ctx, hDraft1, 0, []string{"title", "price_cents", "tax_class"})
	hMustPublish(ctx, hDraft2, 1, []string{"title"})
	hMustRecord(ctx, "rollback", hDraft1, nil, 1)
	records := ctx.Kafka.Records(hTopic)
	ctx.Equal(len(records), 3, "three events must produce three records on %s; the records", hTopic)
	ctx.Equal(ctx.Kafka.Keys(hTopic), []string{"p-1", "p-1", "p-1"}, "records must be keyed by the product id (keyed by anything else, one product's events scatter across partitions)")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "p-1's events landed on partitions %d, %d, %d: one product's history must stay on one partition, in order", records[0].Partition, records[1].Partition, records[2].Partition)
}

func CheckEventTypes(ctx *harness.Ctx) {
	published := hMustPublish(ctx, hDraft1, 0, []string{"title"})
	held := hMustRecord(ctx, "hold", hDraft2, []string{"title"}, 1)
	rolled := hMustRecord(ctx, "rollback", hDraft1, nil, 2)
	var types []string
	for _, r := range ctx.Kafka.Records(hTopic) {
		t, _ := hPayloadOf(ctx, r.Value)["type"].(string)
		types = append(types, t)
	}
	ctx.Equal(types, []string{"catalog.publish", "catalog.hold", "catalog.rollback"}, "the three events' types")
	ctx.Assert(published["version"] == 1 && published["published_version"] == 1, "the publish event must carry version 1 as version and published_version, got %v", published)
	ctx.Assert(held["version"] == 2 && held["published_version"] == 1, "a hold of version 2 while 1 is live must carry version 2 and published_version 1, got %v", held)
	ctx.Assert(rolled["product_id"] == "p-1" && rolled["category"] == "kitchen", "the event must carry product_id and category, got %v", rolled)
	_, err := recordEvent(hEventsBg, "archive", "p-1", "kitchen", hDraft1, nil, 0)
	ctx.Assert(err != nil, "an unknown kind (archive) must be refused, not forwarded as the event type")
}

func CheckNoDraftValues(ctx *harness.Ctx) {
	hMustPublish(ctx, hDraft1, 0, []string{"title", "price_cents"})
	hMustRecord(ctx, "hold", hDraft2, []string{"title", "tax_class"}, 1)
	records := ctx.Kafka.Records(hTopic)
	ctx.Equal(len(records), 2, "a publish and a hold must produce two records on %s; the records", hTopic)
	p := hPayloadOf(ctx, records[0].Value)
	for _, name := range []string{"price_cents", "title", "tax_class"} {
		_, present := p[name]
		ctx.Assert(!present, "the event carries the draft's %s: %v. The topic is retained and replicated; carry the names of the changed fields, not their values", name, p)
	}
	for _, r := range records {
		text := string(r.Value)
		ctx.Assert(!strings.Contains(text, "3499") && !strings.Contains(text, "Kettle") && !strings.Contains(text, "standard"), "the record %s carries a value of the draft, nested or under another name: carry the names of the changed fields only", text)
	}
	ctx.Equal(p["changed_fields"], []any{"price_cents", "title"}, "changed_fields must be the sorted names of the changed fields (given title, price_cents)")
	ctx.Equal(hPayloadOf(ctx, records[1].Value)["changed_fields"], []any{"tax_class", "title"}, "the hold's changed_fields must be the sorted names (given title, tax_class)")
}

func CheckCommitBeforeProduce(ctx *harness.Ctx) {
	// The moment the pointer moves, what is already on the topic.
	atCommit := ctx.Redis.After("catalog:p-1:published", func() any { return len(ctx.Kafka.Records(hTopic)) })
	hMustPublish(ctx, hDraft1, 0, []string{"title"})
	ctx.Assert(atCommit.Fired, "publish never moved catalog:p-1:published")
	ctx.Equal(atCommit.Result, 0, "when the pointer moved the topic already held records: the event described a version the catalog had not committed. Commit the snapshot, then produce; records at the commit")
	ctx.Equal(len(ctx.Kafka.Records(hTopic)), 1, "after the publish, the records on the topic")
	s, err := snapshot.ReadPublished(hEventsBg, "p-1")
	ctx.NoError(err, "ReadPublished failed")
	ctx.Equal(s["version"], 1, "the storefront's published version")
	before := len(ctx.Kafka.Records(hTopic))
	stale, err := publish(hEventsBg, "p-1", hDraft2, "kitchen", 7, []string{"title"})
	ctx.NoError(err, "a stale publish must not fail")
	ctx.Assert(stale == nil, "a publish whose expected version is stale must not move the pointer and must answer nil, got %v", stale)
	ctx.Equal(len(ctx.Kafka.Records(hTopic)), before, "a publish that did not move the pointer must not produce an event; the records")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	hMustPublish(ctx, hDraft1, 0, []string{"title"})
	ctx.Equal(len(ctx.Kafka.Records(hTopic)), 1, "one publish, the records on the topic")
	hMustPublish(ctx, hDraft2, 1, []string{"title"})
	lost := ctx.Kafka.Failover(hTopic)
	ctx.Equal(len(ctx.Kafka.Records(hTopic)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged the event. Use RequireAll; the records on the topic", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

const std::string kHTopic = "catalog.event";
const store::Row kHDraft1{"p-1", 1, "draft", "Kettle", 3499, "standard"};
const store::Row kHDraft2{"p-1", 2, "draft", "Kettle, 2 L", 3499, "standard"};

json hPayloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  try {
    return json::parse(record.Value.value_or(""));
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", record.Value.value_or(""), e.what());
  }
}

json hMustPublish(harness::Ctx& ctx, const store::Row& d, long expected, const std::vector<std::string>& changed) {
  std::optional<json> event;
  try {
    event = publish(d.product_id, d, "kitchen", expected, changed);
  } catch (const std::exception& e) {
    ctx.Fatalf("publishing version %d (expected %d) threw %s: %s", d.version, expected, harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(event.has_value(), "publishing version %d (expected %d) must move the pointer and answer the event", d.version, expected);
  return *event;
}

}  // namespace

void CheckProductKey(harness::Ctx& ctx) {
  hMustPublish(ctx, kHDraft1, 0, {"title", "price_cents", "tax_class"});
  hMustPublish(ctx, kHDraft2, 1, {"title"});
  record_event("rollback", "p-1", "kitchen", kHDraft1, {}, 1);
  const auto records = ctx.Kafka.Records(kHTopic);
  ctx.Equal(records.size(), 3, "three events must produce three records on %s; the records", kHTopic);
  ctx.Equal(ctx.Kafka.Keys(kHTopic), {"p-1", "p-1", "p-1"}, "records must be keyed by the product id (keyed by anything else, one product's events scatter across partitions)");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
             "p-1's events landed on partitions %d, %d, %d: one product's history must stay on one partition, in order",
             records[0].Partition, records[1].Partition, records[2].Partition);
}

void CheckEventTypes(harness::Ctx& ctx) {
  const json published = hMustPublish(ctx, kHDraft1, 0, {"title"});
  const json held = record_event("hold", "p-1", "kitchen", kHDraft2, {"title"}, 1);
  const json rolled = record_event("rollback", "p-1", "kitchen", kHDraft1, {}, 2);
  std::vector<std::string> types;
  for (const auto& r : ctx.Kafka.Records(kHTopic)) types.push_back(hPayloadOf(ctx, r).value("type", ""));
  ctx.Equal(types, {"catalog.publish", "catalog.hold", "catalog.rollback"}, "the three events' types");
  ctx.Assert(published.value("version", 0L) == 1 && published.value("published_version", 0L) == 1,
             "the publish event must carry version 1 as version and published_version, got %s", published.dump());
  ctx.Assert(held.value("version", 0L) == 2 && held.value("published_version", 0L) == 1,
             "a hold of version 2 while 1 is live must carry version 2 and published_version 1, got %s", held.dump());
  ctx.Assert(rolled.value("product_id", "") == "p-1" && rolled.value("category", "") == "kitchen",
             "the event must carry product_id and category, got %s", rolled.dump());
  bool refused = false;
  try {
    record_event("archive", "p-1", "kitchen", kHDraft1, {});
  } catch (const std::exception&) {
    refused = true;
  }
  ctx.Assert(refused, "an unknown kind (archive) must be refused, not forwarded as the event type");
}

void CheckNoDraftValues(harness::Ctx& ctx) {
  hMustPublish(ctx, kHDraft1, 0, {"title", "price_cents"});
  record_event("hold", "p-1", "kitchen", kHDraft2, {"title", "tax_class"}, 1);
  const auto records = ctx.Kafka.Records(kHTopic);
  ctx.Equal(records.size(), 2, "a publish and a hold must produce two records on %s; the records", kHTopic);
  const json p = hPayloadOf(ctx, records[0]);
  for (const std::string name : {"price_cents", "title", "tax_class"}) {
    ctx.Assert(!p.contains(name), "the event carries the draft's %s: %s. The topic is retained and replicated; carry the names of the changed fields, not their values", name, p.dump());
  }
  for (const auto& record : records) {
    const std::string text = record.Value.value_or("");
    ctx.Assert(text.find("3499") == std::string::npos && text.find("Kettle") == std::string::npos && text.find("standard") == std::string::npos,
               "the record %s carries a value of the draft, nested or under another name: carry the names of the changed fields only", text);
  }
  ctx.Equal(p.value("changed_fields", std::vector<std::string>{}), {"price_cents", "title"}, "changed_fields must be the sorted names of the changed fields (given title, price_cents)");
  ctx.Equal(hPayloadOf(ctx, records[1]).value("changed_fields", std::vector<std::string>{}), {"tax_class", "title"}, "the hold's changed_fields must be the sorted names (given title, tax_class)");
}

void CheckCommitBeforeProduce(harness::Ctx& ctx) {
  // The moment the pointer moves, what is already on the topic.
  int atCommit = -1;
  ctx.Redis.After("catalog:p-1:published", [&] { atCommit = static_cast<int>(ctx.Kafka.Records(kHTopic).size()); });
  hMustPublish(ctx, kHDraft1, 0, {"title"});
  ctx.Assert(atCommit >= 0, "publish never moved catalog:p-1:published");
  ctx.Equal(atCommit, 0, "when the pointer moved the topic already held records: the event described a version the catalog had not committed. Commit the snapshot, then produce; records at the commit");
  ctx.Equal(ctx.Kafka.Records(kHTopic).size(), 1, "after the publish, the records on the topic");
  const auto s = snapshot::readPublished("p-1");
  ctx.Assert(s && s->value("version", 0L) == 1, "the storefront must serve version 1");
  const size_t before = ctx.Kafka.Records(kHTopic).size();
  const auto stale = publish("p-1", kHDraft2, "kitchen", 7, {"title"});
  ctx.Assert(!stale, "a publish whose expected version is stale must not move the pointer and must answer nothing");
  ctx.Equal(ctx.Kafka.Records(kHTopic).size(), before, "a publish that did not move the pointer must not produce an event; the records");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kHTopic, 1);
  hMustPublish(ctx, kHDraft1, 0, {"title"});
  ctx.Equal(ctx.Kafka.Records(kHTopic).size(), 1,
            "one publish whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records on the topic");
  hMustPublish(ctx, kHDraft2, 1, {"title"});
  const int lost = ctx.Kafka.Failover(kHTopic);
  ctx.Equal(ctx.Kafka.Records(kHTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    'Publish one product twice and watch the partitions: its two events sit on two of them, and the second one carries the draft price a shopper has not seen yet.',
    'The key decides the partition, and the key is the category. The payload is built from the draft row, so its values go out with it, and it goes out before the pointer moves.',
    'Key by `product_id`, map `kind` through `EVENT_TYPES`, send `version`, `published_version` and sorted `changed_fields` only, produce after `publish_snapshot` moved the pointer, and set `enable.idempotence` with `acks=all`.',
  ],
  debrief: `An event is a promise about state that already exists, which is why the snapshot commits before the record is produced and why a publish whose pointer did not move produces nothing. The key is the product because order only matters per product; the payload carries names and version ids because the topic outlives every rule the draft rows have about who may read a price. Idempotence with acks=all makes a retry after a lost acknowledgement write the record once on every replica, which is the cheapest exactly-once a producer gets. Production catalogs write the event into an outbox row in the same transaction as the version and let a relay produce it, so a broker outage delays the event without losing it.`,
};
