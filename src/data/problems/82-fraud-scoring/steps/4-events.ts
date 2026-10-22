import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Score events keyed by account with features hashed',
  concept: 'kafka',
  file: 'events',
  focus: ['scorer', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces an event on the
happy path and the consumer moves a counter, so the demo shows numbers going up. Four production
contracts are broken, one of them a data leak with a long tail. Find them, fix them, and prove the
fix with the checks below.

Publish one \`fraud.scored\` event per decision and consume those events into the alerting counters.

- The message key is the **account reference** (\`key=account_ref\`, \`key: accountRef\`,
  \`Key: []byte(accountRef)\`, \`ProducerRecord(Topic, accountRef, …)\`). The key is the partition key,
  so keying by account keeps one account's decisions ordered — which is the only way an analyst can
  read a burst in the order it happened. The draft keys by device id, so the same account's history
  arrives interleaved with every other account on that device.
- The event id is the **transaction id**, and the payload carries the **band**, the **fallback
  marker**, the **feature digest** and the model version. Compute the digest with
  \`feature_digest(features)\` — a hash over the canonical feature JSON — because the topic is
  retained for days and replicated: a digest proves which vector scored a decision without shipping
  a person's signals, and never a card number, into that topic.
- The producer is **idempotent with \`acks=all\`** (KafkaJS \`idempotent: true\` + \`acks: -1\`, the
  broker's \`enable.idempotence\` + \`acks=all\`, or required acks \`all\` with hashed routing), so a
  produce retry cannot duplicate a record and double-count an alert.
- The consumer updates the Redis counters (\`HINCRBY alerts:{account_ref}\`) and **only then** commits
  the offset. Commit first and one crash between the two loses the counter update forever, because
  the offset has already moved past the record.

**Failure mode the checks target.** Keying by device id scatters an account's history and makes the
"same account, three cities, ten minutes" query unanswerable. Publishing \`raw_features\` for the
review team is the quiet one: the review team needed the digest, not the vector, and the vector is
now replicated and outliving every retention policy the request path has. An unconfigured producer
duplicates on retry, and commit-before-process turns one crash into a permanently lost alert.`,
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
        'The message key is the account reference, so every decision for one account lands on the same partition and keeps its order, and the event id is the transaction id. The draft keys by device id, which interleaves the account’s history with every other account that shared the device.',
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
        'The producer is idempotent and requires all acknowledgements — `enable.idempotence` with `acks=all`, KafkaJS `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer. A retry of a produce must not duplicate the record, or one alert becomes two.',
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
      title: 'The payload carries a feature digest, never the features',
      detail:
        '`feature_digest(features)` hashes the canonical feature vector (sha256) and the payload carries only that digest. The draft publishes `raw_features` into a retained, replicated topic, which is the leak the review team never asked for.',
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
        'Downstream alerting needs the decision, not the score alone: the payload carries the band and the fallback marker so an outage can be separated from a genuine decline without re-scoring anything. The draft publishes the raw score instead.',
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
        'The consumer does `HINCRBY` and only then commits the offset, so a crash between the two replays the record instead of losing the counter update. The draft commits first — the one order that turns a crash into a permanently missing alert.',
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
    # TODO: the draft keys by device id, publishes the raw feature vector for the review team, and
    # commits the consumer offset before the alerting counters move. Review all three.
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
      starter: `/** fraud.scored publishing and alerting — a model-generated draft. */
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
  // TODO: the draft keys by device id, publishes the raw feature vector for the review team, and
  // commits the consumer offset before the alerting counters move. Review all three.
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

// TODO: the draft keys by device id, publishes the raw feature vector for the review team, and
// commits the consumer offset before the alerting counters move. Review all three.
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

  // TODO: the draft keys by device id, publishes the raw feature vector for the review team, and
  // commits the consumer offset before the alerting counters move. Review all three.
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
      starter: `// fraud.scored publishing and alerting — a model-generated draft.
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

// TODO: the draft keys by device id, publishes the raw feature vector for the review team, and
// commits the consumer offset before the alerting counters move. Review all three.
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
    'The message key is the partition key: `key=account_ref`, `key: accountRef`, `Key: []byte(accountRef)`, `ProducerRecord(Topic, accountRef, …)`. Keyed by the device, one account’s decisions land in different partitions and the analyst’s timeline is no longer a timeline.',
    'Idempotence is producer configuration, not application logic: `enable_idempotence=True` with `acks="all"`, KafkaJS `idempotent: true` with `acks: -1`, required acks `all` with a hash balancer. It only works if the key is stable across retries, which is the same fix as the account key.',
    'The payload is a summary, not the evidence: `band`, `fallback`, `feature_digest(features)` and the model version. The digest is what lets a reviewer prove which vector produced a decision six months later without the vector itself ever entering a replicated topic — and in the consumer, `HINCRBY` first, `commit` second.',
  ],
  debrief: `Four defects are checked here, and only one of them looks like a bug in a demo. Keying by device id destroys per-account ordering, which is the property the whole consumer exists to provide. Publishing the feature vector is the leak the review team never needed: a digest answers the same question without a person's signals living in a topic for a week. An unconfigured producer duplicates records on retry, so a burst alert fires twice and an analyst learns to distrust the counter. And commit-before-process is the classic Kafka mistake: it looks exactly like the correct code until one crash, after which the offset has moved and the counter update is gone for good. Real pipelines add a schema registry so a future producer cannot smuggle fields into the topic, a dead-letter topic for records the consumer cannot parse, and a replay tool that rebuilds the counters from the digest without re-scoring anything.
`,
};
