import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Embedding events for the indexer, keyed by document',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'outbox', 'topic', 'indexer'],
  task: `## Task

**Starting point.** The starter implements \`publish_ready(document_id, content_hashes)\`: for each
chunk it produces one \`embed.ready\` record keyed by the content hash with the producer's default
acks, then writes the chunk to the cache, and flushes at the end. The demo's single document arrives
in order. It compiles and hides 5 flaws.

**Failure mode the checks target.** A large document whose chunks the indexer applies out of order,
a crash that leaves an event for vectors that were not stored, and a broker outage that turns into a
document nobody indexes.

Requirements for \`publish_ready\` and \`event_key(document_id)\`:

- Publish **\`embed.ready\`** keyed by the **document id**, not the content hash, so every chunk of
  one document lands on one partition and the indexer applies them in order.
- Publish **only after the cache write commits**.
- Set **\`acks=all\`** so the produce is durable across replicas.
- When the produce is **rejected** (a full local queue or an unavailable broker), write an **outbox**
  row with the topic, the document key and the payload, so a relay can publish it later.`,
  sequence: {
    participants: ['Embedding API', 'Vector cache', 'Kafka', 'Outbox', 'Indexer'],
    messages: [
      {from: 'Embedding API', to: 'Vector cache', label: 'store every chunk vector', kind: 'sync'},
      {from: 'Vector cache', to: 'Embedding API', label: 'committed', kind: 'reply'},
      {from: 'Embedding API', to: 'Kafka', label: 'produce embed.ready · key = document_id · acks=all', kind: 'sync'},
      {from: 'Kafka', to: 'Embedding API', label: 'accepted / rejected', kind: 'reply'},
      {from: 'Embedding API', to: 'Outbox', label: 'INSERT row on rejection', kind: 'sync'},
      {from: 'Kafka', to: 'Indexer', label: 'embed.ready, one document per partition', kind: 'async'},
    ],
  },
  hints: [
    'Large documents come back from the indexer with chunks in the wrong order; after a broker outage, a batch of documents is embedded, cached, and still missing from the index.',
    'Kafka orders within a partition only, and the content hash spreads one document across many. The produce runs before the cache write, with acks=1 and no path for a rejected record.',
    'Return `document_id` from `event_key`, call `store.put` before `producer.produce`, set `acks=all` on the producer, and on a rejected produce insert an outbox row with topic, key and payload.',
  ],
  checks: [
    {
      id: 'key',
      title: 'Keys the event by document id',
      detail:
        'The event key is the `document_id`, so every chunk of one document lands on the same partition. The starter keys by content hash, so the chunks scatter.',
      match: {
        python: {all: [/def event_key\(/, /document_id/]},
        typescript: {all: [/function eventKey\(/, /documentId/]},
        go: {all: [/func eventKey\(/, /documentID/]},
        scala: {all: [/def eventKey\(/, /documentId/]},
        cpp: {all: [/event_key\(/, /document_id/]},
      },
    },
    {
      id: 'acks',
      title: 'Produces with acks=all',
      detail:
        'The producer is configured for `acks=all` so the event is durable across replicas. The starter leaves the default acks and loses an event when the leader fails.',
      match: {
        python: {all: [/def publish_ready\(/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/function publishReady\(/, /acks:\s*['"]all['"]/]},
        go: {all: [/func publishReady\(/, /RequireAll/]},
        scala: {all: [/def publishReady\(/, /["']acks["']\s*,\s*["']all["']/]},
        cpp: {all: [/publish_ready\(/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'persist-first',
      title: 'Publishes only after the cache write commits',
      detail:
        'The cache write happens before the event is produced. The starter publishes first, so a crash leaves an event for a document that was never stored.',
      match: {
        python: {order: [/store\.put\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.put\(/, /producer\.send\(/]},
        go: {order: [/store\.Put\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/store\.put\(/, /producer\.send\(/]},
        cpp: {order: [/store\.put\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'Records an outbox row when the produce is rejected',
      detail:
        'A rejected produce writes an `outbox` row keyed by the document, so a relay can publish it later. The starter drops the event and leaves the document unindexed.',
      match: {
        python: {all: [/outbox/, /document_id/]},
        typescript: {all: [/outbox/, /documentId/]},
        go: {all: [/outbox/, /documentID/]},
        scala: {all: [/outbox/, /documentId/]},
        cpp: {all: [/outbox/, /document_id/]},
      },
    },
    {
      id: 'topic',
      title: 'Publishes to the embed.ready topic',
      detail:
        'The event goes to `embed.ready`, the topic the indexer consumes. The starter names the topic in a string literal at the call site instead of a named constant.',
      match: {
        python: {all: [/EMBED_READY_TOPIC\s*=\s*["']embed\.ready["']/]},
        typescript: {all: [/EMBED_READY_TOPIC\s*=\s*['"]embed\.ready['"]/]},
        go: {all: [/embedReadyTopic\s*=\s*"embed\.ready"/]},
        scala: {all: [/EmbedReadyTopic\s*=\s*"embed\.ready"/]},
        cpp: {all: [/kEmbedReadyTopic\[\]\s*=\s*"embed\.ready"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""embed.ready: one record per stored chunk, so the indexer learns when a document's vectors exist."""
import json

from confluent_kafka import Producer

producer = Producer({"bootstrap.servers": "kafka:9092"})  # acks defaults to 1


def publish_ready(document_id: str, content_hashes: list[str]) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    for content_hash in content_hashes:
        producer.produce(topic="embed.ready", key=content_hash, value=json.dumps({"document_id": document_id}))
        store.put(content_hash, "ready")
    producer.flush()
`,
      solution: `"""embed.ready — keyed by document id, published only after the cache write commits."""
import json

from confluent_kafka import Producer

EMBED_READY_TOPIC = "embed.ready"
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def event_key(document_id: str) -> str:
    """The document id is the key, so every chunk of one document lands on one partition."""
    return document_id


def publish_ready(document_id: str, content_hashes: list[str]) -> None:
    """Persist every chunk, then publish; on a rejected produce, record the outbox row."""
    store.put(document_id, content_hashes)
    for content_hash in content_hashes:
        try:
            producer.produce(
                topic=EMBED_READY_TOPIC,
                key=event_key(document_id),
                value=json.dumps({"document_id": document_id, "content_hash": content_hash}),
            )
        except BufferError:
            db.execute(
                "INSERT INTO outbox (topic, key, payload) VALUES (%s, %s, %s)",
                (EMBED_READY_TOPIC, event_key(document_id), "{}"),
            )
    producer.flush()
`,
    },
    typescript: {
      starter: `/** embed.ready: one record per stored chunk, so the indexer learns when a document's vectors exist. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();

export async function publishReady(documentId: string, contentHashes: string[]): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  for (const contentHash of contentHashes) {
    await producer.send({
      topic: 'embed.ready',
      messages: [{key: contentHash, value: JSON.stringify({document_id: documentId})}],
    });
    await store.put(contentHash, 'ready');
  }
}
`,
      solution: `/** embed.ready — keyed by document id, published only after the cache write commits. */
import {Kafka} from 'kafkajs';

const EMBED_READY_TOPIC = 'embed.ready';
const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer({acks: 'all'});

/** The document id is the key, so every chunk of one document lands on one partition. */
function eventKey(documentId: string): string {
  return documentId;
}

export async function publishReady(documentId: string, contentHashes: string[]): Promise<void> {
  await store.put(documentId, contentHashes);
  for (const contentHash of contentHashes) {
    try {
      await producer.send({
        topic: EMBED_READY_TOPIC,
        messages: [{key: eventKey(documentId), value: JSON.stringify({document_id: documentId, content_hash: contentHash})}],
      });
    } catch (error) {
      await db.execute('INSERT INTO outbox (topic, key, payload) VALUES (?, ?, ?)', [
        EMBED_READY_TOPIC,
        eventKey(documentId),
        JSON.stringify({document_id: documentId}),
      ]);
    }
  }
}
`,
    },
    go: {
      starter: `// embed.ready: one record per stored chunk, so the indexer learns when a document's vectors exist.
package main

import (
	"context"
	"encoding/json"

	kafka "github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092")}

func publishReady(ctx context.Context, documentID string, contentHashes []string) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	for _, contentHash := range contentHashes {
		payload, _ := json.Marshal(map[string]any{"document_id": documentID})
		_ = writer.WriteMessages(ctx, kafka.Message{Topic: "embed.ready", Key: []byte(contentHash), Value: payload})
		store.Put(contentHash, "ready")
	}
	return nil
}
`,
      solution: `// embed.ready — keyed by document id, published only after the cache write commits.
package main

import (
	"context"
	"encoding/json"

	kafka "github.com/segmentio/kafka-go"
)

const embedReadyTopic = "embed.ready"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	RequiredAcks: kafka.RequireAll,
}

// eventKey is the document id, so every chunk of one document lands on one partition.
func eventKey(documentID string) string {
	return documentID
}

func publishReady(ctx context.Context, documentID string, contentHashes []string) error {
	store.Put(documentID, contentHashes)
	for _, contentHash := range contentHashes {
		payload, _ := json.Marshal(map[string]any{"document_id": documentID, "content_hash": contentHash})
		err := writer.WriteMessages(ctx, kafka.Message{
			Topic: embedReadyTopic,
			Key:   []byte(eventKey(documentID)),
			Value: payload,
		})
		if err != nil {
			_, _ = db.ExecContext(ctx,
				"INSERT INTO outbox (topic, key, payload) VALUES (?, ?, ?)",
				embedReadyTopic, eventKey(documentID), string(payload))
		}
	}
	return nil
}
`,
    },
    scala: {
      starter: `// embed.ready: one record per stored chunk, so the indexer learns when a document's vectors exist.
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object EventPublisher {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")

  val producer = new KafkaProducer[String, String](props)

  def publishReady(documentId: String, contentHashes: List[String]): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    contentHashes.foreach { contentHash =>
      producer.send(new ProducerRecord[String, String]("embed.ready", contentHash, s"""{"document_id":"$documentId"}"""))
      store.put(contentHash, "ready")
    }
    producer.flush()
  }
}
`,
      solution: `// embed.ready — keyed by document id, published only after the cache write commits.
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object EventPublisher {
  val EmbedReadyTopic = "embed.ready"

  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")

  val producer = new KafkaProducer[String, String](props)

  /** The document id is the key, so every chunk of one document lands on one partition. */
  def eventKey(documentId: String): String = documentId

  def publishReady(documentId: String, contentHashes: List[String]): Unit = {
    store.put(documentId, contentHashes)
    contentHashes.foreach { contentHash =>
      val payload = s"""{"document_id":"$documentId","content_hash":"$contentHash"}"""
      try {
        producer.send(new ProducerRecord[String, String](EmbedReadyTopic, eventKey(documentId), payload))
      } catch {
        case _: org.apache.kafka.common.errors.TimeoutException =>
          db.execute("INSERT INTO outbox (topic, key, payload) VALUES (?, ?, ?)", EmbedReadyTopic, eventKey(documentId), payload)
      }
    }
    producer.flush()
  }
}
`,
    },
    cpp: {
      starter: `// embed.ready: one record per stored chunk, so the indexer learns when a document's vectors exist.
#include <librdkafka/rdkafkacpp.h>

#include <string>
#include <vector>

int publish_ready(
    RdKafka::Producer* producer,
    const std::string& document_id,
    const std::vector<std::string>& content_hashes) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  for (const auto& content_hash : content_hashes) {
    RdKafka::ErrorCode err = producer->produce(
        "embed.ready", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(document_id.data()), document_id.size(),
        content_hash.data(), content_hash.size(), 0, nullptr);
    if (err != RdKafka::ERR_NO_ERROR) return 1;
    store.put(content_hash, "ready");
  }
  producer->flush(5000);
  return 0;
}
`,
      solution: `// embed.ready — keyed by document id, published only after the cache write commits.
#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <string>
#include <vector>

constexpr char kEmbedReadyTopic[] = "embed.ready";

/** The document id is the key, so every chunk of one document lands on one partition. */
std::string event_key(const std::string& document_id) { return document_id; }

/** The producer is configured for durability: acks=all so an event survives a leader failure. */
std::unique_ptr<RdKafka::Producer> make_producer() {
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  std::string err;
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

int publish_ready(
    RdKafka::Producer* producer,
    const std::string& document_id,
    const std::vector<std::string>& content_hashes) {
  store.put(document_id, content_hashes);
  for (const auto& content_hash : content_hashes) {
    const std::string payload = "{\\"document_id\\":\\"" + document_id + "\\",\\"content_hash\\":\\"" + content_hash + "\\"}";
    const std::string key = event_key(document_id);
    RdKafka::ErrorCode err = producer->produce(
        kEmbedReadyTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(key.data()), key.size(),
        payload.data(), payload.size(), 0, nullptr);
    if (err != RdKafka::ERR_NO_ERROR) {
      db.execute("INSERT INTO outbox (topic, key, payload) VALUES (?, ?, ?)", kEmbedReadyTopic, key, payload);
      return 1;
    }
  }
  producer->flush(5000);
  return 0;
}
`,
    },
  },
  debrief: `The key is the ordering contract because Kafka orders within a partition and nowhere else: key by
document and every chunk of that document rides one partition in the order it was produced. The
cache write goes first because an event is a promise that the vectors exist; produced before the
write, a crash makes it a lie the indexer acts on. \`acks=all\` makes the broker's acknowledgement
mean replicated, and the outbox row keeps a rejected produce from becoming a document nobody indexes.

This step's outbox has no relay and the producer is not idempotent. A production pipeline drains the
outbox with a relay, enables \`enable.idempotence\` so a retried produce cannot duplicate, and lets
the indexer tolerate a repeated event for a document it already holds.`,
};
