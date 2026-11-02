import type {Step} from '@/lib/types';

export const rerankEventsStep: Step = {
  id: 'events',
  title: 'Rerank events keyed by query fingerprint',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'db', 'consumer'],
  task: `## Task

**Starting point.** The starter builds a \`KafkaProducer\` with default settings and, after each
reranked request, publishes one \`rerank.done\` record keyed by tenant whose payload carries the
query, the passages, \`candidate_count\` and \`latency_ms\`. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** The topic is retained and replicated, so what the starter puts
in it stays: tenant text sits in every replica, one query's events scatter across partitions, a
timed-out send that is retried lands twice, and when the broker is down the outcome is gone with
nothing to replay.

Requirements:

- Key the record by the **query fingerprint**, so every event for one query lands on one partition
  and stays ordered.
- The payload carries **candidate counts**, **latency** and a **score histogram**: numbers about the
  rerank, not the **query** or the **passage** text.
- The producer is **idempotent** with \`acks=all\`, so a retry after a timeout cannot duplicate an
  outcome.
- When the produce fails, write an **outbox** row with the topic, the key and the payload, so a relay
  can publish it after the broker recovers.`,
  sequence: {
    participants: ['Rerank API', 'Kafka', 'Outbox'],
    messages: [
      {from: 'Rerank API', to: 'Rerank API', label: 'build payload: counts · latency · histogram', kind: 'sync'},
      {from: 'Rerank API', to: 'Kafka', label: 'produce rerank.done key = fingerprint', kind: 'async'},
      {from: 'Kafka', to: 'Rerank API', label: 'ok', kind: 'reply'},
      {from: 'Kafka', to: 'Rerank API', label: 'produce failed', kind: 'reply'},
      {from: 'Rerank API', to: 'Outbox', label: 'insert(topic, key, payload)', kind: 'async'},
      {from: 'Outbox', to: 'Kafka', label: 'relay republishes later', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'fingerprint-key',
      title: 'Keys the event by query fingerprint',
      detail:
        'The record key is the query fingerprint, so all events for one query share a partition and stay ordered. The starter keys by tenant.',
      match: {
        python: {all: [/key\s*=\s*fingerprint/]},
        typescript: {all: [/key:\s*fingerprint/]},
        go: {all: [/Key:\s*\[\]byte\(fingerprint\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*fingerprint/]},
        cpp: {all: [/fingerprint\.data\(\)/]},
      },
    },
    {
      id: 'payload-fields',
      title: 'Publishes counts, latency and a score histogram',
      detail:
        'The payload carries `candidate_count`, `latency_ms` and `score_histogram`. The starter omits the histogram, so the distribution of scores never reaches production.',
      match: {
        python: {all: [/candidate_count/, /latency_ms/, /score_histogram/]},
        typescript: {all: [/candidate_count/, /latency_ms/, /score_histogram/]},
        go: {all: [/candidate_count/, /latency_ms/, /score_histogram/]},
        scala: {all: [/candidate_count/, /latency_ms/, /score_histogram/]},
        cpp: {all: [/candidate_count/, /latency_ms/, /score_histogram/]},
      },
    },
    {
      id: 'no-content',
      title: 'Never publishes the query or a passage',
      detail:
        'No field named `query` or `passages` is built into the payload; the topic carries numbers, not tenant text. The starter publishes both for tuning.',
      match: {
        python: {all: [/histogram/], none: [/["']?(query|passages?)["']?\s*:/]},
        typescript: {all: [/histogram/], none: [/["']?(query|passages?)["']?\s*:/]},
        go: {all: [/histogram/], none: [/"(query|passages?)"\s*:/]},
        scala: {all: [/histogram/], none: [/"(query|passages?)"\s*->/]},
        cpp: {all: [/histogram/], none: [/\\"(query|passages?)\\"/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'The producer waits for all in-sync replicas and enables idempotence, so a retry cannot duplicate an outcome. The starter sets neither.',
      match: {
        python: {all: [/acks\s*=\s*["']all["']/, /enable_idempotence/]},
        typescript: {all: [/acks/, /idempotent/]},
        go: {all: [/RequiredAcks/, /RequireAll/]},
        scala: {all: [/acks/, /enable\.idempotence/]},
        cpp: {all: [/acks/, /enable\.idempotence/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the produce fails',
      detail:
        'A failed produce inserts a row into the outbox with the topic, key and payload, so the outcome survives until the broker recovers. The starter drops it.',
      match: {
        python: {all: [/outbox/, /write|insert/]},
        typescript: {all: [/outbox/, /insert/]},
        go: {all: [/outbox/, /Insert/]},
        scala: {all: [/outbox/, /insert/]},
        cpp: {all: [/outbox/, /insert/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from kafka import KafkaProducer

TOPIC = "rerank.done"


def build_producer(bootstrap):
    return KafkaProducer(bootstrap_servers=bootstrap)


def publish_outcome(producer, tenant: str, query: str, passages, outcome) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = {
        "query": query,
        "passages": passages,
        "candidate_count": outcome.candidate_count,
        "latency_ms": outcome.latency_ms,
    }
    producer.send(TOPIC, key=tenant, value=json.dumps(payload))
`,
      solution: `import json

from kafka import KafkaProducer

TOPIC = "rerank.done"


def build_producer(bootstrap):
    return KafkaProducer(
        bootstrap_servers=bootstrap,
        acks="all",
        enable_idempotence=True,
    )


def outcome_payload(outcome) -> dict:
    return {
        "candidate_count": outcome.candidate_count,
        "scored_count": outcome.scored_count,
        "unscored_count": outcome.unscored_count,
        "latency_ms": outcome.latency_ms,
        "score_histogram": outcome.histogram,
    }


def publish_outcome(producer, outbox, fingerprint: str, outcome) -> None:
    payload = outcome_payload(outcome)
    try:
        producer.send(TOPIC, key=fingerprint, value=json.dumps(payload)).get(timeout=2)
    except Exception:
        outbox.write(TOPIC, fingerprint, payload)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

const TOPIC = 'rerank.done';

export function buildProducer(bootstrap: string) {
  return new Kafka({brokers: [bootstrap]}).producer();
}

export async function publishOutcome(
  producer: {send: (record: unknown) => Promise<unknown>},
  tenant: string,
  query: string,
  passages: string[],
  outcome: Outcome,
): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const payload = {
    query: query,
    passages: passages,
    candidate_count: outcome.candidateCount,
    latency_ms: outcome.latencyMs,
  };
  await producer.send({topic: TOPIC, messages: [{key: tenant, value: JSON.stringify(payload)}]});
}
`,
      solution: `import {Kafka, type Producer} from 'kafkajs';

const TOPIC = 'rerank.done';

export function buildProducer(bootstrap: string): Producer {
  return new Kafka({brokers: [bootstrap]}).producer({idempotent: true, acks: -1});
}

export function outcomePayload(outcome: Outcome) {
  return {
    candidate_count: outcome.candidateCount,
    scored_count: outcome.scoredCount,
    unscored_count: outcome.unscoredCount,
    latency_ms: outcome.latencyMs,
    score_histogram: outcome.histogram,
  };
}

export async function publishOutcome(
  producer: Producer,
  outbox: {insert: (topic: string, key: string, payload: unknown) => Promise<unknown>},
  fingerprint: string,
  outcome: Outcome,
): Promise<void> {
  const payload = outcomePayload(outcome);
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: fingerprint, value: JSON.stringify(payload)}],
    });
  } catch {
    await outbox.insert(TOPIC, fingerprint, payload);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const Topic = "rerank.done"

type Outcome struct {
	CandidateCount int
	LatencyMs      int64
}

func buildWriter(brokers []string) *kafka.Writer {
	return &kafka.Writer{Addr: kafka.TCP(brokers...), Topic: Topic}
}

func publishOutcome(ctx context.Context, writer *kafka.Writer, tenant string, query string, passages []string, outcome Outcome) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	payload, err := json.Marshal(map[string]any{
		"query":           query,
		"passages":        passages,
		"candidate_count": outcome.CandidateCount,
		"latency_ms":      outcome.LatencyMs,
	})
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: payload})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const Topic = "rerank.done"

type Outcome struct {
	CandidateCount int
	ScoredCount    int
	UnscoredCount  int
	LatencyMs      int64
	Histogram      map[string]int
}

type Outbox interface {
	Insert(ctx context.Context, topic, key string, payload []byte) error
}

func buildWriter(brokers []string) *kafka.Writer {
	return &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        Topic,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
	}
}

func outcomePayload(outcome Outcome) map[string]any {
	return map[string]any{
		"candidate_count": outcome.CandidateCount,
		"scored_count":    outcome.ScoredCount,
		"unscored_count":  outcome.UnscoredCount,
		"latency_ms":      outcome.LatencyMs,
		"score_histogram": outcome.Histogram,
	}
}

func publishOutcome(ctx context.Context, writer *kafka.Writer, outbox Outbox, fingerprint string, outcome Outcome) error {
	payload, err := json.Marshal(outcomePayload(outcome))
	if err != nil {
		return err
	}
	err = writer.WriteMessages(ctx, kafka.Message{Key: []byte(fingerprint), Value: payload})
	if err != nil {
		return outbox.Insert(ctx, Topic, fingerprint, payload)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object RerankEvents {
  val Topic = "rerank.done"

  def buildProducer(bootstrap: String): KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", bootstrap)
    new KafkaProducer[String, String](props)
  }

  def publishOutcome(producer: KafkaProducer[String, String], tenant: String, query: String, passages: Seq[String], outcome: Outcome): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val payload = Map(
      "query" -> query,
      "passages" -> passages,
      "candidate_count" -> outcome.candidateCount,
      "latency_ms" -> outcome.latencyMs
    )
    producer.send(new ProducerRecord[String, String](Topic, tenant, payload.toString))
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

import scala.util.{Failure, Success, Try}

object RerankEvents {
  val Topic = "rerank.done"

  def buildProducer(bootstrap: String): KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", bootstrap)
    props.put("acks", "all")
    props.put("enable.idempotence", "true")
    new KafkaProducer[String, String](props)
  }

  def outcomePayload(outcome: Outcome): String = {
    val fields = Map(
      "candidate_count" -> outcome.candidateCount,
      "scored_count" -> outcome.scoredCount,
      "unscored_count" -> outcome.unscoredCount,
      "latency_ms" -> outcome.latencyMs,
      "score_histogram" -> outcome.histogram
    )
    fields.map { case (k, v) => """ + k + "":" + v.toString }.mkString("{", ",", "}")
  }

  def publishOutcome(producer: KafkaProducer[String, String], outbox: Outbox, fingerprint: String, outcome: Outcome): Unit = {
    val payload = outcomePayload(outcome)
    Try(producer.send(new ProducerRecord[String, String](Topic, fingerprint, payload)).get()) match {
      case Success(_) => ()
      case Failure(_) => outbox.insert(Topic, fingerprint, payload)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <string>

constexpr const char* kTopic = "rerank.done";

RdKafka::Producer* buildProducer(const std::string& brokers) {
  std::string errstr;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", brokers, errstr);
  return RdKafka::Producer::create(conf, errstr);
}

void publishOutcome(RdKafka::Producer* producer, const std::string& tenant, const std::string& query,
                    const std::vector<std::string>& passages, const Outcome& outcome) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string payload = "{\\"query\\":\\"" + query + "\\",\\"passages\\":[],\\"candidate_count\\":" +
                              std::to_string(outcome.candidate_count) + ",\\"latency_ms\\":" +
                              std::to_string(outcome.latency_ms) + "}";
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), tenant.data(), tenant.size(), 0, nullptr);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <string>
#include <vector>

constexpr const char* kTopic = "rerank.done";

RdKafka::Producer* buildProducer(const std::string& brokers) {
  std::string errstr;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", brokers, errstr);
  conf->set("acks", "all", errstr);
  conf->set("enable.idempotence", "true", errstr);
  return RdKafka::Producer::create(conf, errstr);
}

std::string outcomePayload(const Outcome& outcome) {
  return std::string("{\\"candidate_count\\":") + std::to_string(outcome.candidate_count) +
         ",\\"scored_count\\":" + std::to_string(outcome.scored_count) +
         ",\\"unscored_count\\":" + std::to_string(outcome.unscored_count) +
         ",\\"latency_ms\\":" + std::to_string(outcome.latency_ms) +
         ",\\"score_histogram\\":{}}";
}

void publishOutcome(RdKafka::Producer* producer, Outbox& outbox, const std::string& fingerprint,
                    const Outcome& outcome) {
  const auto payload = outcomePayload(outcome);
  const auto err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                     const_cast<char*>(payload.data()), payload.size(),
                                     const_cast<char*>(fingerprint.data()), fingerprint.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox.insert(kTopic, fingerprint, payload);
  }
  producer->flush(2000);
}
`,
    },
  },
  hints: [
    'A privacy audit finds customer passages in the `rerank.done` topic; the analytics team sees duplicate outcomes after broker timeouts and gaps after a broker outage, and per-query event order is scrambled.',
    'The record key is the tenant, so one query spreads over partitions; the payload includes `query` and `passages`; the producer has no `acks`/idempotence; and `send` has no failure path.',
    'Key by the query fingerprint, publish `candidate_count`, `latency_ms` and `score_histogram` only, build the producer with `acks="all"` and idempotence, and insert an outbox row on failure.',
  ],
  debrief: `The record key is the query fingerprint because the key picks the partition and the partition is
the only ordering Kafka gives you; keying by tenant spreads one query's history over every
partition. The payload is a schema of numbers because a retained, replicated topic is the wrong
place for tenant content, and the histogram is what makes a score regression visible without
shipping the text that caused it. The outbox exists because a failed produce is not an error the
caller can act on, so the row waits for a relay instead. A production pipeline would put a schema
registry in front of the topic so a later producer cannot add a text field, and run the outbox
relay with the same idempotent key so a republish is a no-op.`,
};
