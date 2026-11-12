import type {Step} from '@/lib/types';

export const publishEnrichedStep: Step = {
  id: 'publish-enriched',
  title: 'sku.enriched: idempotent produce, outbox, index before commit, human wins',
  concept: 'kafka',
  file: 'enriched_events',
  focus: ['catalogd', 'enriched', 'indexer', 'search'],
  task: `## Task

**Starting point.** The starter is both ends of \`sku.enriched\`. \`publish(event)\` produces
\`{sku_id, merchant, attributes, attributes_version, taxonomy_version, source}\` keyed by the merchant
with a default producer and ignores the delivery report; step 4 calls it for every reviewer decision.
\`run_indexer()\` consumes the topic in group \`catalog-index\` with auto-commit off, commits each
record as it arrives, then \`store.apply_catalog(event)\`. It hides 5 flaws.

**Failure mode the checks target.** A retry after a lost acknowledgement writes an event twice; an
event the broker refused is gone; a crash between the commit and the write loses the version;
search keeps serving yesterday's attributes; and a later model run undoes a reviewer's correction,
visible only weeks later as a bad brand coming back.

- The producer is idempotent with \`acks=all\` (Go: confluent-kafka-go, which has an idempotent
  producer; kafka-go does not).
- A delivery failure, read from the delivery report, writes \`store.insert_outbox(event, reason)\`.
- The indexer writes \`store.apply_catalog\` and \`store.index_upsert\`, then commits.
- It reads \`store.catalog_current(sku_id)\` first and skips an event whose \`attributes_version\` is
  not newer, and a \`model\` event over attributes a \`human\` set.`,
  sequence: {
    participants: ['catalogd', 'sku.enriched', 'Indexer', 'Redis'],
    messages: [
      {from: 'catalogd', to: 'sku.enriched', label: 'produce · key = merchant · idempotent · acks=all', kind: 'async'},
      {from: 'sku.enriched', to: 'catalogd', label: 'delivery report: error → outbox:enriched', kind: 'reply'},
      {from: 'sku.enriched', to: 'Indexer', label: 'consume · group catalog-index', kind: 'async'},
      {from: 'Indexer', to: 'Redis', label: 'HGETALL catalog:{sku_id} → version, source', kind: 'sync'},
      {
        from: 'Indexer',
        to: 'Redis',
        label: 'catalog:{sku_id} · search:{sku_id} unless stale or model over human',
        kind: 'sync',
      },
      {from: 'Indexer', to: 'sku.enriched', label: 'commit offset (after both writes)', kind: 'sync'},
    ],
  },
  hints: [
    'A reviewer fixes a brand and the next model run brings the wrong one back; search shows a size the catalog no longer has; after a broker hiccup an event is on the topic twice and another is missing.',
    'The producer has no idempotence and nobody reads its delivery report; the indexer commits before it writes, writes only the catalog, and applies events in arrival order without reading what it overwrites.',
    'Set `enable.idempotence` and `acks=all`; pass `on_delivery` that calls `store.insert_outbox`; in the loop read `store.catalog_current`, skip stale or model-over-human events, `apply_catalog` and `index_upsert`, then commit.',
  ],
  checks: [
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'A retry after a lost acknowledgement is written once and a leader failover keeps what was acknowledged. The starter uses a default producer, so the retry duplicates the event.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/ENABLE_IDEMPOTENCE_CONFIG,\s*"true"/, /ACKS_CONFIG,\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox',
      title: 'A refused event goes to the outbox',
      detail:
        "The delivery report (`on_delivery`, the send promise's rejection, the delivery channel, the `Callback`, `dr_cb`) writes a refused event to `store.insert_outbox(event, reason)` for the relay. The starter ignores the report, so the event is lost.",
      match: {
        python: {all: [/store\.insert_outbox\(/, /on_delivery\s*=/], none: [/except KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/store\.InsertOutbox\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /Callback/]},
        cpp: {all: [/store::insert_outbox\(/, /dr_cb/]},
      },
    },
    {
      id: 'commit-after-apply',
      title: 'Commits only after the catalog write',
      detail:
        'The offset is committed after the event is applied, so a crash in between redelivers it. The starter commits each record before writing it.',
      match: {
        python: {order: [/store\.apply_catalog\(/, /consumer\.commit\(/]},
        typescript: {order: [/applyCatalog\(/, /commitOffsets\(/]},
        go: {order: [/store\.ApplyCatalog\(/, /CommitMessage\(/]},
        scala: {order: [/Store\.applyCatalog\(/, /commitSync\(/]},
        cpp: {order: [/store::apply_catalog\(/, /commitSync\(/]},
      },
    },
    {
      id: 'search-index',
      title: 'Updates the search index with the catalog',
      detail:
        'Every applied event is written to the catalog and to the search index (`store.index_upsert`), so a shopper searching sees the attributes the product page shows. The starter writes the catalog only.',
      match: {
        python: {all: [/store\.index_upsert\(/]},
        typescript: {all: [/indexUpsert\(/]},
        go: {all: [/store\.IndexUpsert\(/]},
        scala: {all: [/Store\.indexUpsert\(/]},
        cpp: {all: [/store::index_upsert\(/]},
      },
    },
    {
      id: 'human-wins',
      title: 'Skips stale events and model events over human attributes',
      detail:
        "The indexer reads `store.catalog_current` first and skips an event whose `attributes_version` is not newer, and a `model` event when a `human` set the current attributes. The starter applies events in arrival order, so a replay or a later model run overwrites a reviewer's correction.",
      match: {
        python: {all: [/store\.catalog_current\(/, /["']human["']/]},
        typescript: {all: [/catalogCurrent\(/, /'human'/]},
        go: {all: [/store\.CatalogCurrent\(/, /"human"/]},
        scala: {all: [/Store\.catalogCurrent\(/, /"human"/]},
        cpp: {all: [/store::catalog_current\(/, /"human"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer

from enrich import store  # apply_catalog, index_upsert, catalog_current, insert_outbox

TOPIC = "sku.enriched"
GROUP = "catalog-index"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish(event: dict) -> None:
    """One sku.enriched event: {sku_id, merchant, attributes, attributes_version, taxonomy_version, source}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    producer.produce(TOPIC, key=event["merchant"], value=json.dumps(event))
    producer.poll(0)


def run_indexer() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(message=msg, asynchronous=False)
        store.apply_catalog(json.loads(msg.value()))
`,
      solution: `import json

from confluent_kafka import Consumer, Producer

from enrich import store  # apply_catalog, index_upsert, catalog_current, insert_outbox

TOPIC = "sku.enriched"
GROUP = "catalog-index"

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        store.insert_outbox(json.loads(msg.value()), str(err))  # the broker refused it: the relay produces it later


def publish(event: dict) -> None:
    """One sku.enriched event: {sku_id, merchant, attributes, attributes_version, taxonomy_version, source}."""
    producer.produce(TOPIC, key=event["merchant"], value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery reports


def should_apply(current: dict | None, event: dict) -> bool:
    if current is None:
        return True
    if event["attributes_version"] <= current["attributes_version"]:
        return False  # a replay or an older version
    return not (event["source"] == "model" and current["source"] == "human")  # a reviewer's correction stands


def run_indexer() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        if should_apply(store.catalog_current(event["sku_id"]), event):
            store.apply_catalog(event)
            store.index_upsert(event)
        consumer.commit(message=msg, asynchronous=False)  # after the writes: a crash before this point redelivers
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type EnrichedEvent, applyCatalog} from 'enrich/store';

export const TOPIC = 'sku.enriched';
export const GROUP = 'catalog-index';

const kafka = new Kafka({clientId: 'catalogd', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();

/** One sku.enriched event. */
export async function publish(event: EnrichedEvent): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  await producer.send({topic: TOPIC, messages: [{key: event.merchant, value: JSON.stringify(event)}]}).catch(() => undefined);
}

export async function runIndexer(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await applyCatalog(JSON.parse(Buffer.from(message.value ?? []).toString('utf8')) as EnrichedEvent);
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type EnrichedEvent, type Entry, applyCatalog, catalogCurrent, indexUpsert, insertOutbox} from 'enrich/store';

export const TOPIC = 'sku.enriched';
export const GROUP = 'catalog-index';

const kafka = new Kafka({clientId: 'catalogd', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true}); // idempotent implies acks: -1 (all)
void producer.connect();

/** One sku.enriched event. */
export async function publish(event: EnrichedEvent): Promise<void> {
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: event.merchant, value: JSON.stringify(event)}]});
  } catch (e) {
    await insertOutbox(event, (e as Error).message); // the broker refused it: the relay produces it later
  }
}

function shouldApply(current: Entry | null, event: EnrichedEvent): boolean {
  if (current === null) return true;
  if (event.attributes_version <= current.attributes_version) return false; // a replay or an older version
  return !(event.source === 'model' && current.source === 'human'); // a reviewer's correction stands
}

export async function runIndexer(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(Buffer.from(message.value ?? []).toString('utf8')) as EnrichedEvent;
      if (shouldApply(await catalogCurrent(event.sku_id), event)) {
        await applyCatalog(event);
        await indexUpsert(event);
      }
      // After the writes: a crash before this point redelivers.
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"enrich/store" // store.Event, ApplyCatalog, IndexUpsert, CatalogCurrent, InsertOutbox
)

const (
	topic = "sku.enriched"
	group = "catalog-index"
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

// publish puts one sku.enriched event on the topic, keyed by the merchant.
func publish(ctx context.Context, event store.Event) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(event)
	t := topic
	deliveries := make(chan kafka.Event, 1)
	if err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(event.Merchant), Value: value}, deliveries); err != nil {
		return err
	}
	<-deliveries
	return nil
}

func runIndexer(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": group, "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		return err
	}
	if err := consumer.SubscribeTopics([]string{topic}, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
		var event store.Event
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if err := store.ApplyCatalog(ctx, event); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"enrich/store" // store.Event, ApplyCatalog, IndexUpsert, CatalogCurrent, InsertOutbox
)

const (
	topic = "sku.enriched"
	group = "catalog-index"
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the event before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// publish puts one sku.enriched event on the topic, keyed by the merchant.
func publish(ctx context.Context, event store.Event) error {
	value, _ := json.Marshal(event)
	t := topic
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(event.Merchant), Value: value}, deliveries)
	if err == nil {
		err = (<-deliveries).(*kafka.Message).TopicPartition.Error // the delivery report
	}
	if err != nil {
		return store.InsertOutbox(ctx, event, err.Error()) // the broker refused it: the relay produces it later
	}
	return nil
}

func shouldApply(current *store.Entry, event store.Event) bool {
	if current == nil {
		return true
	}
	if event.AttributesVersion <= current.AttributesVersion {
		return false // a replay or an older version
	}
	return !(event.Source == "model" && current.Source == "human") // a reviewer's correction stands
}

func runIndexer(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": group, "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		return err
	}
	if err := consumer.SubscribeTopics([]string{topic}, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		var event store.Event
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if shouldApply(store.CatalogCurrent(ctx, event.SkuID), event) {
			if err := store.ApplyCatalog(ctx, event); err != nil {
				return err
			}
			if err := store.IndexUpsert(ctx, event); err != nil {
				return err
			}
		}
		if _, err := consumer.CommitMessage(msg); err != nil { // after the writes: a crash before this point redelivers
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}

import scala.jdk.CollectionConverters._

import enrich.Store // Store.applyCatalog, indexUpsert, catalogCurrent, insertOutbox

object EnrichedEvents {
  val Topic = "sku.enriched"
  val Group = "catalog-index"

  private val producer = {
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** One sku.enriched event: {sku_id, merchant, attributes, attributes_version, taxonomy_version, source}. */
  def publish(event: ujson.Value): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    producer.send(new ProducerRecord[String, String](Topic, event("merchant").str, ujson.write(event)))
  }

  def runIndexer(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
        Store.applyCatalog(ujson.read(record.value()))
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerConfig, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}

import scala.jdk.CollectionConverters._

import enrich.Store // Store.applyCatalog, indexUpsert, catalogCurrent, insertOutbox

object EnrichedEvents {
  val Topic = "sku.enriched"
  val Group = "catalog-index"

  private val producer = {
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
    props.put(ProducerConfig.ACKS_CONFIG, "all")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** One sku.enriched event: {sku_id, merchant, attributes, attributes_version, taxonomy_version, source}. */
  def publish(event: ujson.Value): Unit = {
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) Store.insertOutbox(event, exception.getMessage) // the broker refused it: the relay produces it later
    }
    producer.send(new ProducerRecord[String, String](Topic, event("merchant").str, ujson.write(event)), onDelivery)
  }

  def shouldApply(current: Option[ujson.Obj], event: ujson.Value): Boolean = current match {
    case None => true
    case Some(now) =>
      // a newer version only, and a reviewer's correction stands against the model
      event("attributes_version").num > now("attributes_version").num && !(event("source").str == "model" && now("source").str == "human")
  }

  def runIndexer(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = ujson.read(record.value())
        if (shouldApply(Store.catalogCurrent(event("sku_id").str), event)) {
          Store.applyCatalog(event)
          Store.indexUpsert(event)
        }
        // After the writes: a crash before this point redelivers.
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "enrich/store.h"  // store::apply_catalog, index_upsert, catalog_current, insert_outbox

using json = nlohmann::json;

const std::string kTopic = "sku.enriched";
const std::string kGroup = "catalog-index";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One sku.enriched event: {sku_id, merchant, attributes, attributes_version, taxonomy_version, source}.
void publish(const json& event) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string value = event.dump();
  const std::string merchant = event["merchant"];
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    merchant.c_str(), merchant.size(), 0, nullptr);
  producer->poll(0);
}

void run_indexer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    store::apply_catalog(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <string>

#include "enrich/store.h"  // store::apply_catalog, index_upsert, catalog_current, insert_outbox

using json = nlohmann::json;

const std::string kTopic = "sku.enriched";
const std::string kGroup = "catalog-index";

// The delivery report: a refused event goes to the outbox for the relay to produce later.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    store::insert_outbox(json::parse(std::string(static_cast<const char*>(message.payload()), message.len())), message.errstr());
  }
};

ToOutbox delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One sku.enriched event: {sku_id, merchant, attributes, attributes_version, taxonomy_version, source}.
void publish(const json& event) {
  const std::string value = event.dump();
  const std::string merchant = event["merchant"];
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                        merchant.c_str(), merchant.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) store::insert_outbox(event, RdKafka::err2str(err));  // refused before it was queued
  producer->poll(0);  // serve delivery reports
}

bool should_apply(const std::optional<json>& current, const json& event) {
  if (!current) return true;
  if (event["attributes_version"].get<long long>() <= (*current)["attributes_version"].get<long long>()) return false;  // a replay or an older version
  return !(event["source"] == "model" && (*current)["source"] == "human");  // a reviewer's correction stands
}

void run_indexer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    if (should_apply(store::catalog_current(event["sku_id"]), event)) {
      store::apply_catalog(event);
      store::index_upsert(event);
    }
    consumer->commitSync(msg.get());  // after the writes: a crash before this point redelivers
  }
}
`,
    },
  },
  harness: {
    python: `import json

from enrich import store, taxonomy

GROUP = "catalog-index"


def _event(sku_id="sku-1", version=1, source="model", brand="Oatly"):
    attributes = {"brand": brand, "size": 1.0, "unit": "l", "organic": False, "category": "plant-milk"}
    return {"sku_id": sku_id, "merchant": "m-1", "attributes": attributes, "attributes_version": version, "taxonomy_version": taxonomy.VERSION, "source": source}


def _seed(ctx, *events):
    for event in events:
        ctx.kafka.seed("sku.enriched", key=event["merchant"], value=json.dumps(event))


def _versions(ctx):
    return [json.loads(r.value)["attributes_version"] for r in ctx.kafka.records("sku.enriched")]


def _index(ctx):
    m = ctx.load("enriched_events")
    ctx.drain(m.run_indexer)


def check_idempotent_acks(ctx):
    m = ctx.load("enriched_events")
    ctx.kafka.lose_acks("sku.enriched", 1)
    m.publish(_event())
    m.producer.poll(0)
    assert _versions(ctx) == [1], f"after one produce whose acknowledgement was lost sku.enriched holds versions {_versions(ctx)}: the retry wrote the event again. Enable idempotence"
    m.publish(_event(version=2))
    m.producer.poll(0)
    ctx.kafka.failover("sku.enriched")
    assert 2 in _versions(ctx), "a leader failover right after the acknowledgement lost the event: wait for every in-sync replica (acks=all)"


def check_outbox(ctx):
    m = ctx.load("enriched_events")
    ctx.kafka.fail_next("sku.enriched", 1)
    try:
        m.publish(_event())
        m.producer.poll(0)
    except Exception as exc:  # noqa: BLE001 - what it raised is the verdict
        raise AssertionError(f"publish raised {exc!r} when the broker refused the event: write it to the outbox instead") from None
    rows = [json.loads(row) for row in ctx.redis.lrange("outbox:enriched", 0, -1)]
    assert rows, "the broker refused the event and nothing reached outbox:enriched: read the delivery report (on_delivery) and call store.insert_outbox"
    assert rows[0].get("event", {}).get("sku_id") == "sku-1", f"the outbox row must carry the event, got {rows[0]}"
    m.publish(_event(version=2))
    m.producer.poll(0)
    assert _versions(ctx) == [2], f"once the broker accepts events they reach the topic, it holds versions {_versions(ctx)}"
    assert len(ctx.redis.lrange("outbox:enriched", 0, -1)) == 1, "a delivered event must not be written to the outbox"


def check_commit_after_apply(ctx):
    _seed(ctx, _event("sku-1"), _event("sku-2"))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(store.catalog_current("sku-1")))
    _index(ctx)
    assert at_commit, "the indexer never committed an offset"
    assert at_commit[0] is not None, "the first commit came before sku-1 was in the catalog: a crash between the two loses the version"
    assert ctx.kafka.lag(GROUP, "sku.enriched") == 0, "every applied event must be committed"


def check_search_index(ctx):
    _seed(ctx, _event("sku-1"), _event("sku-2", brand="Silk"))
    _index(ctx)
    for sku_id in ("sku-1", "sku-2"):
        catalog, search = store.catalog_current(sku_id), store.search_entry(sku_id)
        assert catalog is not None, f"{sku_id} never reached the catalog"
        assert search == catalog, f"the search index holds {search} for {sku_id} while the catalog holds {catalog}: write both before the commit"


def check_human_wins(ctx):
    _seed(ctx, _event("sku-1", 1, "model", "Glowra"), _event("sku-1", 2, "human", "Oatly"), _event("sku-1", 3, "model", "Silk"))
    _seed(ctx, _event("sku-2", 2, "model", "Califia Farms"), _event("sku-2", 1, "model", "Silk"))
    _index(ctx)
    one = store.catalog_current("sku-1")
    assert one is not None and one["source"] == "human" and one["attributes"]["brand"] == "Oatly", f"a model event overwrote the reviewer's correction of sku-1: the catalog holds {one}"
    two = store.catalog_current("sku-2")
    assert two is not None and two["attributes_version"] == 2, f"an older version replaced a newer one for sku-2: the catalog holds version {two and two['attributes_version']}"
`,
    typescript: `const GROUP = 'catalog-index';

const event = (sku_id = 'sku-1', version = 1, source = 'model', brand = 'Oatly') => ({
  sku_id,
  merchant: 'm-1',
  attributes: {brand, size: 1, unit: 'l', organic: false, category: 'plant-milk'},
  attributes_version: version,
  taxonomy_version: 'tx-2026.11',
  source,
});

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const seed = (ctx, ...events): void => {
  for (const e of events) ctx.kafka.seed('sku.enriched', {key: e.merchant, value: JSON.stringify(e)});
};
const versions = (ctx): number[] => ctx.kafka.records('sku.enriched').map(r => JSON.parse(Buffer.from(r.value).toString('utf8')).attributes_version);

async function index(ctx) {
  const m = ctx.load('enriched_events');
  await ctx.drain(m.runIndexer());
  return ctx.load('/support/enrich/store.ts');
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('enriched_events');
  ctx.kafka.loseAcks('sku.enriched', 1);
  await m.publish(event());
  await settle();
  assert.deepStrictEqual(versions(ctx), [1], \`after one produce whose acknowledgement was lost sku.enriched holds versions \${JSON.stringify(versions(ctx))}: the retry wrote the event again. Enable idempotence\`);
  await m.publish(event('sku-1', 2));
  await settle();
  ctx.kafka.failover('sku.enriched');
  assert(versions(ctx).includes(2), 'a leader failover right after the acknowledgement lost the event: wait for every in-sync replica');
}

export async function check_outbox(ctx) {
  const m = ctx.load('enriched_events');
  ctx.kafka.failNext('sku.enriched', 1);
  try {
    await m.publish(event());
  } catch (e) {
    assert.fail(\`publish threw \${e} when the broker refused the event: write it to the outbox instead\`);
  }
  await settle();
  const rows = ctx.redis.lrange('outbox:enriched', 0, -1).map((row: string) => JSON.parse(row));
  assert(rows.length > 0, 'the broker refused the event and nothing reached outbox:enriched: catch the rejected send and call insertOutbox');
  assert.equal(rows[0].event?.sku_id, 'sku-1', \`the outbox row must carry the event, got \${JSON.stringify(rows[0])}\`);
  await m.publish(event('sku-1', 2));
  await settle();
  assert.deepStrictEqual(versions(ctx), [2], 'once the broker accepts events they reach the topic');
  assert.equal(ctx.redis.lrange('outbox:enriched', 0, -1).length, 1, 'a delivered event must not be written to the outbox');
}

export async function check_commit_after_apply(ctx) {
  seed(ctx, event('sku-1'), event('sku-2'));
  const atCommit: boolean[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.exists('catalog:sku-1') === 1));
  await index(ctx);
  assert(atCommit.length > 0, 'the indexer never committed an offset');
  assert(atCommit[0], 'the first commit came before sku-1 was in the catalog: a crash between the two loses the version');
  assert.equal(ctx.kafka.lag(GROUP, 'sku.enriched'), 0, 'every applied event must be committed');
}

export async function check_search_index(ctx) {
  seed(ctx, event('sku-1'), event('sku-2', 1, 'model', 'Silk'));
  const store = await index(ctx);
  for (const skuId of ['sku-1', 'sku-2']) {
    const catalog = await store.catalogCurrent(skuId);
    const search = await store.searchEntry(skuId);
    assert(catalog !== null, \`\${skuId} never reached the catalog\`);
    assert.deepStrictEqual(search, catalog, \`the search index holds \${JSON.stringify(search)} for \${skuId} while the catalog holds \${JSON.stringify(catalog)}: write both before the commit\`);
  }
}

export async function check_human_wins(ctx) {
  seed(ctx, event('sku-1', 1, 'model', 'Glowra'), event('sku-1', 2, 'human', 'Oatly'), event('sku-1', 3, 'model', 'Silk'));
  seed(ctx, event('sku-2', 2, 'model', 'Califia Farms'), event('sku-2', 1, 'model', 'Silk'));
  const store = await index(ctx);
  const one = await store.catalogCurrent('sku-1');
  assert(one !== null && one.source === 'human' && one.attributes.brand === 'Oatly', \`a model event overwrote the reviewer's correction of sku-1: the catalog holds \${JSON.stringify(one)}\`);
  const two = await store.catalogCurrent('sku-2');
  assert(two !== null && two.attributes_version === 2, \`an older version replaced a newer one for sku-2: the catalog holds \${JSON.stringify(two)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"enrich/store"
	"enrich/taxonomy"

	"leetbuild/harness"
)

const indexGroup = "catalog-index"

var eventsBg = context.Background()

func enrichedEvent(skuID string, version int64, source, brand string) store.Event {
	return store.Event{SkuID: skuID, Merchant: "m-1", Attributes: map[string]any{"brand": brand, "size": 1.0, "unit": "l", "organic": false, "category": "plant-milk"},
		AttributesVersion: version, TaxonomyVersion: taxonomy.Version, Source: source}
}

func seedEvents(ctx *harness.Ctx, events ...store.Event) {
	for _, e := range events {
		value, _ := json.Marshal(e)
		ctx.Kafka.Seed("sku.enriched", e.Merchant, string(value))
	}
}

func eventVersions(ctx *harness.Ctx) []int64 {
	versions := []int64{}
	for _, r := range ctx.Kafka.Records("sku.enriched") {
		var e store.Event
		json.Unmarshal(r.Value, &e)
		versions = append(versions, e.AttributesVersion)
	}
	return versions
}

func outboxRows(ctx *harness.Ctx) []map[string]any {
	var rows []map[string]any
	for _, row := range ctx.Redis.LRange("outbox:enriched", 0, -1) {
		var v map[string]any
		json.Unmarshal([]byte(row), &v)
		rows = append(rows, v)
	}
	return rows
}

func runIndex(ctx *harness.Ctx) {
	var err error
	ctx.Drain(func() { err = runIndexer(eventsBg) })
	ctx.NoError(err, "the indexer stopped")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks("sku.enriched", 1)
	ctx.NoError(publish(eventsBg, enrichedEvent("sku-1", 1, "model", "Oatly")), "publish failed")
	ctx.Settle()
	ctx.Equal(eventVersions(ctx), []int64{1}, "after one produce whose acknowledgement was lost the retry must not write the event again (enable idempotence); the versions on sku.enriched")
	ctx.NoError(publish(eventsBg, enrichedEvent("sku-1", 2, "model", "Oatly")), "publish failed")
	ctx.Settle()
	ctx.Kafka.Failover("sku.enriched")
	ctx.Equal(eventVersions(ctx), []int64{1, 2}, "a leader failover right after the acknowledgement must keep the event (acks=all); the versions")
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext("sku.enriched", 1)
	ctx.NoError(publish(eventsBg, enrichedEvent("sku-1", 1, "model", "Oatly")), "publish failed when the broker refused the event: write it to the outbox instead")
	ctx.Settle()
	rows := outboxRows(ctx)
	ctx.Assert(len(rows) > 0, "the broker refused the event and nothing reached outbox:enriched: read the delivery report and call store.InsertOutbox")
	event, _ := rows[0]["event"].(map[string]any)
	ctx.Equal(event["sku_id"], "sku-1", "the outbox row must carry the event; its sku_id")
	ctx.NoError(publish(eventsBg, enrichedEvent("sku-1", 2, "model", "Oatly")), "publish failed")
	ctx.Settle()
	ctx.Equal(eventVersions(ctx), []int64{2}, "once the broker accepts events they reach the topic; the versions")
	ctx.Equal(len(outboxRows(ctx)), 1, "a delivered event must not be written to the outbox; the rows")
}

func CheckCommitAfterApply(ctx *harness.Ctx) {
	seedEvents(ctx, enrichedEvent("sku-1", 1, "model", "Oatly"), enrichedEvent("sku-2", 1, "model", "Oatly"))
	var atCommit []bool
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, ctx.Redis.Exists("catalog:sku-1") == 1) })
	runIndex(ctx)
	ctx.Assert(len(atCommit) > 0, "the indexer never committed an offset")
	ctx.Assert(atCommit[0], "the first commit came before sku-1 was in the catalog: a crash between the two loses the version")
	ctx.Equal(ctx.Kafka.Lag(indexGroup, "sku.enriched"), 0, "every applied event must be committed; the lag")
}

func CheckSearchIndex(ctx *harness.Ctx) {
	seedEvents(ctx, enrichedEvent("sku-1", 1, "model", "Oatly"), enrichedEvent("sku-2", 1, "model", "Silk"))
	runIndex(ctx)
	for _, skuID := range []string{"sku-1", "sku-2"} {
		catalog, search := store.CatalogCurrent(eventsBg, skuID), store.SearchEntry(eventsBg, skuID)
		ctx.Assert(catalog != nil, "%s never reached the catalog", skuID)
		ctx.Assert(search != nil && search.AttributesVersion == catalog.AttributesVersion && search.Attributes["brand"] == catalog.Attributes["brand"],
			"the search index holds %+v for %s while the catalog holds %+v: write both before the commit", search, skuID, catalog)
	}
}

func CheckHumanWins(ctx *harness.Ctx) {
	seedEvents(ctx, enrichedEvent("sku-1", 1, "model", "Glowra"), enrichedEvent("sku-1", 2, "human", "Oatly"), enrichedEvent("sku-1", 3, "model", "Silk"))
	seedEvents(ctx, enrichedEvent("sku-2", 2, "model", "Califia Farms"), enrichedEvent("sku-2", 1, "model", "Silk"))
	runIndex(ctx)
	one := store.CatalogCurrent(eventsBg, "sku-1")
	ctx.Assert(one != nil && one.Source == "human" && one.Attributes["brand"] == "Oatly", "a model event overwrote the reviewer's correction of sku-1: the catalog holds %+v", one)
	two := store.CatalogCurrent(eventsBg, "sku-2")
	ctx.Assert(two != nil && two.AttributesVersion == 2, "an older version replaced a newer one for sku-2: the catalog holds %+v", two)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "enrich/store.h"
#include "enrich/taxonomy.h"

namespace {

const std::string kIndexGroup = "catalog-index";

nlohmann::json enrichedEvent(const std::string& sku_id, long long version, const std::string& source, const std::string& brand) {
  return {{"sku_id", sku_id}, {"merchant", "m-1"},
          {"attributes", {{"brand", brand}, {"size", 1.0}, {"unit", "l"}, {"organic", false}, {"category", "plant-milk"}}},
          {"attributes_version", version}, {"taxonomy_version", taxonomy::kVersion}, {"source", source}};
}

void seedEvents(harness::Ctx& ctx, const std::vector<nlohmann::json>& events) {
  for (const auto& e : events) ctx.Kafka.Seed("sku.enriched", e["merchant"].get<std::string>(), e.dump());
}

std::vector<long long> eventVersions(harness::Ctx& ctx) {
  std::vector<long long> versions;
  for (const auto& r : ctx.Kafka.Records("sku.enriched")) versions.push_back(nlohmann::json::parse(r.Value.value_or("{}")).value("attributes_version", 0LL));
  return versions;
}

void runIndex(harness::Ctx& ctx) {
  try {
    ctx.Drain([] { run_indexer(); });
  } catch (const std::exception& e) {
    ctx.Fatalf("the indexer stopped: %s", e.what());
  }
}

}  // namespace

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks("sku.enriched", 1);
  publish(enrichedEvent("sku-1", 1, "model", "Oatly"));
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(eventVersions(ctx), std::vector<long long>{1}, "after one produce whose acknowledgement was lost the retry must not write the event again (enable idempotence); the versions on sku.enriched");
  publish(enrichedEvent("sku-1", 2, "model", "Oatly"));
  producer->poll(0);
  ctx.Settle();
  ctx.Kafka.Failover("sku.enriched");
  const auto versions = eventVersions(ctx);
  ctx.Assert(std::find(versions.begin(), versions.end(), 2) != versions.end(), "a leader failover right after the acknowledgement lost the event: wait for every in-sync replica (acks=all)");
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext("sku.enriched", 1);
  try {
    publish(enrichedEvent("sku-1", 1, "model", "Oatly"));
    producer->poll(0);
  } catch (const std::exception& e) {
    ctx.Fatalf("publish threw %s when the broker refused the event: write it to the outbox instead", e.what());
  }
  ctx.Settle();
  const auto rows = ctx.Redis.LRange("outbox:enriched", 0, -1);
  ctx.Assert(!rows.empty(), "the broker refused the event and nothing reached outbox:enriched: handle the delivery report (dr_cb) with store::insert_outbox");
  const auto row = nlohmann::json::parse(rows[0], nullptr, false);
  ctx.Assert(row.is_object() && row.contains("event") && row["event"].value("sku_id", "") == "sku-1", "the outbox row must carry the event, got %s", rows[0]);
  publish(enrichedEvent("sku-1", 2, "model", "Oatly"));
  producer->poll(0);
  ctx.Settle();
  ctx.Equal(eventVersions(ctx), std::vector<long long>{2}, "once the broker accepts events they reach the topic; the versions");
  ctx.Equal(ctx.Redis.LRange("outbox:enriched", 0, -1).size(), 1, "a delivered event must not be written to the outbox; the rows");
}

void CheckCommitAfterApply(harness::Ctx& ctx) {
  seedEvents(ctx, {enrichedEvent("sku-1", 1, "model", "Oatly"), enrichedEvent("sku-2", 1, "model", "Oatly")});
  std::vector<bool> at_commit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { at_commit.push_back(ctx.Redis.Exists("catalog:sku-1") == 1); });
  runIndex(ctx);
  ctx.Assert(!at_commit.empty(), "the indexer never committed an offset");
  ctx.Assert(at_commit[0], "the first commit came before sku-1 was in the catalog: a crash between the two loses the version");
  ctx.Equal(ctx.Kafka.Lag(kIndexGroup, "sku.enriched"), 0, "every applied event must be committed; the lag");
}

void CheckSearchIndex(harness::Ctx& ctx) {
  seedEvents(ctx, {enrichedEvent("sku-1", 1, "model", "Oatly"), enrichedEvent("sku-2", 1, "model", "Silk")});
  runIndex(ctx);
  for (const std::string sku_id : {"sku-1", "sku-2"}) {
    const auto catalog = store::catalog_current(sku_id);
    const auto search = store::search_entry(sku_id);
    ctx.Assert(catalog.has_value(), "%s never reached the catalog", sku_id);
    ctx.Assert(search.has_value() && *search == *catalog, "the search index holds %s for %s while the catalog holds %s: write both before the commit",
               search ? search->dump() : "nothing", sku_id, catalog->dump());
  }
}

void CheckHumanWins(harness::Ctx& ctx) {
  seedEvents(ctx, {enrichedEvent("sku-1", 1, "model", "Glowra"), enrichedEvent("sku-1", 2, "human", "Oatly"), enrichedEvent("sku-1", 3, "model", "Silk")});
  seedEvents(ctx, {enrichedEvent("sku-2", 2, "model", "Califia Farms"), enrichedEvent("sku-2", 1, "model", "Silk")});
  runIndex(ctx);
  const auto one = store::catalog_current("sku-1");
  ctx.Assert(one && (*one)["source"] == "human" && (*one)["attributes"]["brand"] == "Oatly", "a model event overwrote the reviewer's correction of sku-1: the catalog holds %s", one ? one->dump() : "nothing");
  const auto two = store::catalog_current("sku-2");
  ctx.Assert(two && (*two)["attributes_version"] == 2, "an older version replaced a newer one for sku-2: the catalog holds %s", two ? two->dump() : "nothing");
}
`,
  },
  debrief: `The producer settings and the consumer's order are the same decision seen from two ends: the event is the only record that a version exists, so it must land exactly once and the offset may only move once the version is in both stores. The outbox lives in the delivery report because that is where the broker's refusal arrives; anything written around \`produce()\` sees only local errors. Reading the catalog row before writing turns arrival order into version order, and the source rule is the course's whole point about labels: a reviewer's correction is the most expensive attribute the system holds, so a model run cannot outrank it. A larger pipeline would let a human correction expire when the merchant changes the product, relay the outbox with backoff, and reconcile the search index against the catalog on a schedule.`,
};
