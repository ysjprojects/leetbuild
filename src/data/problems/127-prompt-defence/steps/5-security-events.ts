import type {Step} from '@/lib/types';

export const securityEventsStep: Step = {
  id: 'security-events',
  title: 'prompt.security: user key, no text, signatures per hour before the commit',
  concept: 'kafka',
  file: 'security_events',
  focus: ['api', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: every decision becomes an
event and the consumer counts something, so the dashboard shows numbers. Five production contracts
are broken. Find them, fix them, prove the fix.

\`publish(user, document_hash, signals, decision)\` is how promptguard reports each decision, and
the consumer turns those events into attack-signature counts per hour.

- Publish **one** \`prompt.security\` event per decision with the **user** as the message key, so
  one user's events stay ordered on one partition. The payload carries the event id, user,
  document hash, signal names, the decision (\`served\` / \`refused\`), the signature and a
  timestamp.
- **Never** put the question, the answer or the document text in the event or in a log line: the
  topic is retained and replicated, and the whole point of the signature is to count incidents
  without storing what was said.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks
  \`all\` plus a stable hash balancer), so a retried produce cannot duplicate a record.
- The consumer (group \`signatures\`) buckets each refusal by hour — \`HOUR_S = 3600\`,
  key \`signatures:{hour}\` — and \`HINCRBY\` the signature's count; a bucket expires after seven
  days. Served decisions are not counted.
- The consumer commits the offset **after** the Redis write. Commit first and a crash between the
  two loses the count forever, because the offset already moved past the record.

**Failure mode the checks target.** Keying by event id scatters one user's events across
partitions; an unconfigured producer duplicates on retry; the question and the answer in the event
are a retained copy of exactly the text the guard refused to log; a single global counter cannot
show when an attack started; and commit-before-write trades correctness for code that looks
exactly-once.`,
  sequence: {
    participants: ['promptguard', 'prompt.security', 'Signature consumer', 'Redis'],
    messages: [
      {
        from: 'promptguard',
        to: 'prompt.security',
        label: 'produce · key = user · acks = all · idempotent',
        kind: 'sync',
      },
      {from: 'prompt.security', to: 'promptguard', label: 'ack', kind: 'reply'},
      {from: 'prompt.security', to: 'Signature consumer', label: 'consume · group signatures', kind: 'async'},
      {
        from: 'Signature consumer',
        to: 'Redis',
        label: 'HINCRBY signatures:{hour} {signature} 1 · EXPIRE 7d',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Signature consumer', label: 'new count', kind: 'reply'},
      {from: 'Signature consumer', to: 'prompt.security', label: 'commit offset after the write', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=user` (or `Key: []byte(user)`, `key: user`, `ProducerRecord(topic, user, …)`). The payload is ids, hashes, names and a decision — drop every field that is text the user or the model wrote.',
    'Idempotence is producer configuration: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer. It needs the same key on every retry, which is the same fix as the user key.',
    'In the consumer, derive `hour = ts // 3600`, `HINCRBY signatures:{hour} signature 1`, `EXPIRE` the bucket, and only then commit. A crash between the write and the commit replays the record — an over-count of one is recoverable, a lost record is not.',
  ],
  checks: [
    {
      id: 'user-key',
      title: 'Keyed by user; carries the document hash',
      detail:
        'The message key is the user (partition by user) and the event carries `document_hash`. The draft keys by the event id, so one user’s events scatter across partitions and lose order.',
      match: {
        python: {all: [/key=user/, /document_hash/]},
        typescript: {all: [/key:\s*user\b/, /document_hash/]},
        go: {all: [/Key:\s*\[\]byte\(user\)/, /document_hash/]},
        scala: {all: [/ProducerRecord\("prompt\.security",\s*user/, /document_hash/]},
        cpp: {all: [/produce\([^;]*\buser\.data\(\)/, /document_hash/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true` + `acks: -1`, or required acks `all` with a hash balancer. A retried produce must not duplicate the record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-text',
      title: 'No question, answer or document text in the event or logs',
      detail:
        'Neither the event payload nor any log line carries the question, the answer or the document text. The draft copies the question and the answer into every event — a retained, replicated copy of exactly what the guard refused to log.',
      match: {
        python: {none: [/\bquestion\b/i, /\banswer\b/i]},
        typescript: {none: [/\bquestion\b/i, /\banswer\b/i]},
        go: {none: [/\bquestion\b/i, /\banswer\b/i]},
        scala: {none: [/\bquestion\b/i, /\banswer\b/i]},
        cpp: {none: [/\bquestion\b/i, /\banswer\b/i]},
      },
    },
    {
      id: 'hour-bucket',
      title: 'Counts signatures per hour',
      detail:
        'The consumer buckets refusals by `HOUR_S = 3600` into `signatures:{hour}` and increments the signature’s field. The draft counts into one global key, so nobody can tell when an attack started or stopped.',
      match: {
        python: {all: [/HOUR_S\s*=\s*3600/, /signatures:\{hour\}/]},
        typescript: {all: [/HOUR_S\s*=\s*3600/, /signatures:\$\{hour\}/]},
        go: {all: [/hourSeconds\s*=\s*3600/, /signatures:%d/]},
        scala: {all: [/HourSeconds\s*=\s*3600/, /signatures:\$hour/]},
        cpp: {all: [/kHourSeconds\s*=\s*3600/, /"signatures:"\s*\+/]},
      },
    },
    {
      id: 'write-before-commit',
      title: 'Writes the count before committing the offset',
      detail:
        'The consumer runs `HINCRBY` before committing the offset; committing first makes a crash lose the count forever. The draft commits first.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/\.hincrBy\(/, /commitSync\(/]},
        cpp: {order: [/\.hincrby\(|->hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import uuid

import redis
from confluent_kafka import Consumer, Producer

logger = logging.getLogger("promptguard")
producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def publish(user: str, question: str, answer: str, signals: list[str], decision: str) -> None:
    # TODO: key by user instead of the event id, configure the idempotent producer with acks=all,
    # keep the question and the answer out of the event and the logs, bucket the counts by hour,
    # and commit only after the Redis write.
    event_id = str(uuid.uuid4())
    logger.info("security user=%s question=%r answer=%r", user, question, answer)
    event = {
        "id": event_id,
        "user": user,
        "question": question,
        "answer": answer,
        "signals": signals,
        "decision": decision,
    }
    producer.produce("prompt.security", key=event_id, value=json.dumps(event))
    producer.flush()


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "signatures"})
    consumer.subscribe(["prompt.security"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        if event["decision"] == "refused":
            r.hincrby("signatures", ",".join(event["signals"]), 1)
`,
      solution: `import hashlib
import json
import logging
import time
import uuid

import redis
from confluent_kafka import Consumer, Producer

logger = logging.getLogger("promptguard")
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)

HOUR_S = 3600
BUCKET_TTL_S = 7 * 86400


def signature_of(document_hash: str, signals: list[str]) -> str:
    return hashlib.sha256((document_hash + "|" + ",".join(sorted(signals))).encode("utf-8")).hexdigest()[:16]


def publish(user: str, document_hash: str, signals: list[str], decision: str) -> None:
    event = {
        "id": str(uuid.uuid4()),
        "user": user,
        "document_hash": document_hash,
        "signals": signals,
        "decision": decision,
        "signature": signature_of(document_hash, signals),
        "ts": int(time.time()),
    }
    producer.produce("prompt.security", key=user, value=json.dumps(event))
    producer.flush(2.0)
    logger.info("security user=%s decision=%s signature=%s", user, decision, event["signature"])


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "signatures", "enable.auto.commit": False}
    )
    consumer.subscribe(["prompt.security"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        if event["decision"] == "refused":
            hour = int(event["ts"]) // HOUR_S
            bucket = f"signatures:{hour}"
            pipe = r.pipeline()
            pipe.hincrby(bucket, event["signature"], 1)
            pipe.expire(bucket, BUCKET_TTL_S)
            pipe.execute()
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** prompt.security: a model-generated draft that keys by event id and commits too early. */
import {randomUUID} from 'node:crypto';

import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

const kafka = new Kafka({clientId: 'promptguard', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

export async function publish(
  user: string,
  question: string,
  answer: string,
  signals: string[],
  decision: string,
): Promise<void> {
  // TODO: key by user instead of the event id, configure the idempotent producer with acks=all,
  // keep the question and the answer out of the event and the logs, bucket the counts by hour,
  // and commit only after the Redis write.
  const eventId = randomUUID();
  console.info('security', {user, question, answer});
  const event = {id: eventId, user, question, answer, signals, decision};
  await producer.send({
    topic: 'prompt.security',
    messages: [{key: eventId, value: JSON.stringify(event)}],
  });
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'signatures'});
  await consumer.connect();
  await consumer.subscribe({topic: 'prompt.security'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {signals: string[]; decision: string};
      if (event.decision === 'refused') await r.hincrby('signatures', event.signals.join(','), 1);
    },
  });
}
`,
      solution: `/** prompt.security: one idempotent, user-keyed event per decision; counts per hour before the commit. */
import {createHash, randomUUID} from 'node:crypto';

import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

const kafka = new Kafka({clientId: 'promptguard', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

const HOUR_S = 3600;
const BUCKET_TTL_S = 7 * 86400;

interface SecurityEvent {
  id: string;
  user: string;
  document_hash: string;
  signals: string[];
  decision: string;
  signature: string;
  ts: number;
}

function signatureOf(documentHash: string, signals: string[]): string {
  return createHash('sha256')
    .update(documentHash + '|' + [...signals].sort().join(','))
    .digest('hex')
    .slice(0, 16);
}

export async function publish(user: string, documentHash: string, signals: string[], decision: string): Promise<void> {
  const event: SecurityEvent = {
    id: randomUUID(),
    user,
    document_hash: documentHash,
    signals,
    decision,
    signature: signatureOf(documentHash, signals),
    ts: Math.floor(Date.now() / 1000),
  };
  await producer.send({
    topic: 'prompt.security',
    acks: -1,
    messages: [{key: user, value: JSON.stringify(event)}],
  });
  console.info('security', {user, decision, signature: event.signature});
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'signatures'});
  await consumer.connect();
  await consumer.subscribe({topic: 'prompt.security'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as SecurityEvent;
      if (event.decision === 'refused') {
        const hour = Math.floor(event.ts / HOUR_S);
        const bucket = \`signatures:\${hour}\`;
        await r.multi().hincrby(bucket, event.signature, 1).expire(bucket, BUCKET_TTL_S).exec();
      }
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
	"log"
	"strings"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var (
	securityWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "prompt.security"}
	rdb            *redis.Client
)

// TODO: key by user instead of the event id, configure acks=all with a hash balancer, keep the
// question and the answer out of the event and the logs, bucket the counts by hour, and commit
// only after the Redis write.
func publish(ctx context.Context, user, question, answer string, signals []string, decision string) error {
	eventID := uuid.NewString()
	log.Printf("security user=%s question=%q answer=%q", user, question, answer)
	event := map[string]any{
		"id":       eventID,
		"user":     user,
		"question": question,
		"answer":   answer,
		"signals":  signals,
		"decision": decision,
	}
	payload, _ := json.Marshal(event)
	return securityWriter.WriteMessages(ctx, kafka.Message{Key: []byte(eventID), Value: payload})
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "prompt.security",
		GroupID: "signatures",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event struct {
			Signals  []string \`json:"signals"\`
			Decision string   \`json:"decision"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		if event.Decision == "refused" {
			rdb.HIncrBy(ctx, "signatures", strings.Join(event.Signals, ","), 1)
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	hourSeconds   = 3600
	bucketTTLDays = 7
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var securityWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "prompt.security",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var rdb *redis.Client

type SecurityEvent struct {
	ID           string   \`json:"id"\`
	User         string   \`json:"user"\`
	DocumentHash string   \`json:"document_hash"\`
	Signals      []string \`json:"signals"\`
	Decision     string   \`json:"decision"\`
	Signature    string   \`json:"signature"\`
	TS           int64    \`json:"ts"\`
}

func signatureOf(documentHash string, signals []string) string {
	sorted := append([]string(nil), signals...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(documentHash + "|" + strings.Join(sorted, ",")))
	return hex.EncodeToString(sum[:])[:16]
}

func publish(ctx context.Context, user, documentHash string, signals []string, decision string) error {
	event := SecurityEvent{
		ID:           uuid.NewString(),
		User:         user,
		DocumentHash: documentHash,
		Signals:      signals,
		Decision:     decision,
		Signature:    signatureOf(documentHash, signals),
		TS:           time.Now().Unix(),
	}
	payload, _ := json.Marshal(event)
	if err := securityWriter.WriteMessages(ctx, kafka.Message{Key: []byte(user), Value: payload}); err != nil {
		return err
	}
	log.Printf("security user=%s decision=%s signature=%s", user, decision, event.Signature)
	return nil
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "prompt.security",
		GroupID: "signatures",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event SecurityEvent
		_ = json.Unmarshal(msg.Value, &event)
		if event.Decision == "refused" {
			bucket := fmt.Sprintf("signatures:%d", event.TS/hourSeconds)
			pipe := rdb.TxPipeline()
			pipe.HIncrBy(ctx, bucket, event.Signature, 1)
			pipe.Expire(ctx, bucket, bucketTTLDays*24*time.Hour)
			_, _ = pipe.Exec(ctx)
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.{Properties, UUID}
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

object SecurityEvents {
  private val log = Logger.getLogger("promptguard")
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: key by user instead of the event id, configure the idempotent producer with acks=all,
  // keep the question and the answer out of the event and the logs, bucket the counts by hour,
  // and commit only after the Redis write.
  def publish(user: String, question: String, answer: String, signals: Seq[String], decision: String): Unit = {
    val eventId = UUID.randomUUID().toString
    log.info(s"security user=$user question=$question answer=$answer")
    val payload = JsObject(
      "id" -> JsString(eventId),
      "user" -> JsString(user),
      "question" -> JsString(question),
      "answer" -> JsString(answer),
      "signals" -> signals.toJson,
      "decision" -> JsString(decision)
    ).compactPrint
    producer.send(new ProducerRecord("prompt.security", eventId, payload))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of("prompt.security"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        if (event("decision").convertTo[String] == "refused") {
          jedis.hincrBy("signatures", event("signals").convertTo[Seq[String]].mkString(","), 1L)
        }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.{Properties, UUID}
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

object SecurityEvents {
  private val log = Logger.getLogger("promptguard")
  val HourSeconds = 3600L
  val BucketTtlS = 7L * 86400L

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def signatureOf(documentHash: String, signals: Seq[String]): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest((documentHash + "|" + signals.sorted.mkString(",")).getBytes(StandardCharsets.UTF_8))
      .map("%02x".format(_))
      .mkString
      .take(16)

  def publish(user: String, documentHash: String, signals: Seq[String], decision: String): Unit = {
    val signature = signatureOf(documentHash, signals)
    val payload = JsObject(
      "id" -> JsString(UUID.randomUUID().toString),
      "user" -> JsString(user),
      "document_hash" -> JsString(documentHash),
      "signals" -> signals.toJson,
      "decision" -> JsString(decision),
      "signature" -> JsString(signature),
      "ts" -> JsNumber(System.currentTimeMillis() / 1000)
    ).compactPrint
    producer.send(new ProducerRecord("prompt.security", user, payload))
    log.info(s"security user=$user decision=$decision signature=$signature")
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "signatures")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("prompt.security"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        if (event("decision").convertTo[String] == "refused") {
          val hour = event("ts").convertTo[Long] / HourSeconds
          val bucket = s"signatures:$hour"
          val tx = jedis.multi()
          tx.hincrBy(bucket, event("signature").convertTo[String], 1L)
          tx.expire(bucket, BucketTtlS)
          tx.exec()
        }
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kSecurityTopic = "prompt.security";

std::unique_ptr<RdKafka::Producer> producer;
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");
std::string uuidString();

// TODO: key by user instead of the event id, configure the idempotent producer with acks=all, keep
// the question and the answer out of the event and the logs, bucket the counts by hour, and commit
// only after the Redis write.
void publish(const std::string& user, const std::string& question, const std::string& answer,
             const std::vector<std::string>& signals, const std::string& decision) {
  const auto eventId = uuidString();
  std::cerr << "security user=" << user << " question=" << question << " answer=" << answer << "\\n";
  const json event = {{"id", eventId}, {"user", user}, {"question", question}, {"answer", answer}, {"signals", signals}, {"decision", decision}};
  const auto payload = event.dump();
  producer->produce(kSecurityTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), eventId.data(), eventId.size(), 0, nullptr);
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "signatures", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kSecurityTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync();
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    if (event["decision"] == "refused") {
      std::string joined;
      for (const auto& signal : event["signals"]) joined += signal.get<std::string>() + ",";
      redis->hincrby("signatures", joined, 1);
    }
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kSecurityTopic = "prompt.security";
constexpr long long kHourSeconds = 3600;
constexpr long long kBucketTtlS = 7 * 86400;

std::string uuidString();
std::string sha256Hex(const std::string& text);

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

std::string signatureOf(const std::string& documentHash, std::vector<std::string> signals) {
  std::sort(signals.begin(), signals.end());
  std::string joined;
  for (std::size_t i = 0; i < signals.size(); i++) joined += (i == 0 ? "" : ",") + signals[i];
  return sha256Hex(documentHash + "|" + joined).substr(0, 16);
}

void publish(const std::string& user, const std::string& documentHash, const std::vector<std::string>& signals,
             const std::string& decision) {
  const auto signature = signatureOf(documentHash, signals);
  const auto ts = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const json event = {{"id", uuidString()}, {"user", user}, {"document_hash", documentHash}, {"signals", signals}, {"decision", decision}, {"signature", signature}, {"ts", ts}};
  const auto payload = event.dump();
  producer->produce(kSecurityTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), user.data(), user.size(), 0, nullptr);
  producer->flush(2000);
  std::cerr << "security user=" << user << " decision=" << decision << " signature=" << signature << "\\n";
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "signatures", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kSecurityTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    if (event["decision"] == "refused") {
      const auto hour = event["ts"].get<long long>() / kHourSeconds;
      const auto bucket = "signatures:" + std::to_string(hour);
      auto tx = redis->transaction();
      tx.hincrby(bucket, event["signature"].get<std::string>(), 1).expire(bucket, std::chrono::seconds(kBucketTtlS)).exec();
    }
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking the three things a generated Kafka snippet almost always gets wrong, plus the one this course is about. The key is an ordering contract: partition by user and a user's incidents arrive in order; key by event id and they do not. Exactly-once *looking* code is not exactly-once: the producer needs idempotence and acks=all for retries, and the consumer applies its write before the commit, or a crash between the two loses the count. The hour bucket is what turns counts into a timeline — the source's point about attacks evolving after each patch is only visible if you can see when a signature appeared. And the text rule is the course's own: the guard refused to log the question and the answer for a reason, and an event topic that retains and replicates them undoes it. Real pipelines add a schema registry, a dead-letter topic for unparseable events, and an alert when one signature's hourly count crosses a threshold.`,
};
