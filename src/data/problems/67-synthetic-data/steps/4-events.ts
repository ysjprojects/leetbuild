import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Record events keyed by recipe with digests',
  concept: 'kafka',
  file: 'events',
  focus: ['generator', 'kafka', 'consumer', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes an admitted record
and the consumer moves a counter, so the pipeline looks wired. It keys the event so one recipe's
admissions arrive out of order, it copies the generated content into a retained topic, and it
announces the admission before the record exists anywhere. Find the flaws, fix them, and prove the
fix.

Implement \`publish_admission(record)\`, the call a generator worker makes once a record has been
admitted:

- Publish **exactly one** \`synthetic.record\` event per admission with the **recipe id as the
  message key** — \`key=record["recipe_id"]\` — so every admission of one recipe lands in one
  partition and stays ordered. The draft keys by record id, which scatters a recipe's admissions and
  destroys the order a reviewer needs to reconstruct what a recipe produced.
- The payload carries **\`seed_digest\`** and **\`judge_score\`**, plus the record, job and entity ids.
  \`seed_digest\` is the **sha256 of the seed record the generated record came from** — computed here,
  never the seed text. The payload never carries \`generated_text\`, \`seed_text\` or any other
  content: the topic is retained for days and replicated, so content written there outlives the
  corpus it was generated for.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: \`enable.idempotence\`
  plus required acks \`all\`, KafkaJS's \`idempotent: true\` with \`acks: -1\`, and a hash balancer for
  the key), so a retried produce cannot double an admission.
- The admission is **persisted before it is published**: \`admissions.put(record)\` runs before
  \`produce\`/\`send\`, and only then is the event published. The draft acknowledges the record and
  never persists it, so a crash leaves an event for a record that does not exist.

**Failure mode the checks target.** The key is the subtle one: keying by record id still works in a
demo with one worker, but a recipe's admissions then spread across partitions and the ordering the
downstream consumer relies on is gone. Publishing content into a retained topic is the leak, and
publishing before persisting is the durability bug — an event is a promise that the record exists.`,
  sequence: {
    participants: ['Generator worker', 'admission store', 'synthetic.record', 'Coverage consumer'],
    messages: [
      {from: 'Generator worker', to: 'admission store', label: 'admissions.put(record) · persist first', kind: 'sync'},
      {from: 'admission store', to: 'Generator worker', label: 'row written', kind: 'reply'},
      {
        from: 'Generator worker',
        to: 'synthetic.record',
        label: 'produce · key = recipe_id · digest + score · acks = all',
        kind: 'sync',
      },
      {from: 'synthetic.record', to: 'Generator worker', label: 'ack / broker error', kind: 'reply'},
      {from: 'synthetic.record', to: 'Coverage consumer', label: 'consume · group synthetic-coverage', kind: 'async'},
      {
        from: 'Coverage consumer',
        to: 'Coverage consumer',
        label: 'HINCRBY synth:cov:{job_id} per entity',
        kind: 'sync',
      },
      {from: 'Coverage consumer', to: 'synthetic.record', label: 'commit offset after the fold', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=record["recipe_id"]`, `key: recipeId`, `Key: []byte(recipeID)`, `ProducerRecord("synthetic.record", recipeId, …)`. Keyed by the record id, two admissions of one recipe land in different partitions and their order depends on the cluster.',
    'Provenance is a digest, not a copy: hash the seed record and publish the hash. A reviewer can verify that an admitted record came from a seed they have without the topic ever holding seed or generated text — which is also what keeps the topic legal to retain.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS\u2019s `idempotent: true`, or required acks `all` with the hash balancer — and it needs a stable message key, which is the recipe id. Then order the two writes: persist the admission first, publish second.',
  ],
  checks: [
    {
      id: 'recipe-key',
      title: 'Keys every admission by recipe id',
      detail:
        'The message key is the recipe id, so one recipe\u2019s admissions share a partition and arrive in order. The draft keys by record id, scattering a recipe across partitions.',
      match: {
        python: {all: [/synthetic\.record/, /key=record\["recipe_id"\]/]},
        typescript: {all: [/synthetic\.record/, /key:\s*recipeId/]},
        go: {all: [/synthetic\.record/, /Key:\s*\[\]byte\(recipeID\)/]},
        scala: {all: [/synthetic\.record/, /"synthetic\.record",\s*recipeId/]},
        cpp: {all: [/synthetic\.record/, /recipeId\.c_str\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` plus acks, KafkaJS\u2019s `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer. A retried produce must not duplicate an admission.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'digest-only',
      title: 'Carries digests and scores, never generated content',
      detail:
        'The event carries `seed_digest` and `judge_score`; the generated text, the seed text and any other content stay out of the payload and the logs. The draft copies the generated content into a retained topic.',
      match: {
        python: {all: [/seed_digest/, /judge_score/], none: [/generated_text|seed_text|record_text/]},
        typescript: {all: [/seed_digest/, /judge_score/], none: [/generated_text|seed_text|record_text/]},
        go: {all: [/SeedDigest/, /JudgeScore/], none: [/GeneratedText|SeedText|RecordText/]},
        scala: {all: [/SeedDigest/, /JudgeScore/], none: [/GeneratedText|SeedText|RecordText/]},
        cpp: {all: [/seed_digest/, /judge_score/], none: [/generated_text|seed_text|record_text/]},
      },
    },
    {
      id: 'digest-of-seed',
      title: 'Computes the seed digest from the seed record',
      detail:
        '`seed_digest` is the sha256 of the seed record the generated record came from, computed at publish time, so an admitted record resolves back to a seed without the seed text travelling. The draft has no digest at all.',
      match: {
        python: {all: [/sha256/, /seed_digest/]},
        typescript: {all: [/createHash\(/, /seed_digest/]},
        go: {all: [/sha256\.Sum256/, /SeedDigest/]},
        scala: {all: [/MessageDigest|sha256/, /SeedDigest/]},
        cpp: {all: [/sha256_hex|SHA256/, /seed_digest/]},
      },
    },
    {
      id: 'persist-before-publish',
      title: 'Persists the admission before publishing it',
      detail:
        '`admissions.put(record)` runs before the produce, so an event never describes a record that was not stored. The draft announces the admission and never persists it.',
      match: {
        python: {order: [/admissions\.put\(/, /producer\.produce\(/]},
        typescript: {order: [/admissions\.put\(/, /producer\.send\(/]},
        go: {order: [/admissions\.Put\(/, /producer\.WriteMessages\(/]},
        scala: {order: [/admissions\.put\(/, /producer\.send\(/]},
        cpp: {order: [/admissions\.put\(/, /producer\.produce\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""publish_admission: a model-generated draft that keys by record id and ships the content."""
import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("synthd")

producer = Producer({"bootstrap.servers": "kafka:9092"})

TOPIC = "synthetic.record"


def publish_admission(record: dict) -> None:
    # TODO: this draft keys the event by the record id instead of the recipe id, copies the generated
    # content into the payload and the logs, carries no seed digest and no judge score, and announces
    # the admission before the record is persisted. The producer has no idempotence and no delivery
    # guarantee.
    logger.info("admitted record_id=%s generated=%r", record["record_id"], record["generated_text"])
    event = {
        "record_id": record["record_id"],
        "job_id": record["job_id"],
        "entity_id": record["entity_id"],
        "generated_text": record["generated_text"],
    }
    producer.produce(TOPIC, key=record["record_id"], value=json.dumps(event))
    producer.flush()
`,
      solution: `"""publish_admission: persist the admission, then publish one recipe-keyed event with digests."""
import hashlib
import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("synthd")

# Idempotent producer with acks=all: a retried produce cannot duplicate an admission.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)

TOPIC = "synthetic.record"


class AdmissionStore:
    def put(self, record: dict) -> None:
        """One durable row per admission; the event is published only afterwards."""
        raise NotImplementedError


admissions = AdmissionStore()


def publish_admission(record: dict) -> None:
    admissions.put(record)
    event = {
        "record_id": record["record_id"],
        "recipe_id": record["recipe_id"],
        "job_id": record["job_id"],
        "entity_id": record["entity_id"],
        "seed_digest": hashlib.sha256(record["seed"].encode("utf-8")).hexdigest(),
        "judge_score": record["judge_score"],
    }
    producer.produce(TOPIC, key=record["recipe_id"], value=json.dumps(event))
    producer.flush(2.0)
    logger.info("admitted record_id=%s recipe_id=%s", record["record_id"], record["recipe_id"])
`,
    },
    typescript: {
      starter: `/** synthetic.record: a model-generated draft that keys by record id and ships the content. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'synthd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface GeneratedRecord {
  record_id: string;
  job_id: string;
  entity_id: string;
  generated_text: string;
}

export async function publishAdmission(record: GeneratedRecord): Promise<void> {
  // TODO: this draft keys the event by the record id instead of the recipe id, copies the generated
  // content into the payload and the logs, carries no seed digest and no judge score, and announces
  // the admission before the record is persisted. The producer has no idempotence and no delivery
  // guarantee.
  console.log('admitted', record.record_id, record.generated_text);
  const event = {
    record_id: record.record_id,
    job_id: record.job_id,
    entity_id: record.entity_id,
    generated_text: record.generated_text,
  };
  await producer.send({
    topic: 'synthetic.record',
    messages: [{key: record.record_id, value: JSON.stringify(event)}],
  });
}
`,
      solution: `/** publish_admission: persist the admission, then publish one recipe-keyed event with digests. */
import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'synthd', brokers: ['kafka:9092']});
// Idempotent producer with acks=all: a retried produce cannot duplicate an admission.
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface GeneratedRecord {
  record_id: string;
  recipe_id: string;
  job_id: string;
  entity_id: string;
  seed: string;
  judge_score: number;
}

class AdmissionStore {
  /** One durable row per admission; the event is published only afterwards. */
  async put(record: GeneratedRecord): Promise<void> {
    throw new Error('not implemented');
  }
}

const admissions = new AdmissionStore();

export async function publishAdmission(record: GeneratedRecord): Promise<void> {
  await admissions.put(record);
  const recipeId = record.recipe_id;
  const event = {
    record_id: record.record_id,
    recipe_id: recipeId,
    job_id: record.job_id,
    entity_id: record.entity_id,
    seed_digest: createHash('sha256').update(record.seed, 'utf8').digest('hex'),
    judge_score: record.judge_score,
  };
  await producer.send({
    topic: 'synthetic.record',
    acks: -1,
    messages: [{key: recipeId, value: JSON.stringify(event)}],
  });
  console.log('admitted', record.record_id, recipeId);
}
`,
    },
    go: {
      starter: `// synthetic.record: a model-generated draft that keys by record id and ships the content.
package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const syntheticRecordTopic = "synthetic.record"

var producer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: syntheticRecordTopic}

type GeneratedRecord struct {
	RecordID      string \`json:"record_id"\`
	JobID         string \`json:"job_id"\`
	EntityID      string \`json:"entity_id"\`
	GeneratedText string \`json:"generated_text"\`
}

func publishAdmission(ctx context.Context, record GeneratedRecord) error {
	// TODO: this draft keys the event by the record id instead of the recipe id, copies the generated
	// content into the payload and the logs, carries no seed digest and no judge score, and announces
	// the admission before the record is persisted. The writer has no idempotence and no delivery
	// guarantee.
	log.Printf("admitted record_id=%s generated=%q", record.RecordID, record.GeneratedText)
	payload, _ := json.Marshal(map[string]any{
		"record_id":      record.RecordID,
		"job_id":         record.JobID,
		"entity_id":      record.EntityID,
		"generated_text": record.GeneratedText,
	})
	return producer.WriteMessages(ctx, kafka.Message{Topic: syntheticRecordTopic, Key: []byte(record.RecordID), Value: payload})
}
`,
      solution: `// publish_admission: persist the admission, then publish one recipe-keyed event with digests.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const syntheticRecordTopic = "synthetic.record"

// Idempotent writer with required acks and a hash balancer: the recipe id is the message key, so one
// recipe's admissions share a partition and a retried produce cannot duplicate an admission.
var producer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        syntheticRecordTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type GeneratedRecord struct {
	RecordID   string  \`json:"record_id"\`
	RecipeID   string  \`json:"recipe_id"\`
	JobID      string  \`json:"job_id"\`
	EntityID   string  \`json:"entity_id"\`
	Seed       string  \`json:"seed"\`
	JudgeScore float64 \`json:"judge_score"\`
}

type AdmissionStore struct{}

func (s *AdmissionStore) Put(ctx context.Context, record GeneratedRecord) error {
	return nil
}

var admissions = &AdmissionStore{}

type admissionEvent struct {
	RecordID   string  \`json:"record_id"\`
	RecipeID   string  \`json:"recipe_id"\`
	JobID      string  \`json:"job_id"\`
	EntityID   string  \`json:"entity_id"\`
	SeedDigest string  \`json:"seed_digest"\`
	JudgeScore float64 \`json:"judge_score"\`
}

func publishAdmission(ctx context.Context, record GeneratedRecord) error {
	recipeID := record.RecipeID
	if err := admissions.Put(ctx, record); err != nil {
		return err
	}
	sum := sha256.Sum256([]byte(record.Seed))
	event := admissionEvent{
		RecordID:   record.RecordID,
		RecipeID:   recipeID,
		JobID:      record.JobID,
		EntityID:   record.EntityID,
		SeedDigest: hex.EncodeToString(sum[:]),
		JudgeScore: record.JudgeScore,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := producer.WriteMessages(ctx, kafka.Message{Topic: syntheticRecordTopic, Key: []byte(recipeID), Value: payload}); err != nil {
		return err
	}
	log.Printf("admitted record_id=%s recipe_id=%s", record.RecordID, recipeID)
	return nil
}
`,
    },
    scala: {
      starter: `// synthetic.record: a model-generated draft that keys by record id and ships the content.
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class GeneratedRecord(
    record_id: String,
    job_id: String,
    entity_id: String,
    generated_text: String
)

object Records {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def publishAdmission(record: GeneratedRecord): Unit = {
    // TODO: this draft keys the event by the record id instead of the recipe id, copies the generated
    // content into the payload and the logs, carries no seed digest and no judge score, and announces
    // the admission before the record is persisted. The producer has no idempotence and no delivery
    // guarantee.
    println(s"admitted record_id=\${record.record_id} generated=\${record.generated_text}")
    val payload =
      s"""{"record_id":"\${record.record_id}","job_id":"\${record.job_id}","entity_id":"\${record.entity_id}","generated_text":"\${record.generated_text}"}"""
    producer.send(new ProducerRecord[String, String]("synthetic.record", record.record_id, payload))
  }
}
`,
      solution: `// publish_admission: persist the admission, then publish one recipe-keyed event with digests.
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class GeneratedRecord(
    record_id: String,
    recipe_id: String,
    job_id: String,
    entity_id: String,
    seed: String,
    judge_score: Double
)

// The event as it goes on the wire: ids plus the digest and the score, never the generated content.
final case class AdmissionEvent(
    record_id: String,
    recipe_id: String,
    job_id: String,
    entity_id: String,
    SeedDigest: String,
    JudgeScore: Double
)

class AdmissionStore {
  // One durable row per admission; the event is published only afterwards.
  def put(record: GeneratedRecord): Unit = ()
}

object Records {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  val admissions = new AdmissionStore()

  def sha256Hex(seed: String): String = {
    val digest = MessageDigest.getInstance("SHA-256")
    digest.digest(seed.getBytes(StandardCharsets.UTF_8)).map(byte => "%02x".format(byte)).mkString
  }

  def publishAdmission(record: GeneratedRecord): Unit = {
    admissions.put(record)
    val recipeId = record.recipe_id
    val event = AdmissionEvent(
        record.record_id,
        recipeId,
        record.job_id,
        record.entity_id,
        sha256Hex(record.seed),
        record.judge_score
    )
    val payload =
      s"""{"record_id":"\${event.record_id}","recipe_id":"\${event.recipe_id}","job_id":"\${event.job_id}","entity_id":"\${event.entity_id}","seed_digest":"\${event.SeedDigest}","judge_score":\${event.JudgeScore}}"""
    producer.send(new ProducerRecord[String, String]("synthetic.record", recipeId, payload))
    producer.flush()
    println(s"admitted record_id=\${record.record_id} recipe_id=$recipeId")
  }
}
`,
    },
    cpp: {
      starter: `// synthetic.record: a model-generated draft that keys by record id and ships the content.
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

constexpr const char* kRecordTopic = "synthetic.record";

struct GeneratedRecord {
  std::string record_id;
  std::string job_id;
  std::string entity_id;
  std::string generated_text;
};

void publishAdmission(RdKafka::Producer& producer, const GeneratedRecord& record) {
  // TODO: this draft keys the event by the record id instead of the recipe id, copies the generated
  // content into the payload and the logs, carries no seed digest and no judge score, and announces
  // the admission before the record is persisted. The producer has no idempotence and no delivery
  // guarantee.
  const auto payload = json{{"record_id", record.record_id},
                            {"job_id", record.job_id},
                            {"entity_id", record.entity_id},
                            {"generated_text", record.generated_text}}
                           .dump();
  std::cerr << "admitted record_id=" << record.record_id << " generated=" << record.generated_text << "\\n";
  const auto recordId = record.record_id;
  producer.produce(kRecordTopic,
                   RdKafka::Topic::PARTITION_UA,
                   RdKafka::Producer::RK_MSG_COPY,
                   const_cast<char*>(payload.c_str()),
                   payload.size(),
                   recordId.c_str(),
                   recordId.size(),
                   0,
                   nullptr);
}
`,
      solution: `// publish_admission: persist the admission, then publish one recipe-keyed event with digests.
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

constexpr const char* kRecordTopic = "synthetic.record";

struct GeneratedRecord {
  std::string record_id;
  std::string recipe_id;
  std::string job_id;
  std::string entity_id;
  std::string seed;
  double judge_score = 0.0;
};

struct AdmissionStore {
  // One durable row per admission; the event is published only afterwards.
  void put(const GeneratedRecord& record);
};

AdmissionStore admissions;

// sha256 of the seed record this admission was generated from.
std::string sha256_hex(const std::string& value);

// Idempotent producer with acks=all: a retried produce cannot duplicate an admission. The worker
// owns the handle; the publish path uses it by reference.
RdKafka::Producer* makeProducer() {
  std::string errstr;
  static auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("enable.idempotence", "true", errstr);
  conf->set("acks", "all", errstr);
  return RdKafka::Producer::create(conf.get(), errstr);
}

void publishAdmission(RdKafka::Producer& producer, const GeneratedRecord& record) {
  admissions.put(record);
  const auto recipeId = record.recipe_id;
  const auto payload = json{{"record_id", record.record_id},
                            {"recipe_id", recipeId},
                            {"job_id", record.job_id},
                            {"entity_id", record.entity_id},
                            {"seed_digest", sha256_hex(record.seed)},
                            {"judge_score", record.judge_score}}
                           .dump();
  producer.produce(kRecordTopic,
                   RdKafka::Topic::PARTITION_UA,
                   RdKafka::Producer::RK_MSG_COPY,
                   const_cast<char*>(payload.c_str()),
                   payload.size(),
                   recipeId.c_str(),
                   recipeId.size(),
                   0,
                   nullptr);
  producer.flush(2000);
  std::cerr << "admitted record_id=" << record.record_id << " recipe_id=" << recipeId << "\\n";
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can tell a transport detail from a contract. The key looks like a performance knob and is actually the ordering guarantee a downstream consumer builds on; keying by record id works perfectly in a single-worker demo and silently reshuffles a recipe's history in production. The digest is the same kind of decision on the other axis: provenance needs a fingerprint, not the payload, because the topic is retained, replicated and read by people who were never licensed to see the seed. Persist-before-publish is the ordering every event pipeline eventually has to learn — publish first and the event becomes a claim about a record that may not survive the next crash. Real platforms add an outbox for broker outages, a schema registry that rejects content fields, and a replayer that rebuilds coverage from the topic.`,
};
