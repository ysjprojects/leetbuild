import type {Step} from '@/lib/types';

/**
 * Step 4 — the event path. One feedback.recorded event per rating, keyed by tenant so a tenant's
 * quality stream stays ordered, carrying a fingerprint instead of the comment, with an outbox row
 * when the broker rejects the produce.
 */
export const eventsStep: Step = {
  id: 'events',
  title: 'Feedback events without the comment text',
  concept: 'kafka',
  file: 'events',
  focus: ['collector', 'kafka', 'consumer'],
  sequence: {
    participants: ['Feedback Collector', 'feedback.recorded', 'Quality consumer'],
    messages: [
      {
        from: 'Feedback Collector',
        to: 'Feedback Collector',
        label: 'fingerprint the comment, keep the text out of the event',
        kind: 'sync',
      },
      {
        from: 'Feedback Collector',
        to: 'feedback.recorded',
        label: 'produce key=tenant request_id, rating, comment_fingerprint',
        kind: 'async',
      },
      {
        from: 'feedback.recorded',
        to: 'Feedback Collector',
        label: 'acks=all — broker confirms the write',
        kind: 'reply',
      },
      {from: 'feedback.recorded', to: 'Quality consumer', label: 'consume in tenant order', kind: 'async'},
      {from: 'Quality consumer', to: 'Quality consumer', label: 'HINCRBY quality counters', kind: 'sync'},
      {from: 'feedback.recorded', to: 'Feedback Collector', label: 'rejected — no ack', kind: 'reply'},
      {
        from: 'Feedback Collector',
        to: 'Feedback Collector',
        label: 'write an outbox row so the rating is not lost',
        kind: 'sync',
      },
    ],
  },
  task: `## Task

**Starting point.** \`events\` exposes \`publish(tenant, record)\`. It builds a payload with
\`request_id\`, \`rating\` and the raw \`comment\`, calls \`producer.send(TOPIC, key=rating, ...)\` on
the \`feedback.recorded\` topic, logs, and returns without waiting for the broker. It serves the demo
and hides five flaws.

**Failure mode the checks target.** One tenant's quality counters jump around because its events are
spread across partitions, the retained topic contains comment text the retention policy cannot reach,
and a broker rejection loses the rating.

- Produce with \`key=tenant\`, so every event for one tenant shares a partition and the consumer
  reads it in order. The rating is payload, not key.
- The payload carries \`request_id\`, \`rating\` and \`comment_fingerprint\`, a \`hashlib.sha256\` of
  salt plus comment. No \`"comment"\` field in the event.
- Configure the producer with \`acks="all"\` and use \`send_and_wait\` so the write is done only when
  the broker confirms.
- When the produce is rejected, write an \`outbox\` row after the send attempt so the rating can be
  republished later.`,
  hints: [
    'A tenant\u2019s satisfaction counter moves up and down between refreshes, and a privacy audit finds verbatim user comments in a topic retained for 90 days.',
    'The partition is chosen by the message key, and the key here is the rating value, so one tenant\u2019s events land on three partitions. The payload copies `record["comment"]` in; `send` returns before the broker answers.',
    'Use `producer.send_and_wait(TOPIC, key=tenant, value=payload)` with `acks="all"`, replace `comment` with `comment_fingerprint = hashlib.sha256(...)`. On rejection, `outbox.put` the record. The checks cover the rest.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Events are keyed by tenant',
      detail:
        'Set the message key to the tenant so every event for one tenant lands on the same partition and the quality consumer sees them in order — keying by rating value scrambles the stream.',
      match: {
        python: {all: [/key\s*=\s*tenant/, /producer\.send/], none: [/key\s*=\s*rating/]},
        typescript: {all: [/key\s*:\s*tenant/, /producer\.send\(/], none: [/key\s*:\s*rating/]},
        go: {all: [/Key:\s*\[\]byte\(tenant\)/, /WriteMessages\(/], none: [/Key:\s*\[\]byte\(rating\)/]},
        scala: {all: [/key\s*=\s*tenant/, /producer\.send\(/], none: [/key\s*=\s*rating/]},
        cpp: {all: [/key\s*=\s*tenant/, /produce\(/], none: [/key\s*=\s*rating/]},
      },
    },
    {
      id: 'no-comment-text',
      title: 'The payload carries a fingerprint, not the comment',
      detail:
        'The event schema carries `request_id`, `rating` and `comment_fingerprint`; the comment text itself must never appear in a retained, replicated topic.',
      match: {
        python: {all: [/comment_fingerprint/], none: [/"comment"\s*:/]},
        typescript: {all: [/comment_fingerprint/], none: [/comment:\s*comment/]},
        go: {all: [/comment_fingerprint|CommentFingerprint/], none: [/["']comment["']\s*:/]},
        scala: {all: [/comment_fingerprint/], none: [/comment\s*=\s*comment/]},
        cpp: {all: [/comment_fingerprint/], none: [/"comment"\s*,/]},
      },
    },
    {
      id: 'fingerprint',
      title: 'The fingerprint is a hash of the comment',
      detail:
        'Compute `comment_fingerprint` as a salted hash (`sha256`/`hmac`) so duplicates can be told apart without exposing the text and without keeping the comment in the topic.',
      match: {
        python: {all: [/sha256|hmac|hashlib/]},
        typescript: {all: [/createHash\(|createHmac\(/]},
        go: {all: [/sha256\.Sum|hmac\.New/]},
        scala: {all: [/MessageDigest|Mac\.getInstance/]},
        cpp: {all: [/SHA256|EVP_Digest/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce writes an outbox row',
      detail:
        'When the broker rejects the produce, insert an `outbox` row instead of dropping the rating, so a retry can republish it and no rating is lost.',
      match: {
        python: {all: [/outbox/], order: [/producer\.send/, /outbox\./]},
        typescript: {all: [/outbox/], order: [/producer\.send\(/, /outbox\./]},
        go: {all: [/outbox/], order: [/WriteMessages\(/, /outbox\./]},
        scala: {all: [/outbox/], order: [/producer\.send\(/, /outbox\./]},
        cpp: {all: [/outbox/], order: [/produce\(/, /outbox\./]},
      },
    },
    {
      id: 'acks',
      title: 'acks=all and the broker confirms before success',
      detail:
        'Configure `acks=all` and wait for the broker confirmation (`send_and_wait`, `await producer.send`, `WriteMessages`, `acks=all`) instead of returning success before the write is durable.',
      match: {
        python: {all: [/acks\s*=\s*["']all["']/, /send_and_wait\(/]},
        typescript: {all: [/acks\s*:\s*-1/, /await producer\.send\(/]},
        go: {all: [/RequireAll/, /WriteMessages\(/]},
        scala: {all: [/ACKS_CONFIG/, /"all"/, /producer\.send\(/]},
        cpp: {all: [/kProducerConfig/, /"acks",\s*"all"/, /flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from aiokafka import AIOKafkaProducer

logger = logging.getLogger("feedback")

TOPIC = "feedback.recorded"


class Outbox:
    def put(self, record: dict) -> None:
        raise NotImplementedError


outbox = Outbox()


async def publish(tenant: str, record: dict) -> None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = {
        "request_id": record["request_id"],
        "rating": record["rating"],
        "comment": record["comment"],
    }
    producer.send(TOPIC, key=rating, value=payload)
    logger.info("published tenant=%s request=%s", tenant, record["request_id"])
`,
      solution: `import hashlib
import logging

from aiokafka import AIOKafkaProducer

logger = logging.getLogger("feedback")

TOPIC = "feedback.recorded"
HASH_SALT = "feedback"


class Outbox:
    def put(self, record: dict) -> None:
        raise NotImplementedError


outbox = Outbox()


def comment_fingerprint(comment: str) -> str:
    return hashlib.sha256((HASH_SALT + comment).encode("utf-8")).hexdigest()


def produce(key: str, value: dict) -> None:
    """One Kafka produce keyed by tenant so a tenant's events stay ordered."""
    raise NotImplementedError


async def publish(tenant: str, record: dict) -> None:
    payload = {
        "request_id": record["request_id"],
        "rating": record["rating"],
        "comment_fingerprint": comment_fingerprint(record["comment"]),
    }
    try:
        await producer.send_and_wait(TOPIC, key=tenant, value=payload)
    except Exception:
        # The broker rejected the produce: keep the rating in the outbox so a retry republishes it.
        outbox.put(record)
    logger.info("published tenant=%s request=%s", tenant, record["request_id"])
    return None


producer = AIOKafkaProducer(bootstrap_servers="kafka:9092", acks="all", enable_idempotence=True)
`,
    },
    typescript: {
      starter: `/** Publish feedback.recorded events. */
import {Kafka} from 'kafkajs';

const TOPIC = 'feedback.recorded';

export class Outbox {
  async put(record: unknown): Promise<void> {
    throw new Error('not implemented');
  }
}

export const outbox = new Outbox();

export async function publish(tenant: string, record: {request_id: string; rating: number; comment: string}) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = {
    request_id: record.request_id,
    rating: record.rating,
    comment: record.comment,
  };
  await producer.send({topic: TOPIC, messages: [{key: String(record.rating), value: JSON.stringify(payload)}]});
}
`,
      solution: `/** Publish feedback.recorded events, keyed by tenant and free of comment text. */
import {createHash} from 'node:crypto';

import {Kafka, type Producer} from 'kafkajs';

const TOPIC = 'feedback.recorded';
const HASH_SALT = 'feedback';

export function commentFingerprint(comment: string): string {
  return createHash('sha256').update(HASH_SALT + comment).digest('hex');
}

export class Outbox {
  async put(record: unknown): Promise<void> {
    throw new Error('not implemented');
  }
}

export const outbox = new Outbox();

export async function publish(
  producer: Producer,
  tenant: string,
  record: {request_id: string; rating: number; comment: string},
): Promise<void> {
  const payload = {
    request_id: record.request_id,
    rating: record.rating,
    comment_fingerprint: commentFingerprint(record.comment),
  };
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: tenant, value: JSON.stringify(payload)}]});
  } catch {
    // The broker rejected the produce: keep the rating in the outbox so a retry republishes it.
    await outbox.put(record);
  }
}

export const producer = new Kafka({clientId: 'feedback', brokers: ['kafka:9092']}).producer({
  acks: -1,
  idempotent: true,
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const topic = "feedback.recorded"

type Outbox struct{}

func (o *Outbox) Put(ctx context.Context, record map[string]any) error {
	return nil
}

var outbox = &Outbox{}

func publish(ctx context.Context, writer *kafka.Writer, tenant string, record map[string]any) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(map[string]any{
		"request_id": record["request_id"],
		"rating":     record["rating"],
		"comment":    record["comment"],
	})
	writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(record["rating"].(string)),
		Value: payload,
	})
	log.Printf("published tenant=%s request=%v", tenant, record["request_id"])
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const (
	topic    = "feedback.recorded"
	hashSalt = "feedback"
)

type Outbox struct{}

func (o *Outbox) Put(ctx context.Context, record map[string]any) error {
	return nil
}

var outbox = &Outbox{}

// newWriter builds an idempotent writer that waits for the full in-sync replica set (acks=all).
func newWriter() *kafka.Writer {
	return &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Topic:        topic,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
	}
}

func commentFingerprint(comment string) string {
	sum := sha256.Sum256([]byte(hashSalt + comment))
	return hex.EncodeToString(sum[:])
}

func publish(ctx context.Context, writer *kafka.Writer, tenant string, record map[string]any) error {
	payload, _ := json.Marshal(map[string]any{
		"request_id":          record["request_id"],
		"rating":              record["rating"],
		"comment_fingerprint": commentFingerprint(record["comment"].(string)),
	})
	err := writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(tenant),
		Value: payload,
	})
	if err != nil {
		// The broker rejected the produce: keep the rating in the outbox so a retry republishes it.
		if outboxErr := outbox.Put(ctx, record); outboxErr != nil {
			return outboxErr
		}
		return err
	}
	log.Printf("published tenant=%s request=%v", tenant, record["request_id"])
	return nil
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object FeedbackEvents {
  val Topic = "feedback.recorded"

  def publish(producer: KafkaProducer[String, String], tenant: String, record: Map[String, String]): Unit = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = JsObject(
      "request_id" -> JsString(record("request_id")),
      "rating" -> JsString(record("rating")),
      "comment" -> JsString(record("comment"))
    )
    producer.send(new ProducerRecord[String, String](Topic, record("rating"), payload.compactPrint))
  }
}
`,
      solution: `import java.security.MessageDigest

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object FeedbackEvents {
  val Topic = "feedback.recorded"
  val HashSalt = "feedback"

  // acks=all: every produce waits for the full in-sync replica set before it is treated as durable.
  val producerProps: java.util.Properties = new java.util.Properties()
  producerProps.put(ProducerConfig.ACKS_CONFIG, "all")
  producerProps.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")

  def commentFingerprint(comment: String): String = {
    val digest = MessageDigest.getInstance("SHA-256")
    digest.digest((HashSalt + comment).getBytes("UTF-8")).map("%02x".format(_)).mkString
  }

  def publish(producer: KafkaProducer[String, String], tenant: String, record: Map[String, String]): Unit = {
    val payload = JsObject(
      "request_id" -> JsString(record("request_id")),
      "rating" -> JsString(record("rating")),
      "comment_fingerprint" -> JsString(commentFingerprint(record("comment")))
    )
    try {
      producer.send(new ProducerRecord[String, String](Topic, key = tenant, payload.compactPrint)).get()
    } catch {
      case _: Exception =>
        // The broker rejected the produce: keep the rating in the outbox so a retry republishes it.
        outbox.put(record)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <string>

const std::string kTopic = "feedback.recorded";

struct Outbox {
  void put(const std::string& record);
};

Outbox outbox;

void publish(RdKafka::Producer* producer, const std::string& tenant, const std::string& requestId, int rating,
             const std::string& comment) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string payload =
      "{"request_id":"" + requestId + "","rating":" + std::to_string(rating) + ","comment":"" + comment + ""}";
  const std::string key = std::to_string(rating);
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                    payload.size(), key.data(), key.size(), 0, nullptr);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <openssl/sha.h>

#include <iomanip>
#include <map>
#include <sstream>
#include <string>

const std::string kTopic = "feedback.recorded";
const std::string kHashSalt = "feedback";

// acks=all: every produce waits for the full in-sync replica set before it is treated as durable.
const std::map<std::string, std::string> kProducerConfig = {
    {"acks", "all"},
    {"enable.idempotence", "true"},
};

RdKafka::Producer* newProducer(std::string& errstr) {
  RdKafka::Conf* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  for (const auto& entry : kProducerConfig) {
    conf->set(entry.first, entry.second, errstr);
  }
  return RdKafka::Producer::create(conf, errstr);
}

std::string commentFingerprint(const std::string& comment) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  const std::string material = kHashSalt + comment;
  SHA256(reinterpret_cast<const unsigned char*>(material.data()), material.size(), digest);
  std::ostringstream out;
  for (unsigned char byte : digest) {
    out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
  }
  return out.str();
}

struct Outbox {
  void put(const std::string& record);
};

Outbox outbox;

void publish(RdKafka::Producer* producer, const std::string& tenant, const std::string& requestId, int rating,
             const std::string& comment) {
  const std::string payload = "{"request_id":"" + requestId + "","rating":" + std::to_string(rating) +
                              ","comment_fingerprint":"" + commentFingerprint(comment) + ""}";
  const std::string key = tenant;
  const RdKafka::ErrorCode result =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                        const_cast<char*>(payload.data()), payload.size(), key.data(), key.size(), 0, nullptr);
  if (result != RdKafka::ERR_NO_ERROR) {
    // The broker rejected the produce: keep the rating in the outbox so a retry republishes it.
    outbox.put(payload);
  }
  producer->flush(5000);
}
`,
    },
  },
  debrief: `The Kafka message key is the ordering control: key by tenant and every event for that tenant
shares a partition, so the quality consumer sees a tenant's ratings in order. Key by rating value and
the stream scatters, which is the "counters jump around" symptom.

The comment is tenant content. In a retained topic it outlives the feedback row and the database's
retention policy, so the event carries a salted fingerprint instead: enough to dedupe and correlate,
not enough to read. "Produced" is not "stored": the producer waits for the broker's confirmation, and
a rejection writes an outbox row so the rating can be republished.

Production pipelines write the outbox row in the same transaction as the feedback row and drain it
with an idempotent producer so retries cannot double-publish.`,
};
