import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'embed.ready: one event per stored document',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'redis', 'topic', 'outbox', 'indexer'],
  task: `## Task

**Starting point.** The starter's \`publish_ready(tenant, document_id, chunks)\` takes the document's
\`Chunk\`s (text and vector, from \`embedding.config\`). For each chunk it produces an \`embed.ready\`
record keyed by the chunk's content hash with \`acks=1\`, writes an outbox row when \`produce\` raises,
and then stores the vector with \`cache.store_vector\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** An indexer that sees a document's chunks spread over
partitions and cannot tell when it is complete, an event for a vector that is not stored yet, an
event lost when the partition leader fails, and a broker refusal nobody keeps.

- Store **every** chunk's vector first (\`cache.store_vector(tenant, MODEL_VERSION, text, …)\`), then
  produce **one** event keyed by \`document_id\`: \`{tenant, document_id, model_version,
  content_hashes, chunk_count}\`, hashes in chunk order.
- Produce with \`acks=all\`, so the event survives a leader failover.
- A refused record arrives in the **delivery report** (\`on_delivery\`), not as an exception from
  \`produce\`: write \`outbox.insert_outbox(TOPIC, document_id, value)\` there.`,
  sequence: {
    participants: ['Worker', 'Vector cache', 'embed.ready', 'Outbox'],
    messages: [
      {from: 'Worker', to: 'Vector cache', label: 'store_vector per chunk', kind: 'sync'},
      {from: 'Worker', to: 'embed.ready', label: 'produce key=document_id · acks=all', kind: 'async'},
      {from: 'embed.ready', to: 'Worker', label: 'delivery report', kind: 'reply'},
      {from: 'Worker', to: 'Outbox', label: 'on error: insert_outbox(topic, key, value)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'document-event',
      title: 'One event per document, keyed by document id',
      detail:
        'The record key is the document id and the event lists every chunk’s content hash, so one document lands on one partition as one message.',
      match: {
        python: {all: [/key\s*=\s*document_id/, /content_hashes/]},
        typescript: {all: [/key:\s*documentId/, /content_hashes/]},
        go: {all: [/Key:\s*\[\]byte\(documentID\)/, /content_hashes/]},
        scala: {all: [/ProducerRecord\[String,\s*String\]\(\s*Config\.Topic\s*,\s*documentId/, /content_hashes/]},
        cpp: {all: [/document_id\.(c_str|data)\(\)/, /content_hashes/]},
      },
    },
    {
      id: 'after-write',
      title: 'Produces after every vector is stored',
      detail:
        'Every `store_vector` call comes before the produce, so the indexer never fetches a vector that is not there.',
      match: {
        python: {order: [/store_vector\(/, /producer\.produce\(/]},
        typescript: {order: [/storeVector\(/, /producer\.send\(/]},
        go: {order: [/cache\.StoreVector\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/Cache\.storeVector\(/, /producer\.send\(/]},
        cpp: {order: [/cache::storeVector\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'acks-all',
      title: 'acks=all',
      detail: 'The producer waits for every in-sync replica; a leader-only acknowledgement is lost with the leader.',
      match: {
        python: {none: [/["']acks["']\s*:\s*["']?[01]\b/]},
        typescript: {none: [/acks:\s*[01]\b/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {none: [/"acks"\s*,\s*"[01]"/]},
        cpp: {none: [/"acks"\s*,\s*"[01]"/]},
      },
    },
    {
      id: 'outbox',
      title: 'A refused record goes to the outbox from the delivery report',
      detail:
        'The outbox row is written where the broker’s answer arrives (`on_delivery`, a rejected `send`, the `WriteMessages` error, `dr_cb`, a producer `Callback`), not in a `try` around the enqueue.',
      match: {
        python: {all: [/on_delivery\s*=/, /outbox\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/outbox\.insertOutbox\(/], none: [/\.catch\(/]},
        go: {all: [/outbox\.InsertOutbox\(/]},
        scala: {all: [/onCompletion/, /Outbox\.insertOutbox\(/], none: [/case\s+\w+:\s*KafkaException/]},
        cpp: {all: [/dr_cb/, /outbox::insertOutbox\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import KafkaException, Producer

from embedding import cache, outbox
from embedding.config import MODEL_VERSION, TOPIC, Chunk, content_hash

log = logging.getLogger("embedd.ready")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_ready(tenant: str, document_id: str, chunks: list[Chunk]) -> dict:
    """Store the document's chunk vectors and tell the indexer the document is ready."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    hashes = []
    for chunk in chunks:
        digest = content_hash(chunk.text)
        value = json.dumps({"tenant": tenant, "document_id": document_id, "model_version": MODEL_VERSION, "content_hash": digest})
        try:
            producer.produce(TOPIC, key=digest, value=value)
            producer.poll(0)
        except KafkaException as err:
            outbox.insert_outbox(TOPIC, digest, value)
            log.warning("embed.ready produce failed document=%s: %s", document_id, err)
        cache.store_vector(tenant, MODEL_VERSION, chunk.text, lambda chunk=chunk: chunk.vector)
        hashes.append(digest)
    return {"tenant": tenant, "document_id": document_id, "model_version": MODEL_VERSION, "content_hashes": hashes, "chunk_count": len(hashes)}
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from embedding import cache, outbox
from embedding.config import MODEL_VERSION, TOPIC, Chunk, content_hash

log = logging.getLogger("embedd.ready")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def publish_ready(tenant: str, document_id: str, chunks: list[Chunk]) -> dict:
    """Store the document's chunk vectors and tell the indexer the document is ready."""
    hashes = []
    for chunk in chunks:
        cache.store_vector(tenant, MODEL_VERSION, chunk.text, lambda chunk=chunk: chunk.vector)
        hashes.append(content_hash(chunk.text))
    event = {"tenant": tenant, "document_id": document_id, "model_version": MODEL_VERSION, "content_hashes": hashes, "chunk_count": len(hashes)}
    value = json.dumps(event)

    def on_delivery(err, msg) -> None:
        if err is not None:
            outbox.insert_outbox(TOPIC, document_id, value)  # the broker said no: the relay republishes it
            log.warning("embed.ready produce failed document=%s: %s", document_id, err)

    producer.produce(TOPIC, key=document_id, value=value, on_delivery=on_delivery)
    producer.poll(0)  # serve delivery reports already in; returns at once
    return event
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {cache} from 'embedding/cache';
import {type Chunk, MODEL_VERSION, TOPIC, contentHash} from 'embedding/config';

const kafka = new Kafka({clientId: 'embedd', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();

/** Store the document's chunk vectors and tell the indexer the document is ready. */
export async function publishReady(tenant: string, documentId: string, chunks: Chunk[]) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const hashes: string[] = [];
  for (const chunk of chunks) {
    const digest = contentHash(chunk.text);
    const value = JSON.stringify({tenant, document_id: documentId, model_version: MODEL_VERSION, content_hash: digest});
    await producer
      .send({topic: TOPIC, acks: 1, messages: [{key: digest, value}]})
      .catch(err => console.warn(\`embed.ready produce failed document=\${documentId}: \${(err as Error).message}\`));
    await cache.storeVector(tenant, MODEL_VERSION, chunk.text, async () => chunk.vector);
    hashes.push(digest);
  }
  return {tenant, document_id: documentId, model_version: MODEL_VERSION, content_hashes: hashes, chunk_count: hashes.length};
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {cache} from 'embedding/cache';
import {type Chunk, MODEL_VERSION, TOPIC, contentHash} from 'embedding/config';
import {outbox} from 'embedding/outbox';

const kafka = new Kafka({clientId: 'embedd', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();

/** Store the document's chunk vectors and tell the indexer the document is ready. */
export async function publishReady(tenant: string, documentId: string, chunks: Chunk[]) {
  const hashes: string[] = [];
  for (const chunk of chunks) {
    await cache.storeVector(tenant, MODEL_VERSION, chunk.text, async () => chunk.vector);
    hashes.push(contentHash(chunk.text));
  }
  const event = {tenant, document_id: documentId, model_version: MODEL_VERSION, content_hashes: hashes, chunk_count: hashes.length};
  const value = JSON.stringify(event);
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: documentId, value}]});
  } catch (err) {
    await outbox.insertOutbox(TOPIC, documentId, value); // the broker said no: the relay republishes it
    console.warn(\`embed.ready produce failed document=\${documentId}: \${(err as Error).message}\`);
  }
  return event;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"

	"embedding/cache"  // cache.StoreVector — provided
	"embedding/config" // config.Topic, ModelVersion, ContentHash, Chunk — provided
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        config.Topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
}

type readyEvent struct {
	Tenant        string   \`json:"tenant"\`
	DocumentID    string   \`json:"document_id"\`
	ModelVersion  string   \`json:"model_version"\`
	ContentHashes []string \`json:"content_hashes"\`
	ChunkCount    int      \`json:"chunk_count"\`
}

// publishReady stores the document's chunk vectors and tells the indexer the document is ready.
func publishReady(ctx context.Context, tenant, documentID string, chunks []config.Chunk) (readyEvent, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	event := readyEvent{Tenant: tenant, DocumentID: documentID, ModelVersion: config.ModelVersion, ContentHashes: []string{}}
	for _, chunk := range chunks {
		digest := config.ContentHash(chunk.Text)
		value, _ := json.Marshal(map[string]string{"tenant": tenant, "document_id": documentID, "model_version": config.ModelVersion, "content_hash": digest})
		if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(digest), Value: value}); err != nil {
			log.Printf("embed.ready produce failed document=%s: %v", documentID, err)
		}
		vector := chunk.Vector
		if _, err := cache.StoreVector(ctx, tenant, config.ModelVersion, chunk.Text, func() ([]float32, error) { return vector, nil }); err != nil {
			return event, err
		}
		event.ContentHashes = append(event.ContentHashes, digest)
	}
	event.ChunkCount = len(event.ContentHashes)
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"

	"embedding/cache"  // cache.StoreVector — provided
	"embedding/config" // config.Topic, ModelVersion, ContentHash, Chunk — provided
	"embedding/outbox" // outbox.InsertOutbox — provided
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        config.Topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll, // every in-sync replica has it before the write returns
}

type readyEvent struct {
	Tenant        string   \`json:"tenant"\`
	DocumentID    string   \`json:"document_id"\`
	ModelVersion  string   \`json:"model_version"\`
	ContentHashes []string \`json:"content_hashes"\`
	ChunkCount    int      \`json:"chunk_count"\`
}

// publishReady stores the document's chunk vectors and tells the indexer the document is ready.
func publishReady(ctx context.Context, tenant, documentID string, chunks []config.Chunk) (readyEvent, error) {
	event := readyEvent{Tenant: tenant, DocumentID: documentID, ModelVersion: config.ModelVersion, ContentHashes: []string{}}
	for _, chunk := range chunks {
		vector := chunk.Vector
		if _, err := cache.StoreVector(ctx, tenant, config.ModelVersion, chunk.Text, func() ([]float32, error) { return vector, nil }); err != nil {
			return event, err
		}
		event.ContentHashes = append(event.ContentHashes, config.ContentHash(chunk.Text))
	}
	event.ChunkCount = len(event.ContentHashes)
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(documentID), Value: value}); err != nil {
		// The broker said no: the relay republishes it.
		if err := outbox.InsertOutbox(ctx, config.Topic, documentID, value); err != nil {
			return event, err
		}
		log.Printf("embed.ready produce failed document=%s: %v", documentID, err)
	}
	return event, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer

import embedding.{Cache, Chunk, Config, Outbox}

object ReadyPublisher {
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Store the document's chunk vectors and tell the indexer the document is ready. */
  def publishReady(tenant: String, documentId: String, chunks: Seq[Chunk]): ujson.Obj = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val hashes = chunks.map { chunk =>
      val digest = Config.contentHash(chunk.text)
      val value = ujson.write(ujson.Obj("tenant" -> tenant, "document_id" -> documentId, "model_version" -> Config.ModelVersion, "content_hash" -> digest))
      try producer.send(new ProducerRecord[String, String](Config.Topic, digest, value))
      catch {
        case e: KafkaException =>
          Outbox.insertOutbox(Config.Topic, digest, value)
          System.err.println(s"embed.ready produce failed document=$documentId: \${e.getMessage}")
      }
      Cache.storeVector(tenant, Config.ModelVersion, chunk.text, () => chunk.vector)
      digest
    }
    ujson.Obj("tenant" -> tenant, "document_id" -> documentId, "model_version" -> Config.ModelVersion, "content_hashes" -> ujson.Arr.from(hashes.map(ujson.Str(_))), "chunk_count" -> hashes.size)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer

import embedding.{Cache, Chunk, Config, Outbox}

object ReadyPublisher {
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Store the document's chunk vectors and tell the indexer the document is ready. */
  def publishReady(tenant: String, documentId: String, chunks: Seq[Chunk]): ujson.Obj = {
    val hashes = chunks.map { chunk =>
      Cache.storeVector(tenant, Config.ModelVersion, chunk.text, () => chunk.vector)
      Config.contentHash(chunk.text)
    }
    val event = ujson.Obj(
      "tenant" -> tenant,
      "document_id" -> documentId,
      "model_version" -> Config.ModelVersion,
      "content_hashes" -> ujson.Arr.from(hashes.map(ujson.Str(_))),
      "chunk_count" -> hashes.size
    )
    val value = ujson.write(event)
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) {
          Outbox.insertOutbox(Config.Topic, documentId, value) // the broker said no: the relay republishes it
          System.err.println(s"embed.ready produce failed document=$documentId: \${exception.getMessage}")
        }
    }
    producer.send(new ProducerRecord[String, String](Config.Topic, documentId, value), onDelivery)
    event
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include "embedding/cache.h"   // cache::storeVector — provided
#include "embedding/config.h"  // config::kTopic, kModelVersion, contentHash, Chunk — provided
#include "embedding/outbox.h"  // outbox::insertOutbox — provided

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Store the document's chunk vectors and tell the indexer the document is ready.
nlohmann::json publishReady(const std::string& tenant, const std::string& document_id, const std::vector<config::Chunk>& chunks) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  nlohmann::json hashes = nlohmann::json::array();
  for (const config::Chunk& chunk : chunks) {
    const std::string digest = config::contentHash(chunk.text);
    const std::string value = nlohmann::json{{"tenant", tenant}, {"document_id", document_id}, {"model_version", config::kModelVersion}, {"content_hash", digest}}.dump();
    const auto code = producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                        const_cast<char*>(value.data()), value.size(), digest.c_str(), digest.size(), 0, nullptr);
    if (code != RdKafka::ERR_NO_ERROR) {
      outbox::insertOutbox(config::kTopic, digest, value);
      std::cerr << "embed.ready produce failed document=" << document_id << ": " << RdKafka::err2str(code) << "\\n";
    }
    producer->poll(0);
    cache::storeVector(tenant, config::kModelVersion, chunk.text, [&chunk] { return chunk.vector; });
    hashes.push_back(digest);
  }
  return {{"tenant", tenant}, {"document_id", document_id}, {"model_version", config::kModelVersion}, {"content_hashes", hashes}, {"chunk_count", hashes.size()}};
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include "embedding/cache.h"   // cache::storeVector — provided
#include "embedding/config.h"  // config::kTopic, kModelVersion, contentHash, Chunk — provided
#include "embedding/outbox.h"  // outbox::insertOutbox — provided

// The delivery report: a refused record goes to the outbox for the relay to republish.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    const std::string key = message.key() ? *message.key() : "";
    outbox::insertOutbox(message.topic_name(), key, std::string(static_cast<const char*>(message.payload()), message.len()));
    std::cerr << "embed.ready produce failed document=" << key << ": " << message.errstr() << "\\n";
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Store the document's chunk vectors and tell the indexer the document is ready.
nlohmann::json publishReady(const std::string& tenant, const std::string& document_id, const std::vector<config::Chunk>& chunks) {
  nlohmann::json hashes = nlohmann::json::array();
  for (const config::Chunk& chunk : chunks) {
    cache::storeVector(tenant, config::kModelVersion, chunk.text, [&chunk] { return chunk.vector; });
    hashes.push_back(config::contentHash(chunk.text));
  }
  const nlohmann::json event = {{"tenant", tenant}, {"document_id", document_id}, {"model_version", config::kModelVersion},
                                {"content_hashes", hashes}, {"chunk_count", hashes.size()}};
  const std::string value = event.dump();
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), document_id.c_str(), document_id.size(), 0, nullptr);
  producer->poll(0);  // serve delivery reports already in; returns at once
  return event;
}
`,
    },
  },
  harness: {
    python: `import json

from embedding import model
from embedding.config import MODEL_VERSION, TOPIC, Chunk, content_hash, vector_key

TENANT = "acme"
DOC = "doc-42"
TEXTS = ["Rotate keys every 90 days.", "Revoke a leaked key at once.", "Audit key use weekly."]


def _chunks(texts=TEXTS):
    return [Chunk(text=t, vector=model.vector_for(MODEL_VERSION, t)) for t in texts]


def _settle(m):
    """Serve the producer's delivery reports, as the worker's loop would between documents."""
    producer = getattr(m, "producer", None)
    if producer is not None:
        producer.poll(0)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox:embed", 0, -1)]


def check_document_event(ctx):
    m = ctx.load("events")
    m.publish_ready(TENANT, DOC, _chunks())
    m.publish_ready(TENANT, "doc-43", _chunks(["Use one key per service."]))
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 2, f"two documents (three chunks and one) produced {len(records)} records on {TOPIC}: the indexer needs one event per document to know it is complete"
    keys = [r.key for r in records]
    assert keys == [DOC.encode(), b"doc-43"], f"records must be keyed by document id, got {keys}"
    event = json.loads(records[0].value)
    expected = {"tenant": TENANT, "document_id": DOC, "model_version": MODEL_VERSION, "content_hashes": [content_hash(t) for t in TEXTS], "chunk_count": 3}
    for key, value in expected.items():
        assert event.get(key) == value, f"the event must carry {key}={value!r}, got {event}"


def check_after_write(ctx):
    m = ctx.load("events")
    last = vector_key(TENANT, MODEL_VERSION, content_hash(TEXTS[-1]))
    probe = ctx.redis_after(last, lambda: len(ctx.kafka.records(TOPIC)))
    m.publish_ready(TENANT, DOC, _chunks())
    _settle(m)
    assert probe.fired, f"publish_ready never wrote the last chunk's vector ({last})"
    assert probe.result == 0, f"when the last chunk's vector was being stored, {probe.result} record(s) were already on {TOPIC}: the indexer would fetch a vector that is not there yet"
    for t in TEXTS:
        assert ctx.redis.get(vector_key(TENANT, MODEL_VERSION, content_hash(t))) is not None, f"every chunk's vector is stored; {t!r} is missing"
    assert len(ctx.kafka.records(TOPIC)) >= 1, "the document is announced once its vectors are stored"


def check_acks_all(ctx):
    m = ctx.load("events")
    m.publish_ready(TENANT, DOC, _chunks())
    _settle(m)
    produced = len(ctx.kafka.records(TOPIC))
    assert produced >= 1, f"publish_ready produced nothing on {TOPIC}"
    ctx.kafka.failover(TOPIC)
    kept = len(ctx.kafka.records(TOPIC))
    assert kept == produced, f"the partition leader failed right after the event was acknowledged and {produced - kept} of {produced} record(s) are gone: acks=1 lets only the leader hold them; acks=all waits for the replicas"


def check_outbox(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.publish_ready(TENANT, DOC, _chunks())
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"publish_ready raised when the broker refused the record: {e!r}; the event goes to the outbox and the worker goes on") from e
    _settle(m)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused the record and the outbox holds {len(rows)} rows: the refusal arrives in the delivery report, which is where the row is written"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == DOC, f"the outbox row must carry the topic and the document key, got {row}"
    assert json.loads(row.get("value", "{}")).get("content_hashes") == [content_hash(t) for t in TEXTS], f"the outbox row's value must be the event, got {row}"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused record"
    m.publish_ready(TENANT, "doc-43", _chunks(["Use one key per service."]))
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(_outbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row"
`,
    typescript: `const TENANT = 'acme';
const DOC = 'doc-42';
const TEXTS = ['Rotate keys every 90 days.', 'Revoke a leaked key at once.', 'Audit key use weekly.'];

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function world(ctx) {
  const config = ctx.load('/support/embedding/config.ts');
  const model = ctx.load('/support/embedding/model.ts');
  const chunks = (texts: string[] = TEXTS) => texts.map(text => ({text, vector: model.vectorFor(config.MODEL_VERSION, text)}));
  return {m: ctx.load('events'), config, chunks};
}

const outboxRows = ctx => ctx.redis.lrange('outbox:embed', 0, -1).map(row => JSON.parse(row));

export async function check_document_event(ctx) {
  const {m, config, chunks} = world(ctx);
  await m.publishReady(TENANT, DOC, chunks());
  await m.publishReady(TENANT, 'doc-43', chunks(['Use one key per service.']));
  await settle();
  const records = ctx.kafka.records(config.TOPIC);
  assert.equal(records.length, 2, \`two documents (three chunks and one) produced \${records.length} records on \${config.TOPIC}: the indexer needs one event per document to know it is complete\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepEqual(keys, [DOC, 'doc-43'], \`records must be keyed by document id, got \${JSON.stringify(keys)}\`);
  const event = JSON.parse(records[0].value.toString());
  const expected = {tenant: TENANT, document_id: DOC, model_version: config.MODEL_VERSION, content_hashes: TEXTS.map(config.contentHash), chunk_count: 3};
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(event[key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${JSON.stringify(event)}\`);
}

export async function check_after_write(ctx) {
  const {m, config, chunks} = world(ctx);
  const last = config.vectorKey(TENANT, config.MODEL_VERSION, config.contentHash(TEXTS[2]));
  const probe = ctx.redisAfter(last, () => ctx.kafka.records(config.TOPIC).length);
  await m.publishReady(TENANT, DOC, chunks());
  await settle();
  assert(probe.fired, \`publishReady never wrote the last chunk's vector (\${last})\`);
  assert.equal(probe.result, 0, \`when the last chunk's vector was being stored, \${probe.result} record(s) were already on \${config.TOPIC}: the indexer would fetch a vector that is not there yet\`);
  for (const t of TEXTS) assert(ctx.redis.get(config.vectorKey(TENANT, config.MODEL_VERSION, config.contentHash(t))) !== null, \`every chunk's vector is stored; "\${t}" is missing\`);
  assert(ctx.kafka.records(config.TOPIC).length >= 1, 'the document is announced once its vectors are stored');
}

export async function check_acks_all(ctx) {
  const {m, config, chunks} = world(ctx);
  await m.publishReady(TENANT, DOC, chunks());
  await settle();
  const produced = ctx.kafka.records(config.TOPIC).length;
  assert(produced >= 1, \`publishReady produced nothing on \${config.TOPIC}\`);
  ctx.kafka.failover(config.TOPIC);
  const kept = ctx.kafka.records(config.TOPIC).length;
  assert.equal(kept, produced, \`the partition leader failed right after the event was acknowledged and \${produced - kept} of \${produced} record(s) are gone: acks=1 lets only the leader hold them; acks=all waits for the replicas\`);
}

export async function check_outbox(ctx) {
  const {m, config, chunks} = world(ctx);
  ctx.kafka.failNext(config.TOPIC, 1);
  try {
    await m.publishReady(TENANT, DOC, chunks());
  } catch (e) {
    assert.fail(\`publishReady rejected when the broker refused the record: \${e}; the event goes to the outbox and the worker goes on\`);
  }
  await settle();
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused the record and the outbox holds \${rows.length} rows: the refusal arrives as a rejected send, which is where the row is written\`);
  assert(rows[0].topic === config.TOPIC && rows[0].key === DOC, \`the outbox row must carry the topic and the document key, got \${JSON.stringify(rows[0])}\`);
  assert.deepEqual(JSON.parse(rows[0].value ?? '{}').content_hashes, TEXTS.map(config.contentHash), \`the outbox row's value must be the event, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ctx.kafka.records(config.TOPIC).length, 0, 'nothing reached the topic for the refused record');
  await m.publishReady(TENANT, 'doc-43', chunks(['Use one key per service.']));
  await settle();
  assert(ctx.kafka.records(config.TOPIC).length === 1 && outboxRows(ctx).length === 1, 'a healthy produce after the failure reaches the topic and adds no outbox row');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"embedding/config"
	"embedding/model"

	"leetbuild/harness"
)

const (
	eventsTenant = "acme"
	eventsDoc    = "doc-42"
)

var eventsTexts = []string{"Rotate keys every 90 days.", "Revoke a leaked key at once.", "Audit key use weekly."}

func eventsChunks(texts []string) []config.Chunk {
	out := make([]config.Chunk, 0, len(texts))
	for _, t := range texts {
		out = append(out, config.Chunk{Text: t, Vector: model.VectorFor(config.ModelVersion, t)})
	}
	return out
}

func eventsHashes(texts []string) []string {
	out := make([]string, 0, len(texts))
	for _, t := range texts {
		out = append(out, config.ContentHash(t))
	}
	return out
}

func eventsPublish(ctx *harness.Ctx, documentID string, texts []string) {
	_, err := publishReady(context.Background(), eventsTenant, documentID, eventsChunks(texts))
	ctx.NoError(err, "publishReady(%s)", documentID)
}

func eventsOutbox(ctx *harness.Ctx) []map[string]string {
	var out []map[string]string
	for _, row := range ctx.Redis.LRange("outbox:embed", 0, -1) {
		var r map[string]string
		ctx.NoError(json.Unmarshal([]byte(row), &r), "the outbox row is JSON: %s", row)
		out = append(out, r)
	}
	return out
}

func CheckDocumentEvent(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsDoc, eventsTexts)
	eventsPublish(ctx, "doc-43", []string{"Use one key per service."})
	ctx.Settle()
	records := ctx.Kafka.Records(config.Topic)
	ctx.Equal(len(records), 2, "two documents (three chunks and one) must produce one event each on %s, so the indexer knows a document is complete; records", config.Topic)
	keys := ctx.Kafka.Keys(config.Topic)
	ctx.Assert(len(keys) == 2 && ((keys[0] == eventsDoc && keys[1] == "doc-43") || (keys[0] == "doc-43" && keys[1] == eventsDoc)), "records must be keyed by document id, got %v", keys)
	var event map[string]any
	for _, r := range records {
		if string(r.Key) == eventsDoc {
			ctx.NoError(json.Unmarshal(r.Value, &event), "the event is JSON: %s", r.Value)
		}
	}
	ctx.Equal(event["tenant"], eventsTenant, "the event's tenant (%v)", event)
	ctx.Equal(event["document_id"], eventsDoc, "the event's document_id (%v)", event)
	ctx.Equal(event["model_version"], config.ModelVersion, "the event's model_version (%v)", event)
	hashes := []any{}
	for _, h := range eventsHashes(eventsTexts) {
		hashes = append(hashes, h)
	}
	ctx.Equal(event["content_hashes"], hashes, "the event must list every chunk's content hash in order")
	ctx.Equal(event["chunk_count"], 3, "the event's chunk_count")
}

func CheckAfterWrite(ctx *harness.Ctx) {
	last := config.VectorKey(eventsTenant, config.ModelVersion, config.ContentHash(eventsTexts[2]))
	probe := ctx.Redis.After(last, func() any { return len(ctx.Kafka.Records(config.Topic)) })
	eventsPublish(ctx, eventsDoc, eventsTexts)
	ctx.Settle()
	ctx.Assert(probe.Fired, "publishReady never wrote the last chunk's vector (%s)", last)
	ctx.Equal(probe.Result, 0, "when the last chunk's vector was being stored, records were already on %s: the indexer would fetch a vector that is not there yet; records at that moment", config.Topic)
	for _, t := range eventsTexts {
		_, ok := ctx.Redis.Get(config.VectorKey(eventsTenant, config.ModelVersion, config.ContentHash(t)))
		ctx.Assert(ok, "every chunk's vector is stored; %q is missing", t)
	}
	ctx.Assert(len(ctx.Kafka.Records(config.Topic)) >= 1, "the document is announced once its vectors are stored")
}

func CheckAcksAll(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsDoc, eventsTexts)
	ctx.Settle()
	produced := len(ctx.Kafka.Records(config.Topic))
	ctx.Assert(produced >= 1, "publishReady produced nothing on %s", config.Topic)
	ctx.Kafka.Failover(config.Topic)
	kept := len(ctx.Kafka.Records(config.Topic))
	ctx.Assert(kept == produced, "the partition leader failed right after the event was acknowledged and %d of %d record(s) are gone: RequireOne lets only the leader hold them; RequireAll waits for the replicas", produced-kept, produced)
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(config.Topic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("publishReady panicked when the broker refused the record: %v; the event goes to the outbox and the worker goes on", e)
			}
		}()
		eventsPublish(ctx, eventsDoc, eventsTexts)
	}()
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused the record: the refusal arrives as the WriteMessages error, which is where the outbox row is written; outbox rows")
	ctx.Assert(rows[0]["topic"] == config.Topic && rows[0]["key"] == eventsDoc, "the outbox row must carry the topic and the document key, got %v", rows[0])
	var event map[string]any
	json.Unmarshal([]byte(rows[0]["value"]), &event)
	ctx.Equal(event["document_id"], eventsDoc, "the outbox row's value must be the event (%v)", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(config.Topic)), 0, "nothing reached the topic for the refused record; records")
	eventsPublish(ctx, "doc-43", []string{"Use one key per service."})
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(config.Topic)) == 1 && len(eventsOutbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <string>
#include <vector>

#include "embedding/config.h"
#include "embedding/model.h"

namespace {

const std::string kTenant = "acme";
const std::string kDoc = "doc-42";
const std::vector<std::string> kTexts = {"Rotate keys every 90 days.", "Revoke a leaked key at once.", "Audit key use weekly."};

std::vector<config::Chunk> chunksOf(const std::vector<std::string>& texts) {
  std::vector<config::Chunk> out;
  for (const auto& t : texts) out.push_back({t, model::vectorFor(config::kModelVersion, t)});
  return out;
}

std::vector<std::string> hashesOf(const std::vector<std::string>& texts) {
  std::vector<std::string> out;
  for (const auto& t : texts) out.push_back(config::contentHash(t));
  return out;
}

// The worker's loop serves delivery reports between documents.
void settle(harness::Ctx& ctx) {
  ctx.Settle();
  producer->poll(0);
}

std::vector<nlohmann::json> outboxRows(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& row : ctx.Redis.LRange("outbox:embed", 0, -1)) out.push_back(nlohmann::json::parse(row, nullptr, false));
  return out;
}

}  // namespace

void CheckDocumentEvent(harness::Ctx& ctx) {
  publishReady(kTenant, kDoc, chunksOf(kTexts));
  publishReady(kTenant, "doc-43", chunksOf({"Use one key per service."}));
  settle(ctx);
  const auto records = ctx.Kafka.Records(config::kTopic);
  ctx.Equal(records.size(), 2, "two documents (three chunks and one) must produce one event each on %s, so the indexer knows a document is complete; records", config::kTopic);
  ctx.Equal(ctx.Kafka.Keys(config::kTopic), std::vector<std::string>{kDoc, "doc-43"}, "records must be keyed by document id");
  const auto event = nlohmann::json::parse(records[0].Value.value_or("null"), nullptr, false);
  ctx.Equal(event.value("tenant", ""), kTenant, "the event's tenant (%v)", event);
  ctx.Equal(event.value("document_id", ""), kDoc, "the event's document_id (%v)", event);
  ctx.Equal(event.value("model_version", ""), config::kModelVersion, "the event's model_version (%v)", event);
  ctx.Equal(event.value("content_hashes", nlohmann::json::array()), nlohmann::json(hashesOf(kTexts)), "the event must list every chunk's content hash in order");
  ctx.Equal(event.value("chunk_count", 0), 3, "the event's chunk_count");
}

void CheckAfterWrite(harness::Ctx& ctx) {
  const std::string last = config::vectorKey(kTenant, config::kModelVersion, config::contentHash(kTexts[2]));
  bool fired = false;
  size_t seen = 0;
  ctx.Redis.After(last, [&] {
    fired = true;
    seen = ctx.Kafka.Records(config::kTopic).size();
  });
  publishReady(kTenant, kDoc, chunksOf(kTexts));
  settle(ctx);
  ctx.Assert(fired, "publishReady never wrote the last chunk's vector (%s)", last);
  ctx.Assert(seen == 0, "when the last chunk's vector was being stored, %d record(s) were already on %s: the indexer would fetch a vector that is not there yet", seen, config::kTopic);
  for (const auto& t : kTexts) ctx.Assert(ctx.Redis.Get(config::vectorKey(kTenant, config::kModelVersion, config::contentHash(t))).has_value(), "every chunk's vector is stored; %q is missing", t);
  ctx.Assert(!ctx.Kafka.Records(config::kTopic).empty(), "the document is announced once its vectors are stored");
}

void CheckAcksAll(harness::Ctx& ctx) {
  publishReady(kTenant, kDoc, chunksOf(kTexts));
  settle(ctx);
  const size_t produced = ctx.Kafka.Records(config::kTopic).size();
  ctx.Assert(produced >= 1, "publishReady produced nothing on %s", config::kTopic);
  ctx.Kafka.Failover(config::kTopic);
  const size_t kept = ctx.Kafka.Records(config::kTopic).size();
  ctx.Assert(kept == produced, "the partition leader failed right after the event was acknowledged and %d of %d record(s) are gone: acks=1 lets only the leader hold them; acks=all waits for the replicas", produced - kept, produced);
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(config::kTopic, 1);
  try {
    publishReady(kTenant, kDoc, chunksOf(kTexts));
  } catch (const std::exception& e) {
    ctx.Fatalf("publishReady threw when the broker refused the record: %s; the event goes to the outbox and the worker goes on", e.what());
  }
  settle(ctx);
  const auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused the record: the refusal arrives in the delivery report (dr_cb), which is where the outbox row is written; outbox rows");
  ctx.Assert(rows[0].value("topic", "") == config::kTopic && rows[0].value("key", "") == kDoc, "the outbox row must carry the topic and the document key, got %v", rows[0]);
  const auto event = nlohmann::json::parse(rows[0].value("value", "{}"), nullptr, false);
  ctx.Equal(event.value("document_id", ""), kDoc, "the outbox row's value must be the event (%v)", rows[0]);
  ctx.Equal(ctx.Kafka.Records(config::kTopic).size(), 0, "nothing reached the topic for the refused record; records");
  publishReady(kTenant, "doc-43", chunksOf({"Use one key per service."}));
  settle(ctx);
  ctx.Assert(ctx.Kafka.Records(config::kTopic).size() == 1 && outboxRows(ctx).size() == 1, "a healthy produce after the failure reaches the topic and adds no outbox row");
}
`,
  },
  hints: [
    'The indexer receives three records for a three-chunk document, on different partitions, and cannot tell which is the last. After a broker failover some events are gone, and a broker refusal leaves no outbox row.',
    'Each chunk is announced on its own, keyed by its hash, before its vector is written. `acks=1` trusts the leader alone. `produce` only enqueues: the broker’s refusal comes back in the delivery report, which nothing handles.',
    'Call `cache.store_vector` for every chunk first, then produce one event with `key=document_id` and `content_hashes`; configure `"acks": "all"`; pass `on_delivery` and call `outbox.insert_outbox(TOPIC, document_id, value)` when `err` is set.',
  ],
  debrief: `The event is the indexer’s promise that a document is complete, which fixes its shape: one event per document, after every vector is stored, so the indexer never fetches a vector that is not there and never indexes half a document. The key is the document id because a partition is where Kafka keeps order; a document updated twice is applied in order. \`acks=all\` makes the acknowledgement mean the replicas have the record, so a leader failover loses nothing that was confirmed. The outbox is written from the delivery report because that is where the broker’s refusal arrives. Production pipelines add a relay that drains the outbox with the same producer, a schema for the event, and an idempotent producer where the client supports one.`,
};
