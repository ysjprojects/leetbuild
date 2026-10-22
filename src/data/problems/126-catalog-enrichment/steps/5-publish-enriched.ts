import type {Step} from '@/lib/types';

export const publishEnrichedStep: Step = {
  id: 'publish-enriched',
  title: 'sku.enriched: idempotent produce, outbox, index before commit, human wins',
  concept: 'kafka',
  file: 'enriched_events',
  focus: ['catalogd', 'enriched', 'indexer', 'search'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces an event when a
SKU's attributes are ready and a consumer writes them into the catalog. In the demo the catalog
updates, so it looks done. Five production contracts are broken. Find them, fix them, and prove
the fix with the checks below.

\`publish(sku_id, merchant, attributes, attributes_version, taxonomy_version, source)\` is how
catalogd announces a new attribute version — \`source\` is \`model\` (an accepted extraction) or
\`human\` (a review decision) — and the consumer in group **\`catalog-index\`** is what the rest of
DoorDash reads.

- Publish **one** \`sku.enriched\` event per attribute version with the **merchant** as the message
  key; the event id is \`{sku_id}:{attributes_version}\` and the payload carries sku, merchant,
  attributes, \`attributes_version\`, \`taxonomy_version\` and \`source\`.
- The producer must be **idempotent with \`acks=all\`** (or the stack's equivalent), so a retried
  produce cannot duplicate a version.
- When the broker rejects the produce, write the event to the **outbox** (\`insert_outbox\`)
  instead of dropping it or failing the caller; a relay republishes outbox rows.
- The consumer applies the event to the **catalog** and to the **search index**
  (\`search_index.upsert\`) — attributes that are in the catalog but not in the index are invisible
  to the search retrieval the source post describes — and **only then** commits the offset, with
  auto-commit off.
- **Human wins.** Before applying, read \`catalog.current(sku_id)\`: skip the event when its
  \`attributes_version\` is not newer, and skip a \`model\` event when the current attributes came
  from a \`human\`. A re-extraction after a taxonomy release must never overwrite a reviewer's
  correction.

**Failure mode the checks target.** An unconfigured producer duplicates on retry; a failed produce
silently loses the version; commit-before-write loses it on a crash; a consumer that skips the
search index leaves search serving stale attributes while the catalog looks right; and a consumer
that applies every event in arrival order lets the model undo the humans — the quiet one, because
it is only visible as a reviewer's fix mysteriously reverting a week later.`,
  sequence: {
    participants: ['catalogd', 'sku.enriched', 'Index consumer', 'catalog', 'search index'],
    messages: [
      {from: 'catalogd', to: 'sku.enriched', label: 'produce · key = merchant · acks = all · idempotent', kind: 'sync'},
      {from: 'sku.enriched', to: 'catalogd', label: 'ack / broker error', kind: 'reply'},
      {from: 'catalogd', to: 'catalogd', label: 'insert_outbox(merchant, event) on failure', kind: 'sync'},
      {from: 'sku.enriched', to: 'Index consumer', label: 'consume · group catalog-index', kind: 'async'},
      {from: 'Index consumer', to: 'catalog', label: 'current(sku_id) → {attributes_version, source}', kind: 'sync'},
      {from: 'Index consumer', to: 'catalog', label: 'apply(...) unless stale or human beats model', kind: 'sync'},
      {from: 'Index consumer', to: 'search index', label: 'upsert(sku_id, attributes)', kind: 'sync'},
      {from: 'Index consumer', to: 'sku.enriched', label: 'commit offset after both writes', kind: 'async'},
    ],
  },
  hints: [
    'Producer configuration first: `enable.idempotence=true` with `acks=all`, KafkaJS `idempotent: true` with `acks: -1`, kafka-go `RequireAll` with a hash balancer. Then wrap the produce: on a broker error, `insert_outbox(merchant, event)` and return normally.',
    'The consumer needs two writes and one decision before the commit: `catalog.current(sku_id)` tells you the version and source you would overwrite; apply only when the event is newer and not a model result over a human one; then `catalog.apply`, then `search_index.upsert`, then commit.',
    'Name the sources as constants (`SOURCE_MODEL`, `SOURCE_HUMAN`) and compare both sides: `current.source == SOURCE_HUMAN and event.source == SOURCE_MODEL` is the skip. A stale version check (`event.attributes_version <= current.attributes_version`) makes the consumer safe to replay.',
  ],
  checks: [
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. A retried produce must not duplicate an attribute version.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks",\s*"all"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox`/`insertOutbox`/`InsertOutbox`) in the error branch instead of dropping the event. The draft ignores the broker result.',
      match: {
        python: {all: [/outbox\.insert_outbox\(/, /except\s+KafkaException/]},
        typescript: {all: [/outbox\.insertOutbox\(/, /catch\s*\{/]},
        go: {all: [/outbox\.InsertOutbox\(/, /if err := enrichedWriter\.WriteMessages\(/]},
        scala: {all: [/outbox\.insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/outbox\.insertOutbox\(/, /!= RdKafka::ERR_NO_ERROR/]},
      },
    },
    {
      id: 'human-wins',
      title: 'Never overwrites a human correction with a model result',
      detail:
        'The consumer reads `catalog.current(sku_id)` and skips the event when its version is not newer or when a `model` event would replace `human` attributes (`SOURCE_HUMAN`, `SOURCE_MODEL`). The draft applies every event in arrival order.',
      match: {
        python: {
          all: [
            /SOURCE_MODEL\s*=\s*["']model["']/,
            /SOURCE_HUMAN\s*=\s*["']human["']/,
            /catalog\.current\(/,
            /attributes_version/,
          ],
        },
        typescript: {
          all: [
            /SOURCE_MODEL\s*=\s*['"]model['"]/,
            /SOURCE_HUMAN\s*=\s*['"]human['"]/,
            /catalog\.current\(/,
            /attributes_version/,
          ],
        },
        go: {
          all: [/sourceModel\s*=\s*"model"/, /sourceHuman\s*=\s*"human"/, /catalog\.Current\(/, /AttributesVersion/],
        },
        scala: {
          all: [/SourceModel\s*=\s*"model"/, /SourceHuman\s*=\s*"human"/, /catalog\.current\(/, /attributes_version/],
        },
        cpp: {
          all: [/kSourceModel\s*=\s*"model"/, /kSourceHuman\s*=\s*"human"/, /catalog\.current\(/, /attributes_version/],
        },
      },
    },
    {
      id: 'index-update',
      title: 'Updates the search index as well as the catalog',
      detail:
        'The consumer writes the attributes to the catalog and upserts them into the search index (`search_index.upsert`). The draft updates the catalog only, so search keeps serving the old attributes.',
      match: {
        python: {all: [/catalog\.apply\(/, /search_index\.upsert\(/]},
        typescript: {all: [/catalog\.apply\(/, /searchIndex\.upsert\(/]},
        go: {all: [/catalog\.Apply\(/, /searchIndex\.Upsert\(/]},
        scala: {all: [/catalog\.apply\(/, /searchIndex\.upsert\(/]},
        cpp: {all: [/catalog\.apply\(/, /searchIndex\.upsert\(/]},
      },
    },
    {
      id: 'commit-after-write',
      title: 'Commits the offset after both writes, with auto-commit off',
      detail:
        'Auto-commit is disabled and the offset is committed after the catalog and index writes; committing first makes a crash lose the version. The draft commits as soon as it has polled.',
      match: {
        python: {all: [/["']enable\.auto\.commit["']\s*:\s*False/], order: [/catalog\.apply\(/, /consumer\.commit\(/]},
        typescript: {all: [/autoCommit:\s*false/], order: [/catalog\.apply\(/, /commitOffsets\(/]},
        go: {all: [/\.FetchMessage\(/], order: [/catalog\.Apply\(/, /\.CommitMessages\(/], none: [/\.ReadMessage\(/]},
        scala: {all: [/ENABLE_AUTO_COMMIT_CONFIG,\s*"false"/], order: [/catalog\.apply\(/, /consumer\.commitSync\(/]},
        cpp: {all: [/"enable\.auto\.commit",\s*"false"/], order: [/catalog\.apply\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer

TOPIC = "sku.enriched"
GROUP = "catalog-index"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class Catalog:
    def apply(self, sku_id: str, attributes: dict, attributes_version: int, source: str) -> None:
        raise NotImplementedError


catalog = Catalog()


def publish(
    sku_id: str,
    merchant: str,
    attributes: dict,
    attributes_version: int,
    taxonomy_version: str,
    source: str,
) -> None:
    # TODO: this draft's producer is neither idempotent nor acks=all, it ignores a failed produce,
    # and the consumer commits before it writes, skips the search index, and lets a model event
    # overwrite a human correction. Review all five.
    event = {
        "id": f"{sku_id}:{attributes_version}",
        "sku_id": sku_id,
        "merchant": merchant,
        "attributes": attributes,
        "attributes_version": attributes_version,
        "taxonomy_version": taxonomy_version,
        "source": source,
    }
    producer.produce(TOPIC, key=merchant, value=json.dumps(event))
    producer.flush(2.0)


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        catalog.apply(event["sku_id"], event["attributes"], event["attributes_version"], event["source"])
`,
      solution: `import json

from confluent_kafka import Consumer, KafkaException, Producer

TOPIC = "sku.enriched"
GROUP = "catalog-index"
SOURCE_MODEL = "model"
SOURCE_HUMAN = "human"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class OutboxStore:
    def insert_outbox(self, merchant: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


class Catalog:
    def current(self, sku_id: str) -> dict | None:
        """The attributes the catalog serves now: {attributes_version, source}."""
        raise NotImplementedError

    def apply(self, sku_id: str, attributes: dict, attributes_version: int, source: str) -> None:
        raise NotImplementedError


class SearchIndex:
    def upsert(self, sku_id: str, attributes: dict) -> None:
        raise NotImplementedError


outbox = OutboxStore()
catalog = Catalog()
search_index = SearchIndex()


def publish(
    sku_id: str,
    merchant: str,
    attributes: dict,
    attributes_version: int,
    taxonomy_version: str,
    source: str,
) -> None:
    event = {
        "id": f"{sku_id}:{attributes_version}",
        "sku_id": sku_id,
        "merchant": merchant,
        "attributes": attributes,
        "attributes_version": attributes_version,
        "taxonomy_version": taxonomy_version,
        "source": source,
    }
    try:
        producer.produce(TOPIC, key=merchant, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        outbox.insert_outbox(merchant, event)


def should_apply(event: dict, current: dict | None) -> bool:
    """Newer than what the catalog serves, and never a model result over a human one."""
    if current is None:
        return True
    if event["attributes_version"] <= current["attributes_version"]:
        return False
    return not (current["source"] == SOURCE_HUMAN and event["source"] == SOURCE_MODEL)


def apply_event(event: dict) -> None:
    current = catalog.current(event["sku_id"])
    if not should_apply(event, current):
        return
    catalog.apply(event["sku_id"], event["attributes"], event["attributes_version"], event["source"])
    search_index.upsert(event["sku_id"], event["attributes"])


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": GROUP, "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            raise KafkaException(msg.error())
        apply_event(json.loads(msg.value()))
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** sku.enriched: a model-generated draft that drops failed produces and commits too early. */
import {Kafka} from 'kafkajs';

import {catalog} from './catalog';

const TOPIC = 'sku.enriched';
const GROUP = 'catalog-index';

const kafka = new Kafka({clientId: 'catalogd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export interface EnrichedEvent {
  id: string;
  sku_id: string;
  merchant: string;
  attributes: Record<string, unknown>;
  attributes_version: number;
  taxonomy_version: string;
  source: string;
}

export async function publish(
  skuId: string,
  merchant: string,
  attributes: Record<string, unknown>,
  attributesVersion: number,
  taxonomyVersion: string,
  source: string,
): Promise<void> {
  // TODO: this draft's producer is neither idempotent nor acks=all, it ignores a failed produce,
  // and the consumer commits before it writes, skips the search index, and lets a model event
  // overwrite a human correction. Review all five.
  const event: EnrichedEvent = {
    id: \`\${skuId}:\${attributesVersion}\`,
    sku_id: skuId,
    merchant,
    attributes,
    attributes_version: attributesVersion,
    taxonomy_version: taxonomyVersion,
    source,
  };
  await producer.send({topic: TOPIC, messages: [{key: merchant, value: JSON.stringify(event)}]});
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as EnrichedEvent;
      await catalog.apply(event.sku_id, event.attributes, event.attributes_version, event.source);
    },
  });
}
`,
      solution: `/** sku.enriched: idempotent produce with an outbox; catalog and index written before the commit. */
import {Kafka} from 'kafkajs';

import {catalog, outbox, searchIndex} from './catalog';

const TOPIC = 'sku.enriched';
const GROUP = 'catalog-index';
const SOURCE_MODEL = 'model';
const SOURCE_HUMAN = 'human';

const kafka = new Kafka({clientId: 'catalogd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

export interface EnrichedEvent {
  id: string;
  sku_id: string;
  merchant: string;
  attributes: Record<string, unknown>;
  attributes_version: number;
  taxonomy_version: string;
  source: string;
}

export async function publish(
  skuId: string,
  merchant: string,
  attributes: Record<string, unknown>,
  attributesVersion: number,
  taxonomyVersion: string,
  source: string,
): Promise<void> {
  const event: EnrichedEvent = {
    id: \`\${skuId}:\${attributesVersion}\`,
    sku_id: skuId,
    merchant,
    attributes,
    attributes_version: attributesVersion,
    taxonomy_version: taxonomyVersion,
    source,
  };
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: merchant, value: JSON.stringify(event)}]});
  } catch {
    await outbox.insertOutbox(merchant, event);
  }
}

/** Newer than what the catalog serves, and never a model result over a human one. */
function shouldApply(event: EnrichedEvent, current: {attributes_version: number; source: string} | null): boolean {
  if (current === null) return true;
  if (event.attributes_version <= current.attributes_version) return false;
  return !(current.source === SOURCE_HUMAN && event.source === SOURCE_MODEL);
}

async function applyEvent(event: EnrichedEvent): Promise<void> {
  const current = await catalog.current(event.sku_id);
  if (!shouldApply(event, current)) return;
  await catalog.apply(event.sku_id, event.attributes, event.attributes_version, event.source);
  await searchIndex.upsert(event.sku_id, event.attributes);
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as EnrichedEvent;
      await applyEvent(event);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
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
	"fmt"
	"log"

	"github.com/segmentio/kafka-go"
)

const (
	topic = "sku.enriched"
	group = "catalog-index"
)

var enrichedWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic}

type EnrichedEvent struct {
	ID                string         \`json:"id"\`
	SkuID             string         \`json:"sku_id"\`
	Merchant          string         \`json:"merchant"\`
	Attributes        map[string]any \`json:"attributes"\`
	AttributesVersion int64          \`json:"attributes_version"\`
	TaxonomyVersion   string         \`json:"taxonomy_version"\`
	Source            string         \`json:"source"\`
}

type Catalog struct{}

func (c *Catalog) Apply(ctx context.Context, skuID string, attributes map[string]any, version int64, source string) error {
	return nil
}

var catalog = &Catalog{}

// TODO: this draft's producer is neither idempotent nor acks=all, it ignores a failed produce,
// and the consumer commits before it writes, skips the search index, and lets a model event
// overwrite a human correction. Review all five.
func publish(ctx context.Context, skuID, merchant string, attributes map[string]any, attributesVersion int64, taxonomyVersion, source string) {
	event := EnrichedEvent{
		ID:                fmt.Sprintf("%s:%d", skuID, attributesVersion),
		SkuID:             skuID,
		Merchant:          merchant,
		Attributes:        attributes,
		AttributesVersion: attributesVersion,
		TaxonomyVersion:   taxonomyVersion,
		Source:            source,
	}
	payload, _ := json.Marshal(event)
	_ = enrichedWriter.WriteMessages(ctx, kafka.Message{Key: []byte(merchant), Value: payload})
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: group,
	})
	for {
		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			log.Printf("read failed: %v", err)
			continue
		}
		var event EnrichedEvent
		_ = json.Unmarshal(msg.Value, &event)
		_ = catalog.Apply(ctx, event.SkuID, event.Attributes, event.AttributesVersion, event.Source)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"

	"github.com/segmentio/kafka-go"
)

const (
	topic       = "sku.enriched"
	group       = "catalog-index"
	sourceModel = "model"
	sourceHuman = "human"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var enrichedWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type EnrichedEvent struct {
	ID                string         \`json:"id"\`
	SkuID             string         \`json:"sku_id"\`
	Merchant          string         \`json:"merchant"\`
	Attributes        map[string]any \`json:"attributes"\`
	AttributesVersion int64          \`json:"attributes_version"\`
	TaxonomyVersion   string         \`json:"taxonomy_version"\`
	Source            string         \`json:"source"\`
}

// Current is what the catalog serves for a SKU now.
type Current struct {
	AttributesVersion int64
	Source            string
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, merchant string, event EnrichedEvent) error {
	return nil
}

type Catalog struct{}

func (c *Catalog) Current(ctx context.Context, skuID string) (*Current, error) { return nil, nil }

func (c *Catalog) Apply(ctx context.Context, skuID string, attributes map[string]any, version int64, source string) error {
	return nil
}

type SearchIndex struct{}

func (s *SearchIndex) Upsert(ctx context.Context, skuID string, attributes map[string]any) error {
	return nil
}

var (
	outbox      = &OutboxStore{}
	catalog     = &Catalog{}
	searchIndex = &SearchIndex{}
)

func publish(ctx context.Context, skuID, merchant string, attributes map[string]any, attributesVersion int64, taxonomyVersion, source string) error {
	event := EnrichedEvent{
		ID:                fmt.Sprintf("%s:%d", skuID, attributesVersion),
		SkuID:             skuID,
		Merchant:          merchant,
		Attributes:        attributes,
		AttributesVersion: attributesVersion,
		TaxonomyVersion:   taxonomyVersion,
		Source:            source,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := enrichedWriter.WriteMessages(ctx, kafka.Message{Key: []byte(merchant), Value: payload}); err != nil {
		return outbox.InsertOutbox(ctx, merchant, event)
	}
	return nil
}

// shouldApply: newer than what the catalog serves, and never a model result over a human one.
func shouldApply(event EnrichedEvent, current *Current) bool {
	if current == nil {
		return true
	}
	if event.AttributesVersion <= current.AttributesVersion {
		return false
	}
	return !(current.Source == sourceHuman && event.Source == sourceModel)
}

func applyEvent(ctx context.Context, event EnrichedEvent) error {
	current, err := catalog.Current(ctx, event.SkuID)
	if err != nil {
		return err
	}
	if !shouldApply(event, current) {
		return nil
	}
	if err := catalog.Apply(ctx, event.SkuID, event.Attributes, event.AttributesVersion, event.Source); err != nil {
		return err
	}
	return searchIndex.Upsert(ctx, event.SkuID, event.Attributes)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: group,
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			log.Printf("fetch failed: %v", err)
			continue
		}
		var event EnrichedEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed event at offset %d: %v", msg.Offset, err)
		} else if err := applyEvent(ctx, event); err != nil {
			log.Printf("apply failed, event will be redelivered: %v", err)
			continue
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			log.Printf("commit failed: %v", err)
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object EnrichedEvents {
  val Topic = "sku.enriched"
  val Group = "catalog-index"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringSerializer")
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringSerializer")
    props
  })
  val catalog = Catalog.open()

  // TODO: this draft's producer is neither idempotent nor acks=all, it ignores a failed produce,
  // and the consumer commits before it writes, skips the search index, and lets a model event
  // overwrite a human correction. Review all five.
  def publish(
      skuId: String,
      merchant: String,
      attributes: JsObject,
      attributesVersion: Long,
      taxonomyVersion: String,
      source: String): Unit = {
    val event = JsObject(
      "id" -> JsString(s"$skuId:$attributesVersion"),
      "sku_id" -> JsString(skuId),
      "merchant" -> JsString(merchant),
      "attributes" -> attributes,
      "attributes_version" -> JsNumber(attributesVersion),
      "taxonomy_version" -> JsString(taxonomyVersion),
      "source" -> JsString(source)
    )
    producer.send(new ProducerRecord(Topic, merchant, event.compactPrint))
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringDeserializer")
    props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringDeserializer")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        catalog.apply(
          event("sku_id").convertTo[String],
          event("attributes").asJsObject,
          event("attributes_version").convertTo[Long],
          event("source").convertTo[String]
        )
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object EnrichedEvents {
  val Topic = "sku.enriched"
  val Group = "catalog-index"
  val SourceModel = "model"
  val SourceHuman = "human"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringSerializer")
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringSerializer")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val outbox = OutboxStore.open()
  val catalog = Catalog.open()
  val searchIndex = SearchIndex.open()

  def publish(
      skuId: String,
      merchant: String,
      attributes: JsObject,
      attributesVersion: Long,
      taxonomyVersion: String,
      source: String): Unit = {
    val event = JsObject(
      "id" -> JsString(s"$skuId:$attributesVersion"),
      "sku_id" -> JsString(skuId),
      "merchant" -> JsString(merchant),
      "attributes" -> attributes,
      "attributes_version" -> JsNumber(attributesVersion),
      "taxonomy_version" -> JsString(taxonomyVersion),
      "source" -> JsString(source)
    )
    try {
      producer.send(new ProducerRecord(Topic, merchant, event.compactPrint)).get()
    } catch {
      case _: Exception =>
        outbox.insertOutbox(merchant, event)
    }
  }

  /** Newer than what the catalog serves, and never a model result over a human one. */
  def shouldApply(attributesVersion: Long, source: String, current: Option[CatalogCurrent]): Boolean =
    current match {
      case None => true
      case Some(c) if attributesVersion <= c.attributesVersion => false
      case Some(c) => !(c.source == SourceHuman && source == SourceModel)
    }

  def applyEvent(event: Map[String, JsValue]): Unit = {
    val skuId = event("sku_id").convertTo[String]
    val attributesVersion = event("attributes_version").convertTo[Long]
    val source = event("source").convertTo[String]
    if (shouldApply(attributesVersion, source, catalog.current(skuId))) {
      val attributes = event("attributes").asJsObject
      catalog.apply(skuId, attributes, attributesVersion, source)
      searchIndex.upsert(skuId, attributes)
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringDeserializer")
    props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringDeserializer")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        applyEvent(record.value().parseJson.asJsObject.fields)
        consumer.commitSync()
      }
    }
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

const std::string kTopic = "sku.enriched";
const std::string kGroup = "catalog-index";

struct Catalog {
  void apply(const std::string& skuId, const json& attributes, long long attributesVersion, const std::string& source);
};

Catalog catalog;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: this draft's producer is neither idempotent nor acks=all, it ignores a failed produce,
// and the consumer commits before it writes, skips the search index, and lets a model event
// overwrite a human correction. Review all five.
void publish(const std::string& skuId, const std::string& merchant, const json& attributes, long long attributesVersion,
             const std::string& taxonomyVersion, const std::string& source) {
  const json event = {{"id", skuId + ":" + std::to_string(attributesVersion)},
                      {"sku_id", skuId},
                      {"merchant", merchant},
                      {"attributes", attributes},
                      {"attributes_version", attributesVersion},
                      {"taxonomy_version", taxonomyVersion},
                      {"source", source}};
  const auto payload = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), merchant.data(), merchant.size(), 0, nullptr);
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto* bytes = static_cast<const char*>(msg->payload());
    const json event = json::parse(bytes, bytes + msg->len());
    catalog.apply(event["sku_id"].get<std::string>(), event["attributes"], event["attributes_version"].get<long long>(),
                  event["source"].get<std::string>());
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "sku.enriched";
const std::string kGroup = "catalog-index";
const std::string kSourceModel = "model";
const std::string kSourceHuman = "human";

// What the catalog serves for a SKU now.
struct CatalogCurrent {
  long long attributesVersion;
  std::string source;
};

struct OutboxStore {
  void insertOutbox(const std::string& merchant, const json& event);
};

struct Catalog {
  std::optional<CatalogCurrent> current(const std::string& skuId);
  void apply(const std::string& skuId, const json& attributes, long long attributesVersion, const std::string& source);
};

struct SearchIndex {
  void upsert(const std::string& skuId, const json& attributes);
};

OutboxStore outbox;
Catalog catalog;
SearchIndex searchIndex;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

void publish(const std::string& skuId, const std::string& merchant, const json& attributes, long long attributesVersion,
             const std::string& taxonomyVersion, const std::string& source) {
  const json event = {{"id", skuId + ":" + std::to_string(attributesVersion)},
                      {"sku_id", skuId},
                      {"merchant", merchant},
                      {"attributes", attributes},
                      {"attributes_version", attributesVersion},
                      {"taxonomy_version", taxonomyVersion},
                      {"source", source}};
  const auto payload = event.dump();
  const auto err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                     const_cast<char*>(payload.data()), payload.size(), merchant.data(),
                                     merchant.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox.insertOutbox(merchant, event);
    return;
  }
  producer->flush(2000);
}

// Newer than what the catalog serves, and never a model result over a human one.
bool shouldApply(long long attributesVersion, const std::string& source, const std::optional<CatalogCurrent>& current) {
  if (!current) return true;
  if (attributesVersion <= current->attributesVersion) return false;
  return !(current->source == kSourceHuman && source == kSourceModel);
}

void applyEvent(const json& event) {
  const auto skuId = event["sku_id"].get<std::string>();
  const auto attributesVersion = event["attributes_version"].get<long long>();
  const auto source = event["source"].get<std::string>();
  if (!shouldApply(attributesVersion, source, catalog.current(skuId))) return;
  catalog.apply(skuId, event["attributes"], attributesVersion, source);
  searchIndex.upsert(skuId, event["attributes"]);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto* bytes = static_cast<const char*>(msg->payload());
    const json event = json::parse(bytes, bytes + msg->len(), nullptr, false);
    if (event.is_object()) applyEvent(event);
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  debrief: `The interviewer is checking the three things a generated Kafka snippet almost always gets wrong — the producer needs idempotence and acks=all for retries, a failed produce goes to an outbox rather than the void, and the consumer applies its writes before the offset commit — plus two that are specific to a catalog fed by a model. The search index is the first: the source post's reason for extracting attributes at all is that search, ranking and substitutions read them, and a consumer that updates the catalog table but not the index leaves the most visible reader stale. The precedence rule is the second: once a human has corrected a SKU, a later model result — a re-extraction after a taxonomy release, a replayed partition — must not undo it, and a consumer that applies events in arrival order will. Checking the current version and source before the write makes the consumer safe to replay and keeps the humans in charge. Real pipelines add schema registry enforcement on the topic, a compacted topic keyed by SKU so a new consumer can bootstrap from the latest version, and an alert on the age of the oldest outbox row.`,
};
