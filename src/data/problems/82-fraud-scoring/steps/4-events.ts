import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Score events keyed by account, counted before the commit',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'events',
  focus: ['scorer', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter is the \`fraud.scored\` stream: \`publish_scored(decision, features)\`
produces one event per decision with \`transaction_id\`, \`account_ref\`, \`score\` and
\`raw_features\`, keyed by \`transaction_id\`, through a producer with \`acks=1\`; \`run()\` is the
alerting consumer (group \`alerting\`), which commits each record's offset and then does
\`HINCRBY alerts:{account_ref} scored 1\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** One account's decisions scatter across partitions; the feature
vector, a description of a person, sits in a retained topic; alerting cannot tell an outage from a
fraud wave; a lost acknowledgement or a leader failover duplicates or drops an event; and a crash
between the commit and the \`HINCRBY\` loses an alert for good.

- Key every record by \`account_ref\`.
- The payload is \`{transaction_id, account_ref, score, band, fallback, model_version,
  feature_version, feature_digest}\` with \`feature_digest(features)\` from \`fraud.features\`; no raw
  features.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent: true\` with \`acks: -1\`; kafka-go
  has no idempotent producer, so the Go writer uses \`RequireAll\` and alerting tolerates a duplicate).
- The consumer moves \`alerts:{account_ref}\` (\`HINCRBY\` the band, and \`fallback\` for a fallback
  decision), then commits the offset.`,
  sequence: {
    participants: ['scorer', 'fraud.scored', 'Alerting consumer', 'Redis'],
    messages: [
      {
        from: 'scorer',
        to: 'fraud.scored',
        label: 'produce · key = account_ref · acks = all · idempotent',
        kind: 'sync',
      },
      {from: 'fraud.scored', to: 'scorer', label: 'delivery report', kind: 'reply'},
      {from: 'fraud.scored', to: 'Alerting consumer', label: 'consume · group alerting', kind: 'async'},
      {from: 'Alerting consumer', to: 'Redis', label: 'HINCRBY alerts:{account_ref} band · fallback', kind: 'sync'},
      {from: 'Alerting consumer', to: 'fraud.scored', label: 'commit after the counters moved', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'account-key',
      title: 'Keyed by account reference',
      detail:
        "The record key is the decision's `account_ref`, so one account's decisions land on one partition in order; the starter keys by transaction id, which scatters them.",
      match: {
        python: {all: [/key=decision\[["']account_ref["']\]/], none: [/key=decision\[["']transaction_id["']\]/]},
        typescript: {all: [/key:\s*decision\.account_ref/], none: [/key:\s*decision\.transaction_id/]},
        go: {all: [/Key:\s*\[\]byte\(decision\.AccountRef\)/], none: [/Key:\s*\[\]byte\(decision\.TransactionID\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(Topic,\s*accountRef/],
          none: [/ProducerRecord\[String, String\]\(Topic,\s*transactionId/],
        },
        cpp: {all: [/account_ref\.c_str\(\),\s*account_ref\.size\(\)/], none: [/transaction_id\.c_str\(\)/]},
      },
    },
    {
      id: 'digest-not-features',
      title: 'Carries a feature digest, not the features',
      detail:
        'The payload carries `feature_digest(features)` (SHA-256 of the canonical vector) and no raw feature: the topic is retained and replicated, and alerting has no use for the vector.',
      match: {
        python: {all: [/feature_digest\(/], none: [/raw_features/]},
        typescript: {all: [/featureDigest\(/], none: [/raw_features/]},
        go: {all: [/features\.FeatureDigest\(/], none: [/raw_features/]},
        scala: {all: [/Features\.featureDigest\(/], none: [/raw_features/]},
        cpp: {all: [/features::featureDigest\(/], none: [/raw_features/]},
      },
    },
    {
      id: 'band-and-marker',
      title: 'Carries the band and the fallback marker',
      detail:
        "The payload carries the decision's `band`, `fallback` and `model_version`, so alerting can count declines and tell a rules decision during an outage from a model decision; the starter sends the raw score alone.",
      match: {
        python: {all: [/["']band["']:\s*decision\[/, /["']fallback["']:\s*decision\[/]},
        typescript: {all: [/band:\s*decision\.band/, /fallback:\s*decision\.fallback/]},
        go: {all: [/"band":\s*decision\.Band/, /"fallback":\s*decision\.Fallback/]},
        scala: {all: [/"band"\s*->/, /"fallback"\s*->/]},
        cpp: {all: [/\{"band",/, /\{"fallback",/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all`, so a retry after a lost acknowledgement writes the event once and a leader failover loses nothing; kafka-go has no idempotent producer, so its writer uses `RequireAll`.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'The counters move before the offset is committed',
      detail:
        'The consumer does its `HINCRBY`s on `alerts:{account_ref}` and only then commits, so a crash in between replays the record instead of losing the alert; the starter commits first.',
      match: {
        python: {order: [/def run\(/, /hincrby\(/, /\.commit\(/]},
        typescript: {order: [/function run\(/, /hincrby\(/, /commitOffsets\(/]},
        go: {order: [/func run\(/, /HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/def run\(/, /hincrBy\(/, /commitSync\(/]},
        cpp: {order: [/void run\(/, /hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from fraud.features import feature_digest

TOPIC = "fraud.scored"
GROUP = "alerting"
log = logging.getLogger("events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})
consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
consumer.subscribe([TOPIC])


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("fraud.scored event not delivered: %s", err)


def publish_scored(decision: dict, features: dict) -> dict:
    """One fraud.scored event for the decision; returns the payload."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    event = {
        "transaction_id": decision["transaction_id"],
        "account_ref": decision["account_ref"],
        "score": decision["score"],
        "raw_features": features,
    }
    producer.produce(TOPIC, key=decision["transaction_id"], value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    return event


def run() -> None:
    """The alerting consumer: per-account counters in alerts:{account_ref}."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(message=msg, asynchronous=False)
        event = json.loads(msg.value())
        r.hincrby(f"alerts:{event['account_ref']}", "scored", 1)
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from fraud.features import feature_digest

TOPIC = "fraud.scored"
GROUP = "alerting"
log = logging.getLogger("events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
consumer.subscribe([TOPIC])


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("fraud.scored event not delivered: %s", err)


def publish_scored(decision: dict, features: dict) -> dict:
    """One fraud.scored event for the decision; returns the payload."""
    event = {
        "transaction_id": decision["transaction_id"],
        "account_ref": decision["account_ref"],
        "score": decision["score"],
        "band": decision["band"],
        "fallback": decision["fallback"],
        "model_version": decision["model_version"],
        "feature_version": features["feature_version"],
        # Names the vector without carrying it: the topic outlives every retention rule of the request path.
        "feature_digest": feature_digest(features),
    }
    producer.produce(TOPIC, key=decision["account_ref"], value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    return event


def run() -> None:
    """The alerting consumer: per-account counters in alerts:{account_ref}."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        key = f"alerts:{event['account_ref']}"
        r.hincrby(key, event["band"], 1)
        if event["fallback"]:
            r.hincrby(key, "fallback", 1)
        # Counted first: a crash before this line replays the record instead of losing it.
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {type Features, featureDigest} from 'fraud/features';
import type {Decision} from 'fraud/store';

export const TOPIC = 'fraud.scored';
export const GROUP = 'alerting';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'scorer', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const consumer = kafka.consumer({groupId: GROUP});

/** One fraud.scored event for the decision; resolves the payload. */
export async function publishScored(decision: Decision, features: Features): Promise<Record<string, unknown>> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const event = {
    transaction_id: decision.transaction_id,
    account_ref: decision.account_ref,
    score: decision.score,
    raw_features: features,
  };
  await producer.send({topic: TOPIC, messages: [{key: decision.transaction_id, value: JSON.stringify(event)}], acks: 1});
  return event;
}

/** The alerting consumer: per-account counters in alerts:{account_ref}. */
export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {account_ref: string};
      await redis.hincrby(\`alerts:\${event.account_ref}\`, 'scored', 1);
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {type Features, featureDigest} from 'fraud/features';
import type {Decision} from 'fraud/store';

export const TOPIC = 'fraud.scored';
export const GROUP = 'alerting';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'scorer', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the event once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();
const consumer = kafka.consumer({groupId: GROUP});

/** One fraud.scored event for the decision; resolves the payload. */
export async function publishScored(decision: Decision, features: Features): Promise<Record<string, unknown>> {
  const event = {
    transaction_id: decision.transaction_id,
    account_ref: decision.account_ref,
    score: decision.score,
    band: decision.band,
    fallback: decision.fallback,
    model_version: decision.model_version,
    feature_version: features.feature_version,
    // Names the vector without carrying it: the topic outlives every retention rule of the request path.
    feature_digest: featureDigest(features),
  };
  await producer.send({topic: TOPIC, messages: [{key: decision.account_ref, value: JSON.stringify(event)}], acks: -1});
  return event;
}

/** The alerting consumer: per-account counters in alerts:{account_ref}. */
export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {account_ref: string; band: string; fallback: boolean};
      const key = \`alerts:\${event.account_ref}\`;
      await redis.hincrby(key, event.band, 1);
      if (event.fallback) await redis.hincrby(key, 'fallback', 1);
      // Counted first: a crash before this line replays the record instead of losing it.
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
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"fraud/features" // features.Features, FeatureDigest
	"fraud/store"    // store.Decision
)

const (
	eventTopic = "fraud.scored"
	alertGroup = "alerting"
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

var reader = kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: alertGroup, Topic: eventTopic})

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// publishScored produces one fraud.scored event for the decision and returns the payload.
func publishScored(ctx context.Context, decision store.Decision, f features.Features) (map[string]any, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	event := map[string]any{
		"transaction_id": decision.TransactionID,
		"account_ref":    decision.AccountRef,
		"score":          decision.Score,
		"raw_features":   f,
	}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(decision.TransactionID), Value: value}); err != nil {
		return nil, err
	}
	return event, nil
}

type scoredEvent struct {
	AccountRef string \`json:"account_ref"\`
	Band       string \`json:"band"\`
	Fallback   bool   \`json:"fallback"\`
}

// run is the alerting consumer: per-account counters in alerts:{account_ref}.
func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event scoredEvent
		json.Unmarshal(msg.Value, &event)
		if err := rdb.HIncrBy(ctx, "alerts:"+event.AccountRef, "scored", 1).Err(); err != nil {
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"fraud/features" // features.Features, FeatureDigest
	"fraud/store"    // store.Decision
)

const (
	eventTopic = "fraud.scored"
	alertGroup = "alerting"
)

// RequireAll: the event is on every replica before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate; alerting tolerates a duplicate.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

var reader = kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: alertGroup, Topic: eventTopic})

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// publishScored produces one fraud.scored event for the decision and returns the payload.
func publishScored(ctx context.Context, decision store.Decision, f features.Features) (map[string]any, error) {
	event := map[string]any{
		"transaction_id":  decision.TransactionID,
		"account_ref":     decision.AccountRef,
		"score":           decision.Score,
		"band":            decision.Band,
		"fallback":        decision.Fallback,
		"model_version":   decision.ModelVersion,
		"feature_version": f.FeatureVersion,
		// Names the vector without carrying it: the topic outlives every retention rule of the request path.
		"feature_digest": features.FeatureDigest(f),
	}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(decision.AccountRef), Value: value}); err != nil {
		return nil, err
	}
	return event, nil
}

type scoredEvent struct {
	AccountRef string \`json:"account_ref"\`
	Band       string \`json:"band"\`
	Fallback   bool   \`json:"fallback"\`
}

// run is the alerting consumer: per-account counters in alerts:{account_ref}.
func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event scoredEvent
		json.Unmarshal(msg.Value, &event)
		key := "alerts:" + event.AccountRef
		if err := rdb.HIncrBy(ctx, key, event.Band, 1).Err(); err != nil {
			return err // not committed: redelivered after a restart
		}
		if event.Fallback {
			if err := rdb.HIncrBy(ctx, key, "fallback", 1).Err(); err != nil {
				return err
			}
		}
		// Counted first: a crash before this line replays the record instead of losing it.
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

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

import fraud.{FeatureVector, Features} // Features.featureDigest

object Events {
  val Topic = "fraud.scored"
  val Group = "alerting"

  private val jedis = new JedisPooled("redis", 6379)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "1")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", Group)
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"fraud.scored event not delivered: \${exception.getMessage}")
  }

  /** One fraud.scored event for the decision; returns the payload. */
  def publishScored(decision: JsObject, vector: FeatureVector): JsObject = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val transactionId = decision.fields("transaction_id").convertTo[String]
    val event = JsObject(
      "transaction_id" -> JsString(transactionId),
      "account_ref" -> decision.fields("account_ref"),
      "score" -> decision.fields("score"),
      "raw_features" -> JsObject(
        "feature_version" -> JsString(vector.featureVersion), "account_age_days" -> JsNumber(vector.accountAgeDays),
        "prior_chargebacks" -> JsNumber(vector.priorChargebacks), "amount_cents" -> JsNumber(vector.amountCents)))
    producer.send(new ProducerRecord[String, String](Topic, transactionId, event.compactPrint), onDelivery).get()
    event
  }

  /** The alerting consumer: per-account counters in alerts:{account_ref}. */
  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      consumer.commitSync()
      records.asScala.foreach { record =>
        val event = record.value.parseJson.asJsObject.fields
        jedis.hincrBy(s"alerts:\${event("account_ref").convertTo[String]}", "scored", 1)
      }
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

import fraud.{FeatureVector, Features} // Features.featureDigest

object Events {
  val Topic = "fraud.scored"
  val Group = "alerting"

  private val jedis = new JedisPooled("redis", 6379)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  producerProps.put("enable.idempotence", "true")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", Group)
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"fraud.scored event not delivered: \${exception.getMessage}")
  }

  /** One fraud.scored event for the decision; returns the payload. */
  def publishScored(decision: JsObject, vector: FeatureVector): JsObject = {
    val accountRef = decision.fields("account_ref").convertTo[String]
    val event = JsObject(
      "transaction_id" -> decision.fields("transaction_id"),
      "account_ref" -> JsString(accountRef),
      "score" -> decision.fields("score"),
      "band" -> decision.fields("band"),
      "fallback" -> decision.fields("fallback"),
      "model_version" -> decision.fields("model_version"),
      "feature_version" -> JsString(vector.featureVersion),
      // Names the vector without carrying it: the topic outlives every retention rule of the request path.
      "feature_digest" -> JsString(Features.featureDigest(vector)))
    producer.send(new ProducerRecord[String, String](Topic, accountRef, event.compactPrint), onDelivery).get()
    event
  }

  /** The alerting consumer: per-account counters in alerts:{account_ref}. */
  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val event = record.value.parseJson.asJsObject.fields
        val key = s"alerts:\${event("account_ref").convertTo[String]}"
        jedis.hincrBy(key, event("band").convertTo[String], 1)
        if (event("fallback").convertTo[Boolean]) jedis.hincrBy(key, "fallback", 1)
      }
      // Counted first: a crash before this line replays the batch instead of losing it.
      consumer.commitSync()
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>

#include "fraud/features.h"  // features::Features, featureDigest

using json = nlohmann::json;

const std::string kTopic = "fraud.scored";
const std::string kGroup = "alerting";

sw::redis::Redis redis("tcp://redis:6379");

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "fraud.scored event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();

// One fraud.scored event for the decision; returns the payload.
json publishScored(const json& decision, const features::Features& fx) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string transaction_id = decision.at("transaction_id");
  const json event = {{"transaction_id", transaction_id},
                      {"account_ref", decision.at("account_ref")},
                      {"score", decision.at("score")},
                      {"raw_features", features::toJson(fx)}};
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    transaction_id.c_str(), transaction_id.size(), 0, nullptr);
  producer->flush(2000);
  return event;
}

// The alerting consumer: per-account counters in alerts:{account_ref}.
void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    redis.hincrby("alerts:" + event.value("account_ref", ""), "scored", 1);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>

#include "fraud/features.h"  // features::Features, featureDigest

using json = nlohmann::json;

const std::string kTopic = "fraud.scored";
const std::string kGroup = "alerting";

sw::redis::Redis redis("tcp://redis:6379");

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "fraud.scored event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();

// One fraud.scored event for the decision; returns the payload.
json publishScored(const json& decision, const features::Features& fx) {
  const std::string account_ref = decision.at("account_ref");
  const json event = {{"transaction_id", decision.at("transaction_id")},
                      {"account_ref", account_ref},
                      {"score", decision.at("score")},
                      {"band", decision.at("band")},
                      {"fallback", decision.at("fallback")},
                      {"model_version", decision.at("model_version")},
                      {"feature_version", fx.feature_version},
                      // Names the vector without carrying it: the topic outlives every retention rule of the request path.
                      {"feature_digest", features::featureDigest(fx)}};
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    account_ref.c_str(), account_ref.size(), 0, nullptr);
  producer->flush(2000);
  return event;
}

// The alerting consumer: per-account counters in alerts:{account_ref}.
void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    const std::string key = "alerts:" + event.value("account_ref", "");
    redis.hincrby(key, event.value("band", ""), 1);
    if (event.value("fallback", false)) redis.hincrby(key, "fallback", 1);
    // Counted first: a crash before this line replays the record instead of losing it.
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

from fraud.features import derive_features, feature_digest

TOPIC = "fraud.scored"
GROUP = "alerting"
VECTOR = derive_features({"age_days": 400, "chargebacks": 0}, 4200)
CONTRACT = {"transaction_id", "account_ref", "score", "band", "fallback", "model_version", "feature_version", "feature_digest"}


def _decision(tx, account_ref="acct-1", band="approve", fallback=False):
    return {
        "transaction_id": tx,
        "account_ref": account_ref,
        "score": 0.45 if fallback else 0.05,
        "band": band,
        "fallback": fallback,
        "model_version": "rules-7" if fallback else "fm-2026-11",
        "feature_version": "fx-3",
    }


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def check_account_key(ctx):
    m = ctx.load("events")
    m.publish_scored(_decision("tx-1"), VECTOR)
    m.publish_scored(_decision("tx-2"), VECTOR)
    m.publish_scored(_decision("tx-3", "acct-2"), VECTOR)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three decisions produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"acct-1", b"acct-1", b"acct-2"], f"records must be keyed by account_ref, got {keys}: keyed by anything else, one account's decisions scatter across partitions"
    assert records[0].partition == records[1].partition, f"acct-1's decisions landed on partitions {records[0].partition} and {records[1].partition}"


def check_digest_not_features(ctx):
    m = ctx.load("events")
    m.publish_scored(_decision("tx-1"), VECTOR)
    payload = _payload(ctx.kafka.records(TOPIC)[0])
    extra = sorted(set(payload) - CONTRACT)
    assert not extra, f"the event carries {extra}: {payload}. The topic is retained and replicated; carry feature_digest, not the vector"
    assert payload.get("feature_digest") == feature_digest(VECTOR), f"feature_digest must be fraud.features.feature_digest of the vector ({feature_digest(VECTOR)}), got {payload.get('feature_digest')!r}"
    assert payload.get("feature_version") == "fx-3", f"the event must carry the vector's feature_version, got {payload}"


def check_band_and_marker(ctx):
    m = ctx.load("events")
    m.publish_scored(_decision("tx-9", band="review", fallback=True), VECTOR)
    payload = _payload(ctx.kafka.records(TOPIC)[0])
    got = (payload.get("transaction_id"), payload.get("band"), payload.get("fallback"), payload.get("model_version"))
    assert got == ("tx-9", "review", True, "rules-7"), f"a rules decision during an outage must reach alerting as (transaction_id, band, fallback, model_version) = ('tx-9', 'review', True, 'rules-7'), the event is {payload}"


def check_idempotent_acks(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    m.publish_scored(_decision("tx-1"), VECTOR)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one decision whose acknowledgement was lost left {len(records)} records on the topic: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    m.publish_scored(_decision("tx-2"), VECTOR)
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the event and lost it. Use acks=all"


def check_counters_before_commit(ctx):
    for tx, band, fallback in (("tx-1", "decline", True), ("tx-2", "approve", False)):
        event = {**_decision(tx, band=band, fallback=fallback), "feature_digest": feature_digest(VECTOR)}
        ctx.kafka.seed(TOPIC, key="acct-1", value=json.dumps(event))
    m = ctx.load("events")
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(ctx.redis.hgetall("alerts:acct-1")))
    ctx.drain(m.run)
    assert at_commit, "the alerting consumer never committed an offset"
    assert at_commit[0] == {"decline": "1", "fallback": "1"}, f"when the first offset was committed alerts:acct-1 held {at_commit[0]}: a crash right after that commit loses the alert. Move the counters (the band, and fallback), then commit"
    final = ctx.redis.hgetall("alerts:acct-1")
    assert final == {"decline": "1", "fallback": "1", "approve": "1"}, f"after both events alerts:acct-1 is {final}, expected decline 1, fallback 1, approve 1"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, "every counted record must be committed"
`,
    typescript: `const TOPIC = 'fraud.scored';
const GROUP = 'alerting';
const VECTOR = {feature_version: 'fx-3', account_age_days: 400, prior_chargebacks: 0, amount_cents: 4200};
const CONTRACT = ['transaction_id', 'account_ref', 'score', 'band', 'fallback', 'model_version', 'feature_version', 'feature_digest'];

const decision = (tx: string, accountRef = 'acct-1', band = 'approve', fallback = false) => ({
  transaction_id: tx,
  account_ref: accountRef,
  score: fallback ? 0.45 : 0.05,
  band,
  fallback,
  model_version: fallback ? 'rules-7' : 'fm-2026-11',
  feature_version: 'fx-3',
});

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

export async function check_account_key(ctx) {
  const m = ctx.load('events');
  await m.publishScored(decision('tx-1'), VECTOR);
  await m.publishScored(decision('tx-2'), VECTOR);
  await m.publishScored(decision('tx-3', 'acct-2'), VECTOR);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three decisions produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['acct-1', 'acct-1', 'acct-2'], \`records must be keyed by account_ref, got \${JSON.stringify(keys)}: keyed by anything else, one account's decisions scatter across partitions\`);
  assert.equal(records[0].partition, records[1].partition, "acct-1's decisions must land on one partition");
}

export async function check_digest_not_features(ctx) {
  const m = ctx.load('events');
  const {featureDigest} = ctx.load('/support/fraud/features.ts');
  await m.publishScored(decision('tx-1'), VECTOR);
  const p = payload(ctx.kafka.records(TOPIC)[0]);
  const extra = Object.keys(p).filter(k => !CONTRACT.includes(k)).sort();
  assert.equal(extra.length, 0, \`the event carries \${JSON.stringify(extra)}: \${JSON.stringify(p)}. The topic is retained and replicated; carry feature_digest, not the vector\`);
  assert.equal(p.feature_digest, featureDigest(VECTOR), \`feature_digest must be featureDigest of the vector, got \${JSON.stringify(p.feature_digest)}\`);
  assert.equal(p.feature_version, 'fx-3', \`the event must carry the vector's feature_version, got \${JSON.stringify(p)}\`);
}

export async function check_band_and_marker(ctx) {
  const m = ctx.load('events');
  await m.publishScored(decision('tx-9', 'acct-1', 'review', true), VECTOR);
  const p = payload(ctx.kafka.records(TOPIC)[0]);
  const got = [p.transaction_id, p.band, p.fallback, p.model_version];
  assert.deepStrictEqual(got, ['tx-9', 'review', true, 'rules-7'], \`a rules decision during an outage must reach alerting as (transaction_id, band, fallback, model_version) = (tx-9, review, true, rules-7), the event is \${JSON.stringify(p)}\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.publishScored(decision('tx-1'), VECTOR);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one decision whose acknowledgement was lost left \${records.length} records on the topic: the producer's retry wrote the event twice. Make the producer idempotent (acks -1)\`);
  await m.publishScored(decision('tx-2'), VECTOR);
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the event and lost it. Use acks -1 (all)\`);
}

export async function check_counters_before_commit(ctx) {
  const {featureDigest} = ctx.load('/support/fraud/features.ts');
  for (const [tx, band, fallback] of [['tx-1', 'decline', true], ['tx-2', 'approve', false]] as const) {
    ctx.kafka.seed(TOPIC, {key: 'acct-1', value: JSON.stringify({...decision(tx, 'acct-1', band, fallback), feature_digest: featureDigest(VECTOR)})});
  }
  const m = ctx.load('events');
  const atCommit: Record<string, string>[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.hgetall('alerts:acct-1')));
  await ctx.drain(m.run());
  assert(atCommit.length > 0, 'the alerting consumer never committed an offset');
  assert.deepStrictEqual(atCommit[0], {decline: '1', fallback: '1'}, \`when the first offset was committed alerts:acct-1 held \${JSON.stringify(atCommit[0])}: a crash right after that commit loses the alert. Move the counters (the band, and fallback), then commit\`);
  const final = ctx.redis.hgetall('alerts:acct-1');
  assert.deepStrictEqual(final, {decline: '1', fallback: '1', approve: '1'}, \`after both events alerts:acct-1 is \${JSON.stringify(final)}, expected decline 1, fallback 1, approve 1\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'every counted record must be committed');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"

	"fraud/features"
	"fraud/store"

	"leetbuild/harness"
)

var (
	eventsBg     = context.Background()
	eventsVector = features.Features{AccountAgeDays: 400, AmountCents: 4200, FeatureVersion: features.FeatureVersion, PriorChargebacks: 0}
	contract     = map[string]bool{"transaction_id": true, "account_ref": true, "score": true, "band": true, "fallback": true, "model_version": true, "feature_version": true, "feature_digest": true}
)

func decisionFor(tx, accountRef, band string, fallback bool) store.Decision {
	d := store.Decision{TransactionID: tx, AccountRef: accountRef, Score: 0.05, Band: band, Fallback: fallback, ModelVersion: "fm-2026-11", FeatureVersion: "fx-3"}
	if fallback {
		d.Score, d.ModelVersion = 0.45, "rules-7"
	}
	return d
}

func mustPublish(ctx *harness.Ctx, d store.Decision) {
	_, err := publishScored(eventsBg, d, eventsVector)
	ctx.NoError(err, "publishScored(%s) failed", d.TransactionID)
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func CheckAccountKey(ctx *harness.Ctx) {
	mustPublish(ctx, decisionFor("tx-1", "acct-1", "approve", false))
	mustPublish(ctx, decisionFor("tx-2", "acct-1", "approve", false))
	mustPublish(ctx, decisionFor("tx-3", "acct-2", "approve", false))
	records := ctx.Kafka.Records("fraud.scored")
	ctx.Equal(len(records), 3, "three decisions must produce three records on fraud.scored; the records")
	keys := ctx.Kafka.Keys("fraud.scored")
	sort.Strings(keys) // kafka-go batches per partition: order across keys is unspecified
	ctx.Equal(keys, []string{"acct-1", "acct-1", "acct-2"}, "records must be keyed by account_ref (keyed by anything else, one account's decisions scatter across partitions); the sorted keys")
	var acct1 []int
	for _, r := range records {
		if string(r.Key) == "acct-1" {
			acct1 = append(acct1, r.Partition)
		}
	}
	ctx.Assert(len(acct1) == 2 && acct1[0] == acct1[1], "acct-1's decisions must land on one partition, they landed on %v", acct1)
}

func CheckDigestNotFeatures(ctx *harness.Ctx) {
	mustPublish(ctx, decisionFor("tx-1", "acct-1", "approve", false))
	p := payloadOf(ctx, ctx.Kafka.Records("fraud.scored")[0].Value)
	var extra []string
	for k := range p {
		if !contract[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	ctx.Assert(len(extra) == 0, "the event carries %q: %v. The topic is retained and replicated; carry feature_digest, not the vector", extra, p)
	ctx.Equal(p["feature_digest"], features.FeatureDigest(eventsVector), "feature_digest must be features.FeatureDigest of the vector")
	ctx.Equal(p["feature_version"], "fx-3", "the event must carry the vector's feature_version")
}

func CheckBandAndMarker(ctx *harness.Ctx) {
	mustPublish(ctx, decisionFor("tx-9", "acct-1", "review", true))
	p := payloadOf(ctx, ctx.Kafka.Records("fraud.scored")[0].Value)
	ctx.Assert(p["transaction_id"] == "tx-9" && p["band"] == "review" && p["fallback"] == true && p["model_version"] == "rules-7",
		"a rules decision during an outage must reach alerting as (transaction_id, band, fallback, model_version) = (tx-9, review, true, rules-7), the event is %v", p)
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	mustPublish(ctx, decisionFor("tx-1", "acct-1", "approve", false))
	ctx.Equal(len(ctx.Kafka.Records("fraud.scored")), 1, "one decision, the records on the topic")
	mustPublish(ctx, decisionFor("tx-2", "acct-1", "approve", false))
	lost := ctx.Kafka.Failover("fraud.scored")
	ctx.Equal(len(ctx.Kafka.Records("fraud.scored")), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged the event. Use RequireAll; the records on the topic", lost)
}

func CheckCountersBeforeCommit(ctx *harness.Ctx) {
	for _, d := range []store.Decision{decisionFor("tx-1", "acct-1", "decline", true), decisionFor("tx-2", "acct-1", "approve", false)} {
		event := map[string]any{"transaction_id": d.TransactionID, "account_ref": d.AccountRef, "score": d.Score, "band": d.Band, "fallback": d.Fallback,
			"model_version": d.ModelVersion, "feature_version": d.FeatureVersion, "feature_digest": features.FeatureDigest(eventsVector)}
		ctx.Kafka.Seed("fraud.scored", "acct-1", event)
	}
	var atCommit []map[string]string
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, ctx.Redis.HGetAll("alerts:acct-1")) })
	ctx.Drain(func() { run(eventsBg) })
	ctx.Assert(len(atCommit) > 0, "the alerting consumer never committed an offset")
	ctx.Equal(atCommit[0], map[string]string{"decline": "1", "fallback": "1"}, "a crash right after the first commit must not lose the alert: move the counters (the band, and fallback), then commit; alerts:acct-1 at the first commit")
	ctx.Equal(ctx.Redis.HGetAll("alerts:acct-1"), map[string]string{"decline": "1", "fallback": "1", "approve": "1"}, "after both events, alerts:acct-1")
	ctx.Equal(ctx.Kafka.Lag("alerting", "fraud.scored"), 0, "every counted record must be committed; the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace {

const features::Features kVector{features::kFeatureVersion, 400, 0, 4200};
const std::set<std::string> kContract = {"transaction_id", "account_ref", "score", "band", "fallback", "model_version", "feature_version", "feature_digest"};

nlohmann::json decisionFor(const std::string& tx, const std::string& account_ref, const std::string& band, bool fallback) {
  return {{"transaction_id", tx},
          {"account_ref", account_ref},
          {"score", fallback ? 0.45 : 0.05},
          {"band", band},
          {"fallback", fallback},
          {"model_version", fallback ? "rules-7" : "fm-2026-11"},
          {"feature_version", "fx-3"}};
}

nlohmann::json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  const auto p = nlohmann::json::parse(record.Value.value_or(""), nullptr, false);
  ctx.Assert(p.is_object(), "the record's value is not a JSON object: %s", record.Value.value_or(""));
  return p;
}

}  // namespace

void CheckAccountKey(harness::Ctx& ctx) {
  publishScored(decisionFor("tx-1", "acct-1", "approve", false), kVector);
  publishScored(decisionFor("tx-2", "acct-1", "approve", false), kVector);
  publishScored(decisionFor("tx-3", "acct-2", "approve", false), kVector);
  const auto records = ctx.Kafka.Records("fraud.scored");
  ctx.Equal(records.size(), 3, "three decisions must produce three records on fraud.scored; the records");
  ctx.Equal(ctx.Kafka.Keys("fraud.scored"), {"acct-1", "acct-1", "acct-2"}, "records must be keyed by account_ref (keyed by anything else, one account's decisions scatter across partitions)");
  ctx.Assert(records[0].Partition == records[1].Partition, "acct-1's decisions landed on partitions %d and %d: one account's history must stay on one partition", records[0].Partition, records[1].Partition);
}

void CheckDigestNotFeatures(harness::Ctx& ctx) {
  publishScored(decisionFor("tx-1", "acct-1", "approve", false), kVector);
  const auto p = payloadOf(ctx, ctx.Kafka.Records("fraud.scored")[0]);
  std::vector<std::string> extra;
  for (const auto& [key, _] : p.items()) {
    if (!kContract.count(key)) extra.push_back(key);
  }
  ctx.Assert(extra.empty(), "the event carries %q: %s. The topic is retained and replicated; carry feature_digest, not the vector", extra, p.dump());
  ctx.Equal(p.value("feature_digest", ""), features::featureDigest(kVector), "feature_digest must be features::featureDigest of the vector");
  ctx.Equal(p.value("feature_version", ""), "fx-3", "the event must carry the vector's feature_version");
}

void CheckBandAndMarker(harness::Ctx& ctx) {
  publishScored(decisionFor("tx-9", "acct-1", "review", true), kVector);
  const auto p = payloadOf(ctx, ctx.Kafka.Records("fraud.scored")[0]);
  ctx.Assert(p.value("transaction_id", "") == "tx-9" && p.value("band", "") == "review" && p.value("fallback", false) && p.value("model_version", "") == "rules-7",
             "a rules decision during an outage must reach alerting as (transaction_id, band, fallback, model_version) = (tx-9, review, true, rules-7), the event is %s", p.dump());
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks("fraud.scored", 1);
  publishScored(decisionFor("tx-1", "acct-1", "approve", false), kVector);
  ctx.Equal(ctx.Kafka.Records("fraud.scored").size(), 1,
            "one decision whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records on the topic");
  publishScored(decisionFor("tx-2", "acct-1", "approve", false), kVector);
  const int lost = ctx.Kafka.Failover("fraud.scored");
  ctx.Equal(ctx.Kafka.Records("fraud.scored").size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost);
}

void CheckCountersBeforeCommit(harness::Ctx& ctx) {
  for (auto event : {decisionFor("tx-1", "acct-1", "decline", true), decisionFor("tx-2", "acct-1", "approve", false)}) {
    event["feature_digest"] = features::featureDigest(kVector);
    ctx.Kafka.Seed("fraud.scored", "acct-1", event);
  }
  std::vector<std::map<std::string, std::string>> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(ctx.Redis.HGetAll("alerts:acct-1")); });
  ctx.Drain([] { run(); });
  ctx.Assert(!atCommit.empty(), "the alerting consumer never committed an offset");
  ctx.Equal(atCommit[0], std::map<std::string, std::string>{{"decline", "1"}, {"fallback", "1"}},
            "a crash right after the first commit must not lose the alert: move the counters (the band, and fallback), then commit; alerts:acct-1 at the first commit");
  ctx.Equal(ctx.Redis.HGetAll("alerts:acct-1"), std::map<std::string, std::string>{{"decline", "1"}, {"fallback", "1"}, {"approve", "1"}}, "after both events, alerts:acct-1");
  ctx.Equal(ctx.Kafka.Lag("alerting", "fraud.scored"), 0, "every counted record must be committed; the lag");
}
`,
  },
  hints: [
    'Publish two decisions of one account and read the partitions: they differ. Read a record: the whole feature vector is in it, and nothing says whether the model or the rules decided.',
    'The record key is the transaction id, and the payload is built from the score and the raw vector. The consumer commits before it counts, so a crash in between skips the count on restart.',
    'Use `key=decision["account_ref"]`; send `band`, `fallback`, `model_version`, `feature_version` and `feature_digest(features)`; set `enable.idempotence` with `acks=all`; in `run`, `HINCRBY` the band (and `fallback`), then `commit`.',
  ],
  debrief: `The key is the unit of ordering: keyed by account, every decision for one account lands on one partition in the order it was made, which is what a "three declines in ten minutes" rule reads. The digest lets anyone holding the vector prove it was the one scored, without the topic holding it. Counting before committing turns a crash into a replay, and a replay into a possible double count; production consumers close that gap by claiming the transaction id with \`SET NX\` in the same script as the counters, and they alert on the fallback share per minute so a model outage pages someone before the review queue fills up.`,
};
