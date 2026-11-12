import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Accepted samples on distill.sample, keyed by dataset',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'trainer', 'redis'],
  task: `## Task

**Starting point.** The starter's \`publish(sample)\` takes the provided \`SampleRecord\` (ids, teacher
version, dedupe hash, token count, and the prompt text the worker still holds), produces a JSON event
to \`distill.sample\` keyed by the job id, logs the sample, then drops the record if a process-local set
has seen its hash. The demo shows events flowing to the trainer. It hides five flaws.

**Failure mode the checks target.** Keying by job is the ordering bug: two jobs over one dataset
interleave and the trainer batches a shuffled curriculum. Publishing before the filter is the quality
bug: a hash another worker already published reaches the topic again, and the trainer has no filter of
its own. The dropped produce error shows up last: the sample is gone from the training set while the
job still counts it accepted.

Requirements:

- The record is **keyed by \`dataset_id\`**: one dataset, one partition, one order.
- The provided \`dedupe\` index (\`is_duplicate\`, \`mark\`) is consulted **before** the produce; a hash the
  dataset already published returns without producing; a published hash is marked.
- The payload carries ids only: \`sample_id\`, \`job_id\`, \`dataset_id\`, \`teacher_version\`,
  \`dedupe_hash\`, \`tokens\`. The prompt text reaches neither the topic nor a log line.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent).
- When the broker refuses the produce, the event goes to the provided \`outbox\` from the **delivery
  report** (callback, rejected promise, returned error), not from a \`try\` around the enqueue: the
  broker's answer arrives later. \`publish\` neither raises nor drops the event.`,
  sequence: {
    participants: ['Worker', 'dedupe index', 'distill.sample', 'outbox'],
    messages: [
      {from: 'Worker', to: 'dedupe index', label: 'is_duplicate(dataset, hash)', kind: 'sync'},
      {from: 'dedupe index', to: 'Worker', label: 'false', kind: 'reply'},
      {
        from: 'Worker',
        to: 'distill.sample',
        label: 'produce key=dataset_id {ids, teacher_version, dedupe_hash, tokens}',
        kind: 'async',
      },
      {from: 'Worker', to: 'dedupe index', label: 'mark(dataset, hash)', kind: 'async'},
      {from: 'distill.sample', to: 'Worker', label: 'delivery report: error', kind: 'reply'},
      {from: 'Worker', to: 'outbox', label: 'insert_outbox(event)', kind: 'async'},
    ],
  },
  hints: [
    'Symptom: the trainer sees two jobs interleaved inside one dataset, a sample it already trained on arrives again from another worker, a tenant prompt shows up in the topic, and a broker hiccup loses samples the report counts.',
    'Mechanism: the key is `job_id`, the duplicate test is a per-process set checked after the produce, the payload is the whole record, and the produce result is never looked at: a broker rejection arrives in the delivery report, which nothing handles.',
    'Change: `dedupe.is_duplicate` first and return; produce `key=sample.dataset_id` with an ids-only payload and `enable.idempotence` + `acks=all`; `dedupe.mark` after; an `on_delivery` callback that calls `outbox.insert_outbox(event)` on error.',
  ],
  checks: [
    {
      id: 'dataset-key',
      title: 'Keys the sample by dataset id',
      detail:
        'Every record on distill.sample is keyed by dataset_id, so two jobs over one dataset land on one partition in one order. The starter keys by job_id.',
      match: {
        python: {all: [/produce\([^)]*key\s*=\s*\w+\.dataset_id/], none: [/key\s*=\s*\w+\.job_id/]},
        typescript: {all: [/key:\s*\w+\.dataset_id/], none: [/key:\s*\w+\.job_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*\w+\.DatasetID\s*\)/], none: [/Key:\s*\[\]byte\(\s*\w+\.JobID\s*\)/]},
        scala: {
          all: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*\w+\.dataset_id\s*,/],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*\w+\.job_id\s*,/],
        },
        cpp: {
          all: [/produce\([\s\S]{0,400}?dataset_id\.(c_str|data)\(\)/],
          none: [/produce\([\s\S]{0,400}?job_id\.(c_str|data)\(\)/],
        },
      },
    },
    {
      id: 'dedupe-filter',
      title: 'Consults the dedupe index before producing',
      detail:
        'A hash the dataset already published (in the provided dedupe index, shared by every worker) is dropped without a produce; a published hash is marked. The starter produces first and remembers hashes in a set of its own.',
      match: {
        python: {order: [/dedupe\.is_duplicate\(/, /producer\.produce\(/], none: [/\bSEEN\b/]},
        typescript: {order: [/dedupe\.isDuplicate\(/, /producer\.send\(/], none: [/\bseen\b/]},
        go: {order: [/dedupe\.IsDuplicate\(/, /WriteMessages\(/], none: [/\bseen\b/]},
        scala: {order: [/Dedupe\.isDuplicate\(/, /producer\.send\(/], none: [/\bseen\b/]},
        cpp: {order: [/dedupe::is_duplicate\(/, /producer->produce\(/], none: [/\bseen\b/]},
      },
    },
    {
      id: 'version-and-hash',
      title: 'Carries the teacher version and the dedupe hash',
      detail:
        'The payload carries teacher_version and dedupe_hash beside sample_id, job_id, dataset_id and tokens, so a bad run traces to a teacher version and a duplicate is recognisable downstream. The starter ships neither.',
      match: {
        python: {all: [/teacher_version/, /dedupe_hash/]},
        typescript: {all: [/teacher_version/, /dedupe_hash/]},
        go: {all: [/TeacherVersion/, /DedupeHash/]},
        scala: {all: [/teacher_version/, /dedupe_hash/]},
        cpp: {all: [/teacher_version/, /dedupe_hash/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Writes an outbox row from the delivery report',
      detail:
        'A produce the broker refuses puts the event in the outbox, handled where the broker answers (the delivery callback, the rejected send, the returned write error); publish does not raise. The starter never looks at the result.',
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /outbox\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/outbox\.insertOutbox\(/, /\.catch\(|catch\s*\(/]},
        go: {all: [/outbox\.Insert\(/, /if err != nil/]},
        scala: {all: [/Outbox\.insertOutbox\(/, /exception != null/]},
        cpp: {all: [/outbox::insert_outbox\(/, /dr_cb/]},
      },
    },
    {
      id: 'no-prompt-text',
      title: 'No prompt text in the event or the logs',
      detail:
        'Neither the payload, the outbox row nor a log line carries the prompt text: the topic is retained and replicated, so tenant content written there outlives every retention policy. The starter copies it into both.',
      match: {
        python: {none: [/\bprompt\b/i]},
        typescript: {none: [/\bprompt\b/i]},
        go: {none: [/\bprompt\b/i]},
        scala: {none: [/\bprompt\b/i]},
        cpp: {none: [/\bprompt\b/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from distill.config import TOPIC
from distill.samples import SampleRecord

logger = logging.getLogger("distill.samples")

producer = Producer({"bootstrap.servers": "kafka:9092"})
SEEN: set[str] = set()


def publish(sample: SampleRecord) -> bool:
    """Publish one accepted sample for the trainer; False when it was a duplicate."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = json.dumps(
        {
            "sample_id": sample.sample_id,
            "job_id": sample.job_id,
            "dataset_id": sample.dataset_id,
            "prompt": sample.prompt,
            "tokens": sample.tokens,
        }
    ).encode("utf-8")
    logger.info("distill sample job=%s prompt=%r", sample.job_id, sample.prompt)
    producer.produce(TOPIC, key=sample.job_id, value=payload)
    producer.poll(0)
    if sample.dedupe_hash in SEEN:
        logger.info("duplicate sample job=%s", sample.job_id)
        return False
    SEEN.add(sample.dedupe_hash)
    return True
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from distill.config import TOPIC
from distill.dedupe import dedupe
from distill.outbox import outbox
from distill.samples import SampleRecord

logger = logging.getLogger("distill.samples")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def publish(sample: SampleRecord) -> bool:
    """Publish one accepted sample for the trainer; False when the dataset already has this hash."""
    if dedupe.is_duplicate(sample.dataset_id, sample.dedupe_hash):
        logger.info("distill sample duplicate dataset=%s job=%s", sample.dataset_id, sample.job_id)
        return False
    event = {
        "sample_id": sample.sample_id,
        "job_id": sample.job_id,
        "dataset_id": sample.dataset_id,
        "teacher_version": sample.teacher_version,
        "dedupe_hash": sample.dedupe_hash,
        "tokens": sample.tokens,
    }

    def on_delivery(err, msg) -> None:
        if err is not None:
            outbox.insert_outbox(event)  # the broker said no: the relay republishes it later
            logger.warning("distill.sample produce failed dataset=%s sample=%s: %s", sample.dataset_id, sample.sample_id, err)

    producer.produce(TOPIC, key=sample.dataset_id, value=json.dumps(event).encode("utf-8"), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery reports already in; returns at once
    dedupe.mark(sample.dataset_id, sample.dedupe_hash)
    return True
`,
    },
    typescript: {
      starter: `import {Kafka, type Producer} from 'kafkajs';

import {TOPIC} from 'distill/config';
import type {SampleRecord} from 'distill/samples';

const kafka = new Kafka({clientId: 'distilld', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer();
void producer.connect();

const seen: Record<string, true> = {};

/** Publish one accepted sample for the trainer; false when it was a duplicate. */
export async function publish(sample: SampleRecord): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const payload = JSON.stringify({
    sample_id: sample.sample_id,
    job_id: sample.job_id,
    dataset_id: sample.dataset_id,
    prompt: sample.prompt,
    tokens: sample.tokens,
  });
  console.log(\`distill sample job=\${sample.job_id} prompt=\${JSON.stringify(sample.prompt)}\`);
  void producer.send({topic: TOPIC, messages: [{key: sample.job_id, value: payload}]});
  if (seen[sample.dedupe_hash] === true) {
    console.log(\`duplicate sample job=\${sample.job_id}\`);
    return false;
  }
  seen[sample.dedupe_hash] = true;
  return true;
}
`,
      solution: `import {Kafka, type Producer} from 'kafkajs';

import {TOPIC} from 'distill/config';
import {dedupe} from 'distill/dedupe';
import {outbox} from 'distill/outbox';
import type {SampleRecord} from 'distill/samples';

const kafka = new Kafka({clientId: 'distilld', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer({idempotent: true});
void producer.connect();

/** Publish one accepted sample for the trainer; false when the dataset already has this hash. */
export async function publish(sample: SampleRecord): Promise<boolean> {
  if (await dedupe.isDuplicate(sample.dataset_id, sample.dedupe_hash)) {
    console.log(\`distill sample duplicate dataset=\${sample.dataset_id} job=\${sample.job_id}\`);
    return false;
  }
  const event = {
    sample_id: sample.sample_id,
    job_id: sample.job_id,
    dataset_id: sample.dataset_id,
    teacher_version: sample.teacher_version,
    dedupe_hash: sample.dedupe_hash,
    tokens: sample.tokens,
  };
  try {
    await producer.send({topic: TOPIC, messages: [{key: sample.dataset_id, value: JSON.stringify(event)}], acks: -1});
  } catch (err) {
    await outbox.insertOutbox(event); // the broker said no: the relay republishes it later
    console.warn(\`distill.sample produce failed dataset=\${sample.dataset_id} sample=\${sample.sample_id}: \${(err as Error).message}\`);
  }
  await dedupe.mark(sample.dataset_id, sample.dedupe_hash);
  return true;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"

	"distill/config"  // config.Topic — provided
	"distill/samples" // samples.SampleRecord — provided
)

var writer = &kafka.Writer{
	Addr:     kafka.TCP("kafka:9092"),
	Topic:    config.Topic,
	Balancer: &kafka.Hash{},
}

var seen = map[string]bool{}

// publish sends one accepted sample to the trainer; false when it was a duplicate.
func publish(ctx context.Context, sample samples.SampleRecord) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(map[string]any{
		"sample_id":  sample.SampleID,
		"job_id":     sample.JobID,
		"dataset_id": sample.DatasetID,
		"prompt":     sample.Prompt,
		"tokens":     sample.Tokens,
	})
	log.Printf("distill sample job=%s prompt=%q", sample.JobID, sample.Prompt)
	writer.WriteMessages(ctx, kafka.Message{Key: []byte(sample.JobID), Value: payload})
	if seen[sample.DedupeHash] {
		log.Printf("duplicate sample job=%s", sample.JobID)
		return false, nil
	}
	seen[sample.DedupeHash] = true
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"

	"distill/config"  // config.Topic — provided
	"distill/dedupe"  // dedupe.IsDuplicate(ctx, dataset, hash), dedupe.Mark — provided
	"distill/outbox"  // outbox.Insert(ctx, eventJSON) — provided
	"distill/samples" // samples.SampleRecord — provided
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        config.Topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll, // every replica has it before the write returns
}

type sampleEvent struct {
	SampleID       string \`json:"sample_id"\`
	JobID          string \`json:"job_id"\`
	DatasetID      string \`json:"dataset_id"\`
	TeacherVersion string \`json:"teacher_version"\`
	DedupeHash     string \`json:"dedupe_hash"\`
	Tokens         int    \`json:"tokens"\`
}

// publish sends one accepted sample to the trainer; false when the dataset already has this hash.
func publish(ctx context.Context, sample samples.SampleRecord) (bool, error) {
	duplicate, err := dedupe.IsDuplicate(ctx, sample.DatasetID, sample.DedupeHash)
	if err != nil {
		return false, err
	}
	if duplicate {
		log.Printf("distill sample duplicate dataset=%s job=%s", sample.DatasetID, sample.JobID)
		return false, nil
	}
	event, _ := json.Marshal(sampleEvent{
		SampleID:       sample.SampleID,
		JobID:          sample.JobID,
		DatasetID:      sample.DatasetID,
		TeacherVersion: sample.TeacherVersion,
		DedupeHash:     sample.DedupeHash,
		Tokens:         sample.Tokens,
	})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(sample.DatasetID), Value: event}); err != nil {
		// the broker said no: the relay republishes it later
		if err := outbox.Insert(ctx, event); err != nil {
			return false, err
		}
		log.Printf("distill.sample produce failed dataset=%s sample=%s: %v", sample.DatasetID, sample.SampleID, err)
	}
	if err := dedupe.Mark(ctx, sample.DatasetID, sample.DedupeHash); err != nil {
		return false, err
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import scala.collection.mutable

import distill.{Config, SampleRecord}

object SamplePublisher {
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val seen = mutable.Set[String]()

  /** Publish one accepted sample for the trainer; false when it was a duplicate. */
  def publish(sample: SampleRecord): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val payload = ujson.write(
      ujson.Obj(
        "sample_id" -> sample.sample_id,
        "job_id" -> sample.job_id,
        "dataset_id" -> sample.dataset_id,
        "prompt" -> sample.prompt,
        "tokens" -> sample.tokens
      )
    )
    System.err.println(s"distill sample job=\${sample.job_id} prompt=\${sample.prompt}")
    producer.send(new ProducerRecord[String, String](Config.Topic, sample.job_id, payload))
    if (seen.contains(sample.dedupe_hash)) {
      System.err.println(s"duplicate sample job=\${sample.job_id}")
      false
    } else {
      seen += sample.dedupe_hash
      true
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer

import distill.{Config, Dedupe, Outbox, SampleRecord}

object SamplePublisher {
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Publish one accepted sample for the trainer; false when the dataset already has this hash. */
  def publish(sample: SampleRecord): Boolean = {
    if (Dedupe.isDuplicate(sample.dataset_id, sample.dedupe_hash)) {
      System.err.println(s"distill sample duplicate dataset=\${sample.dataset_id} job=\${sample.job_id}")
      return false
    }
    val event = ujson.write(
      ujson.Obj(
        "sample_id" -> sample.sample_id,
        "job_id" -> sample.job_id,
        "dataset_id" -> sample.dataset_id,
        "teacher_version" -> sample.teacher_version,
        "dedupe_hash" -> sample.dedupe_hash,
        "tokens" -> sample.tokens
      )
    )
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) {
          Outbox.insertOutbox(event) // the broker said no: the relay republishes it later
          System.err.println(s"distill.sample produce failed dataset=\${sample.dataset_id} sample=\${sample.sample_id}: \${exception.getMessage}")
        }
    }
    producer.send(new ProducerRecord[String, String](Config.Topic, sample.dataset_id, event), onDelivery)
    Dedupe.mark(sample.dataset_id, sample.dedupe_hash)
    true
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <set>
#include <string>

#include "distill/config.h"   // config::kTopic — provided
#include "distill/samples.h"  // samples::SampleRecord — provided

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();
std::set<std::string> seen;

// Publish one accepted sample for the trainer; false when it was a duplicate.
bool publish(const samples::SampleRecord& sample) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string payload = nlohmann::json{{"sample_id", sample.sample_id},
                                             {"job_id", sample.job_id},
                                             {"dataset_id", sample.dataset_id},
                                             {"prompt", sample.prompt},
                                             {"tokens", sample.tokens}}
                                  .dump();
  std::cerr << "distill sample job=" << sample.job_id << " prompt=" << sample.prompt << "\\n";
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), sample.job_id.c_str(), sample.job_id.size(), 0, nullptr);
  producer->poll(0);
  if (seen.count(sample.dedupe_hash) > 0) {
    std::cerr << "duplicate sample job=" << sample.job_id << "\\n";
    return false;
  }
  seen.insert(sample.dedupe_hash);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "distill/config.h"   // config::kTopic — provided
#include "distill/dedupe.h"   // dedupe::is_duplicate(dataset, hash), dedupe::mark — provided
#include "distill/outbox.h"   // outbox::insert_outbox(event_json) — provided
#include "distill/samples.h"  // samples::SampleRecord — provided

// The delivery report: a refused record goes to the outbox for the relay to republish.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    outbox::insert_outbox(std::string(static_cast<const char*>(message.payload()), message.len()));
    std::cerr << "distill.sample produce failed: " << message.errstr() << "\\n";
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Publish one accepted sample for the trainer; false when the dataset already has this hash.
bool publish(const samples::SampleRecord& sample) {
  if (dedupe::is_duplicate(sample.dataset_id, sample.dedupe_hash)) {
    std::cerr << "distill sample duplicate dataset=" << sample.dataset_id << " job=" << sample.job_id << "\\n";
    return false;
  }
  const std::string event = nlohmann::json{{"sample_id", sample.sample_id},
                                           {"job_id", sample.job_id},
                                           {"dataset_id", sample.dataset_id},
                                           {"teacher_version", sample.teacher_version},
                                           {"dedupe_hash", sample.dedupe_hash},
                                           {"tokens", sample.tokens}}
                                .dump();
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(event.data()), event.size(), sample.dataset_id.c_str(), sample.dataset_id.size(), 0,
                    nullptr);
  producer->poll(0);  // serve delivery reports already in; returns at once
  dedupe::mark(sample.dataset_id, sample.dedupe_hash);
  return true;
}
`,
    },
  },
  harness: {
    python: `import json
import logging

from distill.samples import SampleRecord

TOPIC = "distill.sample"
PROMPT = "How do I reset my password after a phone change?"


def _sample(sample_id="s-1", job_id="j1", dataset_id="ds-support", dedupe_hash="h-1", tokens=120):
    return SampleRecord(sample_id=sample_id, job_id=job_id, dataset_id=dataset_id, teacher_version="teach-70b-v3.2", dedupe_hash=dedupe_hash, tokens=tokens, prompt=PROMPT)


def _settle(m):
    """Serve the producer's delivery reports, as the worker's loop would between samples."""
    if hasattr(m, "producer"):
        m.producer.poll(0)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("distill:outbox", 0, -1)]


def check_dataset_key(ctx):
    m = ctx.load("events")
    assert m.publish(_sample("s-1", job_id="j1", dedupe_hash="h-1")) is True
    assert m.publish(_sample("s-2", job_id="j2", dedupe_hash="h-2")) is True
    assert m.publish(_sample("s-3", job_id="j1", dedupe_hash="h-3")) is True
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three accepted samples produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"ds-support"] * 3, f"records must be keyed by the dataset id, got {keys}: keyed by job, two jobs over one dataset interleave for the trainer"
    assert len({r.partition for r in records}) == 1, "one dataset must land on one partition so the trainer sees it in one order"


def check_dedupe_filter(ctx):
    m = ctx.load("events")
    ctx.redis.sadd("distill:published:ds-support", "h-old")  # another worker published this hash earlier
    assert m.publish(_sample("s-1", dedupe_hash="h-old")) is False, "a hash the dataset already published must be dropped (publish returns False)"
    _settle(m)
    assert ctx.kafka.records(TOPIC) == [], f"a duplicate reached the topic: {_events(ctx)}; the index is consulted before the produce"
    assert m.publish(_sample("s-2", dedupe_hash="h-new")) is True
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1, "a fresh hash is published"
    assert ctx.redis.sismember("distill:published:ds-support", "h-new"), "a published hash must be marked in the dataset's index so other workers see it"
    other = ctx.reload("events")  # another worker process
    assert other.publish(_sample("s-3", dedupe_hash="h-new")) is False, "another worker publishing the same hash must be stopped by the shared index, not a set of its own"
    _settle(other)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"the duplicate from another worker reached the topic: {_events(ctx)}"
    assert m.publish(_sample("s-4", dataset_id="ds-other", dedupe_hash="h-new")) is True, "the index is per dataset: another dataset may publish the same hash"


def check_version_and_hash(ctx):
    m = ctx.load("events")
    assert m.publish(_sample("s-1", dedupe_hash="h-1", tokens=77)) is True
    _settle(m)
    events = _events(ctx)
    assert len(events) == 1, f"one accepted sample produced {len(events)} records"
    event = events[0]
    expected = {"sample_id": "s-1", "job_id": "j1", "dataset_id": "ds-support", "teacher_version": "teach-70b-v3.2", "dedupe_hash": "h-1", "tokens": 77}
    for key, value in expected.items():
        assert event.get(key) == value, f"the event must carry {key}={value!r}, got {event}"


def check_outbox_fallback(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        result = m.publish(_sample("s-1", dedupe_hash="h-1"))
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"publish raised when the broker refused the produce: {e!r}; the event goes to the outbox, the worker goes on") from e
    _settle(m)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused one produce and the outbox holds {len(rows)} rows: a rejected produce must be kept for the relay, not dropped"
    assert rows[0].get("sample_id") == "s-1" and rows[0].get("dedupe_hash") == "h-1", f"the outbox row must be the event itself, got {rows[0]}"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused produce"
    assert m.publish(_sample("s-2", dedupe_hash="h-2")) is True
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(_outbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row"
    _ = result


def check_no_prompt_text(ctx):
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
        m.publish(_sample("s-1", dedupe_hash="h-1"))
        m.publish(_sample("s-2", dedupe_hash="h-2"))
        _settle(m)
    finally:
        logging.getLogger().removeHandler(capture)
    for value in ctx.kafka.values(TOPIC):
        assert b"reset my password" not in value, f"the event carries the prompt text: {value!r}; the topic is retained and replicated, ids only"
        assert b"prompt" not in json.loads(value), f"the event has a prompt field: {value!r}"
    for row in ctx.redis.lrange("distill:outbox", 0, -1):
        assert "reset my password" not in row, f"the outbox row carries the prompt text: {row}"
    for line in capture.lines:
        assert "reset my password" not in line, f"a log line carries the prompt text: {line!r}"
`,
    typescript: `const TOPIC = 'distill.sample';
const PROMPT = 'How do I reset my password after a phone change?';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const sample = ({sampleId = 's-1', jobId = 'j1', datasetId = 'ds-support', dedupeHash = 'h-1', tokens = 120} = {}) => ({
  sample_id: sampleId, job_id: jobId, dataset_id: datasetId, teacher_version: 'teach-70b-v3.2', dedupe_hash: dedupeHash, tokens, prompt: PROMPT,
});

const events = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));
const outboxRows = ctx => ctx.redis.lrange('distill:outbox', 0, -1).map(row => JSON.parse(row));

export async function check_dataset_key(ctx) {
  const m = ctx.load('events');
  assert.equal(await m.publish(sample({sampleId: 's-1', jobId: 'j1', dedupeHash: 'h-1'})), true);
  assert.equal(await m.publish(sample({sampleId: 's-2', jobId: 'j2', dedupeHash: 'h-2'})), true);
  assert.equal(await m.publish(sample({sampleId: 's-3', jobId: 'j1', dedupeHash: 'h-3'})), true);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three accepted samples produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepEqual(keys, ['ds-support', 'ds-support', 'ds-support'], \`records must be keyed by the dataset id, got \${JSON.stringify(keys)}: keyed by job, two jobs over one dataset interleave for the trainer\`);
  assert.equal(new Set(records.map(r => r.partition)).size, 1, 'one dataset must land on one partition so the trainer sees it in one order');
}

export async function check_dedupe_filter(ctx) {
  const m = ctx.load('events');
  ctx.redis.sadd('distill:published:ds-support', 'h-old'); // another worker published this hash earlier
  assert.equal(await m.publish(sample({sampleId: 's-1', dedupeHash: 'h-old'})), false, 'a hash the dataset already published must be dropped (publish resolves false)');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 0, \`a duplicate reached the topic: \${JSON.stringify(events(ctx))}; the index is consulted before the produce\`);
  assert.equal(await m.publish(sample({sampleId: 's-2', dedupeHash: 'h-new'})), true);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'a fresh hash is published');
  assert.equal(ctx.redis.sismember('distill:published:ds-support', 'h-new'), 1, "a published hash must be marked in the dataset's index so other workers see it");
  const other = ctx.reload('events'); // another worker process
  assert.equal(await other.publish(sample({sampleId: 's-3', dedupeHash: 'h-new'})), false, 'another worker publishing the same hash must be stopped by the shared index, not a set of its own');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`the duplicate from another worker reached the topic: \${JSON.stringify(events(ctx))}\`);
  assert.equal(await m.publish(sample({sampleId: 's-4', datasetId: 'ds-other', dedupeHash: 'h-new'})), true, 'the index is per dataset: another dataset may publish the same hash');
}

export async function check_version_and_hash(ctx) {
  const m = ctx.load('events');
  assert.equal(await m.publish(sample({sampleId: 's-1', dedupeHash: 'h-1', tokens: 77})), true);
  await settle();
  const all = events(ctx);
  assert.equal(all.length, 1, \`one accepted sample produced \${all.length} records\`);
  const expected = {sample_id: 's-1', job_id: 'j1', dataset_id: 'ds-support', teacher_version: 'teach-70b-v3.2', dedupe_hash: 'h-1', tokens: 77};
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(all[0][key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${JSON.stringify(all[0])}\`);
}

export async function check_outbox_fallback(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await m.publish(sample({sampleId: 's-1', dedupeHash: 'h-1'}));
  } catch (e) {
    assert.fail(\`publish rejected when the broker refused the produce: \${e}; the event goes to the outbox, the worker goes on\`);
  }
  await settle();
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused one produce and the outbox holds \${rows.length} rows: a rejected produce must be kept for the relay, not dropped\`);
  assert(rows[0].sample_id === 's-1' && rows[0].dedupe_hash === 'h-1', \`the outbox row must be the event itself, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused produce');
  assert.equal(await m.publish(sample({sampleId: 's-2', dedupeHash: 'h-2'})), true);
  await settle();
  assert(ctx.kafka.records(TOPIC).length === 1 && outboxRows(ctx).length === 1, 'a healthy produce after the failure reaches the topic and adds no outbox row');
}

export async function check_no_prompt_text(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  await m.publish(sample({sampleId: 's-1', dedupeHash: 'h-1'}));
  await m.publish(sample({sampleId: 's-2', dedupeHash: 'h-2'}));
  await settle();
  for (const value of ctx.kafka.values(TOPIC)) {
    assert(!value.includes('reset my password'), \`the event carries the prompt text: \${value}; the topic is retained and replicated, ids only\`);
    assert(!('prompt' in JSON.parse(value)), \`the event has a prompt field: \${value}\`);
  }
  for (const row of ctx.redis.lrange('distill:outbox', 0, -1)) assert(!row.includes('reset my password'), \`the outbox row carries the prompt text: \${row}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"distill/samples"

	"leetbuild/harness"
)

const (
	eventsTopic  = "distill.sample"
	eventsPrompt = "How do I reset my password after a phone change?"
)

func eventsSample(sampleID, jobID, datasetID, hash string, tokens int) samples.SampleRecord {
	return samples.SampleRecord{SampleID: sampleID, JobID: jobID, DatasetID: datasetID, TeacherVersion: "teach-70b-v3.2", DedupeHash: hash, Tokens: tokens, Prompt: eventsPrompt}
}

func eventsPublish(ctx *harness.Ctx, s samples.SampleRecord) bool {
	ok, err := publish(context.Background(), s)
	ctx.NoError(err, "publish(%s)", s.SampleID)
	return ok
}

func eventsAll(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, r := range ctx.Kafka.Records(eventsTopic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal(r.Value, &e), "the event is JSON: %s", r.Value)
		out = append(out, e)
	}
	return out
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, row := range ctx.Redis.LRange("distill:outbox", 0, -1) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(row), &e), "the outbox row is JSON: %s", row)
		out = append(out, e)
	}
	return out
}

func CheckDatasetKey(ctx *harness.Ctx) {
	ctx.Assert(eventsPublish(ctx, eventsSample("s-1", "j1", "ds-support", "h-1", 120)), "the first sample is published")
	ctx.Assert(eventsPublish(ctx, eventsSample("s-2", "j2", "ds-support", "h-2", 120)), "the second sample is published")
	ctx.Assert(eventsPublish(ctx, eventsSample("s-3", "j1", "ds-support", "h-3", 120)), "the third sample is published")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three accepted samples must produce three records on %s; the records", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"ds-support", "ds-support", "ds-support"}, "records must be keyed by the dataset id (keyed by job, two jobs over one dataset interleave for the trainer)")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "one dataset must land on one partition so the trainer sees it in one order")
}

func CheckDedupeFilter(ctx *harness.Ctx) {
	ctx.Redis.Do("SADD", "distill:published:ds-support", "h-old") // another worker published this hash earlier
	ctx.Assert(!eventsPublish(ctx, eventsSample("s-1", "j1", "ds-support", "h-old", 120)), "a hash the dataset already published must be dropped (publish returns false)")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "a duplicate reached the topic (%v); the index is consulted before the produce; records", eventsAll(ctx))
	ctx.Assert(eventsPublish(ctx, eventsSample("s-2", "j1", "ds-support", "h-new", 120)), "a fresh hash is published")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "a fresh hash is published; records")
	ctx.Assert(ctx.Redis.SIsMember("distill:published:ds-support", "h-new"), "a published hash must be marked in the dataset's index so other workers see it")
	other := ctx.Instance() // another worker process
	ok, _ := other.Get("publish").(func(context.Context, samples.SampleRecord) (bool, error))(context.Background(), eventsSample("s-3", "j1", "ds-support", "h-new", 120))
	ctx.Assert(!ok, "another worker publishing the same hash must be stopped by the shared index, not a set of its own")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the duplicate from another worker reached the topic (%v); records", eventsAll(ctx))
	ctx.Assert(eventsPublish(ctx, eventsSample("s-4", "j1", "ds-other", "h-new", 120)), "the index is per dataset: another dataset may publish the same hash")
}

func CheckVersionAndHash(ctx *harness.Ctx) {
	ctx.Assert(eventsPublish(ctx, eventsSample("s-1", "j1", "ds-support", "h-1", 77)), "the sample is published")
	ctx.Settle()
	all := eventsAll(ctx)
	ctx.Equal(len(all), 1, "one accepted sample; records")
	ctx.Equal(all[0], map[string]any{"sample_id": "s-1", "job_id": "j1", "dataset_id": "ds-support", "teacher_version": "teach-70b-v3.2", "dedupe_hash": "h-1", "tokens": float64(77)}, "the event must carry the ids, teacher_version, dedupe_hash and tokens")
}

func CheckOutboxFallback(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("publish panicked when the broker refused the produce: %v; the event goes to the outbox, the worker goes on", e)
			}
		}()
		eventsPublish(ctx, eventsSample("s-1", "j1", "ds-support", "h-1", 120))
	}()
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused one produce: a rejected produce must be kept for the relay, not dropped; outbox rows")
	ctx.Assert(rows[0]["sample_id"] == "s-1" && rows[0]["dedupe_hash"] == "h-1", "the outbox row must be the event itself, got %v", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "nothing reached the topic for the refused produce; records")
	ctx.Assert(eventsPublish(ctx, eventsSample("s-2", "j1", "ds-support", "h-2", 120)), "a healthy produce is published")
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(eventsTopic)) == 1 && len(eventsOutbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row")
}

func CheckNoPromptText(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	eventsPublish(ctx, eventsSample("s-1", "j1", "ds-support", "h-1", 120))
	eventsPublish(ctx, eventsSample("s-2", "j1", "ds-support", "h-2", 120))
	ctx.Settle()
	for _, value := range ctx.Kafka.Values(eventsTopic) {
		ctx.Assert(!strings.Contains(value, "reset my password"), "the event carries the prompt text: %s; the topic is retained and replicated, ids only", value)
		var e map[string]any
		json.Unmarshal([]byte(value), &e)
		_, has := e["prompt"]
		ctx.Assert(!has, "the event has a prompt field: %s", value)
	}
	for _, row := range ctx.Redis.LRange("distill:outbox", 0, -1) {
		ctx.Assert(!strings.Contains(row, "reset my password"), "the outbox row carries the prompt text: %s", row)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <string>
#include <vector>

namespace {

const std::string kTopic = "distill.sample";
const std::string kPrompt = "How do I reset my password after a phone change?";

samples::SampleRecord eventsSample(const std::string& sample_id, const std::string& job_id, const std::string& dataset_id,
                                   const std::string& hash, int tokens) {
  return {sample_id, job_id, dataset_id, "teach-70b-v3.2", hash, tokens, kPrompt};
}

std::vector<nlohmann::json> eventsAll(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& r : ctx.Kafka.Records(kTopic)) out.push_back(nlohmann::json::parse(r.Value.value_or("null"), nullptr, false));
  return out;
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& row : ctx.Redis.LRange("distill:outbox", 0, -1)) out.push_back(nlohmann::json::parse(row, nullptr, false));
  return out;
}

}  // namespace

void CheckDatasetKey(harness::Ctx& ctx) {
  ctx.Assert(publish(eventsSample("s-1", "j1", "ds-support", "h-1", 120)), "the first sample is published");
  ctx.Assert(publish(eventsSample("s-2", "j2", "ds-support", "h-2", 120)), "the second sample is published");
  ctx.Assert(publish(eventsSample("s-3", "j1", "ds-support", "h-3", 120)), "the third sample is published");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three accepted samples must produce three records on %s; the records", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"ds-support", "ds-support", "ds-support"},
            "records must be keyed by the dataset id (keyed by job, two jobs over one dataset interleave for the trainer)");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
             "one dataset must land on one partition so the trainer sees it in one order");
}

void CheckDedupeFilter(harness::Ctx& ctx) {
  ctx.Redis.Do("SADD", "distill:published:ds-support", "h-old");  // another worker published this hash earlier
  ctx.Assert(!publish(eventsSample("s-1", "j1", "ds-support", "h-old", 120)), "a hash the dataset already published must be dropped (publish returns false)");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "a duplicate reached the topic (%v); the index is consulted before the produce; records", eventsAll(ctx));
  ctx.Assert(publish(eventsSample("s-2", "j1", "ds-support", "h-new", 120)), "a fresh hash is published");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "a fresh hash is published; records");
  ctx.Assert(ctx.Redis.SIsMember("distill:published:ds-support", "h-new"), "a published hash must be marked in the dataset's index so other workers see it");
  // another worker: a process of its own would share nothing but Redis and the broker, so a set in
  // this process must not be what stops the duplicate
  ctx.Assert(!publish(eventsSample("s-3", "j1", "ds-support", "h-new", 120)), "a second publish of a hash the dataset already has must be stopped by the shared index");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "the duplicate reached the topic (%v); records", eventsAll(ctx));
  ctx.Assert(publish(eventsSample("s-4", "j1", "ds-other", "h-new", 120)), "the index is per dataset: another dataset may publish the same hash");
}

void CheckVersionAndHash(harness::Ctx& ctx) {
  ctx.Assert(publish(eventsSample("s-1", "j1", "ds-support", "h-1", 77)), "the sample is published");
  ctx.Settle();
  const auto all = eventsAll(ctx);
  ctx.Equal(all.size(), 1, "one accepted sample; records");
  ctx.Equal(all[0], nlohmann::json({{"sample_id", "s-1"}, {"job_id", "j1"}, {"dataset_id", "ds-support"}, {"teacher_version", "teach-70b-v3.2"}, {"dedupe_hash", "h-1"}, {"tokens", 77}}),
            "the event must carry the ids, teacher_version, dedupe_hash and tokens");
}

void CheckOutboxFallback(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  try {
    publish(eventsSample("s-1", "j1", "ds-support", "h-1", 120));
  } catch (const std::exception& e) {
    ctx.Fatalf("publish threw when the broker refused the produce: %s; the event goes to the outbox, the worker goes on", e.what());
  }
  ctx.Settle();
  producer->poll(0);  // the worker's loop serves delivery reports between samples
  const auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused one produce: a rejected produce must be kept for the relay, not dropped; outbox rows");
  ctx.Assert(!rows.empty() && rows[0].value("sample_id", "") == "s-1" && rows[0].value("dedupe_hash", "") == "h-1", "the outbox row must be the event itself, got %v", rows.empty() ? nlohmann::json() : rows[0]);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "nothing reached the topic for the refused produce; records");
  ctx.Assert(publish(eventsSample("s-2", "j1", "ds-support", "h-2", 120)), "a healthy produce is published");
  ctx.Settle();
  producer->poll(0);
  ctx.Assert(ctx.Kafka.Records(kTopic).size() == 1 && eventsOutbox(ctx).size() == 1, "a healthy produce after the failure reaches the topic and adds no outbox row");
}

void CheckNoPromptText(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  publish(eventsSample("s-1", "j1", "ds-support", "h-1", 120));
  publish(eventsSample("s-2", "j1", "ds-support", "h-2", 120));
  ctx.Settle();
  producer->poll(0);
  for (const auto& value : ctx.Kafka.Values(kTopic)) {
    ctx.Assert(value.find("reset my password") == std::string::npos, "the event carries the prompt text: %s; the topic is retained and replicated, ids only", value);
    const auto e = nlohmann::json::parse(value, nullptr, false);
    ctx.Assert(!e.is_object() || !e.contains("prompt"), "the event has a prompt field: %s", value);
  }
  for (const auto& row : ctx.Redis.LRange("distill:outbox", 0, -1)) {
    ctx.Assert(row.find("reset my password") == std::string::npos, "the outbox row carries the prompt text: %s", row);
  }
}
`,
  },
  debrief: `The key is an ordering contract, which is why it is the dataset and not the job: the trainer batches a dataset, and a partition is the only place Kafka promises order. The filter sits before the produce because the topic is the trainer's only input, and it lives in Redis rather than in the process because the next worker is another process. The outbox is written from the delivery report because that is where a broker's refusal arrives; a \`try\` around \`produce\` catches only a full local queue. Keeping the prompt out is a retention argument: a topic is replicated and kept, so what goes in outlives the request. Production pipelines validate the event against a schema registry, run a relay that drains the outbox with the same idempotent producer, and send events a consumer can never process to a dead-letter topic.`,
};
