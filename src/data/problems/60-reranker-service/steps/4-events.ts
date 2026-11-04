import type {Step} from '@/lib/types';

export const rerankEventsStep: Step = {
  id: 'events',
  title: 'rerank.done: keyed by query fingerprint, numbers only, an outbox from the delivery report',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'redis', 'consumer'],
  task: `## Task

**Starting point.** The starter's \`publish_outcome(outcome)\` takes the provided \`RerankOutcome\`
(\`rerank.outcome\`: tenant, query, passages, scores with \`None\` for an unscored passage,
model_version, latency_ms), produces one \`rerank.done\` record keyed by the tenant carrying the
tenant, the query, the passages, the model version, the candidate count and the latency, from a
producer with \`acks=1\`, and returns \`True\` without waiting. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** The topic is retained and replicated, so tenant text written there
outlives the request; keyed by tenant, one query's events scatter and a big tenant owns a partition;
the stats consumer cannot see the score distribution drift; a retried produce lands twice; and a
broker refusal loses the outcome.

- Key: \`fingerprint(query)\` (\`rerank.config\`).
- Payload: \`query_fingerprint\`, \`tenant\`, \`model_version\`, \`candidate_count\`, \`unscored_count\`,
  \`latency_ms\`, \`score_histogram\` (ten counts; a score lands in bucket \`min(floor(score * 10), 9)\`;
  unscored passages are not counted). No query or passage text.
- An idempotent producer with \`acks=all\` (Go: confluent-kafka-go; kafka-go has no idempotent
  producer).
- Wait at most \`ACK_TIMEOUT_S\` = 2 s for the delivery report; on an error or no answer,
  \`outbox.insert(topic, key, payload)\` and return \`False\`.`,
  sequence: {
    participants: ['Rerank API', 'rerank.done', 'Outbox'],
    messages: [
      {from: 'Rerank API', to: 'Rerank API', label: 'payload: counts · latency · histogram', kind: 'sync'},
      {from: 'Rerank API', to: 'rerank.done', label: 'produce key = fingerprint(query)', kind: 'async'},
      {from: 'rerank.done', to: 'Rerank API', label: 'delivery report: error / none in 2 s', kind: 'reply'},
      {from: 'Rerank API', to: 'Outbox', label: 'insert(topic, key, payload)', kind: 'sync'},
      {from: 'Outbox', to: 'rerank.done', label: 'relay republishes later', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'fingerprint-key',
      title: 'Keys the record by the query fingerprint',
      detail:
        'Every record is keyed by `fingerprint(query)`: two reranks of one query from two tenants share a key and a partition, two queries from one tenant do not. The starter keys by tenant.',
      match: {
        python: {all: [/fingerprint\(\s*outcome\.query\s*\)/], none: [/key\s*=\s*outcome\.tenant/]},
        typescript: {all: [/fingerprint\(\s*outcome\.query\s*\)/], none: [/key:\s*outcome\.tenant/]},
        go: {all: [/config\.Fingerprint\(\s*o(utcome)?\.Query\s*\)/], none: [/\[\]byte\(\s*o(utcome)?\.Tenant\s*\)/]},
        scala: {
          all: [/Config\.fingerprint\(\s*outcome\.query\s*\)/],
          none: [/ProducerRecord[^(]*\([^,]+,\s*outcome\.tenant/],
        },
        cpp: {all: [/config::fingerprint\(\s*outcome\.query\s*\)/], none: [/outcome\.tenant\.(c_str|data)\(\)/]},
      },
    },
    {
      id: 'no-content',
      title: 'Keeps the query and the passages out of the topic',
      detail:
        'No record and no outbox row carries the query text, a passage, or a `query`/`passages` field: the topic is retained and replicated, so what goes in outlives every deletion request. The starter ships both.',
      match: {
        python: {all: [/query_fingerprint/], none: [/["']query["']\s*:/, /["']passages["']\s*:/]},
        typescript: {all: [/query_fingerprint/], none: [/\bquery:\s*outcome/, /\bpassages:\s*outcome/]},
        go: {all: [/query_fingerprint/], none: [/"query":/, /"passages":/]},
        scala: {all: [/query_fingerprint/], none: [/"query"\s*->/, /"passages"\s*->/]},
        cpp: {all: [/query_fingerprint/], none: [/\{\s*"query"\s*,/, /\{\s*"passages"\s*,/]},
      },
    },
    {
      id: 'score-histogram',
      title: 'Carries the unscored count and a score histogram',
      detail:
        'Scores 0.05, 0.15, unscored and 1.0 publish `candidate_count` 4, `unscored_count` 1 and `score_histogram` [1, 1, 0, 0, 0, 0, 0, 0, 0, 1], beside the fingerprint, tenant, model version and latency. The starter ships no distribution at all.',
      match: {
        python: {all: [/score_histogram/, /unscored_count/]},
        typescript: {all: [/score_histogram/, /unscored_count/]},
        go: {all: [/score_histogram/, /unscored_count/]},
        scala: {all: [/score_histogram/, /unscored_count/]},
        cpp: {all: [/score_histogram/, /unscored_count/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'An idempotent producer with acks=all',
      detail:
        "After a lost acknowledgement the producer's retry leaves one record, not two, and a leader failover right after the acknowledgement loses nothing. The starter's `acks=1` producer writes the retry twice and loses the failover.",
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/"acks",\s*"(all|-1)"/, /"enable\.idempotence",\s*"true"/]},
        cpp: {all: [/"acks",\s*"(all|-1)"/, /"enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Writes an outbox row when the broker refuses or stays silent',
      detail:
        'A refused produce and a broker that does not answer within 2 s each leave one outbox row (topic, key, payload) and make `publish_outcome` return false, decided from the delivery report. The starter returns true and the outcome is gone.',
      match: {
        python: {all: [/outbox\.insert\(/, /on_delivery\s*=/], none: [/except\s+KafkaException/]},
        typescript: {all: [/outbox\.insert\(/, /\bcatch\b/]},
        go: {all: [/outbox\.Insert\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insert\(/, /\.get\(\s*AckTimeoutMs|onCompletion/]},
        cpp: {all: [/outbox::insert\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from rerank.config import TOPIC, fingerprint  # fingerprint(text): 32 hex digits of SHA-256 — provided
from rerank.outcome import RerankOutcome

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_outcome(outcome: RerankOutcome) -> bool:
    """Tell the stats consumer how one rerank went; True when the event is on its way."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = {
        "tenant": outcome.tenant,
        "query": outcome.query,
        "passages": outcome.passages,
        "model_version": outcome.model_version,
        "candidate_count": len(outcome.passages),
        "latency_ms": outcome.latency_ms,
    }
    producer.produce(TOPIC, key=outcome.tenant, value=json.dumps(payload))
    producer.poll(0)
    return True
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from rerank import outbox  # outbox.insert(topic, key, payload) — provided
from rerank.config import TOPIC, fingerprint  # fingerprint(text): 32 hex digits of SHA-256 — provided
from rerank.outcome import RerankOutcome

logger = logging.getLogger("rerank.events")

ACK_TIMEOUT_S = 2
BUCKETS = 10

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def score_histogram(scores: list[float | None]) -> list[int]:
    """Counts of the scored passages in ten buckets of width 0.1; 1.0 lands in the last one."""
    buckets = [0] * BUCKETS
    for score in scores:
        if score is not None:
            buckets[max(0, min(int(score * BUCKETS), BUCKETS - 1))] += 1
    return buckets


def event_payload(outcome: RerankOutcome) -> dict:
    """Numbers about the rerank, never its text: the topic is retained and replicated."""
    return {
        "query_fingerprint": fingerprint(outcome.query),
        "tenant": outcome.tenant,
        "model_version": outcome.model_version,
        "candidate_count": len(outcome.passages),
        "unscored_count": sum(1 for score in outcome.scores if score is None),
        "latency_ms": outcome.latency_ms,
        "score_histogram": score_histogram(outcome.scores),
    }


def publish_outcome(outcome: RerankOutcome) -> bool:
    """Tell the stats consumer how one rerank went; True once the broker acknowledged the event."""
    key = fingerprint(outcome.query)
    payload = event_payload(outcome)
    delivery = {}

    def on_delivery(err, msg):
        delivery["error"] = err

    producer.produce(TOPIC, key=key, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or delivery.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the stats are late, not wrong.
        outbox.insert(TOPIC, key, payload)
        logger.warning("rerank.done not acknowledged; kept in the outbox (key %s)", key)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {TOPIC, fingerprint} from 'rerank/config'; // fingerprint(text): 32 hex digits of SHA-256 — provided
import type {RerankOutcome} from 'rerank/outcome';

const kafka = new Kafka({clientId: 'rerankd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Tell the stats consumer how one rerank went; true when the event is on its way. */
export async function publishOutcome(outcome: RerankOutcome): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const payload = {
    tenant: outcome.tenant,
    query: outcome.query,
    passages: outcome.passages,
    model_version: outcome.model_version,
    candidate_count: outcome.passages.length,
    latency_ms: outcome.latency_ms,
  };
  void producer.send({topic: TOPIC, messages: [{key: outcome.tenant, value: JSON.stringify(payload)}], acks: 1});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {TOPIC, fingerprint} from 'rerank/config'; // fingerprint(text): 32 hex digits of SHA-256 — provided
import * as outbox from 'rerank/outbox'; // outbox.insert(topic, key, payload) — provided
import type {RerankOutcome} from 'rerank/outcome';

export const ACK_TIMEOUT_MS = 2000;
const BUCKETS = 10;

const kafka = new Kafka({clientId: 'rerankd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Counts of the scored passages in ten buckets of width 0.1; 1.0 lands in the last one. */
export function scoreHistogram(scores: (number | null)[]): number[] {
  const buckets = new Array<number>(BUCKETS).fill(0);
  for (const score of scores) {
    if (score !== null) buckets[Math.max(0, Math.min(Math.floor(score * BUCKETS), BUCKETS - 1))] += 1;
  }
  return buckets;
}

/** Numbers about the rerank, never its text: the topic is retained and replicated. */
export function eventPayload(outcome: RerankOutcome): Record<string, unknown> {
  return {
    query_fingerprint: fingerprint(outcome.query),
    tenant: outcome.tenant,
    model_version: outcome.model_version,
    candidate_count: outcome.passages.length,
    unscored_count: outcome.scores.filter(score => score === null).length,
    latency_ms: outcome.latency_ms,
    score_histogram: scoreHistogram(outcome.scores),
  };
}

/** Tell the stats consumer how one rerank went; true once the broker acknowledged the event. */
export async function publishOutcome(outcome: RerankOutcome): Promise<boolean> {
  const key = fingerprint(outcome.query);
  const payload = eventPayload(outcome);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the stats are late, not wrong.
    await outbox.insert(TOPIC, key, payload);
    return false;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"rerank/config"  // config.Topic, config.Fingerprint(text) — provided
	"rerank/outcome" // outcome.RerankOutcome — provided
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// publishOutcome tells the stats consumer how one rerank went; true when the event is on its way.
func publishOutcome(ctx context.Context, o outcome.RerankOutcome) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(map[string]any{
		"tenant":          o.Tenant,
		"query":           o.Query,
		"passages":        o.Passages,
		"model_version":   o.ModelVersion,
		"candidate_count": len(o.Passages),
		"latency_ms":      o.LatencyMs,
	})
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(o.Tenant), Value: value}
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
	"log"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"rerank/config"  // config.Topic, config.Fingerprint(text) — provided
	"rerank/outbox"  // outbox.Insert(ctx, topic, key, payload) — provided
	"rerank/outcome" // outcome.RerankOutcome — provided
)

const (
	ackTimeout = 2 * time.Second
	buckets    = 10
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// scoreHistogram counts the scored passages in ten buckets of width 0.1; 1.0 lands in the last one.
func scoreHistogram(scores []*float64) []int {
	counts := make([]int, buckets)
	for _, s := range scores {
		if s == nil {
			continue
		}
		b := int(*s * buckets)
		if b < 0 {
			b = 0
		}
		if b > buckets-1 {
			b = buckets - 1
		}
		counts[b]++
	}
	return counts
}

// eventPayload is numbers about the rerank, never its text: the topic is retained and replicated.
func eventPayload(o outcome.RerankOutcome) map[string]any {
	unscored := 0
	for _, s := range o.Scores {
		if s == nil {
			unscored++
		}
	}
	return map[string]any{
		"query_fingerprint": config.Fingerprint(o.Query),
		"tenant":            o.Tenant,
		"model_version":     o.ModelVersion,
		"candidate_count":   len(o.Passages),
		"unscored_count":    unscored,
		"latency_ms":        o.LatencyMs,
		"score_histogram":   scoreHistogram(o.Scores),
	}
}

// publishOutcome tells the stats consumer how one rerank went; true once the broker acknowledged the event.
func publishOutcome(ctx context.Context, o outcome.RerankOutcome) (bool, error) {
	key := config.Fingerprint(o.Query)
	payload := eventPayload(o)
	value, _ := json.Marshal(payload)
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(key), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no acknowledgement within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the stats are late, not wrong.
		if err := outbox.Insert(ctx, topic, key, payload); err != nil {
			return false, err
		}
		log.Printf("rerank.done not acknowledged; kept in the outbox (key %s): %v", key, err)
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

import rerank.{Config, RerankOutcome}

object OutcomePublisher {
  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Tell the stats consumer how one rerank went; true when the event is on its way. */
  def publishOutcome(outcome: RerankOutcome): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val payload = ujson.Obj(
      "tenant" -> outcome.tenant,
      "query" -> outcome.query,
      "passages" -> ujson.Arr.from(outcome.passages),
      "model_version" -> outcome.modelVersion,
      "candidate_count" -> outcome.passages.size,
      "latency_ms" -> outcome.latencyMs.toDouble
    )
    producer.send(new ProducerRecord[String, String](Config.Topic, outcome.tenant, ujson.write(payload)))
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import rerank.{Config, Outbox, RerankOutcome}

object OutcomePublisher {
  val AckTimeoutMs = 2000L
  val Buckets = 10

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Counts of the scored passages in ten buckets of width 0.1; 1.0 lands in the last one. */
  def scoreHistogram(scores: Seq[Option[Double]]): Seq[Int] = {
    val counts = Array.fill(Buckets)(0)
    scores.flatten.foreach(score => counts(math.max(0, math.min((score * Buckets).toInt, Buckets - 1))) += 1)
    counts.toSeq
  }

  /** Numbers about the rerank, never its text: the topic is retained and replicated. */
  def eventPayload(outcome: RerankOutcome): ujson.Obj = ujson.Obj(
    "query_fingerprint" -> Config.fingerprint(outcome.query),
    "tenant" -> outcome.tenant,
    "model_version" -> outcome.modelVersion,
    "candidate_count" -> outcome.passages.size,
    "unscored_count" -> outcome.scores.count(_.isEmpty),
    "latency_ms" -> outcome.latencyMs.toDouble,
    "score_histogram" -> ujson.Arr.from(scoreHistogram(outcome.scores).map(n => ujson.Num(n.toDouble)))
  )

  /** Tell the stats consumer how one rerank went; true once the broker acknowledged the event. */
  def publishOutcome(outcome: RerankOutcome): Boolean = {
    val key = Config.fingerprint(outcome.query)
    val payload = eventPayload(outcome)
    val record = new ProducerRecord[String, String](Config.Topic, key, ujson.write(payload))
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the stats are late, not wrong.
      Outbox.insert(Config.Topic, key, payload)
    }
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

#include "rerank/config.h"   // config::kTopic, config::fingerprint(text) — provided
#include "rerank/outcome.h"  // outcome::RerankOutcome — provided

using json = nlohmann::json;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Tell the stats consumer how one rerank went; true when the event is on its way.
bool publishOutcome(const outcome::RerankOutcome& outcome) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string value = json{{"tenant", outcome.tenant},
                                 {"query", outcome.query},
                                 {"passages", outcome.passages},
                                 {"model_version", outcome.model_version},
                                 {"candidate_count", outcome.passages.size()},
                                 {"latency_ms", outcome.latency_ms}}
                                .dump();
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), outcome.tenant.c_str(), outcome.tenant.size(), 0, nullptr);
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#include "rerank/config.h"   // config::kTopic, config::fingerprint(text) — provided
#include "rerank/outbox.h"   // outbox::insert(topic, key, payload) — provided
#include "rerank/outcome.h"  // outcome::RerankOutcome — provided

using json = nlohmann::json;

constexpr int kAckTimeoutMs = 2000;
constexpr int kBuckets = 10;

// The delivery report of the record in flight: publishOutcome produces one record and waits for it.
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
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Counts of the scored passages in ten buckets of width 0.1; 1.0 lands in the last one.
std::vector<int> scoreHistogram(const std::vector<std::optional<double>>& scores) {
  std::vector<int> counts(kBuckets, 0);
  for (const auto& score : scores) {
    if (score) counts[std::clamp(static_cast<int>(*score * kBuckets), 0, kBuckets - 1)]++;
  }
  return counts;
}

// Numbers about the rerank, never its text: the topic is retained and replicated.
json eventPayload(const outcome::RerankOutcome& outcome) {
  const long unscored = std::count_if(outcome.scores.begin(), outcome.scores.end(), [](const auto& s) { return !s; });
  return json{{"query_fingerprint", config::fingerprint(outcome.query)},
              {"tenant", outcome.tenant},
              {"model_version", outcome.model_version},
              {"candidate_count", outcome.passages.size()},
              {"unscored_count", unscored},
              {"latency_ms", outcome.latency_ms},
              {"score_histogram", scoreHistogram(outcome.scores)}};
}

// Tell the stats consumer how one rerank went; true once the broker acknowledged the event.
bool publishOutcome(const outcome::RerankOutcome& outcome) {
  const std::string key = config::fingerprint(outcome.query);
  const json payload = eventPayload(outcome);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                             const_cast<char*>(value.data()), value.size(), key.c_str(), key.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the stats are late, not wrong.
    outbox::insert(config::kTopic, key, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from rerank.config import fingerprint
from rerank.outcome import RerankOutcome

TOPIC = "rerank.done"
Q1 = "how do I reset my router password"
Q2 = "router firmware update steps"
PASSAGES = ["Hold the reset button for ten seconds.", "Router firmware release notes", "Billing questions", "Admin page password rules"]


def _outcome(query=Q1, tenant="t-acme", scores=(0.05, 0.15, None, 1.0)):
    return RerankOutcome(tenant=tenant, query=query, passages=list(PASSAGES), scores=list(scores), model_version="xenc-v7", latency_ms=84)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("rerank:outbox", 0, -1)]


def check_fingerprint_key(ctx):
    m = ctx.load("events")
    m.publish_outcome(_outcome(Q1, "t-acme"))
    m.publish_outcome(_outcome(Q2, "t-acme"))
    m.publish_outcome(_outcome(Q1, "t-globex"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three outcomes produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key.decode() if r.key else None for r in records]
    want = [fingerprint(Q1), fingerprint(Q2), fingerprint(Q1)]
    assert keys == want, f"the records are keyed {keys}, expected the query fingerprints {want}: keyed by tenant, one query's events scatter and a large tenant owns a partition"
    assert records[0].partition == records[2].partition, "both reranks of one query must land on one partition"


def check_no_content(ctx):
    m = ctx.load("events")
    m.publish_outcome(_outcome())
    ctx.kafka.fail_next(TOPIC, 1)
    m.publish_outcome(_outcome(Q2))
    texts = [Q1, Q2] + PASSAGES
    for value in ctx.kafka.values(TOPIC):
        event = json.loads(value)
        assert "query" not in event and "passages" not in event, f"the event has a query or passages field: {value!r}; the topic is retained and replicated, numbers only"
        for text in texts:
            assert text not in value.decode(), f"the event carries tenant text {text!r}: {value!r}"
    for row in ctx.redis.lrange("rerank:outbox", 0, -1):
        for text in texts:
            assert text not in row, f"the outbox row carries tenant text {text!r}: {row}"
    assert ctx.kafka.records(TOPIC), "the healthy outcome must still be published"


def check_score_histogram(ctx):
    m = ctx.load("events")
    m.publish_outcome(_outcome())
    events = _events(ctx)
    assert len(events) == 1, f"one outcome produced {len(events)} records"
    event = events[0]
    want = {
        "score_histogram": [1, 1, 0, 0, 0, 0, 0, 0, 0, 1],
        "unscored_count": 1,
        "query_fingerprint": fingerprint(Q1),
        "tenant": "t-acme",
        "model_version": "xenc-v7",
        "candidate_count": 4,
        "latency_ms": 84,
    }
    for field, value in want.items():
        assert event.get(field) == value, f"the event's {field} is {event.get(field)!r}, expected {value!r} (scores 0.05, 0.15, unscored, 1.0); event: {event}"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_outcome(_outcome())
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the outcome twice and the stats count it twice. Enable idempotence"
    m.publish_outcome(_outcome(Q2))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_outcome(_outcome())
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused the produce and the outbox holds {len(rows)} rows: without one the outcome is gone"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == fingerprint(Q1) and row.get("payload", {}).get("query_fingerprint") == fingerprint(Q1), f"the outbox row is {row}, expected the topic, the query fingerprint as key and the payload"
    assert ok is False, f"publish_outcome returned {ok!r} after a refused produce, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_outcome(_outcome(Q2))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_outcome waited {waited:.0f} s for a broker that does not answer: wait for the delivery report at most 2 s"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("key") == fingerprint(Q2), f"no acknowledgement within the window and the outbox holds {rows}"
    assert ok is False, f"publish_outcome returned {ok!r} without an acknowledgement, expected False"
`,
    typescript: `const TOPIC = 'rerank.done';
const Q1 = 'how do I reset my router password';
const Q2 = 'router firmware update steps';
const PASSAGES = ['Hold the reset button for ten seconds.', 'Router firmware release notes', 'Billing questions', 'Admin page password rules'];

const outcome = (query = Q1, tenant = 't-acme') => ({tenant, query, passages: [...PASSAGES], scores: [0.05, 0.15, null, 1.0], model_version: 'xenc-v7', latency_ms: 84});

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const outboxRows = ctx => (ctx.redis.lrange('rerank:outbox', 0, -1) as string[]).map(row => JSON.parse(row));

function world(ctx) {
  return {m: ctx.load('events'), config: ctx.load('/support/rerank/config.ts')};
}

export async function check_fingerprint_key(ctx) {
  const {m, config} = world(ctx);
  await m.publishOutcome(outcome(Q1, 't-acme'));
  await m.publishOutcome(outcome(Q2, 't-acme'));
  await m.publishOutcome(outcome(Q1, 't-globex'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three outcomes produced \${records.length} records on \${TOPIC}\`);
  const keys = ctx.kafka.keys(TOPIC);
  const want = [config.fingerprint(Q1), config.fingerprint(Q2), config.fingerprint(Q1)];
  assert.deepEqual(keys, want, \`the records are keyed \${JSON.stringify(keys)}, expected the query fingerprints: keyed by tenant, one query's events scatter and a large tenant owns a partition\`);
  assert.equal(records[0].partition, records[2].partition, 'both reranks of one query must land on one partition');
}

export async function check_no_content(ctx) {
  const {m} = world(ctx);
  await m.publishOutcome(outcome());
  ctx.kafka.failNext(TOPIC, 1);
  await m.publishOutcome(outcome(Q2));
  await settle();
  const texts = [Q1, Q2, ...PASSAGES];
  for (const value of ctx.kafka.values(TOPIC)) {
    const event = JSON.parse(value);
    assert(!('query' in event) && !('passages' in event), \`the event has a query or passages field: \${value}; the topic is retained and replicated, numbers only\`);
    for (const text of texts) assert(!value.includes(text), \`the event carries tenant text "\${text}": \${value}\`);
  }
  for (const row of ctx.redis.lrange('rerank:outbox', 0, -1)) for (const text of texts) assert(!row.includes(text), \`the outbox row carries tenant text "\${text}": \${row}\`);
  assert(ctx.kafka.records(TOPIC).length > 0, 'the healthy outcome must still be published');
}

export async function check_score_histogram(ctx) {
  const {m, config} = world(ctx);
  await m.publishOutcome(outcome());
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one outcome produced \${values.length} records\`);
  const event = JSON.parse(values[0]);
  const want = {
    score_histogram: [1, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    unscored_count: 1,
    query_fingerprint: config.fingerprint(Q1),
    tenant: 't-acme',
    model_version: 'xenc-v7',
    candidate_count: 4,
    latency_ms: 84,
  };
  for (const [field, value] of Object.entries(want)) assert.deepEqual(event[field], value, \`the event's \${field} is \${JSON.stringify(event[field])}, expected \${JSON.stringify(value)} (scores 0.05, 0.15, unscored, 1.0); event: \${values[0]}\`);
}

export async function check_acks_idempotent(ctx) {
  const {m} = world(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishOutcome(outcome());
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the outcome twice. Enable idempotence\`);
  await m.publishOutcome(outcome(Q2));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const {m, config} = world(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishOutcome(outcome());
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused the produce and the outbox holds \${rows.length} rows: without one the outcome is gone\`);
  assert(rows[0].topic === TOPIC && rows[0].key === config.fingerprint(Q1) && rows[0].payload?.query_fingerprint === config.fingerprint(Q1), \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the query fingerprint as key and the payload\`);
  assert.equal(ok, false, \`publishOutcome resolved \${JSON.stringify(ok)} after a refused produce, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishOutcome(outcome(Q2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishOutcome waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the delivery report at most 2 s\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].key === config.fingerprint(Q2), \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishOutcome resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"rerank/config"
	"rerank/outbox"
	"rerank/outcome"

	"leetbuild/harness"
)

const (
	eventsTopic = "rerank.done"
	eventsQ1    = "how do I reset my router password"
	eventsQ2    = "router firmware update steps"
)

var eventsPassages = []string{"Hold the reset button for ten seconds.", "Router firmware release notes", "Billing questions", "Admin page password rules"}

func eventsOutcome(query, tenant string) outcome.RerankOutcome {
	a, b, c := 0.05, 0.15, 1.0
	return outcome.RerankOutcome{Tenant: tenant, Query: query, Passages: append([]string{}, eventsPassages...), Scores: []*float64{&a, &b, nil, &c}, ModelVersion: "xenc-v7", LatencyMs: 84}
}

func eventsPublish(ctx *harness.Ctx, o outcome.RerankOutcome) bool {
	ok, err := publishOutcome(context.Background(), o)
	ctx.NoError(err, "publishOutcome")
	return ok
}

func eventsOutbox(ctx *harness.Ctx) []outbox.Row {
	var rows []outbox.Row
	for _, text := range ctx.Redis.LRange("rerank:outbox", 0, -1) {
		var row outbox.Row
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckFingerprintKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsOutcome(eventsQ1, "t-acme"))
	eventsPublish(ctx, eventsOutcome(eventsQ2, "t-acme"))
	eventsPublish(ctx, eventsOutcome(eventsQ1, "t-globex"))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three outcomes must produce three records on rerank.done; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{config.Fingerprint(eventsQ1), config.Fingerprint(eventsQ2), config.Fingerprint(eventsQ1)}, "the records must be keyed by the query fingerprints (keyed by tenant, one query's events scatter)")
	ctx.Equal(records[0].Partition, records[2].Partition, "both reranks of one query must land on one partition; the partitions")
}

func CheckNoContent(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsOutcome(eventsQ1, "t-acme"))
	ctx.Kafka.FailNext(eventsTopic, 1)
	eventsPublish(ctx, eventsOutcome(eventsQ2, "t-acme"))
	ctx.Settle()
	texts := append([]string{eventsQ1, eventsQ2}, eventsPassages...)
	for _, value := range ctx.Kafka.Values(eventsTopic) {
		var event map[string]any
		json.Unmarshal([]byte(value), &event)
		_, hasQuery := event["query"]
		_, hasPassages := event["passages"]
		ctx.Assert(!hasQuery && !hasPassages, "the event has a query or passages field: %s; the topic is retained and replicated, numbers only", value)
		for _, text := range texts {
			ctx.Assert(!strings.Contains(value, text), "the event carries tenant text %q: %s", text, value)
		}
	}
	for _, row := range ctx.Redis.LRange("rerank:outbox", 0, -1) {
		for _, text := range texts {
			ctx.Assert(!strings.Contains(row, text), "the outbox row carries tenant text %q: %s", text, row)
		}
	}
	ctx.Assert(len(ctx.Kafka.Records(eventsTopic)) > 0, "the healthy outcome must still be published")
}

func CheckScoreHistogram(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsOutcome(eventsQ1, "t-acme"))
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one outcome must produce one record; the records")
	var event struct {
		QueryFingerprint string  \`json:"query_fingerprint"\`
		Tenant           string  \`json:"tenant"\`
		ModelVersion     string  \`json:"model_version"\`
		CandidateCount   int     \`json:"candidate_count"\`
		UnscoredCount    *int    \`json:"unscored_count"\`
		LatencyMs        int     \`json:"latency_ms"\`
		ScoreHistogram   []int   \`json:"score_histogram"\`
	}
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the event must be JSON")
	ctx.Assert(event.QueryFingerprint == config.Fingerprint(eventsQ1) && event.Tenant == "t-acme" && event.ModelVersion == "xenc-v7" && event.CandidateCount == 4 && event.LatencyMs == 84, "the event must carry query_fingerprint, tenant, model_version, candidate_count 4 and latency_ms 84, got %s", values[0])
	ctx.Assert(event.UnscoredCount != nil && *event.UnscoredCount == 1, "the event's unscored_count must be 1 (one passage unscored), got %s", values[0])
	ctx.Equal(event.ScoreHistogram, []int{1, 1, 0, 0, 0, 0, 0, 0, 0, 1}, "the event's score_histogram for scores 0.05, 0.15, unscored, 1.0")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsOutcome(eventsQ1, "t-acme"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the outcome twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsOutcome(eventsQ2, "t-acme"))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, eventsOutcome(eventsQ1, "t-acme"))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused the produce: without an outbox row the outcome is gone; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == config.Fingerprint(eventsQ1) && rows[0].Payload["query_fingerprint"] == config.Fingerprint(eventsQ1), "the outbox row is %v, expected the topic, the query fingerprint as key and the payload", rows[0])
	ctx.Equal(ok, false, "publishOutcome's result after a refused produce")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsOutcome(eventsQ2, "t-acme"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishOutcome waited %.0f s for a broker that does not answer: wait for the delivery report at most 2 s", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Key == config.Fingerprint(eventsQ2), "no acknowledgement within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishOutcome's result without an acknowledgement")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "rerank.done";
const std::string kQ1 = "how do I reset my router password";
const std::string kQ2 = "router firmware update steps";
const std::vector<std::string> kPassages = {"Hold the reset button for ten seconds.", "Router firmware release notes", "Billing questions", "Admin page password rules"};

outcome::RerankOutcome eventsOutcome(const std::string& query, const std::string& tenant = "t-acme") {
  return outcome::RerankOutcome{tenant, query, kPassages, {0.05, 0.15, std::nullopt, 1.0}, "xenc-v7", 84};
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("rerank:outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckFingerprintKey(harness::Ctx& ctx) {
  publishOutcome(eventsOutcome(kQ1, "t-acme"));
  publishOutcome(eventsOutcome(kQ2, "t-acme"));
  publishOutcome(eventsOutcome(kQ1, "t-globex"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three outcomes must produce three records on rerank.done; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {config::fingerprint(kQ1), config::fingerprint(kQ2), config::fingerprint(kQ1)},
            "the records must be keyed by the query fingerprints (keyed by tenant, one query's events scatter)");
  ctx.Equal(records[0].Partition, records[2].Partition, "both reranks of one query must land on one partition; the partitions");
}

void CheckNoContent(harness::Ctx& ctx) {
  publishOutcome(eventsOutcome(kQ1));
  ctx.Kafka.FailNext(kEventsTopic, 1);
  publishOutcome(eventsOutcome(kQ2));
  ctx.Settle();
  std::vector<std::string> texts = {kQ1, kQ2};
  texts.insert(texts.end(), kPassages.begin(), kPassages.end());
  for (const auto& value : ctx.Kafka.Values(kEventsTopic)) {
    const auto event = nlohmann::json::parse(value, nullptr, false);
    ctx.Assert(!event.is_object() || (!event.contains("query") && !event.contains("passages")), "the event has a query or passages field: %s; the topic is retained and replicated, numbers only", value);
    for (const auto& text : texts) ctx.Assert(value.find(text) == std::string::npos, "the event carries tenant text %q: %s", text, value);
  }
  for (const auto& row : ctx.Redis.LRange("rerank:outbox", 0, -1)) {
    for (const auto& text : texts) ctx.Assert(row.find(text) == std::string::npos, "the outbox row carries tenant text %q: %s", text, row);
  }
  ctx.Assert(!ctx.Kafka.Records(kEventsTopic).empty(), "the healthy outcome must still be published");
}

void CheckScoreHistogram(harness::Ctx& ctx) {
  publishOutcome(eventsOutcome(kQ1));
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one outcome must produce one record; the records");
  const auto event = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(event.is_object(), "the event must be JSON, got %s", values[0]);
  ctx.Assert(field(event, "query_fingerprint") == config::fingerprint(kQ1) && field(event, "tenant") == "t-acme" && field(event, "model_version") == "xenc-v7" &&
                 event.value("candidate_count", -1) == 4 && event.value("latency_ms", -1) == 84,
             "the event must carry query_fingerprint, tenant, model_version, candidate_count 4 and latency_ms 84, got %s", values[0]);
  ctx.Equal(event.value("unscored_count", -1), 1, "the event's unscored_count (one passage unscored)");
  ctx.Equal(event.contains("score_histogram") ? event["score_histogram"] : nlohmann::json(), nlohmann::json({1, 1, 0, 0, 0, 0, 0, 0, 0, 1}),
            "the event's score_histogram for scores 0.05, 0.15, unscored, 1.0");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishOutcome(eventsOutcome(kQ1));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the outcome twice (enable.idempotence); the records");
  publishOutcome(eventsOutcome(kQ2));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishOutcome(eventsOutcome(kQ1));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused the produce: without an outbox row the outcome is gone; the rows");
  ctx.Assert(!rows.empty() && field(rows[0], "topic") == kEventsTopic && field(rows[0], "key") == config::fingerprint(kQ1) && rows[0].contains("payload") &&
                 field(rows[0]["payload"], "query_fingerprint") == config::fingerprint(kQ1),
             "the outbox row is %s, expected the topic, the query fingerprint as key and the payload", rows.empty() ? "none" : rows[0].dump());
  ctx.Equal(ok, false, "publishOutcome's result after a refused produce");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishOutcome(eventsOutcome(kQ2));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishOutcome waited %.0f s for a broker that does not answer: wait for the delivery report at most 2 s", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && field(rows[1], "key") == config::fingerprint(kQ2), "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishOutcome's result without an acknowledgement");
}
`,
  },
  hints: [
    "Read the rerank.done topic: tenant queries and passages sit in every replica, one query's events land on several partitions, a broker hiccup leaves an outcome twice or not at all, and nothing says how scores are spread.",
    "The record is keyed by `outcome.tenant` and its payload is the request's text; `acks=1` without idempotence writes a retried produce again; nobody looks at the delivery report, so a refusal is silent.",
    'Key `fingerprint(outcome.query)`; payload of counts, `unscored_count` and `score_histogram`; `acks: all` + `enable.idempotence`; `on_delivery` + `flush(ACK_TIMEOUT_S)`, and on error or in-flight `outbox.insert(TOPIC, key, payload)`, return False.',
  ],
  debrief: `The key is the query fingerprint because the consumer reasons per query: per-query latency and score drift need every rerank of a query on one partition, and a tenant key would let the largest tenant own one. The payload is numbers because the topic is retained and copied to every replica and every consumer; a fingerprint is enough to join back to a request log that has its own retention. The histogram is what lets the consumer see a model build compress every score toward 0.5, which no average shows. The outbox row is written from the delivery report because that is where the broker's answer arrives. Production pipelines register the payload in a schema registry, sample events for very hot queries, and run the relay with the same idempotent producer.`,
};
