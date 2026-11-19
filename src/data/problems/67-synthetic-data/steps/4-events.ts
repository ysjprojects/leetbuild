import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Admitted records on synthetic.record, keyed by recipe',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter's \`publish_admission(record, score, judge_version)\` takes an admitted
\`SyntheticRecord\` and produces a JSON event to \`synthetic.record\` with the record, job, recipe and
entity ids, \`seed_digest(record.text)\`, the score, the judge version and the generated text, keyed by
the record id, from a default producer; it logs the text, writes the provided \`outbox\` when
\`produce\` raises, and returns True. The demo shows events reaching the curation consumer. It hides 5
flaws.

**Failure mode the checks target.** Keyed by record, one recipe's records spread across partitions and
lose their order. A digest of the generated text points at nothing a reviewer can look up. Content on a
retained topic outlives every deletion request. A lost acknowledgement writes the event twice, and a
broker's refusal arrives in the delivery report, after \`produce\` has returned, so the outbox never sees
it.

- The event is **keyed by \`recipe_id\`**.
- \`seed_digest\` is the SHA-256 of the **seed** (\`seed_digest(record.seed_text)\`); the event carries
  \`record_id\`, \`job_id\`, \`recipe_id\`, \`entity_id\`, \`seed_digest\`, \`judge_score\`, \`judge_version\`.
- No generated or seed text in the event, the outbox row or a log line.
- The producer is **idempotent with \`acks=all\`** (Go: confluent-kafka-go, which has idempotence).
- Wait for the delivery report, at most 2 s; a failed or missing one writes the event to the outbox
  and returns False.`,
  sequence: {
    participants: ['Worker', 'synthetic.record', 'outbox'],
    messages: [
      {
        from: 'Worker',
        to: 'synthetic.record',
        label: 'produce key=recipe_id {ids, seed_digest, judge_score, judge_version}',
        kind: 'async',
      },
      {from: 'synthetic.record', to: 'Worker', label: 'delivery report: error', kind: 'reply'},
      {from: 'Worker', to: 'outbox', label: 'insert_outbox(event) → False', kind: 'async'},
    ],
  },
  hints: [
    "Symptom: the consumer sees one recipe's records out of order, a reviewer cannot match a record's digest to any seed, the generated text is readable on the topic, a broker hiccup writes duplicates, and a refused event is simply gone.",
    "Mechanism: the key is the record id; the digest hashes `record.text`; the event and the log carry the text; the producer has no idempotence; the `except` wraps `produce`, which only enqueues, so the broker's answer lands in a delivery report nobody reads.",
    'Change: `key=record.recipe_id`, `seed_digest(record.seed_text)`, drop the text from the event and the log, `enable.idempotence` + `acks=all`, an `on_delivery` callback and `flush(ACK_TIMEOUT_S)`; on an error or a timeout, `outbox.insert_outbox(event)` and return False.',
  ],
  checks: [
    {
      id: 'recipe-key',
      title: 'Keys the event by recipe id',
      detail:
        "Every record on synthetic.record is keyed by recipe_id, so one recipe's records share a partition and an order. The starter keys by record id.",
      match: {
        python: {all: [/produce\([^)]*key\s*=\s*record\.recipe_id/], none: [/key\s*=\s*record\.record_id/]},
        typescript: {all: [/key:\s*record\.recipe_id/], none: [/key:\s*record\.record_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*record\.RecipeID\s*\)/], none: [/Key:\s*\[\]byte\(\s*record\.RecordID\s*\)/]},
        scala: {
          all: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*record\.recipe_id\s*,/],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*record\.record_id\s*,/],
        },
        cpp: {all: [/record\.recipe_id\.c_str\(\)/], none: [/record\.record_id\.c_str\(\)/]},
      },
    },
    {
      id: 'seed-digest',
      title: 'Carries the digest of the seed and the judge score',
      detail:
        "seed_digest is the SHA-256 of the seed record's text, beside judge_score, judge_version and the record, job, recipe and entity ids, so an admitted record traces back to its seed. The starter hashes the generated text.",
      match: {
        python: {
          all: [/seed_digest\(\s*record\.seed_text\s*\)/, /judge_score/],
          none: [/seed_digest\(\s*record\.text\s*\)/],
        },
        typescript: {
          all: [/seedDigest\(\s*record\.seed_text\s*\)/, /judge_score/],
          none: [/seedDigest\(\s*record\.text\s*\)/],
        },
        go: {
          all: [/records\.SeedDigest\(\s*record\.SeedText\s*\)/, /judge_score/],
          none: [/SeedDigest\(\s*record\.Text\s*\)/],
        },
        scala: {
          all: [/Records\.seedDigest\(\s*record\.seed_text\s*\)/, /judge_score/],
          none: [/seedDigest\(\s*record\.text\s*\)/],
        },
        cpp: {
          all: [/records::seed_digest\(\s*record\.seed_text\s*\)/, /judge_score/],
          none: [/seed_digest\(\s*record\.text\s*\)/],
        },
      },
    },
    {
      id: 'no-content',
      title: 'No generated or seed text in the event, the outbox or the logs',
      detail:
        'Neither the event, the outbox row nor a log line carries the generated text or the seed text: the topic is retained and replicated, so content written there outlives the record. The starter puts the generated text in the event and the log.',
      match: {
        python: {none: [/\brecord\.text\b/]},
        typescript: {none: [/\brecord\.text\b/]},
        go: {none: [/\brecord\.Text\b/]},
        scala: {none: [/\brecord\.text\b/]},
        cpp: {none: [/\brecord\.text\b/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once. The starter uses a default producer, which writes the retry again.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Writes the outbox from the delivery report',
      detail:
        'A produce the broker refuses leaves the event in the outbox and the call returns false; the refusal is read where the broker answers (the delivery callback, the awaited send, the delivery channel, the send future). A broker that acknowledges after 1 s is waited for and writes no outbox row; one that stops answering costs at most about 2 s and leaves the whole event in the outbox, with false. The starter catches only errors raised by produce itself.',
      match: {
        python: {
          all: [/on_delivery\s*=|callback\s*=/, /outbox\.insert_outbox\(/, /\.flush\(/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/outbox\.insertOutbox\(/, /await\s+producer\.send\(/], none: [/void\s+producer\.send\(/]},
        go: {all: [/outbox\.Insert\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/], none: [/case\s+\w+\s*:\s*KafkaException/]},
        cpp: {all: [/outbox::insert_outbox\(/, /dr_cb/, /->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import KafkaException, Producer

from synth.config import TOPIC
from synth.outbox import outbox
from synth.records import SyntheticRecord, seed_digest

logger = logging.getLogger("synthd.events")

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_admission(record: SyntheticRecord, score: float, judge_version: str) -> bool:
    """Announce one admitted record to the curation consumers; True once the broker has it."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "record_id": record.record_id,
        "job_id": record.job_id,
        "recipe_id": record.recipe_id,
        "entity_id": record.entity_id,
        "seed_digest": seed_digest(record.text),
        "judge_score": score,
        "judge_version": judge_version,
        "text": record.text,
    }
    logger.info("admitted record=%s text=%r", record.record_id, record.text)
    try:
        producer.produce(TOPIC, key=record.record_id, value=json.dumps(event).encode("utf-8"))
        producer.poll(0)
    except KafkaException:
        outbox.insert_outbox(event)
        return False
    return True
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from synth.config import TOPIC
from synth.outbox import outbox
from synth.records import SyntheticRecord, seed_digest

logger = logging.getLogger("synthd.events")

ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the event before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def publish_admission(record: SyntheticRecord, score: float, judge_version: str) -> bool:
    """Announce one admitted record to the curation consumers; True once the broker has it."""
    event = {
        "record_id": record.record_id,
        "job_id": record.job_id,
        "recipe_id": record.recipe_id,
        "entity_id": record.entity_id,
        "seed_digest": seed_digest(record.seed_text),
        "judge_score": score,
        "judge_version": judge_version,
    }
    outcome = {}

    def on_delivery(err, msg) -> None:
        outcome["error"] = err

    producer.produce(TOPIC, key=record.recipe_id, value=json.dumps(event).encode("utf-8"), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay republishes the row later.
        outbox.insert_outbox(event)
        logger.warning("synthetic.record produce failed record=%s recipe=%s: %s", record.record_id, record.recipe_id, outcome.get("error"))
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka, type Producer} from 'kafkajs';

import {TOPIC} from 'synth/config';
import {outbox} from 'synth/outbox';
import {type SyntheticRecord, seedDigest} from 'synth/records';

const kafka = new Kafka({clientId: 'synthd', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer();
void producer.connect();

/** Announce one admitted record to the curation consumers; true once the broker has it. */
export async function publishAdmission(record: SyntheticRecord, score: number, judgeVersion: string): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const event = {
    record_id: record.record_id,
    job_id: record.job_id,
    recipe_id: record.recipe_id,
    entity_id: record.entity_id,
    seed_digest: seedDigest(record.text),
    judge_score: score,
    judge_version: judgeVersion,
    text: record.text,
  };
  console.log(\`admitted record=\${record.record_id} text=\${JSON.stringify(record.text)}\`);
  try {
    void producer.send({topic: TOPIC, messages: [{key: record.record_id, value: JSON.stringify(event)}]});
  } catch {
    await outbox.insertOutbox(event);
    return false;
  }
  return true;
}
`,
      solution: `import {Kafka, type Producer} from 'kafkajs';

import {TOPIC} from 'synth/config';
import {outbox} from 'synth/outbox';
import {type SyntheticRecord, seedDigest} from 'synth/records';

export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'synthd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer: Producer = kafka.producer({idempotent: true});
void producer.connect();

/** Announce one admitted record to the curation consumers; true once the broker has it. */
export async function publishAdmission(record: SyntheticRecord, score: number, judgeVersion: string): Promise<boolean> {
  const event = {
    record_id: record.record_id,
    job_id: record.job_id,
    recipe_id: record.recipe_id,
    entity_id: record.entity_id,
    seed_digest: seedDigest(record.seed_text),
    judge_score: score,
    judge_version: judgeVersion,
  };
  try {
    // acks: -1 (all): every in-sync replica has the event before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: record.recipe_id, value: JSON.stringify(event)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    // The broker did not take it: the relay republishes the row later.
    await outbox.insertOutbox(event);
    console.warn(\`synthetic.record produce failed record=\${record.record_id} recipe=\${record.recipe_id}: \${(err as Error).message}\`);
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
	"log"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"synth/config"  // config.Topic — provided
	"synth/outbox"  // outbox.Insert(ctx, eventJSON) — provided
	"synth/records" // records.SyntheticRecord, records.SeedDigest — provided
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

// publishAdmission announces one admitted record to the curation consumers; true once the broker has it.
func publishAdmission(ctx context.Context, record records.SyntheticRecord, score float64, judgeVersion string) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	event, _ := json.Marshal(map[string]any{
		"record_id":     record.RecordID,
		"job_id":        record.JobID,
		"recipe_id":     record.RecipeID,
		"entity_id":     record.EntityID,
		"seed_digest":   records.SeedDigest(record.Text),
		"judge_score":   score,
		"judge_version": judgeVersion,
		"text":          record.Text,
	})
	log.Printf("admitted record=%s text=%q", record.RecordID, record.Text)
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(record.RecordID), Value: event}
	if err := producer.Produce(msg, nil); err != nil {
		if err := outbox.Insert(ctx, event); err != nil {
			return false, err
		}
		return false, nil
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

	"synth/config"  // config.Topic — provided
	"synth/outbox"  // outbox.Insert(ctx, eventJSON) — provided
	"synth/records" // records.SyntheticRecord, records.SeedDigest — provided
)

const ackTimeout = 2 * time.Second

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the event before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

type recordEvent struct {
	RecordID     string  \`json:"record_id"\`
	JobID        string  \`json:"job_id"\`
	RecipeID     string  \`json:"recipe_id"\`
	EntityID     string  \`json:"entity_id"\`
	SeedDigest   string  \`json:"seed_digest"\`
	JudgeScore   float64 \`json:"judge_score"\`
	JudgeVersion string  \`json:"judge_version"\`
}

// publishAdmission announces one admitted record to the curation consumers; true once the broker has it.
func publishAdmission(ctx context.Context, record records.SyntheticRecord, score float64, judgeVersion string) (bool, error) {
	event, _ := json.Marshal(recordEvent{
		RecordID:     record.RecordID,
		JobID:        record.JobID,
		RecipeID:     record.RecipeID,
		EntityID:     record.EntityID,
		SeedDigest:   records.SeedDigest(record.SeedText),
		JudgeScore:   score,
		JudgeVersion: judgeVersion,
	})
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(record.RecipeID), Value: event}
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
		// The broker did not take it: the relay republishes the row later.
		log.Printf("synthetic.record produce failed record=%s recipe=%s: %v", record.RecordID, record.RecipeID, err)
		if err := outbox.Insert(ctx, event); err != nil {
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
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer

import synth.{Config, Outbox, Records, SyntheticRecord}

object RecordEvents {
  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Announce one admitted record to the curation consumers; true once the broker has it. */
  def publishAdmission(record: SyntheticRecord, score: Double, judgeVersion: String): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val event = ujson.write(
      ujson.Obj(
        "record_id" -> record.record_id,
        "job_id" -> record.job_id,
        "recipe_id" -> record.recipe_id,
        "entity_id" -> record.entity_id,
        "seed_digest" -> Records.seedDigest(record.text),
        "judge_score" -> score,
        "judge_version" -> judgeVersion,
        "text" -> record.text
      )
    )
    System.err.println(s"admitted record=\${record.record_id} text=\${record.text}")
    try {
      producer.send(new ProducerRecord[String, String](Config.Topic, record.record_id, event))
      true
    } catch {
      case _: KafkaException =>
        Outbox.insertOutbox(event)
        false
    }
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import synth.{Config, Outbox, Records, SyntheticRecord}

object RecordEvents {
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the event before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Announce one admitted record to the curation consumers; true once the broker has it. */
  def publishAdmission(record: SyntheticRecord, score: Double, judgeVersion: String): Boolean = {
    val event = ujson.write(
      ujson.Obj(
        "record_id" -> record.record_id,
        "job_id" -> record.job_id,
        "recipe_id" -> record.recipe_id,
        "entity_id" -> record.entity_id,
        "seed_digest" -> Records.seedDigest(record.seed_text),
        "judge_score" -> score,
        "judge_version" -> judgeVersion
      )
    )
    val sent = new ProducerRecord[String, String](Config.Topic, record.recipe_id, event)
    val acked = Try(producer.send(sent).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay republishes the row later.
      Outbox.insertOutbox(event)
      System.err.println(s"synthetic.record produce failed record=\${record.record_id}: \${acked.failed.get.getMessage}")
    }
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "synth/config.h"   // config::kTopic — provided
#include "synth/outbox.h"   // outbox::insert_outbox(event_json) — provided
#include "synth/records.h"  // records::SyntheticRecord, records::seed_digest — provided

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Announce one admitted record to the curation consumers; true once the broker has it.
bool publish_admission(const records::SyntheticRecord& record, double score, const std::string& judge_version) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string event = nlohmann::json{{"record_id", record.record_id},
                                           {"job_id", record.job_id},
                                           {"recipe_id", record.recipe_id},
                                           {"entity_id", record.entity_id},
                                           {"seed_digest", records::seed_digest(record.text)},
                                           {"judge_score", score},
                                           {"judge_version", judge_version},
                                           {"text", record.text}}
                                .dump();
  std::cerr << "admitted record=" << record.record_id << " text=" << record.text << "\\n";
  const RdKafka::ErrorCode err =
      producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                        event.size(), record.record_id.c_str(), record.record_id.size(), 0, nullptr);
  producer->poll(0);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox::insert_outbox(event);
    return false;
  }
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "synth/config.h"   // config::kTopic — provided
#include "synth/outbox.h"   // outbox::insert_outbox(event_json) — provided
#include "synth/records.h"  // records::SyntheticRecord, records::seed_digest — provided

constexpr int kAckTimeoutMs = 2000;

// The delivery report of the event in flight: publish_admission produces one event and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the event before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Announce one admitted record to the curation consumers; true once the broker has it.
bool publish_admission(const records::SyntheticRecord& record, double score, const std::string& judge_version) {
  const std::string event = nlohmann::json{{"record_id", record.record_id},
                                           {"job_id", record.job_id},
                                           {"recipe_id", record.recipe_id},
                                           {"entity_id", record.entity_id},
                                           {"seed_digest", records::seed_digest(record.seed_text)},
                                           {"judge_score", score},
                                           {"judge_version", judge_version}}
                                .dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                        event.size(), record.recipe_id.c_str(), record.recipe_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay republishes the row later.
    outbox::insert_outbox(event);
    std::cerr << "synthetic.record produce failed record=" << record.record_id << ": " << RdKafka::err2str(err) << "\\n";
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json
import logging

from synth.records import SyntheticRecord

TOPIC = "synthetic.record"
SEED = "Marie Curie won Nobel Prizes in physics and in chemistry."
TEXT = "Q: In which two sciences did Marie Curie win a Nobel Prize? A: Physics and chemistry."
VERSION = "judge-rm-2026.10"


def _record(n, recipe="qa-pairs"):
    return SyntheticRecord(record_id=f"r-{n}", job_id="j1", recipe_id=recipe, entity_id="e-curie", seq=n, seed_text=SEED, text=TEXT)


def _settle(m):
    """Serve delivery reports a starter left queued, as the worker's loop would between records."""
    if hasattr(m, "producer"):
        m.producer.poll(0)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("synth:outbox", 0, -1)]


def check_recipe_key(ctx):
    m = ctx.load("events")
    for n, recipe in ((1, "qa-pairs"), (2, "summaries"), (3, "qa-pairs")):
        m.publish_admission(_record(n, recipe), 0.87, VERSION)
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three admissions produced {len(records)} records on {TOPIC}"
    keys = sorted(r.key for r in records)
    assert keys == [b"qa-pairs", b"qa-pairs", b"summaries"], f"records must be keyed by recipe id, got {keys}: keyed by record, one recipe's records scatter across partitions"
    assert len({r.partition for r in records if r.key == b"qa-pairs"}) == 1, "one recipe must land on one partition so its records keep their order"


def check_seed_digest(ctx):
    m = ctx.load("events")
    m.publish_admission(_record(1), 0.87, VERSION)
    _settle(m)
    events = _events(ctx)
    assert len(events) == 1, f"one admission produced {len(events)} records"
    event = events[0]
    seed = hashlib.sha256(SEED.encode()).hexdigest()
    if event.get("seed_digest") == hashlib.sha256(TEXT.encode()).hexdigest():
        raise AssertionError("seed_digest is the SHA-256 of the generated text: a reviewer cannot trace that to any seed; hash record.seed_text")
    expected = {"record_id": "r-1", "job_id": "j1", "recipe_id": "qa-pairs", "entity_id": "e-curie", "seed_digest": seed, "judge_score": 0.87, "judge_version": VERSION}
    for key, value in expected.items():
        assert event.get(key) == value, f"the event must carry {key}={value!r}, got {event}"


def check_no_content(ctx):
    class Capture(logging.Handler):
        def __init__(self):
            super().__init__()
            self.lines = []

        def emit(self, record):
            self.lines.append(record.getMessage())

    capture = Capture()
    logging.getLogger().addHandler(capture)
    try:
        m = ctx.load("events")
        ctx.kafka.fail_next(TOPIC, 1)
        m.publish_admission(_record(1), 0.87, VERSION)
        m.publish_admission(_record(2), 0.87, VERSION)
        _settle(m)
    finally:
        logging.getLogger().removeHandler(capture)
    for value in ctx.kafka.values(TOPIC):
        assert b"Marie Curie" not in value, f"the event carries generated or seed text: {value!r}; the topic is retained and replicated, ids and digests only"
    for row in ctx.redis.lrange("synth:outbox", 0, -1):
        assert "Marie Curie" not in row, f"the outbox row carries generated or seed text: {row}"
    for line in capture.lines:
        assert "Marie Curie" not in line, f"a log line carries generated or seed text: {line!r}"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_admission(_record(1), 0.87, VERSION)
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        result = m.publish_admission(_record(1), 0.87, VERSION)
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"publish_admission raised when the broker refused the event: {e!r}; the event goes to the outbox, the worker goes on") from e
    _settle(m)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused one event and the outbox holds {len(rows)} rows: the refusal arrives in the delivery report, after produce returned"
    assert rows[0].get("record_id") == "r-1" and rows[0].get("recipe_id") == "qa-pairs", f"the outbox row must be the event itself, got {rows[0]}"
    assert result is False, f"publish_admission returned {result!r} for an event the broker refused, expected False"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused event"
    assert m.publish_admission(_record(2), 0.87, VERSION) is True, "a healthy produce returns True once the broker acknowledged it"
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(_outbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row"
    ctx.kafka.stall(TOPIC, seconds=1.0)
    assert m.publish_admission(_record(3), 0.87, VERSION) is True, "a broker that acknowledges after 1 s is within the 2 s window: the call waits for the report and returns True"
    assert len(ctx.kafka.records(TOPIC)) == 2 and len(_outbox(ctx)) == 1, f"an event acknowledged within the window reaches the topic and writes no outbox row (the relay would publish it twice): the topic holds {len(ctx.kafka.records(TOPIC))} records, the outbox {len(_outbox(ctx))} rows"
    ctx.kafka.stall(TOPIC)
    started = ctx.clock.offset
    result = m.publish_admission(_record(4), 0.87, VERSION)
    waited = ctx.clock.offset - started
    assert waited <= 2.5, f"the broker stopped answering and publish_admission waited {waited:.1f} s: the delivery report gets at most 2 s"
    assert result is False, f"no delivery report within 2 s and publish_admission returned {result!r}, expected False"
    rows = _outbox(ctx)
    expected = {"record_id": "r-4", "job_id": "j1", "recipe_id": "qa-pairs", "entity_id": "e-curie", "seed_digest": hashlib.sha256(SEED.encode()).hexdigest(), "judge_score": 0.87, "judge_version": VERSION}
    assert len(rows) == 2 and all(rows[-1].get(k) == v for k, v in expected.items()), f"a missing delivery report writes the whole event to the outbox like a refused one: the outbox holds {rows}"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'synthetic.record';
const SEED = 'Marie Curie won Nobel Prizes in physics and in chemistry.';
const TEXT = 'Q: In which two sciences did Marie Curie win a Nobel Prize? A: Physics and chemistry.';
const VERSION = 'judge-rm-2026.10';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const record = (n: number, recipe = 'qa-pairs') => ({
  record_id: \`r-\${n}\`, job_id: 'j1', recipe_id: recipe, entity_id: 'e-curie', seq: n, seed_text: SEED, text: TEXT,
});
const events = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));
const outboxRows = ctx => ctx.redis.lrange('synth:outbox', 0, -1).map(row => JSON.parse(row));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export async function check_recipe_key(ctx) {
  const m = ctx.load('events');
  for (const [n, recipe] of [[1, 'qa-pairs'], [2, 'summaries'], [3, 'qa-pairs']] as const) await m.publishAdmission(record(n, recipe), 0.87, VERSION);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three admissions produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null).sort();
  assert.deepEqual(keys, ['qa-pairs', 'qa-pairs', 'summaries'], \`records must be keyed by recipe id, got \${JSON.stringify(keys)}: keyed by record, one recipe's records scatter across partitions\`);
  assert.equal(new Set(records.filter(r => r.key?.toString() === 'qa-pairs').map(r => r.partition)).size, 1, "one recipe must land on one partition so its records keep their order");
}

export async function check_seed_digest(ctx) {
  const m = ctx.load('events');
  await m.publishAdmission(record(1), 0.87, VERSION);
  await settle();
  const all = events(ctx);
  assert.equal(all.length, 1, \`one admission produced \${all.length} records\`);
  assert.notEqual(all[0].seed_digest, sha(TEXT), 'seed_digest is the SHA-256 of the generated text: a reviewer cannot trace that to any seed; hash record.seed_text');
  const expected = {record_id: 'r-1', job_id: 'j1', recipe_id: 'qa-pairs', entity_id: 'e-curie', seed_digest: sha(SEED), judge_score: 0.87, judge_version: VERSION};
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(all[0][key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${JSON.stringify(all[0])}\`);
}

export async function check_no_content(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  await m.publishAdmission(record(1), 0.87, VERSION);
  await m.publishAdmission(record(2), 0.87, VERSION);
  await settle();
  for (const value of ctx.kafka.values(TOPIC)) assert(!value.includes('Marie Curie'), \`the event carries generated or seed text: \${value}; the topic is retained and replicated, ids and digests only\`);
  for (const row of ctx.redis.lrange('synth:outbox', 0, -1)) assert(!row.includes('Marie Curie'), \`the outbox row carries generated or seed text: \${row}\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishAdmission(record(1), 0.87, VERSION);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let result;
  try {
    result = await m.publishAdmission(record(1), 0.87, VERSION);
  } catch (e) {
    assert.fail(\`publishAdmission rejected when the broker refused the event: \${e}; the event goes to the outbox, the worker goes on\`);
  }
  await settle();
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused one event and the outbox holds \${rows.length} rows: the refusal arrives with the send's result, not as an exception from the call that started it\`);
  assert(rows[0].record_id === 'r-1' && rows[0].recipe_id === 'qa-pairs', \`the outbox row must be the event itself, got \${JSON.stringify(rows[0])}\`);
  assert.equal(result, false, \`publishAdmission resolved \${JSON.stringify(result)} for an event the broker refused, expected false\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused event');
  assert.equal(await m.publishAdmission(record(2), 0.87, VERSION), true, 'a healthy produce resolves true once the broker acknowledged it');
  assert(ctx.kafka.records(TOPIC).length === 1 && outboxRows(ctx).length === 1, 'a healthy produce after the failure reaches the topic and adds no outbox row');
  ctx.kafka.stall(TOPIC, 1.0);
  assert.equal(await m.publishAdmission(record(3), 0.87, VERSION), true, 'a broker that acknowledges after 1 s is within the 2 s window: the call waits for the acknowledgement and resolves true');
  await settle();
  assert(ctx.kafka.records(TOPIC).length === 2 && outboxRows(ctx).length === 1, \`an event acknowledged within the window reaches the topic and writes no outbox row (the relay would publish it twice): the topic holds \${ctx.kafka.records(TOPIC).length} records, the outbox \${outboxRows(ctx).length} rows\`);
  ctx.kafka.stall(TOPIC);
  const started = ctx.clock.now();
  const late = await m.publishAdmission(record(4), 0.87, VERSION);
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 2.5, \`the broker stopped answering and publishAdmission waited \${waited.toFixed(1)} s: the acknowledgement gets at most 2 s\`);
  assert.equal(late, false, \`no acknowledgement within 2 s and publishAdmission resolved \${JSON.stringify(late)}, expected false\`);
  await settle();
  const all = outboxRows(ctx);
  const expected = {record_id: 'r-4', job_id: 'j1', recipe_id: 'qa-pairs', entity_id: 'e-curie', seed_digest: sha(SEED), judge_score: 0.87, judge_version: VERSION};
  assert(all.length === 2 && Object.entries(expected).every(([k, v]) => all[1][k] === v), \`a missing acknowledgement writes the whole event to the outbox like a refused one: the outbox holds \${JSON.stringify(all)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"synth/records"

	"leetbuild/harness"
)

const (
	kHEventsTopic   = "synthetic.record"
	kHEventsSeed    = "Marie Curie won Nobel Prizes in physics and in chemistry."
	kHEventsText    = "Q: In which two sciences did Marie Curie win a Nobel Prize? A: Physics and chemistry."
	kHEventsVersion = "judge-rm-2026.10"
)

func hEventsRecord(n int, recipe string) records.SyntheticRecord {
	return records.SyntheticRecord{RecordID: "r-" + strconv.Itoa(n), JobID: "j1", RecipeID: recipe, EntityID: "e-curie", Seq: n, SeedText: kHEventsSeed, Text: kHEventsText}
}

func hEventsPublish(ctx *harness.Ctx, r records.SyntheticRecord) bool {
	ok, err := publishAdmission(context.Background(), r, 0.87, kHEventsVersion)
	ctx.NoError(err, "publishAdmission(%s)", r.RecordID)
	return ok
}

func hEventsAll(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, v := range ctx.Kafka.Values(kHEventsTopic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(v), &e), "the event is JSON: %s", v)
		out = append(out, e)
	}
	return out
}

func hEventsOutbox(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, row := range ctx.Redis.LRange("synth:outbox", 0, -1) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(row), &e), "the outbox row is JSON: %s", row)
		out = append(out, e)
	}
	return out
}

func CheckRecipeKey(ctx *harness.Ctx) {
	hEventsPublish(ctx, hEventsRecord(1, "qa-pairs"))
	hEventsPublish(ctx, hEventsRecord(2, "summaries"))
	hEventsPublish(ctx, hEventsRecord(3, "qa-pairs"))
	ctx.Settle()
	recs := ctx.Kafka.Records(kHEventsTopic)
	ctx.Equal(len(recs), 3, "three admissions must produce three records on %s; the records", kHEventsTopic)
	keys := ctx.Kafka.Keys(kHEventsTopic)
	sort.Strings(keys)
	ctx.Equal(keys, []string{"qa-pairs", "qa-pairs", "summaries"}, "records must be keyed by recipe id (keyed by record, one recipe's records scatter across partitions)")
	parts := map[int]bool{}
	for _, r := range recs {
		if string(r.Key) == "qa-pairs" {
			parts[r.Partition] = true
		}
	}
	ctx.Equal(len(parts), 1, "one recipe must land on one partition so its records keep their order; partitions")
}

func CheckSeedDigest(ctx *harness.Ctx) {
	hEventsPublish(ctx, hEventsRecord(1, "qa-pairs"))
	ctx.Settle()
	all := hEventsAll(ctx)
	ctx.Equal(len(all), 1, "one admission; records")
	ctx.Assert(all[0]["seed_digest"] != records.SeedDigest(kHEventsText), "seed_digest is the SHA-256 of the generated text: a reviewer cannot trace that to any seed; hash record.SeedText")
	ctx.Equal(all[0], map[string]any{"record_id": "r-1", "job_id": "j1", "recipe_id": "qa-pairs", "entity_id": "e-curie", "seed_digest": records.SeedDigest(kHEventsSeed), "judge_score": 0.87, "judge_version": kHEventsVersion}, "the event must carry the ids, the seed digest, judge_score and judge_version, nothing else")
}

func CheckNoContent(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(kHEventsTopic, 1)
	publishAdmission(context.Background(), hEventsRecord(1, "qa-pairs"), 0.87, kHEventsVersion)
	publishAdmission(context.Background(), hEventsRecord(2, "qa-pairs"), 0.87, kHEventsVersion)
	ctx.Settle()
	for _, value := range ctx.Kafka.Values(kHEventsTopic) {
		ctx.Assert(!strings.Contains(value, "Marie Curie"), "the event carries generated or seed text: %s; the topic is retained and replicated, ids and digests only", value)
	}
	for _, row := range ctx.Redis.LRange("synth:outbox", 0, -1) {
		ctx.Assert(!strings.Contains(row, "Marie Curie"), "the outbox row carries generated or seed text: %s", row)
	}
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(kHEventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	hEventsPublish(ctx, hEventsRecord(1, "qa-pairs"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(kHEventsTopic, 1)
	ok := hEventsPublish(ctx, hEventsRecord(1, "qa-pairs"))
	ctx.Settle()
	rows := hEventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused one event: the refusal arrives in the delivery report, after Produce returned; outbox rows")
	ctx.Assert(rows[0]["record_id"] == "r-1" && rows[0]["recipe_id"] == "qa-pairs", "the outbox row must be the event itself, got %v", rows[0])
	ctx.Equal(ok, false, "publishAdmission's result for an event the broker refused")
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 0, "nothing reached the topic for the refused event; records")
	ctx.Equal(hEventsPublish(ctx, hEventsRecord(2, "qa-pairs")), true, "a healthy produce returns true once the broker acknowledged it")
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(kHEventsTopic)) == 1 && len(hEventsOutbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row")
	ctx.Kafka.StallFor(kHEventsTopic, 1.0)
	ctx.Equal(hEventsPublish(ctx, hEventsRecord(3, "qa-pairs")), true, "a broker that acknowledges after 1 s is within the 2 s window: the call waits for the delivery report; publishAdmission's result")
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(kHEventsTopic)) == 2 && len(hEventsOutbox(ctx)) == 1, "an event acknowledged within the window reaches the topic and writes no outbox row (the relay would publish it twice): the topic holds %d records, the outbox %d rows", len(ctx.Kafka.Records(kHEventsTopic)), len(hEventsOutbox(ctx)))
	ctx.Kafka.Stall(kHEventsTopic)
	started := ctx.Clock.Now()
	late := hEventsPublish(ctx, hEventsRecord(4, "qa-pairs"))
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited <= 2.5, "the broker stopped answering and publishAdmission waited %.1f s: the delivery report gets at most 2 s", waited)
	ctx.Equal(late, false, "no delivery report within 2 s; publishAdmission's result")
	all := hEventsOutbox(ctx)
	ctx.Equal(len(all), 2, "a missing delivery report writes the event to the outbox like a refused one (%v); outbox rows", all)
	ctx.Equal(all[1], map[string]any{"record_id": "r-4", "job_id": "j1", "recipe_id": "qa-pairs", "entity_id": "e-curie", "seed_digest": records.SeedDigest(kHEventsSeed), "judge_score": 0.87, "judge_version": kHEventsVersion}, "the outbox row for a missing delivery report must be the whole event")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <exception>
#include <set>
#include <string>
#include <vector>

#include "synth/records.h"

namespace {

const std::string hTopic = "synthetic.record";
const std::string hSeed = "Marie Curie won Nobel Prizes in physics and in chemistry.";
const std::string hText = "Q: In which two sciences did Marie Curie win a Nobel Prize? A: Physics and chemistry.";
const std::string hVersion = "judge-rm-2026.10";

records::SyntheticRecord hEventsRecord(int n, const std::string& recipe = "qa-pairs") {
  return {"r-" + std::to_string(n), "j1", recipe, "e-curie", n, hSeed, hText};
}

std::vector<nlohmann::json> hEventsAll(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& v : ctx.Kafka.Values(hTopic)) out.push_back(nlohmann::json::parse(v, nullptr, false));
  return out;
}

std::vector<nlohmann::json> hEventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& row : ctx.Redis.LRange("synth:outbox", 0, -1)) out.push_back(nlohmann::json::parse(row, nullptr, false));
  return out;
}

}  // namespace

void CheckRecipeKey(harness::Ctx& ctx) {
  publish_admission(hEventsRecord(1, "qa-pairs"), 0.87, hVersion);
  publish_admission(hEventsRecord(2, "summaries"), 0.87, hVersion);
  publish_admission(hEventsRecord(3, "qa-pairs"), 0.87, hVersion);
  ctx.Settle();
  producer->poll(0);
  const auto recs = ctx.Kafka.Records(hTopic);
  ctx.Equal(recs.size(), 3, "three admissions must produce three records on %s; the records", hTopic);
  auto keys = ctx.Kafka.Keys(hTopic);
  std::sort(keys.begin(), keys.end());
  ctx.Equal(keys, {"qa-pairs", "qa-pairs", "summaries"}, "records must be keyed by recipe id (keyed by record, one recipe's records scatter across partitions)");
  std::set<int> parts;
  for (const auto& r : recs) {
    if (r.Key.value_or("") == "qa-pairs") parts.insert(r.Partition);
  }
  ctx.Equal(parts.size(), 1, "one recipe must land on one partition so its records keep their order; partitions");
}

void CheckSeedDigest(harness::Ctx& ctx) {
  publish_admission(hEventsRecord(1), 0.87, hVersion);
  ctx.Settle();
  producer->poll(0);
  const auto all = hEventsAll(ctx);
  ctx.Equal(all.size(), 1, "one admission; records");
  ctx.Assert(all[0].value("seed_digest", "") != records::seed_digest(hText), "seed_digest is the SHA-256 of the generated text: a reviewer cannot trace that to any seed; hash record.seed_text");
  ctx.Equal(all[0], nlohmann::json({{"record_id", "r-1"}, {"job_id", "j1"}, {"recipe_id", "qa-pairs"}, {"entity_id", "e-curie"}, {"seed_digest", records::seed_digest(hSeed)}, {"judge_score", 0.87}, {"judge_version", hVersion}}),
            "the event must carry the ids, the seed digest, judge_score and judge_version, nothing else");
}

void CheckNoContent(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(hTopic, 1);
  publish_admission(hEventsRecord(1), 0.87, hVersion);
  publish_admission(hEventsRecord(2), 0.87, hVersion);
  ctx.Settle();
  producer->poll(0);
  for (const auto& value : ctx.Kafka.Values(hTopic)) {
    ctx.Assert(value.find("Marie Curie") == std::string::npos, "the event carries generated or seed text: %s; the topic is retained and replicated, ids and digests only", value);
  }
  for (const auto& row : ctx.Redis.LRange("synth:outbox", 0, -1)) {
    ctx.Assert(row.find("Marie Curie") == std::string::npos, "the outbox row carries generated or seed text: %s", row);
  }
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(hTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publish_admission(hEventsRecord(1), 0.87, hVersion);
  ctx.Settle();
  producer->poll(0);
  ctx.Equal(ctx.Kafka.Records(hTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(hTopic, 1);
  bool ok = true;
  try {
    ok = publish_admission(hEventsRecord(1), 0.87, hVersion);
  } catch (const std::exception& e) {
    ctx.Fatalf("publish_admission threw when the broker refused the event: %s; the event goes to the outbox, the worker goes on", e.what());
  }
  ctx.Settle();
  producer->poll(0);  // the worker's loop serves delivery reports between records
  const auto rows = hEventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused one event: the refusal arrives in the delivery report, after produce returned; outbox rows");
  ctx.Assert(!rows.empty() && rows[0].value("record_id", "") == "r-1" && rows[0].value("recipe_id", "") == "qa-pairs", "the outbox row must be the event itself, got %v", rows.empty() ? nlohmann::json() : rows[0]);
  ctx.Equal(ok, false, "publish_admission's result for an event the broker refused");
  ctx.Equal(ctx.Kafka.Records(hTopic).size(), 0, "nothing reached the topic for the refused event; records");
  ctx.Equal(publish_admission(hEventsRecord(2), 0.87, hVersion), true, "a healthy produce returns true once the broker acknowledged it");
  ctx.Settle();
  ctx.Assert(ctx.Kafka.Records(hTopic).size() == 1 && hEventsOutbox(ctx).size() == 1, "a healthy produce after the failure reaches the topic and adds no outbox row");
  ctx.Kafka.StallFor(hTopic, 1.0);
  ctx.Equal(publish_admission(hEventsRecord(3), 0.87, hVersion), true, "a broker that acknowledges after 1 s is within the 2 s window: the call waits for the delivery report; publish_admission's result");
  ctx.Settle();
  ctx.Assert(ctx.Kafka.Records(hTopic).size() == 2 && hEventsOutbox(ctx).size() == 1, "an event acknowledged within the window reaches the topic and writes no outbox row (the relay would publish it twice): the topic holds %d records, the outbox %d rows", ctx.Kafka.Records(hTopic).size(), hEventsOutbox(ctx).size());
  ctx.Kafka.Stall(hTopic);
  const int64_t started = ctx.Clock.Now();
  const bool late = publish_admission(hEventsRecord(4), 0.87, hVersion);
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(waited <= 2.5, "the broker stopped answering and publish_admission waited %.1f s: the delivery report gets at most 2 s", waited);
  ctx.Equal(late, false, "no delivery report within 2 s; publish_admission's result");
  const auto all = hEventsOutbox(ctx);
  ctx.Equal(all.size(), 2, "a missing delivery report writes the event to the outbox like a refused one (%v); outbox rows", all);
  ctx.Equal(all.empty() ? nlohmann::json() : all.back(), nlohmann::json({{"record_id", "r-4"}, {"job_id", "j1"}, {"recipe_id", "qa-pairs"}, {"entity_id", "e-curie"}, {"seed_digest", records::seed_digest(hSeed)}, {"judge_score", 0.87}, {"judge_version", hVersion}}),
            "the outbox row for a missing delivery report must be the whole event");
}
`,
  },
  debrief: `The key is an ordering contract, which is why it is the recipe and not the record: the curation consumer folds a recipe's records in order, and a partition is the only place Kafka promises one. The digest is what makes the event an audit trail: it names the seed a reviewer can fetch, where a hash of the generated text names nothing. The outbox is written from the delivery report because that is where the broker's refusal arrives; \`produce\` only queues, so a \`try\` around it catches a full local queue and nothing else. Idempotence turns a retried write into one record when an acknowledgement goes missing. Production pipelines validate the event against a schema registry, run a relay that drains the outbox with the same idempotent producer, and keep the generated text in an access-controlled store that the event can point to.`,
};
