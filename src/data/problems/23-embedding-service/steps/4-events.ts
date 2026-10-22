import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Embedding events for the indexer, keyed by document',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'outbox', 'topic', 'indexer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: once the vectors are stored it
publishes one \`embed.ready\` per chunk. The demo's single document arrives in order. It hides three
failures that only show up when documents are large or the broker is down. Find them and fix them.

Implement \`publish_ready(document_id, content_hashes)\` and \`event_key(document_id)\`:

- Publish **\`embed.ready\`** keyed by the **document id**, not the content hash. Keyed by document id
  every chunk of one document lands on one partition, so the indexer updates a document's chunks in
  order; keyed by content hash the chunks of one document scatter across partitions.
- Publish **only after the cache write commits**. The draft publishes first, so a crash between the
  two leaves an indexed document whose vectors were never written.
- Set **\`acks=all\`** so the produce is durable across replicas.
- When the produce is **rejected** — a full local queue or an unavailable broker — write an **outbox**
  row with the topic, the document key and the payload, so a relay can publish it later instead of
  the document being left unindexed.

**Failure mode the checks target.** Ordering dies first: keying by content hash scatters a document's
chunks, so the indexer applies them out of order. Durability dies second: publishing before the cache
write commits lets a crash produce an event for a document that was never stored. And the missing
outbox turns one broker outage into a document that is never indexed.`,
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
    "Key the event by `document_id`, not by the content hash: Kafka only preserves order within a partition, and one document's chunks must share one.",
    'Write the cache first and publish second — the event must never exist before the vectors it announces.',
    '`acks=all` makes the produce durable; on a rejected produce, record an outbox row so a relay can publish it later.',
  ],
  checks: [
    {
      id: 'key',
      title: 'Keys the event by document id',
      detail:
        'The event key is the `document_id`, so every chunk of one document lands on the same partition. The draft keys by content hash, so the chunks scatter.',
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
        'The producer is configured for `acks=all` so the event is durable across replicas. The draft leaves the default acks and loses an event when the leader fails.',
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
        'The cache write happens before the event is produced. The draft publishes first, so a crash leaves an event for a document that was never stored.',
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
        'A rejected produce writes an `outbox` row keyed by the document, so a relay can publish it later. The draft drops the event and leaves the document unindexed.',
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
        'The event goes to `embed.ready`, the topic the indexer consumes. The draft names the topic in a string literal at the call site instead of a named constant.',
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
      starter: `"""Draft: embed.ready — keyed by content hash, published before the cache write commits."""
import json

from confluent_kafka import Producer

producer = Producer({"bootstrap.servers": "kafka:9092"})  # acks defaults to 1


def publish_ready(document_id: str, content_hashes: list[str]) -> None:
    # TODO: key by document id (the draft keys by content hash, so chunks scatter), publish only
    # after the cache write commits (the draft publishes first) and record an outbox row when the
    # produce is rejected.
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
      starter: `/** Draft: embed.ready — keyed by content hash, published before the cache write commits. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();

export async function publishReady(documentId: string, contentHashes: string[]): Promise<void> {
  // TODO: key by document id (the draft keys by content hash, so chunks scatter), publish only
  // after the cache write commits (the draft publishes first) and record an outbox row when the
  // produce is rejected.
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
      starter: `// Draft: embed.ready — keyed by content hash, published before the cache write commits.
package main

import (
	"context"
	"encoding/json"

	kafka "github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092")}

func publishReady(ctx context.Context, documentID string, contentHashes []string) error {
	// TODO: key by document id (the draft keys by content hash, so chunks scatter), publish only
	// after the cache write commits (the draft publishes first) and record an outbox row when the
	// produce is rejected.
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
      starter: `// Draft: embed.ready — keyed by content hash, published before the cache write commits.
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object EventPublisher {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")

  val producer = new KafkaProducer[String, String](props)

  def publishReady(documentId: String, contentHashes: List[String]): Unit = {
    // TODO: key by document id (the draft keys by content hash, so chunks scatter), publish only
    // after the cache write commits (the draft publishes first) and record an outbox row when the
    // produce is rejected.
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
      starter: `// Draft: embed.ready — keyed by content hash, published before the cache write commits.
#include <librdkafka/rdkafkacpp.h>

#include <string>
#include <vector>

int publish_ready(
    RdKafka::Producer* producer,
    const std::string& document_id,
    const std::vector<std::string>& content_hashes) {
  // TODO: key by document id (the draft keys by content hash, so chunks scatter), publish only
  // after the cache write commits (the draft publishes first) and record an outbox row when the
  // produce is rejected.
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
  debrief: `Kafka orders within a partition, not across them — so the key is the ordering contract: key by
document and a document's chunks apply in order. Publish after the cache write commits, or the event
can announce vectors that were never stored. \`acks=all\` makes the produce durable, and the outbox row
turns a rejected produce into a document a relay can finish instead of a document that is never indexed.`,
};
