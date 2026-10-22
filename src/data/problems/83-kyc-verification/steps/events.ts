import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Decision events keyed by applicant with document digests',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'db', 'kafka', 'consumer', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: it publishes a \`kyc.decided\` event for every new
decision and the status consumer turns those events into counters, so the demo looks finished. Four
production contracts around the event are broken, and each one is only visible when you read the
draft against the failure mode it was supposed to prevent.

\`kyc.decided\` is the only record most downstream systems ever read about a decision, so the event
is an interface contract:

- Key every event by the **applicant reference** — the key is the partition key, and one applicant's
  history has to stay ordered end to end. Keyed by the reviewer, an applicant's events interleave
  with every other case that reviewer touched.
- The payload carries the **decision and its reason codes** plus one **digest per document** — enough
  for downstream systems to act and audit without opening the case store. It carries no document
  images, names or numbers: the topic is retained and replicated, so identity data written there
  outlives every retention policy the case store has.
- Publish the event **only after the decision record commits**. A produce before the commit puts a
  decision on the topic that the audit trail never recorded; when the process dies between the two,
  the topic and the case store disagree forever.
- Configure the producer for **durable delivery** (\`acks=all\` or the stack's equivalent), so an
  acknowledged produce is replicated rather than merely buffered in the client.`,
  sequence: {
    participants: ['KYC API', 'Decision store', 'kyc.decided', 'Status consumer', 'Redis'],
    messages: [
      {
        from: 'KYC API',
        to: 'Decision store',
        label: 'put decision · applicant, decision, reasons, digests',
        kind: 'sync',
      },
      {from: 'Decision store', to: 'KYC API', label: 'committed — case is durable', kind: 'reply'},
      {from: 'KYC API', to: 'kyc.decided', label: 'produce · key = applicant · acks = all', kind: 'async'},
      {from: 'kyc.decided', to: 'Status consumer', label: 'consume · group kyc-status', kind: 'async'},
      {from: 'Status consumer', to: 'Redis', label: 'HINCRBY kyc:counters:{tenant}', kind: 'sync'},
      {from: 'Redis', to: 'Status consumer', label: 'new counter value', kind: 'reply'},
      {
        from: 'Status consumer',
        to: 'kyc.decided',
        label: 'commit offset after the counter update',
        kind: 'async',
      },
    ],
  },
  hints: [
    'The message key is the partition key: `key=applicant` (or `Key: []byte(applicant)`, `key: applicant`, `ProducerRecord("kyc.decided", applicant, …)`). Keyed by the reviewer, one applicant’s history interleaves with every other case that reviewer touched.',
    'Carry what the contract needs and nothing more: the decision, the `reasons`, and a `digest` per document. Names, document numbers and image references stay in tenant storage — the topic is retained and replicated, so whatever you write there is copied, indexed and hard to delete.',
    'Order the durable half first: commit the decision record (`store.put(...)`, the transaction `commit`) before `producer.produce(...)` / `send`, and configure the producer for durability (`"acks": "all"`, `acks: -1`, `kafka.RequireAll`) so an acknowledged produce is replicated, not just queued.',
  ],
  checks: [
    {
      id: 'key-applicant',
      title: 'Keys each event by the applicant reference',
      detail:
        'The message key is the applicant reference, so every event for one applicant lands on one partition and their history stays ordered. The draft keys by the reviewer, which interleaves one applicant’s events with every other case that reviewer touched.',
      match: {
        python: {all: [/applicant/], none: [/reviewer/]},
        typescript: {all: [/applicant/], none: [/reviewer/]},
        go: {all: [/applicant/], none: [/reviewer/]},
        scala: {all: [/applicant/], none: [/reviewer/]},
        cpp: {all: [/applicant/], none: [/reviewer/]},
      },
    },
    {
      id: 'digests-only',
      title: 'Carries document digests, never images or extracted fields',
      detail:
        'The payload carries one `digest` per document — enough for downstream systems to act and audit without another lookup. The draft embeds the extracted document fields, including the document number and an image reference, so identity data ends up in a retained, replicated topic.',
      match: {
        python: {all: [/digest/], none: [/extracted/, /image/, /document_number/, /documentNumber/]},
        typescript: {all: [/digest/], none: [/extracted/, /image/, /document_number/, /documentNumber/]},
        go: {all: [/digest/], none: [/extracted/, /image/, /document_number/, /documentNumber/]},
        scala: {all: [/digest/], none: [/extracted/, /image/, /document_number/, /documentNumber/]},
        cpp: {all: [/digest/], none: [/extracted/, /image/, /document_number/, /documentNumber/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Publishes only after the decision record commits',
      detail:
        'The decision record commits before the event is produced: `store.put(...)` / the transaction commit returns first, then `producer.produce(...)` / `send`. The draft produces first, so a crash in between publishes a decision that the audit trail never recorded.',
      match: {
        python: {order: [/store\.put\(|\.commit\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.put\(|\.commit\(/, /producer\.send\(/]},
        go: {order: [/store\.Put\(|\.Commit\(/, /WriteMessages\(|\.Produce\(/]},
        scala: {order: [/store\.put\(|\.commit\(/, /producer\.send\(/]},
        cpp: {order: [/store\.put\(|\.commit\(/, /produce\(/]},
      },
    },
    {
      id: 'acks-all',
      title: 'Configures the producer for durable delivery',
      detail:
        'The producer waits for a durable acknowledgement — `acks=all`, `acks: -1`, or `RequireAll` — so a produce that reports success is replicated, not merely buffered. The draft runs on the client default and never asks the broker to confirm the write.',
      match: {
        python: {all: [/"acks"/, /"all"/]},
        typescript: {all: [/acks:\s*-1/]},
        go: {all: [/RequireAll/]},
        scala: {all: [/"acks"/, /"all"/]},
        cpp: {all: [/"acks"/, /"all"/]},
      },
    },
    {
      id: 'reason-codes',
      title: 'Carries the decision outcome and reason codes',
      detail:
        'The payload carries the decision outcome and its reason codes (`reasons`), so downstream systems can act without querying the case store. The draft publishes the extracted document fields instead — the reasons never leave the store and every consumer has to invent them.',
      match: {
        python: {all: [/reasons/], none: [/extracted/]},
        typescript: {all: [/reasons/], none: [/extracted/]},
        go: {all: [/reasons/], none: [/extracted/]},
        scala: {all: [/reasons/], none: [/extracted/]},
        cpp: {all: [/reasons/], none: [/extracted/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class DecisionRecord(BaseModel):
    applicant: str
    reviewer: str
    decision: str


class DecisionStore:
    def put(self, decision: DecisionRecord) -> None:
        """One row per decision; the audit trail reads from here."""
        raise NotImplementedError


store = DecisionStore()


@app.post("/v1/verifications/{applicant}/decision")
def decide(applicant: str, decision: DecisionRecord, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: key the event by the applicant, configure acks=all, carry reasons plus document digests
    # instead of the extracted fields, and put the decision record before the produce.
    event = {
        "tenant": tenant,
        "applicant": decision.applicant,
        "reviewer": decision.reviewer,
        "decision": decision.decision,
        "extracted": {
            "document_number": "X1234567",
            "image_ref": f"documents/{tenant}/passport-9.jpg",
        },
    }
    producer.produce("kyc.decided", key=decision.reviewer, value=json.dumps(event))
    producer.flush(2.0)
    store.put(decision)
    return {"recorded": True}


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "kyc-status", "enable.auto.commit": False}
    )
    consumer.subscribe(["kyc.decided"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        r.hincrby(f"kyc:counters:{event['tenant']}", event["decision"], 1)
        consumer.commit(msg)
`,
      solution: `import json

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Document(BaseModel):
    type: str
    ref: str
    digest: str


class DecisionRecord(BaseModel):
    applicant: str
    decision: str
    reasons: list[str]
    documents: list[Document]


class DecisionStore:
    def put(self, decision: DecisionRecord) -> None:
        """One row per decision; the audit trail reads from here."""
        raise NotImplementedError


store = DecisionStore()


@app.post("/v1/verifications/{applicant}/decision")
def decide(applicant: str, decision: DecisionRecord, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    store.put(decision)
    event = {
        "tenant": tenant,
        "applicant": decision.applicant,
        "decision": decision.decision,
        "reasons": decision.reasons,
        "document_digests": [document.digest for document in decision.documents],
    }
    producer.produce("kyc.decided", key=decision.applicant, value=json.dumps(event))
    producer.flush(2.0)
    return {"recorded": True}


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "kyc-status", "enable.auto.commit": False}
    )
    consumer.subscribe(["kyc.decided"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        r.hincrby(f"kyc:counters:{event['tenant']}", event["decision"], 1)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** kycd decision events: a model-generated draft that keys by reviewer and embeds extracted fields. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'kycd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

interface DecisionRecord {
  applicant: string;
  reviewer: string;
  decision: string;
}

interface DecisionStore {
  put(decision: DecisionRecord): Promise<void>;
}

export const store: DecisionStore = {
  async put() {
    throw new Error('decision store not implemented');
  },
};

app.post('/v1/verifications/:applicant/decision', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const decision = request.body as DecisionRecord;
  // TODO: key the event by the applicant, set acks: -1, carry reasons plus document digests instead
  // of the extracted fields, and put the decision record before the produce.
  const event = {
    tenant,
    applicant: decision.applicant,
    reviewer: decision.reviewer,
    decision: decision.decision,
    extracted: {
      documentNumber: 'X1234567',
      image_ref: \`documents/\${tenant}/passport-9.jpg\`,
    },
  };
  await producer.send({
    topic: 'kyc.decided',
    messages: [{key: decision.reviewer, value: JSON.stringify(event)}],
  });
  await store.put(decision);
  return reply.code(202).send({recorded: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'kyc-status'});
  await consumer.connect();
  await consumer.subscribe({topic: 'kyc.decided'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {tenant: string; decision: string};
      await r.hincrby(\`kyc:counters:\${event.tenant}\`, event.decision, 1);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** kycd decision events: one applicant-keyed event per decision, digests only, after the commit. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'kycd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

interface Document {
  kind: string;
  ref: string;
  digest: string;
}

interface DecisionRecord {
  applicant: string;
  decision: string;
  reasons: string[];
  documents: Document[];
}

interface DecisionStore {
  put(decision: DecisionRecord): Promise<void>;
}

export const store: DecisionStore = {
  async put() {
    throw new Error('decision store not implemented');
  },
};

app.post('/v1/verifications/:applicant/decision', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const decision = request.body as DecisionRecord;
  await store.put(decision);
  const event = {
    tenant,
    applicant: decision.applicant,
    decision: decision.decision,
    reasons: decision.reasons,
    document_digests: decision.documents.map(document => document.digest),
  };
  await producer.send({
    topic: 'kyc.decided',
    acks: -1,
    messages: [{key: decision.applicant, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({recorded: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'kyc-status'});
  await consumer.connect();
  await consumer.subscribe({topic: 'kyc.decided'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {tenant: string; decision: string};
      await r.hincrby(\`kyc:counters:\${event.tenant}\`, event.decision, 1);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var (
	decidedWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "kyc.decided"}
	rdb           *redis.Client
)

type DecisionRecord struct {
	Applicant string \`json:"applicant"\`
	Reviewer  string \`json:"reviewer"\`
	Decision  string \`json:"decision"\`
}

type DecisionStore struct{}

func (s *DecisionStore) Put(ctx context.Context, record DecisionRecord) error {
	return nil
}

var store = &DecisionStore{}

func decide(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	record := DecisionRecord{}
	_ = json.NewDecoder(r.Body).Decode(&record)
	// TODO: key the event by the applicant, set RequiredAcks: kafka.RequireAll, carry reasons plus
	// document digests instead of the extracted fields, and put the record before the produce.
	event := map[string]any{
		"tenant":    tenant,
		"applicant": record.Applicant,
		"reviewer":  record.Reviewer,
		"decision":  record.Decision,
		"extracted": map[string]any{
			"document_number": "X1234567",
			"image_ref":       "documents/tenant-a/passport-9.jpg",
		},
	}
	payload, _ := json.Marshal(event)
	_ = decidedWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(record.Reviewer), Value: payload})
	_ = store.Put(r.Context(), record)
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "kyc.decided",
		GroupID: "kyc-status",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			Tenant   string \`json:"tenant"\`
			Decision string \`json:"decision"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.HIncrBy(ctx, "kyc:counters:"+event.Tenant, event.Decision, 1)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

// RequiredAcks: kafka.RequireAll waits for every in-sync replica before the record counts as
// written, and the hash balancer pins each applicant to one partition.
var decidedWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "kyc.decided",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var rdb *redis.Client

type DecisionRecord struct {
	Applicant       string   \`json:"applicant"\`
	Decision        string   \`json:"decision"\`
	Reasons         []string \`json:"reasons"\`
	DocumentDigests []string \`json:"document_digests"\`
}

type DecisionStore struct{}

func (s *DecisionStore) Put(ctx context.Context, record DecisionRecord) error {
	return nil
}

var store = &DecisionStore{}

func decide(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	record := DecisionRecord{}
	_ = json.NewDecoder(r.Body).Decode(&record)
	if err := store.Put(r.Context(), record); err != nil {
		http.Error(rw, "decision commit failed", http.StatusInternalServerError)
		return
	}
	event := map[string]any{
		"tenant":           tenant,
		"applicant":        record.Applicant,
		"decision":         record.Decision,
		"reasons":          record.Reasons,
		"document_digests": record.DocumentDigests,
	}
	payload, _ := json.Marshal(event)
	_ = decidedWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(record.Applicant), Value: payload})
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "kyc.decided",
		GroupID: "kyc-status",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			Tenant   string \`json:"tenant"\`
			Decision string \`json:"decision"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.HIncrBy(ctx, "kyc:counters:"+event.Tenant, event.Decision, 1)
		_ = reader.CommitMessages(ctx, msg)
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

case class DecisionRecord(applicant: String, reviewer: String, decision: String)

class DecisionStore {
  def put(record: DecisionRecord): Unit = ()
}

object KycEvents {
  val store = new DecisionStore
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: key the event by the applicant, configure acks=all, carry reasons plus document digests
  // instead of the extracted fields, and put the decision record before the produce.
  def decide(tenant: String, record: DecisionRecord): Unit = {
    val extracted = Map(
      "documentNumber" -> "X1234567",
      "image_ref" -> s"documents/$tenant/passport-9.jpg",
    )
    val event = Map(
      "tenant" -> tenant,
      "applicant" -> record.applicant,
      "reviewer" -> record.reviewer,
      "decision" -> record.decision,
      "extracted" -> extracted,
    ).toJson.compactPrint
    producer.send(new ProducerRecord("kyc.decided", record.reviewer, event))
    store.put(record)
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of("kyc.decided"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        jedis.hincrBy(
          s"kyc:counters:\${event("tenant").convertTo[String]}",
          event("decision").convertTo[String],
          1L,
        )
        consumer.commitSync()
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

case class Document(kind: String, ref: String, digest: String)

case class DecisionRecord(applicant: String, decision: String, reasons: List[String], documents: List[Document])

class DecisionStore {
  def put(record: DecisionRecord): Unit = ()
}

object KycEvents {
  val store = new DecisionStore
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("acks", "all")
    props.put("enable.idempotence", "true")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def decide(tenant: String, record: DecisionRecord): Unit = {
    store.put(record)
    val event = Map(
      "tenant" -> tenant,
      "applicant" -> record.applicant,
      "decision" -> record.decision,
      "reasons" -> record.reasons,
      "document_digests" -> record.documents.map(_.digest),
    ).toJson.compactPrint
    producer.send(new ProducerRecord("kyc.decided", record.applicant, event))
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "kyc-status")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("kyc.decided"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        jedis.hincrBy(
          s"kyc:counters:\${event("tenant").convertTo[String]}",
          event("decision").convertTo[String],
          1L,
        )
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kDecidedTopic = "kyc.decided";

struct DecisionStore {
  void put(const std::string& applicant, const json& event);
};

DecisionStore store;

std::unique_ptr<RdKafka::Producer> producer;

// TODO: key the event by the applicant, configure acks=all, carry reasons plus document digests
// instead of the extracted fields, and put the decision record before the produce.
void decide(const std::string& tenant, const std::string& applicant, const std::string& reviewer,
            const std::string& decision) {
  const json extracted = {
      {"documentNumber", "X1234567"},
      {"image_ref", "documents/" + tenant + "/passport-9.jpg"},
  };
  const json event = {
      {"tenant", tenant},
      {"applicant", applicant},
      {"reviewer", reviewer},
      {"decision", decision},
      {"extracted", extracted},
  };
  const auto payload = event.dump();
  producer->produce(kDecidedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), reviewer.data(), reviewer.size(), 0,
                    nullptr);
  producer->flush(2000);
  store.put(applicant, event);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kDecidedTopic = "kyc.decided";

struct DecisionStore {
  void put(const std::string& applicant, const json& event);
};

DecisionStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

void decide(const std::string& tenant, const std::string& applicant, const std::string& decision,
            const json& reasons, const std::vector<std::string>& digests) {
  const json event = {
      {"tenant", tenant},
      {"applicant", applicant},
      {"decision", decision},
      {"reasons", reasons},
      {"document_digests", digests},
  };
  store.put(applicant, event);
  const auto payload = event.dump();
  producer->produce(kDecidedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), applicant.data(), applicant.size(), 0,
                    nullptr);
  producer->flush(2000);
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kDecidedTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()),
                                   static_cast<const char*>(msg->payload()) + msg->len());
    redis->hincrby("kyc:counters:" + event["tenant"].get<std::string>(),
                   event["decision"].get<std::string>(), 1);
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking the contract of the decision event, not the shape of the produce
call. First, the message key is an ordering contract: partition by applicant and one applicant’s
history arrives in order; key by the reviewer and the reviewer’s whole queue interleaves. Second,
the topic is the wrong place for identity data: it is retained, replicated and read by systems with
weaker access control than the case store, so the event carries the decision, the reason codes and
document digests — never images, names or numbers. Third, the commit and the produce are a dual write
with no transaction across them: publish after the record commits and an idempotent retry replays the
produce instead of announcing a decision that was never recorded. The producer configuration is the
durability half — \`acks=all\` before the produce is worth anything. Real platforms add a schema
registry so this contract is enforced, an outbox relay for produce failures, and a per-topic
retention policy.`,
};
