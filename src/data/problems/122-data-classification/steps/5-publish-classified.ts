import type {Step} from '@/lib/types';

export const publishClassifiedStep: Step = {
  id: 'publish-classified',
  title: 'entity.classified: keyed by entity, acknowledged or kept, applied newest-first',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'publish_classified',
  focus: ['metasense', 'classified', 'catalog', 'redis'],
  task: `## Task

**Starting point.** After a verification, \`publish_classified(entity, tier, tags, verified_by,
version)\` produces \`{entity, tier, tags, verified_by, version}\` to \`entity.classified\` keyed by
\`{entity}:{version}\` from a producer with default settings, wraps the produce in
\`try … except KafkaException\` to write \`store.insert_outbox\`, and returns \`True\`. Its \`consume()\`
(group \`metadata-store\`, auto-commit off) runs \`store.upsert_catalog\` for every event, then
commits. It hides 4 flaws.

**Failure mode the checks target.** One table's versions land on different partitions and arrive out
of order; a lost acknowledgement writes the event twice and a leader failover loses it; a broker
that refuses the record reports it in the delivery report, after the \`try\` has finished; and a
replayed old version rolls a Tier 1 table back to Tier 4.

- The record key is the **entity**.
- The producer is idempotent with \`acks=all\` (Go: confluent-kafka-go; kafka-go has no idempotent
  producer).
- Wait for the delivery report, at most 5 s (\`ACK_TIMEOUT_S\`); when it fails or does not come, write
  the outbox row (topic, key, payload) and return \`False\`.
- The consumer applies an event only when its \`version\` is newer than
  \`store.catalog_version(entity)\`; it commits either way.`,
  sequence: {
    participants: ['metasense', 'entity.classified', 'Metadata store', 'Redis'],
    messages: [
      {
        from: 'metasense',
        to: 'entity.classified',
        label: 'produce · key = entity · idempotent · acks = all',
        kind: 'sync',
      },
      {from: 'entity.classified', to: 'metasense', label: 'delivery report (or none in 5 s → outbox)', kind: 'reply'},
      {from: 'entity.classified', to: 'Metadata store', label: 'consume · group metadata-store', kind: 'async'},
      {from: 'Metadata store', to: 'Redis', label: 'catalog_version(entity) < version?', kind: 'sync'},
      {from: 'Metadata store', to: 'Redis', label: 'upsert_catalog(entity, tier, tags, version)', kind: 'sync'},
      {from: 'Metadata store', to: 'entity.classified', label: 'commit', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'entity-key',
      title: 'Keys entity.classified by entity',
      detail:
        'Two versions of one entity carry the key `deliveries` and land on one partition, and the payload carries `verified_by` and `version`. The starter keys by `{entity}:{version}`, which spreads one table over every partition.',
      match: {
        python: {all: [/produce\([^\n]*key\s*=\s*entity\s*[,)]/]},
        typescript: {all: [/key:\s*entity\s*[,}]/]},
        go: {all: [/Key:\s*\[\]byte\(entity\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*entity,/]},
        cpp: {all: [/entity\.c_str\(\),\s*entity\.size\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'After a lost acknowledgement the topic holds the event once, and a leader failover right after the acknowledgement keeps it. The starter uses the default producer: its retry writes twice and a leader-only acknowledgement can vanish.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/put\("enable\.idempotence",\s*"true"\)/, /put\("acks",\s*"all"\)/]},
        cpp: {all: [/set\("enable\.idempotence",\s*"true"/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and keeps a refused event',
      detail:
        'A delivery the broker fails, or one with no report within the window, leaves an outbox row with the topic, the entity and the payload, and the call returns false. The starter only catches errors the produce call raises, which a broker refusal never does.',
      match: {
        python: {
          all: [/on_delivery\s*=/, /producer\.flush\(/, /store\.insert_outbox\(/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/await producer\.send\(/, /insertOutbox\(/]},
        go: {all: [/TopicPartition\.Error/, /store\.InsertOutbox\(/]},
        scala: {all: [/\.send\([^\n]*\)\.get\(/, /Store\.insertOutbox\(/]},
        cpp: {all: [/dr_cb/, /->flush\(/, /store::insertOutbox\(/]},
      },
    },
    {
      id: 'version-guard',
      title: 'Applies only a newer version',
      detail:
        'Versions 1, 2 and a replayed 1 of one table leave the catalogue at version 2 and Tier 1, and every record is committed. The starter applies whatever arrives last.',
      match: {
        python: {all: [/store\.catalog_version\(/]},
        typescript: {all: [/catalogVersion\(/]},
        go: {all: [/store\.CatalogVersion\(/]},
        scala: {all: [/Store\.catalogVersion\(/]},
        cpp: {all: [/store::catalogVersion\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, KafkaException, Producer

from metasense import store  # store.insert_outbox, catalog_version, upsert_catalog

TOPIC = "entity.classified"

producer = Producer({"bootstrap.servers": "kafka:9092"})
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "metadata-store",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC])


def publish_classified(entity: str, tier: int, tags: dict, verified_by: str, version: int) -> bool:
    """Tell the metadata store about a verified classification; True when it is on its way."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    payload = {"entity": entity, "tier": tier, "tags": tags, "verified_by": verified_by, "version": version}
    try:
        producer.produce(TOPIC, key=f"{entity}:{version}", value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        store.insert_outbox(TOPIC, entity, payload)
        return False
    return True


def consume() -> None:
    """The metadata store's side: apply each classification to the catalogue."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        store.upsert_catalog(event["entity"], event["tier"], event["tags"], event["version"])
        consumer.commit(message=msg, asynchronous=False)
`,
      solution: `import json

from confluent_kafka import Consumer, Producer

from metasense import store  # store.insert_outbox, catalog_version, upsert_catalog

TOPIC = "entity.classified"
ACK_TIMEOUT_S = 5

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,  # a retry after a lost acknowledgement lands once
        "acks": "all",  # every in-sync replica has it before the broker answers
    }
)
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "metadata-store",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC])


def publish_classified(entity: str, tier: int, tags: dict, verified_by: str, version: int) -> bool:
    """Tell the metadata store about a verified classification; True once the broker acknowledged it."""
    payload = {"entity": entity, "tier": tier, "tags": tags, "verified_by": verified_by, "version": version}
    failed = []
    producer.produce(TOPIC, key=entity, value=json.dumps(payload), on_delivery=lambda err, _: failed.append(err) if err else None)
    if producer.flush(ACK_TIMEOUT_S) > 0 or failed:
        # The broker did not take it: the relay republishes the row, so the catalogue is late, not wrong.
        store.insert_outbox(TOPIC, entity, payload)
        return False
    return True


def consume() -> None:
    """The metadata store's side: apply each classification newer than the one it holds."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        if event["version"] > store.catalog_version(event["entity"]):
            store.upsert_catalog(event["entity"], event["tier"], event["tags"], event["version"])
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {catalogVersion, insertOutbox, upsertCatalog} from 'metasense/store';

export const TOPIC = 'entity.classified';

const kafka = new Kafka({clientId: 'metasense', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
export const consumer = kafka.consumer({groupId: 'metadata-store'});

/** Tell the metadata store about a verified classification; true when it is on its way. */
export async function publishClassified(entity: string, tier: number, tags: Record<string, string>, verifiedBy: string, version: number): Promise<boolean> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const payload = {entity, tier, tags, verified_by: verifiedBy, version};
  try {
    void producer.send({topic: TOPIC, messages: [{key: \`\${entity}:\${version}\`, value: JSON.stringify(payload)}]});
  } catch {
    await insertOutbox(TOPIC, entity, payload);
    return false;
  }
  return true;
}

/** The metadata store's side: apply each classification to the catalogue. */
export async function consume(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(String(message.value));
      await upsertCatalog(event.entity, event.tier, event.tags, event.version);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {catalogVersion, insertOutbox, upsertCatalog} from 'metasense/store';

export const TOPIC = 'entity.classified';
export const ACK_TIMEOUT_MS = 5000;

const kafka = new Kafka({clientId: 'metasense', brokers: ['kafka:9092']});
// Idempotent: a retry after a lost acknowledgement lands once (it requires acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();
export const consumer = kafka.consumer({groupId: 'metadata-store'});

/** Tell the metadata store about a verified classification; true once the broker acknowledged it. */
export async function publishClassified(entity: string, tier: number, tags: Record<string, string>, verifiedBy: string, version: number): Promise<boolean> {
  const payload = {entity, tier, tags, verified_by: verifiedBy, version};
  try {
    await producer.send({topic: TOPIC, messages: [{key: entity, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay republishes the row, so the catalogue is late, not wrong.
    await insertOutbox(TOPIC, entity, payload);
    return false;
  }
}

/** The metadata store's side: apply each classification newer than the one it holds. */
export async function consume(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(String(message.value));
      if (event.version > (await catalogVersion(event.entity))) await upsertCatalog(event.entity, event.tier, event.tags, event.version);
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
	"strconv"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	kafkago "github.com/segmentio/kafka-go"

	"metasense/store" // store.InsertOutbox, CatalogVersion, UpsertCatalog
)

const classifiedTopic = "entity.classified"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

var reader = kafkago.NewReader(kafkago.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     "metadata-store",
	Topic:       classifiedTopic,
	StartOffset: kafkago.FirstOffset,
})

type classified struct {
	Entity     string            \`json:"entity"\`
	Tier       int               \`json:"tier"\`
	Tags       map[string]string \`json:"tags"\`
	VerifiedBy string            \`json:"verified_by"\`
	Version    int64             \`json:"version"\`
}

// publishClassified tells the metadata store about a verified classification; true when it is on its way.
func publishClassified(ctx context.Context, entity string, tier int, tags map[string]string, verifiedBy string, version int64) (bool, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	payload := classified{Entity: entity, Tier: tier, Tags: tags, VerifiedBy: verifiedBy, Version: version}
	value, _ := json.Marshal(payload)
	topic := classifiedTopic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(entity + ":" + strconv.FormatInt(version, 10)), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, store.InsertOutbox(ctx, classifiedTopic, entity, payload)
	}
	return true, nil
}

// consume is the metadata store's side: apply each classification to the catalogue.
func consume(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event classified
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if err := store.UpsertCatalog(ctx, event.Entity, event.Tier, event.Tags, event.Version); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	kafkago "github.com/segmentio/kafka-go"

	"metasense/store" // store.InsertOutbox, CatalogVersion, UpsertCatalog
)

const (
	classifiedTopic = "entity.classified"
	ackTimeout      = 5 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"enable.idempotence": true,  // a retry after a lost acknowledgement lands once
		"acks":               "all", // every in-sync replica has it before the broker answers
	})
	if err != nil {
		panic(err)
	}
	return p
}

var reader = kafkago.NewReader(kafkago.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     "metadata-store",
	Topic:       classifiedTopic,
	StartOffset: kafkago.FirstOffset,
})

type classified struct {
	Entity     string            \`json:"entity"\`
	Tier       int               \`json:"tier"\`
	Tags       map[string]string \`json:"tags"\`
	VerifiedBy string            \`json:"verified_by"\`
	Version    int64             \`json:"version"\`
}

// publishClassified tells the metadata store about a verified classification; true once the broker acknowledged it.
func publishClassified(ctx context.Context, entity string, tier int, tags map[string]string, verifiedBy string, version int64) (bool, error) {
	payload := classified{Entity: entity, Tier: tier, Tags: tags, VerifiedBy: verifiedBy, Version: version}
	value, _ := json.Marshal(payload)
	topic := classifiedTopic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(entity), Value: value}
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
		// The broker did not take it: the relay republishes the row, so the catalogue is late, not wrong.
		return false, store.InsertOutbox(ctx, classifiedTopic, entity, payload)
	}
	return true, nil
}

// consume is the metadata store's side: apply each classification newer than the one it holds.
func consume(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event classified
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		current, err := store.CatalogVersion(ctx, event.Entity)
		if err != nil {
			return err
		}
		if event.Version > current {
			if err := store.UpsertCatalog(ctx, event.Entity, event.Tier, event.Tags, event.Version); err != nil {
				return err
			}
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.{KafkaException, TopicPartition}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import metasense.Store // Store.insertOutbox, catalogVersion, upsertCatalog

import scala.jdk.CollectionConverters._

object PublishClassified {
  val Topic = "entity.classified"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  private val consumer: KafkaConsumer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "metadata-store")
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val c = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    c.subscribe(List(Topic).asJava)
    c
  }

  /** Tell the metadata store about a verified classification; true when it is on its way. */
  def publishClassified(entity: String, tier: Int, tags: Map[String, String], verifiedBy: String, version: Long): Boolean = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val payload = JsObject(
      "entity" -> JsString(entity),
      "tier" -> JsNumber(tier),
      "tags" -> JsObject(tags.map { case (c, t) => c -> JsString(t) }),
      "verified_by" -> JsString(verifiedBy),
      "version" -> JsNumber(version)
    )
    try {
      producer.send(new ProducerRecord[String, String](Topic, s"$entity:$version", payload.compactPrint))
      true
    } catch {
      case _: KafkaException =>
        Store.insertOutbox(Topic, entity, payload)
        false
    }
  }

  /** The metadata store's side: apply each classification to the catalogue. */
  def consume(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = record.value.parseJson.asJsObject.fields
        val tags = event("tags").asJsObject.fields.collect { case (c, JsString(t)) => c -> t }
        val version = event("version").asInstanceOf[JsNumber].value.toLong
        val entity = event("entity").asInstanceOf[JsString].value
        Store.upsertCatalog(entity, event("tier").asInstanceOf[JsNumber].value.toInt, tags, version)
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
      }
}
`,
      solution: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import metasense.Store // Store.insertOutbox, catalogVersion, upsertCatalog

import scala.jdk.CollectionConverters._
import scala.util.Try

object PublishClassified {
  val Topic = "entity.classified"
  val AckTimeoutMs = 5000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("enable.idempotence", "true") // a retry after a lost acknowledgement lands once
    props.put("acks", "all") // every in-sync replica has it before the broker answers
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  private val consumer: KafkaConsumer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "metadata-store")
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val c = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    c.subscribe(List(Topic).asJava)
    c
  }

  /** Tell the metadata store about a verified classification; true once the broker acknowledged it. */
  def publishClassified(entity: String, tier: Int, tags: Map[String, String], verifiedBy: String, version: Long): Boolean = {
    val payload = JsObject(
      "entity" -> JsString(entity),
      "tier" -> JsNumber(tier),
      "tags" -> JsObject(tags.map { case (c, t) => c -> JsString(t) }),
      "verified_by" -> JsString(verifiedBy),
      "version" -> JsNumber(version)
    )
    val record = new ProducerRecord[String, String](Topic, entity, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    // The broker did not take it: the relay republishes the row, so the catalogue is late, not wrong.
    if (acked.isFailure) Store.insertOutbox(Topic, entity, payload)
    acked.isSuccess
  }

  /** The metadata store's side: apply each classification newer than the one it holds. */
  def consume(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = record.value.parseJson.asJsObject.fields
        val tags = event("tags").asJsObject.fields.collect { case (c, JsString(t)) => c -> t }
        val version = event("version").asInstanceOf[JsNumber].value.toLong
        val entity = event("entity").asInstanceOf[JsString].value
        if (version > Store.catalogVersion(entity)) Store.upsertCatalog(entity, event("tier").asInstanceOf[JsNumber].value.toInt, tags, version)
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
      }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <map>
#include <memory>
#include <string>

#include "metasense/store.h"  // store::insertOutbox, catalogVersion, upsertCatalog

using json = nlohmann::json;

const std::string kClassifiedTopic = "entity.classified";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> makeConsumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "metadata-store", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kClassifiedTopic});
  return consumer;
}

auto producer = makeProducer();
auto consumer = makeConsumer();

// Tell the metadata store about a verified classification; true when it is on its way.
bool publishClassified(const std::string& entity, int tier, const std::map<std::string, std::string>& tags, const std::string& verified_by,
                       long long version) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const json payload{{"entity", entity}, {"tier", tier}, {"tags", tags}, {"verified_by", verified_by}, {"version", version}};
  const std::string value = payload.dump();
  const std::string key = entity + ":" + std::to_string(version);
  if (producer->produce(kClassifiedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), key.c_str(), key.size(), 0, nullptr) != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(kClassifiedTopic, entity, payload);
    return false;
  }
  producer->poll(0);
  return true;
}

// The metadata store's side: apply each classification to the catalogue.
void consume() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    store::upsertCatalog(event["entity"], event["tier"], event["tags"].get<std::map<std::string, std::string>>(), event["version"]);
    consumer->commitSync(msg.get());
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <map>
#include <memory>
#include <string>

#include "metasense/store.h"  // store::insertOutbox, catalogVersion, upsertCatalog

using json = nlohmann::json;

const std::string kClassifiedTopic = "entity.classified";
constexpr int kAckTimeoutMs = 5000;

// The delivery report of the record in flight: publishClassified produces one record and waits for it.
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
  conf->set("enable.idempotence", "true", err);  // a retry after a lost acknowledgement lands once
  conf->set("acks", "all", err);                 // every in-sync replica has it before the broker answers
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> makeConsumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "metadata-store", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kClassifiedTopic});
  return consumer;
}

auto producer = makeProducer();
auto consumer = makeConsumer();

// Tell the metadata store about a verified classification; true once the broker acknowledged it.
bool publishClassified(const std::string& entity, int tier, const std::map<std::string, std::string>& tags, const std::string& verified_by,
                       long long version) {
  const json payload{{"entity", entity}, {"tier", tier}, {"tags", tags}, {"verified_by", verified_by}, {"version", version}};
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kClassifiedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                             const_cast<char*>(value.data()), value.size(), entity.c_str(), entity.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay republishes the row, so the catalogue is late, not wrong.
    store::insertOutbox(kClassifiedTopic, entity, payload);
    return false;
  }
  return true;
}

// The metadata store's side: apply each classification newer than the one it holds.
void consume() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    const std::string entity = event["entity"];
    const long long version = event["version"];
    if (version > store::catalogVersion(entity)) {
      store::upsertCatalog(entity, event["tier"], event["tags"].get<std::map<std::string, std::string>>(), version);
    }
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "entity.classified"
GROUP = "metadata-store"
TAGS = {"passport_no": "Personal.ID", "merchant_id": "None"}


def _publish(m, entity="deliveries", version=1, tier=1, tags=TAGS):
    return m.publish_classified(entity, tier, tags, "team-logistics", version)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_entity_key(ctx):
    m = ctx.load("publish_classified")
    _publish(m, "deliveries", 1)
    _publish(m, "orders", 1, 4, {"order_id": "None"})
    _publish(m, "deliveries", 2)
    records = ctx.kafka.records(TOPIC)
    keys = [bytes(r.key).decode() if r.key is not None else None for r in records]
    assert keys == ["deliveries", "orders", "deliveries"], f"the records are keyed {keys}, expected the entities: one table's versions must share a key"
    assert records[0].partition == records[2].partition, "both versions of deliveries must land on one partition, or the metadata store sees them out of order"
    value = json.loads(records[2].value)
    want = {"entity": "deliveries", "tier": 1, "tags": TAGS, "verified_by": "team-logistics", "version": 2}
    assert value == want, f"the event is {value}, expected {want}"


def check_idempotent_acks(ctx):
    m = ctx.load("publish_classified")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    _publish(m, "deliveries", 1)
    n = len(ctx.kafka.records(TOPIC))
    assert n == 1, f"after one lost acknowledgement the topic holds {n} records: the producer's retry wrote the event twice. Make it idempotent"
    _publish(m, "deliveries", 2)
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    n = len(ctx.kafka.records(TOPIC))
    assert n == 2, f"a leader failover lost the event the leader alone had acknowledged ({n} records left): acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("publish_classified")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = _publish(m, "deliveries", 1)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker failed the delivery and the outbox holds {len(rows)} rows: the tier change is gone from the metadata store"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "deliveries" and rows[0].get("payload", {}).get("version") == 1, f"the outbox row is {rows[0]}, expected the topic, the entity as key and the payload"
    assert ok is False, f"publish_classified returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    started = ctx.clock.time()
    ok = _publish(m, "deliveries", 2)
    waited = ctx.clock.time() - started
    assert waited <= 10, f"publish_classified waited {waited:.0f} s on a broker that does not answer, expected at most ACK_TIMEOUT_S = 5"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("version") == 2, f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_classified returned {ok!r} without a delivery report, expected False"


def check_version_guard(ctx):
    for version, tier in ((1, 4), (2, 1), (1, 4)):  # the last one is a replay of version 1
        event = {"entity": "deliveries", "tier": tier, "tags": TAGS, "verified_by": "team-logistics", "version": version}
        ctx.kafka.seed(TOPIC, key="deliveries", value=json.dumps(event))
    m = ctx.load("publish_classified")
    try:
        ctx.drain(m.consume)
    except Exception as exc:
        raise AssertionError(f"consume() stopped with {type(exc).__name__}: {exc}") from exc
    catalog = ctx.redis.hgetall("catalog:deliveries")
    assert catalog.get("version") == "2" and catalog.get("tier") == "1", f"after versions 1, 2 and a replayed 1 the catalogue holds version {catalog.get('version')} at tier {catalog.get('tier')}: the replay rolled the table back. Apply only a newer version"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, f"{ctx.kafka.lag(GROUP, TOPIC)} record(s) left uncommitted: a skipped version is committed too"
`,
    typescript: `const TOPIC = 'entity.classified';
const GROUP = 'metadata-store';
const TAGS = {passport_no: 'Personal.ID', merchant_id: 'None'};

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const publish = (m, entity = 'deliveries', version = 1, tier = 1, tags: Record<string, string> = TAGS) => m.publishClassified(entity, tier, tags, 'team-logistics', version);
const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

export async function check_entity_key(ctx) {
  const m = ctx.load('publish_classified');
  await publish(m, 'deliveries', 1);
  await publish(m, 'orders', 1, 4, {order_id: 'None'});
  await publish(m, 'deliveries', 2);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['deliveries', 'orders', 'deliveries'], \`the records are keyed \${JSON.stringify(keys)}, expected the entities: one table's versions must share a key\`);
  assert.equal(records[0].partition, records[2].partition, 'both versions of deliveries must land on one partition, or the metadata store sees them out of order');
  const value = JSON.parse(ctx.kafka.values(TOPIC)[2]);
  assert.deepEqual(value, {entity: 'deliveries', tier: 1, tags: TAGS, verified_by: 'team-logistics', version: 2}, \`the event is \${JSON.stringify(value)}\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('publish_classified');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await publish(m, 'deliveries', 1);
  await settle();
  let n = ctx.kafka.records(TOPIC).length;
  assert.equal(n, 1, \`after one lost acknowledgement the topic holds \${n} records: the producer's retry wrote the event twice. Make it idempotent\`);
  await publish(m, 'deliveries', 2);
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  n = ctx.kafka.records(TOPIC).length;
  assert.equal(n, 2, \`a leader failover lost the event the leader alone had acknowledged (\${n} records left): acks: -1 waits for every in-sync replica\`);
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('publish_classified');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await publish(m, 'deliveries', 1);
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker failed the delivery and the outbox holds \${rows.length} rows: the tier change is gone from the metadata store\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'deliveries' && rows[0].payload?.version === 1, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the entity as key and the payload\`);
  assert.equal(ok, false, \`publishClassified resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const started = ctx.clock.now();
  ok = await publish(m, 'deliveries', 2);
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 10, \`publishClassified waited \${waited.toFixed(0)} s on a broker that does not answer, expected at most ACK_TIMEOUT_MS = 5000\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.version === 2, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishClassified resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}

export async function check_version_guard(ctx) {
  for (const [version, tier] of [[1, 4], [2, 1], [1, 4]]) {
    // the last one is a replay of version 1
    ctx.kafka.seed(TOPIC, {key: 'deliveries', value: JSON.stringify({entity: 'deliveries', tier, tags: TAGS, verified_by: 'team-logistics', version})});
  }
  const m = ctx.load('publish_classified');
  await ctx.drain(m.consume());
  const catalog = ctx.redis.hgetall('catalog:deliveries');
  assert(catalog.version === '2' && catalog.tier === '1', \`after versions 1, 2 and a replayed 1 the catalogue holds version \${catalog.version} at tier \${catalog.tier}: the replay rolled the table back. Apply only a newer version\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'a skipped version must be committed too');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"

	"leetbuild/harness"
)

const classifiedGroup = "metadata-store"

var classifiedTags = map[string]string{"passport_no": "Personal.ID", "merchant_id": "None"}

func classifiedPublish(ctx *harness.Ctx, entity string, version int64, tier int, tags map[string]string) bool {
	ok, err := publishClassified(context.Background(), entity, tier, tags, "team-logistics", version)
	ctx.NoError(err, "publishClassified(%s, version %d)", entity, version)
	return ok
}

type classifiedRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func classifiedOutbox(ctx *harness.Ctx) []classifiedRow {
	var rows []classifiedRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row classifiedRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckEntityKey(ctx *harness.Ctx) {
	classifiedPublish(ctx, "deliveries", 1, 1, classifiedTags)
	classifiedPublish(ctx, "orders", 1, 4, map[string]string{"order_id": "None"})
	classifiedPublish(ctx, "deliveries", 2, 1, classifiedTags)
	ctx.Settle()
	records := ctx.Kafka.Records(classifiedTopic)
	ctx.Equal(ctx.Kafka.Keys(classifiedTopic), []string{"deliveries", "orders", "deliveries"}, "the records must be keyed by entity: one table's versions share a key")
	ctx.Equal(records[0].Partition, records[2].Partition, "both versions of deliveries must land on one partition, or the metadata store sees them out of order; the partitions")
	var value map[string]any
	ctx.NoError(json.Unmarshal(records[2].Value, &value), "the event must be JSON")
	ctx.Equal(value, map[string]any{"entity": "deliveries", "tier": 1, "tags": map[string]any{"passport_no": "Personal.ID", "merchant_id": "None"}, "verified_by": "team-logistics", "version": 2}, "the event")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(classifiedTopic, 1) // the broker wrote it, the acknowledgement never arrived
	classifiedPublish(ctx, "deliveries", 1, 1, classifiedTags)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(classifiedTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	classifiedPublish(ctx, "deliveries", 2, 1, classifiedTags)
	ctx.Settle()
	ctx.Kafka.Failover(classifiedTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(classifiedTopic)), 2, "a leader failover must not lose an acknowledged event (acks=all); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(classifiedTopic, 1)
	ok := classifiedPublish(ctx, "deliveries", 1, 1, classifiedTags)
	ctx.Settle()
	rows := classifiedOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker failed the delivery: without an outbox row the tier change is gone from the metadata store; the rows")
	ctx.Assert(rows[0].Topic == classifiedTopic && rows[0].Key == "deliveries" && rows[0].Payload["version"] == float64(1), "the outbox row is %v, expected the topic, the entity as key and the payload", rows[0])
	ctx.Equal(ok, false, "publishClassified's result after a failed delivery")
	ctx.Kafka.Stall(classifiedTopic) // the broker stops answering
	started := ctx.Clock.Now()
	ok = classifiedPublish(ctx, "deliveries", 2, 1, classifiedTags)
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited <= 10, "publishClassified waited %.0f s on a broker that does not answer, expected at most 5", waited)
	rows = classifiedOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["version"] == float64(2), "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishClassified's result without a delivery report")
}

func CheckVersionGuard(ctx *harness.Ctx) {
	for _, v := range [][2]int{{1, 4}, {2, 1}, {1, 4}} { // the last one is a replay of version 1
		event, _ := json.Marshal(map[string]any{"entity": "deliveries", "tier": v[1], "tags": classifiedTags, "verified_by": "team-logistics", "version": v[0]})
		ctx.Kafka.Seed(classifiedTopic, "deliveries", event)
	}
	c, cancel := context.WithCancel(context.Background())
	var err error
	ctx.Drain(func() { err = consume(c) })
	cancel()
	ctx.Settle()
	if err != nil && !errors.Is(err, context.Canceled) {
		ctx.Fatalf("consume returned an error: %v", err)
	}
	catalog := ctx.Redis.HGetAll("catalog:deliveries")
	ctx.Assert(catalog["version"] == "2" && catalog["tier"] == "1", "after versions 1, 2 and a replayed 1 the catalogue holds version %s at tier %s: the replay rolled the table back. Apply only a newer version", catalog["version"], catalog["tier"])
	ctx.Equal(ctx.Kafka.Lag(classifiedGroup, classifiedTopic), 0, "a skipped version must be committed too; records left")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kGroup = "metadata-store";
const std::map<std::string, std::string> kTags = {{"passport_no", "Personal.ID"}, {"merchant_id", "None"}};

bool publish(const std::string& entity, long long version, int tier = 1, const std::map<std::string, std::string>& tags = kTags) {
  return publishClassified(entity, tier, tags, "team-logistics", version);
}

std::vector<nlohmann::json> outboxRows(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

long long payloadVersion(const nlohmann::json& row) {
  return row.contains("payload") && row["payload"].is_object() ? row["payload"].value("version", 0LL) : 0;
}

struct runner {
  bool done = false;
  std::optional<std::string> err;
};
std::shared_ptr<runner> active;

}  // namespace

void CheckEntityKey(harness::Ctx& ctx) {
  publish("deliveries", 1);
  publish("orders", 1, 4, {{"order_id", "None"}});
  publish("deliveries", 2);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kClassifiedTopic);
  ctx.Equal(ctx.Kafka.Keys(kClassifiedTopic), {"deliveries", "orders", "deliveries"}, "the records must be keyed by entity: one table's versions share a key");
  ctx.Equal(records[0].Partition, records[2].Partition, "both versions of deliveries must land on one partition, or the metadata store sees them out of order; the partitions");
  const auto value = nlohmann::json::parse(ctx.Kafka.Values(kClassifiedTopic)[2], nullptr, false);
  ctx.Equal(value, nlohmann::json{{"entity", "deliveries"}, {"tier", 1}, {"tags", kTags}, {"verified_by", "team-logistics"}, {"version", 2}}, "the event");
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kClassifiedTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publish("deliveries", 1);
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kClassifiedTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publish("deliveries", 2);
  ctx.Settle();
  ctx.Kafka.Failover(kClassifiedTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kClassifiedTopic).size(), 2, "a leader failover must not lose an acknowledged event (acks=all); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kClassifiedTopic, 1);
  bool ok = publish("deliveries", 1);
  ctx.Settle();
  auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the broker failed the delivery: without an outbox row the tier change is gone from the metadata store; the rows");
  ctx.Assert(rows[0].value("topic", "") == kClassifiedTopic && rows[0].value("key", "") == "deliveries" && payloadVersion(rows[0]) == 1,
             "the outbox row is %s, expected the topic, the entity as key and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishClassified's result after a failed delivery");
  ctx.Kafka.Stall(kClassifiedTopic);  // the broker stops answering
  const int64_t started = ctx.Clock.Now();
  ok = publish("deliveries", 2);
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(waited <= 10, "publishClassified waited %.0f s on a broker that does not answer, expected at most 5", waited);
  rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 2 && payloadVersion(rows[1]) == 2, "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishClassified's result without a delivery report");
}

void CheckVersionGuard(harness::Ctx& ctx) {
  for (const auto& [version, tier] : std::vector<std::pair<int, int>>{{1, 4}, {2, 1}, {1, 4}}) {  // the last one is a replay of version 1
    ctx.Kafka.Seed(kClassifiedTopic, "deliveries",
                   nlohmann::json{{"entity", "deliveries"}, {"tier", tier}, {"tags", kTags}, {"verified_by", "team-logistics"}, {"version", version}}.dump());
  }
  if (!active || active->done) {
    auto r = active = std::make_shared<runner>();
    lb::spawn([r] {
      try {
        consume();
      } catch (const std::exception& e) {
        r->err = std::string(e.what());
      } catch (...) {
        r->err = harness::CurrentExceptionType();
      }
      r->done = true;
    });
  }
  ctx.Settle();
  if (active->done && active->err) ctx.Fatalf("consume() stopped with %s", *active->err);
  const auto catalog = ctx.Redis.HGetAll("catalog:deliveries");
  const std::string version = catalog.count("version") ? catalog.at("version") : "";
  const std::string tier = catalog.count("tier") ? catalog.at("tier") : "";
  ctx.Assert(version == "2" && tier == "1", "after versions 1, 2 and a replayed 1 the catalogue holds version %q at tier %q: the replay rolled the table back. Apply only a newer version", version, tier);
  ctx.Equal(ctx.Kafka.Lag(kGroup, kClassifiedTopic), 0, "a skipped version must be committed too; records left");
}
`,
  },
  hints: [
    'An owner raises a table from Tier 4 to Tier 1, and an hour later the catalogue shows Tier 4 again; on the day the broker restarted another table never got its tier at all, and one got it twice.',
    'The key changes with every version, so one table spreads over partitions and its versions race; the default producer neither deduplicates retries nor waits for every replica; a broker refusal arrives in the delivery report, after the `try` has returned; the consumer writes whatever arrives.',
    '`key=entity`; `enable.idempotence: True` and `acks: "all"`; produce with `on_delivery`, `flush(ACK_TIMEOUT_S)`, and insert the outbox row when anything is still queued or the callback saw an error; in `consume`, upsert only when `version > store.catalog_version(entity)`.',
  ],
  debrief: `Ordering in Kafka is per partition, so the key decides what stays ordered: keying by entity puts every version of one table on one partition. The delivery report is the only place a produce outcome arrives, which is why the outbox is written from it and not from an exception the produce call never raises. Idempotence and acks=all close the two gaps that waiting opens, a retry after a lost acknowledgement and a leader that fails over. The version guard makes the consumer correct even when the outbox relay republishes an old event after a newer one. Production systems write the outbox row in the same transaction as the verification and let a relay do every produce, and they register the event schema so no producer can silently add a field.`,
};
