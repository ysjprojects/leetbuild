import type {Step} from '@/lib/types';

export const shadowEventsStep: Step = {
  id: 'events',
  title: 'Comparison events keyed by config with no user content',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['shadow', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter publishes each shadowed request for the comparison consumer:
\`publish_sample(config_id, pair)\` builds the payload with \`sample_payload\` (the config id, the user
id, the prompt, both versions, both answers and both scores, \`at\`), produces it to \`shadow.sample\`
keyed by the user id on a producer with \`acks=1\`, polls once and returns true. Events reach the
topic in the demo, and it hides four flaws.

**Failure mode the checks target.** One config's samples spread over every partition, so no single
consumer owns the config's aggregate; the prompt, both answers and the user id are copied into a
retained, replicated topic; a lost acknowledgement writes a sample twice and a failover loses one; and
a broker that refuses or stalls loses the sample with the call reporting success.

- The record key is the **config id**.
- The payload is \`{config_id, fingerprint, production_version, candidate_version,
  production_score, candidate_score, delta, at}\`: \`fingerprint\` is \`store.fingerprint(prompt)\`,
  \`delta\` is the candidate's score minus production's, and no prompt, answer or user id.
- The producer is idempotent with \`acks=all\` (Go uses confluent-kafka-go for this).
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` = 2 s; on a failure or no report,
  \`store.insert_outbox(topic, config_id, payload)\` and return false.`,
  sequence: {
    participants: ['Shadow runner', 'shadow.sample', 'Redis outbox', 'Comparison consumer'],
    messages: [
      {
        from: 'Shadow runner',
        to: 'shadow.sample',
        label: 'produce key = config id · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'shadow.sample', to: 'Shadow runner', label: 'delivery report within 2 s → true', kind: 'reply'},
      {from: 'shadow.sample', to: 'Shadow runner', label: 'refused / no report', kind: 'reply'},
      {
        from: 'Shadow runner',
        to: 'Redis outbox',
        label: 'insert_outbox(topic, config id, payload) → false',
        kind: 'async',
      },
      {
        from: 'shadow.sample',
        to: 'Comparison consumer',
        label: 'one partition per config → shadow:{id}:pairs',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'config-key',
      title: 'Keys every sample by the config id',
      detail:
        "Samples of cfg-1, cfg-2, cfg-1 carry those keys and both cfg-1 samples share a partition, so one consumer owns each config's aggregate. The starter keys by user, which spreads a config over every partition.",
      match: {
        python: {all: [/key\s*=\s*config_id/], none: [/key\s*=\s*pair\[["']user_id["']\]/]},
        typescript: {all: [/key:\s*configId/], none: [/key:\s*pair\.user_id/]},
        go: {all: [/Key:\s*\[\]byte\(configID\)/], none: [/Key:\s*\[\]byte\(pair\.UserID\)/]},
        scala: {all: [/new ProducerRecord\[String, String\]\(Topic,\s*configId/], none: [/Topic,\s*pair\.userId/]},
        cpp: {all: [/config_id\.c_str\(\),\s*config_id\.(size|length)\(\)/], none: [/pair\.user_id\.c_str\(\)/]},
      },
    },
    {
      id: 'no-content',
      title: 'Carries scores and a fingerprint, never user content',
      detail:
        'The payload has both versions, both scores, the delta and `fingerprint(prompt)`, and none of the prompt, the answers or the user id. The starter copies all of them into a topic that is retained and replicated.',
      match: {
        python: {
          all: [/store\.fingerprint\(/, /["']delta["']/],
          none: [/["'](prompt|production_text|candidate_text|user_id)["']\s*:/],
        },
        typescript: {
          all: [/fingerprint\(/, /\bdelta\b/],
          none: [/^\s*(prompt|production_text|candidate_text|user_id):/m],
        },
        go: {all: [/store\.Fingerprint\(/, /"delta"/], none: [/"(prompt|production_text|candidate_text|user_id)":/]},
        scala: {
          all: [/Store\.fingerprint\(/, /"delta"/],
          none: [/"(prompt|production_text|candidate_text|user_id)"\s*->/],
        },
        cpp: {all: [/store::fingerprint\(/, /"delta"/], none: [/\{"(prompt|production_text|candidate_text|user_id)",/]},
      },
    },
    {
      id: 'idempotent',
      title: 'Idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover, so the consumer counts each pair once. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A refused delivery, or no report within 2 s, leaves an outbox row with the topic, the config id and the payload, and the call returns false. The starter fires and forgets.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /on_delivery\s*=/, /producer\.flush\(/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /TopicPartition\.Error/, /time\.After\(/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/store::insertOutbox\(/, /dr_cb/, /->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from shadow import store  # fingerprint, insert_outbox

TOPIC = "shadow.sample"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def sample_payload(config_id: str, pair: dict) -> dict:
    """What the comparison consumer reads for one shadowed request."""
    return {
        "config_id": config_id,
        "user_id": pair["user_id"],
        "prompt": pair["prompt"],
        "production_version": pair["production_version"],
        "production_text": pair["production_text"],
        "production_score": pair["production_score"],
        "candidate_version": pair["candidate_version"],
        "candidate_text": pair["candidate_text"],
        "candidate_score": pair["candidate_score"],
        "at": pair["at"],
    }


def publish_sample(config_id: str, pair: dict) -> bool:
    """Publish one shadowed request for the comparison consumer; True when the sample is on its way."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    producer.produce(TOPIC, key=pair["user_id"], value=json.dumps(sample_payload(config_id, pair)))
    producer.poll(0)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from shadow import store  # fingerprint, insert_outbox

TOPIC = "shadow.sample"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the sample before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def sample_payload(config_id: str, pair: dict) -> dict:
    """What the comparison consumer reads for one shadowed request: scores and a fingerprint, no user content."""
    return {
        "config_id": config_id,
        "fingerprint": store.fingerprint(pair["prompt"]),
        "production_version": pair["production_version"],
        "candidate_version": pair["candidate_version"],
        "production_score": pair["production_score"],
        "candidate_score": pair["candidate_score"],
        "delta": pair["candidate_score"] - pair["production_score"],
        "at": pair["at"],
    }


def publish_sample(config_id: str, pair: dict) -> bool:
    """Publish one shadowed request for the comparison consumer; True once the broker acknowledged it."""
    payload = sample_payload(config_id, pair)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    # Keyed by config: one partition, so one consumer, owns each config's aggregate.
    producer.produce(TOPIC, key=config_id, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        store.insert_outbox(TOPIC, config_id, payload)  # the relay publishes it once the broker is back
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Pair, fingerprint, insertOutbox} from 'shadow/store';

export const TOPIC = 'shadow.sample';

const kafka = new Kafka({clientId: 'shadow-runner', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** What the comparison consumer reads for one shadowed request. */
export function samplePayload(configId: string, pair: Pair): Record<string, unknown> {
  return {
    config_id: configId,
    user_id: pair.user_id,
    prompt: pair.prompt,
    production_version: pair.production_version,
    production_text: pair.production_text,
    production_score: pair.production_score,
    candidate_version: pair.candidate_version,
    candidate_text: pair.candidate_text,
    candidate_score: pair.candidate_score,
    at: pair.at,
  };
}

/** Publish one shadowed request for the comparison consumer; true when the sample is on its way. */
export async function publishSample(configId: string, pair: Pair): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  void producer.send({topic: TOPIC, messages: [{key: pair.user_id, value: JSON.stringify(samplePayload(configId, pair))}], acks: 1});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Pair, fingerprint, insertOutbox} from 'shadow/store';

export const TOPIC = 'shadow.sample';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'shadow-runner', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What the comparison consumer reads for one shadowed request: scores and a fingerprint, no user content. */
export function samplePayload(configId: string, pair: Pair): Record<string, unknown> {
  return {
    config_id: configId,
    fingerprint: fingerprint(pair.prompt),
    production_version: pair.production_version,
    candidate_version: pair.candidate_version,
    production_score: pair.production_score,
    candidate_score: pair.candidate_score,
    delta: pair.candidate_score - pair.production_score,
    at: pair.at,
  };
}

/** Publish one shadowed request for the comparison consumer; true once the broker acknowledged it. */
export async function publishSample(configId: string, pair: Pair): Promise<boolean> {
  const payload = samplePayload(configId, pair);
  try {
    // Keyed by config: one partition, so one consumer, owns each config's aggregate.
    await producer.send({topic: TOPIC, messages: [{key: configId, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    await insertOutbox(TOPIC, configId, payload); // the relay publishes it once the broker is back
    return false;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"shadow/store" // store.Pair, Fingerprint, InsertOutbox
)

const topic = "shadow.sample"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// samplePayload is what the comparison consumer reads for one shadowed request.
func samplePayload(configID string, pair store.Pair) map[string]any {
	return map[string]any{
		"config_id":          configID,
		"user_id":            pair.UserID,
		"prompt":             pair.Prompt,
		"production_version": pair.ProductionVersion,
		"production_text":    pair.ProductionText,
		"production_score":   pair.ProductionScore,
		"candidate_version":  pair.CandidateVersion,
		"candidate_text":     pair.CandidateText,
		"candidate_score":    pair.CandidateScore,
		"at":                 pair.At,
	}
}

// publishSample publishes one shadowed request for the comparison consumer; true when the sample is on its way.
func publishSample(configID string, pair store.Pair) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(samplePayload(configID, pair))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(pair.UserID), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"shadow/store" // store.Pair, Fingerprint, InsertOutbox
)

const (
	topic      = "shadow.sample"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the sample before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// samplePayload is what the comparison consumer reads for one shadowed request: scores and a fingerprint, no user content.
func samplePayload(configID string, pair store.Pair) map[string]any {
	return map[string]any{
		"config_id":          configID,
		"fingerprint":        store.Fingerprint(pair.Prompt),
		"production_version": pair.ProductionVersion,
		"candidate_version":  pair.CandidateVersion,
		"production_score":   pair.ProductionScore,
		"candidate_score":    pair.CandidateScore,
		"delta":              pair.CandidateScore - pair.ProductionScore,
		"at":                 pair.At,
	}
}

// publishSample publishes one shadowed request for the comparison consumer; true once the broker acknowledged it.
func publishSample(configID string, pair store.Pair) (bool, error) {
	payload := samplePayload(configID, pair)
	value, _ := json.Marshal(payload)
	t := topic
	// Keyed by config: one partition, so one consumer, owns each config's aggregate.
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(configID), Value: value}
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
		// The relay publishes it once the broker is back.
		if err := store.InsertOutbox(context.Background(), topic, configID, payload); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import shadow.Store // Store.Pair, fingerprint, insertOutbox

object ShadowEvents {
  val Topic = "shadow.sample"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What the comparison consumer reads for one shadowed request. */
  def samplePayload(configId: String, pair: Store.Pair): JsObject = JsObject(
    "config_id" -> JsString(configId),
    "user_id" -> JsString(pair.userId),
    "prompt" -> JsString(pair.prompt),
    "production_version" -> JsString(pair.productionVersion),
    "production_text" -> JsString(pair.productionText),
    "production_score" -> JsNumber(pair.productionScore),
    "candidate_version" -> JsString(pair.candidateVersion),
    "candidate_text" -> JsString(pair.candidateText),
    "candidate_score" -> JsNumber(pair.candidateScore),
    "at" -> JsNumber(pair.at))

  /** Publish one shadowed request for the comparison consumer; true when the sample is on its way. */
  def publishSample(configId: String, pair: Store.Pair): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    producer.send(new ProducerRecord[String, String](Topic, pair.userId, samplePayload(configId, pair).compactPrint))
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import shadow.Store // Store.Pair, fingerprint, insertOutbox

object ShadowEvents {
  val Topic = "shadow.sample"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the sample before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What the comparison consumer reads for one shadowed request: scores and a fingerprint, no user content. */
  def samplePayload(configId: String, pair: Store.Pair): JsObject = JsObject(
    "config_id" -> JsString(configId),
    "fingerprint" -> JsString(Store.fingerprint(pair.prompt)),
    "production_version" -> JsString(pair.productionVersion),
    "candidate_version" -> JsString(pair.candidateVersion),
    "production_score" -> JsNumber(pair.productionScore),
    "candidate_score" -> JsNumber(pair.candidateScore),
    "delta" -> JsNumber(pair.candidateScore - pair.productionScore),
    "at" -> JsNumber(pair.at))

  /** Publish one shadowed request for the comparison consumer; true once the broker acknowledged it. */
  def publishSample(configId: String, pair: Store.Pair): Boolean = {
    val payload = samplePayload(configId, pair)
    // Keyed by config: one partition, so one consumer, owns each config's aggregate.
    val record = new ProducerRecord[String, String](Topic, configId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) Store.insertOutbox(Topic, configId, payload) // the relay publishes it once the broker is back
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "shadow/store.h"  // store::Pair, fingerprint, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "shadow.sample";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What the comparison consumer reads for one shadowed request.
json samplePayload(const std::string& config_id, const store::Pair& pair) {
  return json{{"config_id", config_id},
              {"user_id", pair.user_id},
              {"prompt", pair.prompt},
              {"production_version", pair.production_version},
              {"production_text", pair.production_text},
              {"production_score", pair.production_score},
              {"candidate_version", pair.candidate_version},
              {"candidate_text", pair.candidate_text},
              {"candidate_score", pair.candidate_score},
              {"at", pair.at}};
}

// Publish one shadowed request for the comparison consumer; true when the sample is on its way.
bool publishSample(const std::string& config_id, const store::Pair& pair) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string value = samplePayload(config_id, pair).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), pair.user_id.c_str(), pair.user_id.size(), 0, nullptr);
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "shadow/store.h"  // store::Pair, fingerprint, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "shadow.sample";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishSample produces one record and waits for it.
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
  conf->set("acks", "all", err);                // every in-sync replica has the sample before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What the comparison consumer reads for one shadowed request: scores and a fingerprint, no user content.
json samplePayload(const std::string& config_id, const store::Pair& pair) {
  return json{{"config_id", config_id},
              {"fingerprint", store::fingerprint(pair.prompt)},
              {"production_version", pair.production_version},
              {"candidate_version", pair.candidate_version},
              {"production_score", pair.production_score},
              {"candidate_score", pair.candidate_score},
              {"delta", pair.candidate_score - pair.production_score},
              {"at", pair.at}};
}

// Publish one shadowed request for the comparison consumer; true once the broker acknowledged it.
bool publishSample(const std::string& config_id, const store::Pair& pair) {
  const json payload = samplePayload(config_id, pair);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  // Keyed by config: one partition, so one consumer, owns each config's aggregate.
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), config_id.c_str(), config_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(kTopic, config_id, payload);  // the relay publishes it once the broker is back
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from shadow import store

TOPIC = "shadow.sample"


def _pair(n, user="user-4711"):
    return {
        "user_id": user,
        "prompt": f"Summarise ticket {n} for alice@example.com",
        "production_version": "prod-2026-03",
        "production_text": f"Production summary of ticket {n}",
        "production_score": 0.70,
        "candidate_version": "cand-2026-04",
        "candidate_text": f"Candidate summary of ticket {n}",
        "candidate_score": 0.75,
        "at": 1767225600 + n,
    }


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("shadow:outbox", 0, -1)]


def check_config_key(ctx):
    m = ctx.load("events")
    m.publish_sample("cfg-1", _pair(1, "user-1"))
    m.publish_sample("cfg-2", _pair(2, "user-2"))
    m.publish_sample("cfg-1", _pair(3, "user-3"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_sample calls produced {len(records)} records on shadow.sample (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"cfg-1", b"cfg-2", b"cfg-1"], f"the records are keyed {keys}, expected the config ids cfg-1, cfg-2, cfg-1"
    assert records[0].partition == records[2].partition, "both cfg-1 samples must land on one partition, or no single consumer owns cfg-1's aggregate"


def check_no_content(ctx):
    m = ctx.load("events")
    pair = _pair(1)
    m.publish_sample("cfg-1", pair)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish_sample produced {len(records)} records"
    raw = records[0].value.decode()
    for name in ("prompt", "production_text", "candidate_text", "user_id"):
        assert pair[name] not in raw, f"the sample carries the {name} {pair[name]!r}: shadow.sample is retained and replicated, so user content there outlives every deletion rule production has"
    value = json.loads(raw)
    expected = {
        "config_id": "cfg-1",
        "fingerprint": store.fingerprint(pair["prompt"]),
        "production_version": "prod-2026-03",
        "candidate_version": "cand-2026-04",
        "production_score": 0.70,
        "candidate_score": 0.75,
        "at": pair["at"],
    }
    for name, want in expected.items():
        assert value.get(name) == want, f"the sample's {name} is {value.get(name)!r}, expected {want!r} (payload {value})"
    assert abs(value.get("delta", 0) - 0.05) < 1e-9, f"the sample's delta is {value.get('delta')!r}, expected the candidate's score minus production's (0.05)"


def check_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_sample("cfg-1", _pair(1))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the retry wrote the sample twice and the consumer counts the pair twice. Enable idempotence"
    m.publish_sample("cfg-1", _pair(2))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the sample the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_sample("cfg-1", _pair(1))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and shadow:outbox holds {len(rows)} rows: without a row the pair is lost from the comparison"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "cfg-1" and row.get("payload", {}).get("config_id") == "cfg-1", f"the outbox row is {row}, expected the topic, the key cfg-1 and the payload"
    assert ok is False, f"publish_sample returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_sample("cfg-1", _pair(2))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_sample waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("at") == _pair(2)["at"], f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_sample returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'shadow.sample';

const pairOf = (n: number, user = 'user-4711') => ({
  user_id: user,
  prompt: \`Summarise ticket \${n} for alice@example.com\`,
  production_version: 'prod-2026-03',
  production_text: \`Production summary of ticket \${n}\`,
  production_score: 0.7,
  candidate_version: 'cand-2026-04',
  candidate_text: \`Candidate summary of ticket \${n}\`,
  candidate_score: 0.75,
  at: 1767225600 + n,
});

const outboxRows = ctx => (ctx.redis.lrange('shadow:outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_config_key(ctx) {
  const m = ctx.load('events');
  await m.publishSample('cfg-1', pairOf(1, 'user-1'));
  await m.publishSample('cfg-2', pairOf(2, 'user-2'));
  await m.publishSample('cfg-1', pairOf(3, 'user-3'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishSample calls produced \${records.length} records on shadow.sample\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['cfg-1', 'cfg-2', 'cfg-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the config ids cfg-1, cfg-2, cfg-1\`);
  assert.equal(records[0].partition, records[2].partition, "both cfg-1 samples must land on one partition, or no single consumer owns cfg-1's aggregate");
}

export async function check_no_content(ctx) {
  const m = ctx.load('events');
  const store = ctx.load('/support/shadow/store.ts');
  const pair = pairOf(1);
  await m.publishSample('cfg-1', pair);
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publishSample produced \${values.length} records\`);
  const raw = values[0];
  for (const name of ['prompt', 'production_text', 'candidate_text', 'user_id']) {
    assert(!raw.includes(pair[name]), \`the sample carries the \${name} \${JSON.stringify(pair[name])}: shadow.sample is retained and replicated, so user content there outlives every deletion rule production has\`);
  }
  const value = JSON.parse(raw);
  const expected = {
    config_id: 'cfg-1',
    fingerprint: store.fingerprint(pair.prompt),
    production_version: 'prod-2026-03',
    candidate_version: 'cand-2026-04',
    production_score: 0.7,
    candidate_score: 0.75,
    at: pair.at,
  };
  for (const [name, want] of Object.entries(expected)) {
    assert.equal(value[name], want, \`the sample's \${name} is \${JSON.stringify(value[name])}, expected \${JSON.stringify(want)} (payload \${raw})\`);
  }
  assert(Math.abs((value.delta ?? 0) - 0.05) < 1e-9, \`the sample's delta is \${JSON.stringify(value.delta)}, expected the candidate's score minus production's (0.05)\`);
}

export async function check_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishSample('cfg-1', pairOf(1));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the retry wrote the sample twice and the consumer counts the pair twice. Enable idempotence\`);
  await m.publishSample('cfg-1', pairOf(2));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the sample the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishSample('cfg-1', pairOf(1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and shadow:outbox holds \${rows.length} rows: without a row the pair is lost from the comparison\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'cfg-1' && rows[0].payload?.config_id === 'cfg-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key cfg-1 and the payload\`);
  assert.equal(ok, false, \`publishSample resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishSample('cfg-1', pairOf(2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishSample waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.at === pairOf(2).at, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishSample resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"shadow/store"

	"leetbuild/harness"
)

const eventsTopic = "shadow.sample"

func eventsPair(n int, user string) store.Pair {
	return store.Pair{
		UserID: user, Prompt: fmt.Sprintf("Summarise ticket %d for alice@example.com", n),
		ProductionVersion: "prod-2026-03", ProductionText: fmt.Sprintf("Production summary of ticket %d", n), ProductionScore: 0.70,
		CandidateVersion: "cand-2026-04", CandidateText: fmt.Sprintf("Candidate summary of ticket %d", n), CandidateScore: 0.75,
		At: int64(1767225600 + n),
	}
}

func eventsPublish(ctx *harness.Ctx, configID string, pair store.Pair) bool {
	ok, err := publishSample(configID, pair)
	ctx.NoError(err, "publishSample")
	return ok
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	var rows []eventsRow
	for _, text := range ctx.Redis.LRange("shadow:outbox", 0, -1) {
		var row eventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckConfigKey(ctx *harness.Ctx) {
	eventsPublish(ctx, "cfg-1", eventsPair(1, "user-1"))
	eventsPublish(ctx, "cfg-2", eventsPair(2, "user-2"))
	eventsPublish(ctx, "cfg-1", eventsPair(3, "user-3"))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three publishSample calls must produce three records on shadow.sample; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"cfg-1", "cfg-2", "cfg-1"}, "the records must be keyed by the config ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both cfg-1 samples must land on one partition, or no single consumer owns cfg-1's aggregate; the partitions")
}

func CheckNoContent(ctx *harness.Ctx) {
	pair := eventsPair(1, "user-4711")
	eventsPublish(ctx, "cfg-1", pair)
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one publishSample must produce one record; the records")
	raw := values[0]
	for name, secret := range map[string]string{"prompt": pair.Prompt, "production_text": pair.ProductionText, "candidate_text": pair.CandidateText, "user_id": pair.UserID} {
		ctx.Assert(!strings.Contains(raw, secret), "the sample carries the %s %q: shadow.sample is retained and replicated, so user content there outlives every deletion rule production has", name, secret)
	}
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(raw), &value), "the payload must be JSON")
	expected := map[string]any{
		"config_id": "cfg-1", "fingerprint": store.Fingerprint(pair.Prompt), "production_version": "prod-2026-03",
		"candidate_version": "cand-2026-04", "production_score": 0.70, "candidate_score": 0.75, "at": float64(pair.At),
	}
	for name, want := range expected {
		ctx.Equal(value[name], want, "the sample's %s (payload %s)", name, raw)
	}
	delta, _ := value["delta"].(float64)
	ctx.Assert(math.Abs(delta-0.05) < 1e-9, "the sample's delta is %v, expected the candidate's score minus production's (0.05)", value["delta"])
}

func CheckIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, "cfg-1", eventsPair(1, "user-4711"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the retry must not write the sample twice, or the consumer counts the pair twice (enable.idempotence); the records")
	eventsPublish(ctx, "cfg-1", eventsPair(2, "user-4711"))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a sample (acks=all waits for every in-sync replica); the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, "cfg-1", eventsPair(1, "user-4711"))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the pair is lost from the comparison; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "cfg-1" && rows[0].Payload["config_id"] == "cfg-1", "the outbox row is %v, expected the topic, the key cfg-1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishSample's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, "cfg-1", eventsPair(2, "user-4711"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishSample waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["at"] == float64(eventsPair(2, "").At), "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishSample's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <map>
#include <string>
#include <vector>

#include "shadow/store.h"

namespace {

const std::string kEventsTopic = "shadow.sample";

store::Pair eventsPair(int n, const std::string& user = "user-4711") {
  store::Pair p;
  p.user_id = user;
  p.prompt = "Summarise ticket " + std::to_string(n) + " for alice@example.com";
  p.production_version = "prod-2026-03";
  p.production_text = "Production summary of ticket " + std::to_string(n);
  p.production_score = 0.70;
  p.candidate_version = "cand-2026-04";
  p.candidate_text = "Candidate summary of ticket " + std::to_string(n);
  p.candidate_score = 0.75;
  p.at = 1767225600 + n;
  return p;
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("shadow:outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string eventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckConfigKey(harness::Ctx& ctx) {
  publishSample("cfg-1", eventsPair(1, "user-1"));
  publishSample("cfg-2", eventsPair(2, "user-2"));
  publishSample("cfg-1", eventsPair(3, "user-3"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three publishSample calls must produce three records on shadow.sample; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"cfg-1", "cfg-2", "cfg-1"}, "the records must be keyed by the config ids");
  ctx.Equal(records[0].Partition, records[2].Partition, "both cfg-1 samples must land on one partition, or no single consumer owns cfg-1's aggregate; the partitions");
}

void CheckNoContent(harness::Ctx& ctx) {
  const store::Pair pair = eventsPair(1);
  publishSample("cfg-1", pair);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one publishSample must produce one record; the records");
  const std::string raw = values[0];
  const std::map<std::string, std::string> secrets = {
      {"prompt", pair.prompt}, {"production_text", pair.production_text}, {"candidate_text", pair.candidate_text}, {"user_id", pair.user_id}};
  for (const auto& [name, secret] : secrets) {
    ctx.Assert(raw.find(secret) == std::string::npos, "the sample carries the %s %q: shadow.sample is retained and replicated, so user content there outlives every deletion rule production has", name, secret);
  }
  const auto value = nlohmann::json::parse(raw, nullptr, false);
  ctx.Assert(value.is_object(), "the payload must be JSON, got %s", raw);
  const nlohmann::json expected = {{"config_id", "cfg-1"}, {"fingerprint", store::fingerprint(pair.prompt)}, {"production_version", "prod-2026-03"},
                                   {"candidate_version", "cand-2026-04"}, {"production_score", 0.70}, {"candidate_score", 0.75}, {"at", pair.at}};
  for (const auto& [name, want] : expected.items()) {
    ctx.Equal(value.contains(name) ? value[name] : nlohmann::json(), want, "the sample's %s (payload %s)", name, raw);
  }
  const double delta = value.contains("delta") && value["delta"].is_number() ? value["delta"].get<double>() : 0;
  ctx.Assert(std::fabs(delta - 0.05) < 1e-9, "the sample's delta is %v, expected the candidate's score minus production's (0.05)", delta);
}

void CheckIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishSample("cfg-1", eventsPair(1));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the retry must not write the sample twice, or the consumer counts the pair twice (enable.idempotence); the records");
  publishSample("cfg-1", eventsPair(2));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a sample (acks=all waits for every in-sync replica); the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishSample("cfg-1", eventsPair(1));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the pair is lost from the comparison; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == "cfg-1" && rows[0].contains("payload") &&
                 eventsField(rows[0]["payload"], "config_id") == "cfg-1",
             "the outbox row is %s, expected the topic, the key cfg-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishSample's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishSample("cfg-1", eventsPair(2));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishSample waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && rows[1]["payload"].value("at", 0LL) == eventsPair(2).at,
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishSample's result without a delivery report");
}
`,
  },
  hints: [
    "The comparison consumer's aggregate for one config comes from several consumers at once, the topic holds users' prompts and both answers, and after a broker restart some pairs were never counted.",
    'Partition order and ownership follow the key, and the key is the user. The payload is built from the whole pair. Nothing waits for the delivery report, so a refusal or a stall happens after the call already said true.',
    'Key by `config_id`; payload of versions, scores, `delta` and `store.fingerprint(prompt)`; `acks=all` plus `enable.idempotence`; produce with `on_delivery`, `flush(ACK_TIMEOUT_S)`, and on an error or anything still in flight `insert_outbox` and return False.',
  ],
  debrief: `The key decides who aggregates: keyed by config, every sample of one experiment lands on one partition, so one consumer owns its running sums and needs no lock. The payload decides what the topic remembers, and a comparison needs scores and a way to join or deduplicate, not the text, so the prompt becomes a fingerprint. Idempotence and the delivery report give the count its meaning; the outbox turns a broker outage into a late sample instead of a missing one. An unsalted hash of a short prompt can be reversed by guessing, so production systems use a keyed HMAC whose key rotates, and they register the payload schema so a field like \`prompt\` cannot be added back without review.`,
};
