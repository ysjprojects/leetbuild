import type {Step} from '@/lib/types';

export const publishClassifiedStep: Step = {
  id: 'publish-classified',
  title: 'entity.classified: entity key, outbox, versioned upsert before commit',
  concept: 'kafka',
  file: 'publish_classified',
  focus: ['metasense', 'classified', 'catalog', 'db'],
  task: `## Task

**Starting point.** The starter's \`publish_classified(entity, tier, tags, verified_by, version)\`
produces one \`entity.classified\` event keyed by \`{entity}:{version}\` from a producer with only
\`bootstrap.servers\` set and no handling for a rejected produce; its \`consume()\` loop in group
\`metadata-store\` commits the offset, then calls \`store.upsert\` with every event it reads. The
demo shows the tier changing in the catalogue; it hides five flaws.

**Failure mode the checks target.** Keying by event id scatters one entity's versions across
partitions; an unconfigured producer can duplicate on retry; a failed produce loses the event that
would have closed a table; an unversioned upsert lets a replay undo a verification; and
commit-before-write trades correctness for exactly-once *looking* code.

- Publish **one** event per verification with the **entity** as the message key, so an entity's
  versions stay in order. The payload carries \`entity\`, \`tier\`, \`tags\`, \`verified_by\` and
  \`version\`; the event id is \`{entity}:{version}\`.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent), so a retried produce
  cannot duplicate a record.
- When the broker rejects the produce, write the event to the **outbox** (\`store.insert_outbox\`)
  instead of dropping it; a relay republishes it.
- The consumer (group \`metadata-store\`, auto-commit off) reads \`store.current_version(entity)\`
  and **skips** events whose \`version\` is not greater, so a replay cannot roll a Tier 1 back to
  Tier 4.
- The consumer **upserts the catalogue and only then commits** the offset.`,
  sequence: {
    participants: ['metasense', 'entity.classified', 'Metadata store', 'catalogue'],
    messages: [
      {from: 'metasense', to: 'entity.classified', label: 'produce · key = entity · acks = all', kind: 'sync'},
      {from: 'entity.classified', to: 'metasense', label: 'ack / broker error', kind: 'reply'},
      {from: 'metasense', to: 'metasense', label: 'insert_outbox(entity, event) on failure', kind: 'sync'},
      {from: 'entity.classified', to: 'Metadata store', label: 'consume · group metadata-store', kind: 'async'},
      {from: 'Metadata store', to: 'catalogue', label: 'current_version(entity) · skip if ≥ event', kind: 'sync'},
      {from: 'Metadata store', to: 'catalogue', label: 'upsert(entity, tier, tags, version)', kind: 'sync'},
      {from: 'Metadata store', to: 'entity.classified', label: 'commit offset after the upsert', kind: 'async'},
    ],
  },
  hints: [
    'An owner edits a table from Tier 4 to Tier 1; a minute later the catalogue shows Tier 4 again, and a different table never got its tier at all after the broker blipped.',
    'Versions of one entity hash to different partitions by event id, the consumer applies whatever arrives (no version compare) after it has already committed, and a produce error has no path except the exception.',
    '`key=entity`; producer config `enable.idempotence=True`, `acks="all"`; `try: produce()` then `store.insert_outbox` on `KafkaException`; consumer: `enable.auto.commit=False`, skip when `version <= store.current_version(entity)`, `upsert`, then `commit`.',
  ],
  checks: [
    {
      id: 'entity-key',
      title: 'Keyed by entity, carries verified_by and version',
      detail:
        'The message key is the entity (partition by entity) and the payload carries `verified_by` and `version`. The starter keys by the event id and drops the verifier.',
      match: {
        python: {all: [/key=entity/, /verified_by/, /"version"/]},
        typescript: {all: [/key:\s*entity\b/, /verified_by/, /version/]},
        go: {all: [/Key:\s*\[\]byte\(entity\)/, /verified_by/, /version/]},
        scala: {all: [/ProducerRecord\("entity\.classified",\s*entity/, /verified_by/, /version/]},
        cpp: {all: [/entity\.data\(\),\s*entity\.size\(\)/, /verified_by/, /version/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. A retry of a produce must not duplicate the record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox`/`insertOutbox`/`InsertOutbox`) in the error branch instead of dropping the event. The starter ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'version-guard',
      title: 'Skips events that are not newer than the stored version',
      detail:
        'The consumer reads `store.current_version(entity)` and ignores an event whose `version` is not greater, so a replayed or reordered event cannot undo a later verification. The starter applies every event it sees.',
      match: {
        python: {all: [/store\.current_version\(/, /<=\s*current/]},
        typescript: {all: [/store\.currentVersion\(/, /<=\s*current/]},
        go: {all: [/store\.CurrentVersion\(/, /<=\s*current/]},
        scala: {all: [/store\.currentVersion\(/, /<=\s*current/]},
        cpp: {all: [/store\.currentVersion\(/, /<=\s*current/]},
      },
    },
    {
      id: 'upsert-before-commit',
      title: 'Upserts the catalogue before committing the offset',
      detail:
        'The consumer runs `store.upsert(...)` before committing the offset; committing first makes a crash lose the tier change. The starter commits first.',
      match: {
        python: {order: [/store\.upsert\(/, /consumer\.commit\(/]},
        typescript: {order: [/store\.upsert\(/, /await commit\(\)/]},
        go: {order: [/store\.Upsert\(/, /CommitMessages\(/]},
        scala: {order: [/store\.upsert\(/, /commitSync\(/]},
        cpp: {order: [/store\.upsert\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer

TOPIC = "entity.classified"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class CatalogueStore:
    def upsert(self, entity: str, tier: int, tags: dict[str, str], version: int) -> None:
        """Write the entity's verified tier and tags; access control reads this row."""
        raise NotImplementedError


store = CatalogueStore()


def publish_classified(entity: str, tier: int, tags: dict[str, str], verified_by: str, version: int) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event_id = f"{entity}:{version}"
    event = {"id": event_id, "entity": entity, "tier": tier, "tags": tags, "version": version}
    producer.produce(TOPIC, key=event_id, value=json.dumps(event))
    producer.flush()


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "metadata-store"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        store.upsert(event["entity"], event["tier"], event["tags"], event["version"])
`,
      solution: `import json

from confluent_kafka import Consumer, KafkaException, Producer

TOPIC = "entity.classified"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class CatalogueStore:
    def insert_outbox(self, entity: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError

    def current_version(self, entity: str) -> int:
        """The version last applied for the entity; 0 when it was never classified."""
        raise NotImplementedError

    def upsert(self, entity: str, tier: int, tags: dict[str, str], version: int) -> None:
        """Write the entity's verified tier and tags; access control reads this row."""
        raise NotImplementedError


store = CatalogueStore()


def publish_classified(entity: str, tier: int, tags: dict[str, str], verified_by: str, version: int) -> None:
    event = {
        "id": f"{entity}:{version}",
        "entity": entity,
        "tier": tier,
        "tags": tags,
        "verified_by": verified_by,
        "version": version,
    }
    try:
        producer.produce(TOPIC, key=entity, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(entity, event)


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "metadata-store", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        current = store.current_version(event["entity"])
        if event["version"] <= current:
            consumer.commit(msg)
            continue
        store.upsert(event["entity"], event["tier"], event["tags"], event["version"])
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** entity.classified: flawed code that keys by event id and commits too early. */
import {Kafka} from 'kafkajs';

import {store} from './store';

const TOPIC = 'entity.classified';
const kafka = new Kafka({clientId: 'metasense', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface Classified {
  id: string;
  entity: string;
  tier: number;
  tags: Record<string, string>;
  version: number;
}

export async function publishClassified(
  entity: string,
  tier: number,
  tags: Record<string, string>,
  verifiedBy: string,
  version: number,
): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const id = \`\${entity}:\${version}\`;
  const event: Classified = {id, entity, tier, tags, version};
  await producer.send({topic: TOPIC, messages: [{key: id, value: JSON.stringify(event)}]});
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'metadata-store'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as Classified;
      await store.upsert(event.entity, event.tier, event.tags, event.version);
    },
  });
}
`,
      solution: `/** entity.classified: one idempotent, entity-keyed event per verification; versioned upsert before commit. */
import {Kafka} from 'kafkajs';

import {store} from './store';

const TOPIC = 'entity.classified';
const kafka = new Kafka({clientId: 'metasense', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface Classified {
  id: string;
  entity: string;
  tier: number;
  tags: Record<string, string>;
  verified_by: string;
  version: number;
}

export async function publishClassified(
  entity: string,
  tier: number,
  tags: Record<string, string>,
  verifiedBy: string,
  version: number,
): Promise<void> {
  const event: Classified = {id: \`\${entity}:\${version}\`, entity, tier, tags, verified_by: verifiedBy, version};
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: entity, value: JSON.stringify(event)}]});
  } catch (error) {
    await store.insertOutbox(entity, event);
  }
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'metadata-store'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const commit = () =>
        consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as Classified;
      const current = await store.currentVersion(event.entity);
      if (event.version <= current) {
        await commit();
        return;
      }
      await store.upsert(event.entity, event.tier, event.tags, event.version);
      await commit();
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

	"github.com/segmentio/kafka-go"
)

const topic = "entity.classified"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic}

type Classified struct {
	ID      string            \`json:"id"\`
	Entity  string            \`json:"entity"\`
	Tier    int               \`json:"tier"\`
	Tags    map[string]string \`json:"tags"\`
	Version int               \`json:"version"\`
}

type CatalogueStore struct{}

// Upsert writes the entity's verified tier and tags; access control reads this row.
func (s *CatalogueStore) Upsert(ctx context.Context, entity string, tier int, tags map[string]string, version int) error {
	return nil
}

var store = &CatalogueStore{}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
func publishClassified(ctx context.Context, entity string, tier int, tags map[string]string, verifiedBy string, version int) {
	id := fmt.Sprintf("%s:%d", entity, version)
	event := Classified{ID: id, Entity: entity, Tier: tier, Tags: tags, Version: version}
	payload, _ := json.Marshal(event)
	_ = writer.WriteMessages(ctx, kafka.Message{Key: []byte(id), Value: payload})
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: "metadata-store",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event Classified
		_ = json.Unmarshal(msg.Value, &event)
		_ = store.Upsert(ctx, event.Entity, event.Tier, event.Tags, event.Version)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/segmentio/kafka-go"
)

const topic = "entity.classified"

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type Classified struct {
	ID         string            \`json:"id"\`
	Entity     string            \`json:"entity"\`
	Tier       int               \`json:"tier"\`
	Tags       map[string]string \`json:"tags"\`
	VerifiedBy string            \`json:"verified_by"\`
	Version    int               \`json:"version"\`
}

type CatalogueStore struct{}

// InsertOutbox stores one undelivered event; a relay republishes it.
func (s *CatalogueStore) InsertOutbox(ctx context.Context, entity string, event Classified) error { return nil }

// CurrentVersion returns the version last applied for the entity, 0 when never classified.
func (s *CatalogueStore) CurrentVersion(ctx context.Context, entity string) (int, error) { return 0, nil }

// Upsert writes the entity's verified tier and tags; access control reads this row.
func (s *CatalogueStore) Upsert(ctx context.Context, entity string, tier int, tags map[string]string, version int) error {
	return nil
}

var store = &CatalogueStore{}

func publishClassified(ctx context.Context, entity string, tier int, tags map[string]string, verifiedBy string, version int) error {
	event := Classified{
		ID:         fmt.Sprintf("%s:%d", entity, version),
		Entity:     entity,
		Tier:       tier,
		Tags:       tags,
		VerifiedBy: verifiedBy,
		Version:    version,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(entity), Value: payload}); err != nil {
		return store.InsertOutbox(ctx, entity, event)
	}
	return nil
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: "metadata-store",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event Classified
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			_ = reader.CommitMessages(ctx, msg)
			continue
		}
		current, err := store.CurrentVersion(ctx, event.Entity)
		if err != nil {
			continue
		}
		if event.Version <= current {
			_ = reader.CommitMessages(ctx, msg)
			continue
		}
		if err := store.Upsert(ctx, event.Entity, event.Tier, event.Tags, event.Version); err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._
import spray.json.DefaultJsonProtocol._

object PublishClassified {
  val Topic = "entity.classified"
  val producer = new KafkaProducer[String, String](new Properties())
  val store = CatalogueStore.open()

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def publishClassified(entity: String, tier: Int, tags: Map[String, String], verifiedBy: String, version: Int): Unit = {
    val id = s"$entity:$version"
    val payload = JsObject(
      "id" -> JsString(id),
      "entity" -> JsString(entity),
      "tier" -> JsNumber(tier),
      "tags" -> tags.toJson,
      "version" -> JsNumber(version)
    ).compactPrint
    producer.send(new ProducerRecord(Topic, id, payload))
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "metadata-store")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        store.upsert(
          event("entity").convertTo[String],
          event("tier").convertTo[Int],
          event("tags").convertTo[Map[String, String]],
          event("version").convertTo[Int]
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
import spray.json.DefaultJsonProtocol._

object PublishClassified {
  val Topic = "entity.classified"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val store = CatalogueStore.open()

  def publishClassified(entity: String, tier: Int, tags: Map[String, String], verifiedBy: String, version: Int): Unit = {
    val payload = JsObject(
      "id" -> JsString(s"$entity:$version"),
      "entity" -> JsString(entity),
      "tier" -> JsNumber(tier),
      "tags" -> tags.toJson,
      "verified_by" -> JsString(verifiedBy),
      "version" -> JsNumber(version)
    ).compactPrint
    try {
      producer.send(new ProducerRecord("entity.classified", entity, payload)).get()
    } catch {
      case _: Exception =>
        store.insertOutbox(entity, payload)
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "metadata-store")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val entity = event("entity").convertTo[String]
        val version = event("version").convertTo[Int]
        val current = store.currentVersion(entity)
        if (version <= current) {
          consumer.commitSync()
        } else {
          store.upsert(entity, event("tier").convertTo[Int], event("tags").convertTo[Map[String, String]], version)
          consumer.commitSync()
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "entity.classified";

struct CatalogueStore {
  void upsert(const std::string& entity, int tier, const std::map<std::string, std::string>& tags, int version);
};

CatalogueStore store;
std::unique_ptr<RdKafka::Producer> producer;

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
void publishClassified(const std::string& entity, int tier, const std::map<std::string, std::string>& tags,
                       const std::string& verifiedBy, int version) {
  const std::string id = entity + ":" + std::to_string(version);
  const json event = {{"id", id}, {"entity", entity}, {"tier", tier}, {"tags", tags}, {"version", version}};
  const auto payload = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), id.data(), id.size(), 0, nullptr);
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "metadata-store", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const json event = json::parse(static_cast<const char*>(msg->payload()),
                                   static_cast<const char*>(msg->payload()) + msg->len());
    store.upsert(event["entity"].get<std::string>(), event["tier"].get<int>(),
                 event["tags"].get<std::map<std::string, std::string>>(), event["version"].get<int>());
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "entity.classified";

struct CatalogueStore {
  void insertOutbox(const std::string& entity, const json& event);
  int currentVersion(const std::string& entity);
  void upsert(const std::string& entity, int tier, const std::map<std::string, std::string>& tags, int version);
};

CatalogueStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

void publishClassified(const std::string& entity, int tier, const std::map<std::string, std::string>& tags,
                       const std::string& verifiedBy, int version) {
  const json event = {{"id", entity + ":" + std::to_string(version)}, {"entity", entity}, {"tier", tier},
                      {"tags", tags},  {"verified_by", verifiedBy}, {"version", version}};
  const auto payload = event.dump();
  const auto err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                     const_cast<char*>(payload.data()), payload.size(), entity.data(), entity.size(),
                                     0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(entity, event);
    return;
  }
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "metadata-store", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto* begin = static_cast<const char*>(msg->payload());
    const json event = json::parse(begin, begin + msg->len(), nullptr, false);
    if (!event.is_object()) {
      consumer->commitSync(msg.get());
      continue;
    }
    const auto entity = event["entity"].get<std::string>();
    const int version = event["version"].get<int>();
    const int current = store.currentVersion(entity);
    if (version <= current) {
      consumer->commitSync(msg.get());
      continue;
    }
    store.upsert(entity, event["tier"].get<int>(), event["tags"].get<std::map<std::string, std::string>>(), version);
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  debrief: `The message key is an ordering contract: partition by entity and an entity's versions arrive in order; key by event id and they do not, which is why the fix changes one argument and nothing about the payload. Exactly-once *looking* code is not exactly-once: the producer needs idempotence and acks=all, and the consumer must apply its write before the offset commit or a crash loses it, with the version guard turning the replay into a no-op. A broker is not a database, so the durable path on a failed produce is an outbox row a relay drains. The version guard matters here because this topic decides who can read a table. Production platforms also validate the event against a schema registry and reconcile the catalogue against the latest version per entity.`,
};
