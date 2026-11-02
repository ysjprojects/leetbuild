import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Score events keyed by account with features hashed',
  concept: 'kafka',
  file: 'events',
  focus: ['scorer', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter publishes one \`fraud.scored\` event per decision and consumes those
events into the alerting counters: \`publish_scored\` builds an event with the transaction id, the
account reference, the raw score and \`raw_features\`, sends it with \`key=device_id\` through a
default \`KafkaProducer\`, and \`consume\` commits the offset and then does \`HINCRBY\` on
\`alerts:{account_ref}\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** Keying by device id scatters an account's history across
partitions and makes the "same account, three cities, ten minutes" query unanswerable. Publishing
\`raw_features\` puts a person's signals into a retained, replicated topic that outlives every
retention policy the request path has. A default producer duplicates on retry, the raw score alone
cannot separate an outage from a decline, and commit-before-process turns one crash into a
permanently lost alert.

- The message key is the account reference (\`key=account_ref\`, \`key: accountRef\`,
  \`Key: []byte(accountRef)\`, \`ProducerRecord(Topic, accountRef, …)\`), so one account's decisions
  stay ordered.
- The event id is the transaction id, and the payload carries the band, the fallback marker, the
  model version and the digest from \`feature_digest(features)\`, a sha256 over the canonical feature
  JSON. No raw features, no card numbers.
- The producer is idempotent with \`acks=all\` (KafkaJS \`idempotent: true\` + \`acks: -1\`, the
  broker's \`enable.idempotence\` + \`acks=all\`, or required acks \`all\` with hashed routing).
- The consumer updates the Redis counters (\`HINCRBY alerts:{account_ref}\`) and only then commits
  the offset.`,
  sequence: {
    participants: ['Fraud Scorer', 'fraud.scored', 'Alerting consumer', 'Redis'],
    messages: [
      {from: 'Fraud Scorer', to: 'fraud.scored', label: 'produce · key = account_ref · acks = all', kind: 'sync'},
      {from: 'fraud.scored', to: 'Fraud Scorer', label: 'ack / broker error', kind: 'reply'},
      {from: 'fraud.scored', to: 'Alerting consumer', label: 'consume · group alerts', kind: 'async'},
      {from: 'Alerting consumer', to: 'Redis', label: 'HINCRBY alerts:{account_ref} band', kind: 'sync'},
      {from: 'Redis', to: 'Alerting consumer', label: 'new counter value', kind: 'reply'},
      {from: 'Alerting consumer', to: 'fraud.scored', label: 'commit offset after the counters moved', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'account-key',
      title: 'Keyed by account reference, id is the transaction id',
      detail:
        'The message key is the account reference, so every decision for one account lands on the same partition and keeps its order, and the event id is the transaction id. The starter keys by device id, which interleaves the account’s history with every other account that shared the device.',
      match: {
        python: {all: [/key=account_ref/, /transaction_id/]},
        typescript: {all: [/key:\s*accountRef/, /transaction_id|transactionId/]},
        go: {all: [/Key:\s*\[\]byte\(accountRef\)/, /TransactionID/]},
        scala: {all: [/ProducerRecord\(Topic,\s*accountRef/, /verdict\.transactionId/]},
        cpp: {all: [/produce\([^;]*account_ref\.data\(\)/, /transaction_id/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is idempotent and requires all acknowledgements: `enable.idempotence` with `acks=all`, KafkaJS `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer. The starter constructs the producer with defaults, so a retried produce can duplicate the record and one alert becomes two.',
      match: {
        python: {all: [/enable_idempotence/, /acks\s*=\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /setProperty\("acks",\s*"all"\)|put\("acks",\s*"all"\)/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'digest-not-features',
      title: 'The payload carries a feature digest, not the features',
      detail:
        '`feature_digest(features)` hashes the canonical feature vector (sha256) and the payload carries only that digest. The starter publishes `raw_features` into a retained, replicated topic, which is a leak the alerting consumer has no use for.',
      match: {
        python: {all: [/hashlib\.sha256/, /feature_digest/], none: [/raw_features/]},
        typescript: {all: [/createHash\(\s*'sha256'\)/, /feature_digest/], none: [/raw_features/]},
        go: {all: [/sha256\.Sum256/, /FeatureDigest/], none: [/RawFeatures/]},
        scala: {all: [/MessageDigest\.getInstance\("SHA-256"\)/, /featureDigest/], none: [/rawFeatures/]},
        cpp: {all: [/SHA256\(/, /featureDigest/], none: [/rawFeatures/]},
      },
    },
    {
      id: 'band-and-marker',
      title: 'The event carries the band and the fallback marker',
      detail:
        'Downstream alerting needs the decision, not the score alone: the payload carries the band and the fallback marker so an outage can be separated from a genuine decline without re-scoring anything. The starter publishes the raw score instead.',
      match: {
        python: {all: [/["']band["']/, /["']fallback["']/]},
        typescript: {all: [/band:/, /fallback:/]},
        go: {all: [/Band:/, /Fallback:/]},
        scala: {all: [/"band"/, /"fallback"/]},
        cpp: {all: [/\["band"\]|"band"/, /\["fallback"\]|"fallback"/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Counters move before the offset is committed',
      detail:
        'The consumer does `HINCRBY` and only then commits the offset, so a crash between the two replays the record instead of losing the counter update. The starter commits first, the one order that turns a crash into a permanently missing alert.',
      match: {
        python: {order: [/hincrby\(/, /commit\(/]},
        typescript: {order: [/hincrby\(/, /commitOffsets\(/]},
        go: {order: [/HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/hincrBy\(/, /commitSync\(/]},
        cpp: {order: [/hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from kafka import KafkaConsumer, KafkaProducer
from redis import Redis

logger = logging.getLogger("scored")

TOPIC = "fraud.scored"
redis = Redis(host="redis", port=6379)

producer = KafkaProducer(
    bootstrap_servers="kafka:9092",
    value_serializer=lambda event: json.dumps(event).encode("utf-8"),
)


def publish_scored(verdict: dict, account_ref: str, device_id: str, features: dict) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "id": verdict["transaction_id"],
        "account_ref": account_ref,
        "score": verdict["score"],
        "raw_features": features,
    }
    producer.send(TOPIC, key=device_id, value=event)


def consume() -> None:
    consumer = KafkaConsumer(TOPIC, group_id="alerts", enable_auto_commit=False)
    for record in consumer:
        event = record.value
        consumer.commit()
        redis.hincrby(f"alerts:{event['account_ref']}", "scored", 1)
`,
      solution: `import hashlib
import json
import logging

from kafka import KafkaConsumer, KafkaProducer
from redis import Redis

logger = logging.getLogger("scored")

TOPIC = "fraud.scored"
CONSUMER_GROUP = "alerts"
redis = Redis(host="redis", port=6379)

producer = KafkaProducer(
    bootstrap_servers="kafka:9092",
    acks="all",
    enable_idempotence=True,
    key_serializer=lambda key: key.encode("utf-8"),
    value_serializer=lambda event: json.dumps(event).encode("utf-8"),
)


def feature_digest(features: dict) -> str:
    """The auditable part of a feature vector: it proves which vector scored a transaction without
    copying the vector itself into a topic that is retained and replicated."""
    canonical = json.dumps(features, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def publish_scored(verdict: dict, account_ref: str, features: dict) -> None:
    event = {
        "id": verdict["transaction_id"],
        "account_ref": account_ref,
        "band": verdict["band"],
        "fallback": verdict["fallback"],
        "feature_digest": feature_digest(features),
        "model_version": verdict["model_version"],
    }
    producer.send(TOPIC, key=account_ref, value=event)


def consume() -> None:
    consumer = KafkaConsumer(TOPIC, group_id=CONSUMER_GROUP, enable_auto_commit=False)
    for record in consumer:
        event = record.value
        key = f"alerts:{event['account_ref']}"
        # Counters first, offset second: a crash in between replays the record instead of losing
        # the alert, which is the only safe direction to be wrong in.
        redis.hincrby(key, event["band"], 1)
        if event["fallback"]:
            redis.hincrby(key, "fallback", 1)
        consumer.commit()
`,
    },
    typescript: {
      starter: `/** fraud.scored publishing and alerting — flawed code. */
import {Kafka} from 'kafkajs';
import Redis from 'ioredis';

const TOPIC = 'fraud.scored';
const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({brokers: ['kafka:9092'], clientId: 'scorer'});
const producer = kafka.producer();

export interface ScoredEvent {
  id: string;
  account_ref: string;
  score: number;
  raw_features: Record<string, unknown>;
}

export async function publishScored(
  verdict: {transaction_id: string; score: number},
  accountRef: string,
  deviceId: string,
  features: Record<string, unknown>,
): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const event: ScoredEvent = {
    id: verdict.transaction_id,
    account_ref: accountRef,
    score: verdict.score,
    raw_features: features,
  };
  await producer.send({topic: TOPIC, messages: [{key: deviceId, value: JSON.stringify(event)}]});
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'alerts'});
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as ScoredEvent;
      await redis.hincrby(\`alerts:\${event.account_ref}\`, 'scored', 1);
    },
  });
}
`,
      solution: `/** fraud.scored: one idempotent, account-keyed event per decision; counters before the commit. */
import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';
import Redis from 'ioredis';

const TOPIC = 'fraud.scored';
const CONSUMER_GROUP = 'alerts';
const redis = new Redis({host: 'redis', port: 6379});

const kafka = new Kafka({brokers: ['kafka:9092'], clientId: 'scorer'});
const producer = kafka.producer({idempotent: true, acks: -1, transactionTimeout: 30_000});

export interface ScoredVerdict {
  transaction_id: string;
  band: string;
  fallback: boolean;
  model_version: string;
}

export interface ScoredEvent {
  id: string;
  account_ref: string;
  band: string;
  fallback: boolean;
  feature_digest: string;
  model_version: string;
}

function canonicalJson(features: Record<string, unknown>): string {
  const keys = Object.keys(features).sort();
  return JSON.stringify(Object.fromEntries(keys.map(key => [key, features[key]])));
}

/** The auditable part of a feature vector: it proves which vector scored a transaction without
 * copying the vector itself into a topic that is retained and replicated. */
function featureDigest(features: Record<string, unknown>): string {
  return \`sha256:\${createHash('sha256').update(canonicalJson(features)).digest('hex')}\`;
}

export async function publishScored(
  verdict: ScoredVerdict,
  accountRef: string,
  features: Record<string, unknown>,
): Promise<void> {
  const event: ScoredEvent = {
    id: verdict.transaction_id,
    account_ref: accountRef,
    band: verdict.band,
    fallback: verdict.fallback,
    feature_digest: featureDigest(features),
    model_version: verdict.model_version,
  };
  await producer.send({topic: TOPIC, messages: [{key: accountRef, value: JSON.stringify(event)}]});
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: CONSUMER_GROUP});
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as ScoredEvent;
      const key = \`alerts:\${event.account_ref}\`;
      // Counters first, offset second: a crash in between replays the record instead of losing
      // the alert.
      await redis.hincrby(key, event.band, 1);
      if (event.fallback) await redis.hincrby(key, 'fallback', 1);
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var scoredWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "fraud.scored"}

type ScoredVerdict struct {
	TransactionID string
	Score         float64
	Band          string
	Fallback      bool
	ModelVersion  string
}

type ScoredEvent struct {
	ID          string         \`json:"id"\`
	AccountRef  string         \`json:"account_ref"\`
	Score       float64        \`json:"score"\`
	RawFeatures map[string]any \`json:"raw_features"\`
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
func publishScored(ctx context.Context, verdict ScoredVerdict, accountRef, deviceID string, features map[string]any) error {
	event := ScoredEvent{ID: verdict.TransactionID, AccountRef: accountRef, Score: verdict.Score, RawFeatures: features}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return scoredWriter.WriteMessages(ctx, kafka.Message{Key: []byte(deviceID), Value: payload})
}

func consume(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "fraud.scored",
		GroupID: "alerts",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event ScoredEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		rdb.HIncrBy(ctx, "alerts:"+event.AccountRef, "scored", 1)
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	topic         = "fraud.scored"
	consumerGroup = "alerts"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges once the record is replicated, and retries of the same key land
// on the same partition instead of duplicating across them.
var scoredWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type ScoredVerdict struct {
	TransactionID string
	Band          string
	Fallback      bool
	ModelVersion  string
}

type ScoredEvent struct {
	ID            string \`json:"id"\`
	AccountRef    string \`json:"account_ref"\`
	Band          string \`json:"band"\`
	Fallback      bool   \`json:"fallback"\`
	FeatureDigest string \`json:"feature_digest"\`
	ModelVersion  string \`json:"model_version"\`
}

// The auditable part of a feature vector: it proves which vector scored a transaction without
// copying the vector itself into a topic that is retained and replicated.
func featureDigest(features map[string]any) string {
	canonical, _ := json.Marshal(features)
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func publishScored(ctx context.Context, verdict ScoredVerdict, accountRef string, features map[string]any) error {
	event := ScoredEvent{
		ID:            verdict.TransactionID,
		AccountRef:    accountRef,
		Band:          verdict.Band,
		Fallback:      verdict.Fallback,
		FeatureDigest: featureDigest(features),
		ModelVersion:  verdict.ModelVersion,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return scoredWriter.WriteMessages(ctx, kafka.Message{Key: []byte(accountRef), Value: payload})
}

func consume(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: consumerGroup,
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event ScoredEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		key := "alerts:" + event.AccountRef
		// Counters first, offset second: a crash in between replays the record instead of losing
		// the alert.
		rdb.HIncrBy(ctx, key, event.Band, 1)
		if event.Fallback {
			rdb.HIncrBy(ctx, key, "fallback", 1)
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object ScoredEvents {
  val Topic = "fraud.scored"
  val jedis = new Jedis("redis", 6379)
  val producer = new KafkaProducer[String, String](new Properties())

  case class ScoredVerdict(transactionId: String, score: Double, band: String, fallback: Boolean, modelVersion: String)

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def publishScored(verdict: ScoredVerdict, accountRef: String, deviceId: String, features: Map[String, Any]): Unit = {
    val rawFeatures = JsObject(features.map { case (key, value) => key -> JsString(String.valueOf(value)) })
    val event = JsObject(
      "id" -> JsString(verdict.transactionId),
      "account_ref" -> JsString(accountRef),
      "score" -> JsNumber(verdict.score),
      "rawFeatures" -> rawFeatures,
    ).compactPrint
    producer.send(new ProducerRecord("fraud.scored", deviceId, event))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        jedis.hincrBy("alerts:" + event("account_ref").convertTo[String], "scored", 1L)
      }
    }
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object ScoredEvents {
  val Topic = "fraud.scored"
  val ConsumerGroup = "alerts"
  val jedis = new Jedis("redis", 6379)

  case class ScoredVerdict(transactionId: String, band: String, fallback: Boolean, modelVersion: String)

  // Idempotent producer with acks=all: a retry of a produce cannot duplicate a record.
  private val producerProperties = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  }

  val producer = new KafkaProducer[String, String](producerProperties)

  def featureDigest(features: Map[String, Any]): String = {
    val canonical = features.toSeq.sortBy(_._1).map { case (key, value) => s"$key=\${String.valueOf(value)}" }.mkString(",")
    "sha256:" + MessageDigest.getInstance("SHA-256").digest(canonical.getBytes("UTF-8")).map("%02x".format(_)).mkString
  }

  def publishScored(verdict: ScoredVerdict, accountRef: String, features: Map[String, Any]): Unit = {
    val event = JsObject(
      "id" -> JsString(verdict.transactionId),
      "account_ref" -> JsString(accountRef),
      "band" -> JsString(verdict.band),
      "fallback" -> JsBoolean(verdict.fallback),
      "feature_digest" -> JsString(featureDigest(features)),
      "model_version" -> JsString(verdict.modelVersion),
    ).compactPrint
    producer.send(new ProducerRecord(Topic, accountRef, event))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val key = "alerts:" + event("account_ref").convertTo[String]
        // Counters first, offset second: a crash in between replays the record instead of losing
        // the alert.
        jedis.hincrBy(key, event("band").convertTo[String], 1L)
        if (event("fallback").convertTo[Boolean]) jedis.hincrBy(key, "fallback", 1L)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `// fraud.scored publishing and alerting — flawed code.
#include <string>

#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

using json = nlohmann::json;

static const char* kTopic = "fraud.scored";

struct ScoredVerdict {
  std::string transaction_id;
  double score = 0.0;
};

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
static void publishScored(RdKafka::Producer* producer, const json& verdict, const std::string& account_ref,
                          const std::string& device_id, const json& features, RdKafka::Topic* topic) {
  const json event = {
      {"id", verdict["transaction_id"]},
      {"account_ref", account_ref},
      {"score", verdict["score"]},
      {"rawFeatures", features},
  };
  const std::string payload = event.dump();
  producer->produce(topic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), device_id.data(), device_id.size(), 0, nullptr);
}

static void consume(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& redis, RdKafka::Topic* topic) {
  consumer->subscribe({kTopic});
  while (true) {
    RdKafka::Message* msg = consumer->consume(1000);
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      delete msg;
      continue;
    }
    consumer->commitSync(msg);
    const json event = json::parse(static_cast<const char*>(msg->payload()), nullptr, false);
    redis.hincrby("alerts:" + event.value("account_ref", std::string()), "scored", 1);
    delete msg;
  }
}
`,
      solution: `// fraud.scored: one idempotent, account-keyed event per decision; counters before the commit.
#include <cstdio>
#include <string>

#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

using json = nlohmann::json;

static const char* kTopic = "fraud.scored";

// Idempotent producer with acks=all: a retry of a produce cannot duplicate a record.
static void configureProducer(RdKafka::Conf* conf, std::string& errstr) {
  conf->set("enable.idempotence", "true", errstr);
  conf->set("acks", "all", errstr);
}

// The auditable part of a feature vector: it proves which vector scored a transaction without
// copying the vector itself into a topic that is retained and replicated.
static std::string featureDigest(const json& features) {
  const std::string canonical = features.dump();
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(canonical.data()), canonical.size(), digest);
  std::string hex;
  for (const unsigned char byte : digest) {
    char pair[3];
    std::snprintf(pair, sizeof(pair), "%02x", byte);
    hex += pair;
  }
  return "sha256:" + hex;
}

static json scoredEvent(const json& verdict, const std::string& account_ref, const json& features) {
  return json{
      {"id", verdict["transaction_id"]},
      {"account_ref", account_ref},
      {"band", verdict["band"]},
      {"fallback", verdict["fallback"]},
      {"feature_digest", featureDigest(features)},
      {"model_version", verdict["model_version"]},
  };
}

static void publishScored(RdKafka::Producer* producer, const json& verdict, const std::string& account_ref,
                          const json& features, RdKafka::Topic* topic) {
  const std::string payload = scoredEvent(verdict, account_ref, features).dump();
  producer->produce(topic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                    payload.size(), account_ref.data(), account_ref.size(), 0, nullptr);
}

static void consume(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& redis) {
  consumer->subscribe({kTopic});
  while (true) {
    RdKafka::Message* msg = consumer->consume(1000);
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      delete msg;
      continue;
    }
    const json event = json::parse(static_cast<const char*>(msg->payload()), nullptr, false);
    const std::string key = "alerts:" + event.value("account_ref", std::string());
    // Counters first, offset second: a crash in between replays the record instead of losing the
    // alert.
    redis.hincrby(key, event.value("band", std::string()), 1);
    if (event.value("fallback", false)) redis.hincrby(key, "fallback", 1);
    consumer->commitSync(msg);
    delete msg;
  }
}
`,
    },
  },
  hints: [
    "An analyst pulls one account's decisions and gets them out of order, with the feature vector attached to each; after a consumer restart the alert counter for a burst is one short.",
    '`key=device_id` spreads one account across partitions, the event carries `raw_features` and `score` but no `band`/`fallback`, the producer has no idempotence, and `consume` calls `commit()` before `hincrby`.',
    'Send with `key=account_ref`; build the payload from `band`, `fallback`, the model version and `feature_digest(features)` via `hashlib.sha256`; set `enable_idempotence=True, acks="all"`; in `consume`, `hincrby` first, then `commit()`.',
  ],
  debrief: `The key is the account reference because the key is the partition, and the partition is the only ordering Kafka gives you: an account's burst is readable as a timeline only if every decision for it lands in one place. The payload is a digest rather than the vector because the topic is retained and replicated while the request path is not; a sha256 over the canonical JSON still proves which vector produced a decision. Idempotence lives in producer configuration because a retry is the client library's decision, not the application's. And \`HINCRBY\` before \`commit\` trades a possible double count after a crash, visible and bounded, for a lost one that nothing can detect. Production pipelines add a schema registry so a future producer cannot reintroduce a raw field, a dead-letter topic for unparseable records, and a replay tool that rebuilds the counters from the topic.
`,
};
