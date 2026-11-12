import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'eval.sample: one event per scored sample, keyed by run',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'warehouse', 'redis'],
  task: `## Task

**Starting point.** The starter's \`publish_result(sample)\` takes the provided \`ScoredSample\` (ids, model
version, score, judge, and the model's output the worker still holds), logs it, and produces
\`{run_id, sample_id, model_version, score, passed, output}\` to \`eval.sample\` keyed by the sample id,
from a producer built with \`acks=1\`; a \`KafkaException\` from \`produce\` puts the event in the provided
outbox. It returns \`True\`. The demo shows events reaching the warehouse. It hides 5 flaws.

**Failure mode the checks target.** Keyed by sample, one run's results scatter over every partition;
without \`judge\` the warehouse counts a fallback score as judged; the output is tenant content in a
retained topic; a lost acknowledgement duplicates a result and a leader failover loses one; and a
refused produce is reported in the delivery report, which the \`try\` never sees.

Requirements:

- Key by **\`run_id\`**.
- The payload is \`{run_id, sample_id, model_version, score, passed, judge}\`; the output text is in
  neither the event nor a log line.
- The producer is **idempotent** with **\`acks=all\`** (Go uses confluent-kafka-go: kafka-go has no
  idempotent producer).
- Wait for the acknowledgement at most **2 s** (\`ACK_TIMEOUT_S\`); a failed delivery or no answer puts
  the event in the outbox (\`outbox.insert_outbox(event)\`) and returns \`False\`.`,
  sequence: {
    participants: ['Worker', 'eval.sample', 'outbox'],
    messages: [
      {
        from: 'Worker',
        to: 'eval.sample',
        label: 'produce key=run_id {run_id, sample_id, model_version, score, passed, judge}',
        kind: 'sync',
      },
      {from: 'eval.sample', to: 'Worker', label: 'ack (acks=all, idempotent) within 2 s → True', kind: 'reply'},
      {from: 'eval.sample', to: 'Worker', label: 'delivery error / no ack', kind: 'reply'},
      {from: 'Worker', to: 'outbox', label: 'insert_outbox(event) → False', kind: 'async'},
    ],
  },
  hints: [
    "Symptom: the warehouse shows one run's samples out of order and counts fallback scores as judged, a customer's message turns up in the topic, and after a broker restart one sample is missing while another appears twice.",
    "Mechanism: the key is the sample id; the payload copies the output and drops the judge; `acks=1` without idempotence trusts the leader alone; and a refusal arrives in the delivery report after `produce` returned, out of the `try`'s reach.",
    'Change: `key=sample.run_id`; payload `{run_id, sample_id, model_version, score, passed, judge}`; `enable.idempotence` with `acks=all`; an `on_delivery` callback and `flush(ACK_TIMEOUT_S)`; on an error or a record still in flight, `outbox.insert_outbox(event)` and return `False`.',
  ],
  checks: [
    {
      id: 'run-key',
      title: 'Keys eval.sample by the run id',
      detail:
        'Samples of runs r1, r2, r1 are keyed r1, r2, r1 and the two r1 samples share a partition. The starter keys by sample id, which spreads one run over every partition.',
      match: {
        python: {all: [/produce\([^)]*key\s*=\s*sample\.run_id/], none: [/key\s*=\s*sample\.sample_id/]},
        typescript: {all: [/key:\s*sample\.run_id/], none: [/key:\s*sample\.sample_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*sample\.RunID\s*\)/], none: [/Key:\s*\[\]byte\(\s*sample\.SampleID\s*\)/]},
        scala: {
          all: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*sample\.run_id\s*,/],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*sample\.sample_id\s*,/],
        },
        cpp: {
          all: [/sample\.run_id\.c_str\(\)\s*,\s*sample\.run_id\.(size|length)\(\)/],
          none: [/sample\.sample_id\.c_str\(\)\s*,\s*sample\.sample_id\.(size|length)\(\)/],
        },
      },
    },
    {
      id: 'event-payload',
      title: 'Carries the judge beside the score',
      detail:
        'The event is {run_id, sample_id, model_version, score, passed, judge}, so the warehouse can tell a judged score from a fallback one. The starter sends no judge.',
      match: {
        python: {all: [/["']judge["']\s*:\s*sample\.judge/]},
        typescript: {all: [/\bjudge:\s*sample\.judge/]},
        go: {all: [/json:"judge"|"judge":\s*sample\.Judge/]},
        scala: {all: [/"judge"\s*->\s*sample\.judge/]},
        cpp: {all: [/\{\s*"judge"\s*,\s*sample\.judge\s*\}/]},
      },
    },
    {
      id: 'no-output-text',
      title: 'No model output in the event, the outbox or the logs',
      detail:
        "Neither a record, an outbox row nor a log line carries the model's output: the topic is retained and replicated, so tenant content written there outlives the run. The starter copies it into the event and the log.",
      match: {
        python: {none: [/\boutput\b/i]},
        typescript: {none: [/\boutput\b/i]},
        go: {none: [/\boutput\b/i]},
        scala: {none: [/\boutput\b/i]},
        cpp: {none: [/\boutput\b/i]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'An idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter sets acks=1 and no idempotence.',
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
      title: 'Waits for the ack and falls back to the outbox',
      detail:
        'A failed delivery, or no acknowledgement within 2 s, leaves the event as an outbox row and publish returns false. The starter catches only a local produce error and returns true.',
      match: {
        python: {
          all: [/outbox\.insert_outbox\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/outbox\.insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/], none: [/case\s+\w+\s*:\s*KafkaException/]},
        cpp: {all: [/outbox::insert_outbox\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import KafkaException, Producer

from evals.config import PASS_SCORE, TOPIC
from evals.outbox import outbox
from evals.samples import ScoredSample

logger = logging.getLogger("evald.events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_result(sample: ScoredSample) -> bool:
    """Publish one scored sample for the results warehouse; True when the event is on its way."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "run_id": sample.run_id,
        "sample_id": sample.sample_id,
        "model_version": sample.model_version,
        "score": sample.score,
        "passed": sample.score >= PASS_SCORE,
        "output": sample.output,
    }
    logger.info("eval sample run=%s sample=%s output=%r", sample.run_id, sample.sample_id, sample.output)
    try:
        producer.produce(TOPIC, key=sample.sample_id, value=json.dumps(event))
        producer.poll(0)
    except KafkaException:
        outbox.insert_outbox(event)
        return False
    return True
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from evals.config import PASS_SCORE, TOPIC
from evals.outbox import outbox
from evals.samples import ScoredSample

logger = logging.getLogger("evald.events")

ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def publish_result(sample: ScoredSample) -> bool:
    """Publish one scored sample for the results warehouse; True once the broker acknowledged it."""
    event = {
        "run_id": sample.run_id,
        "sample_id": sample.sample_id,
        "model_version": sample.model_version,
        "score": sample.score,
        "passed": sample.score >= PASS_SCORE,
        "judge": sample.judge,
    }
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=sample.run_id, value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay republishes the row, so the warehouse is late, not short.
        outbox.insert_outbox(event)
        logger.warning("eval.sample not acknowledged run=%s sample=%s: %s", sample.run_id, sample.sample_id, outcome.get("error", "timed out"))
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {PASS_SCORE, TOPIC} from 'evals/config';
import {outbox} from 'evals/outbox';
import type {ScoredSample} from 'evals/samples';

const kafka = new Kafka({clientId: 'evald', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Publish one scored sample for the results warehouse; true when the event is on its way. */
export async function publishResult(sample: ScoredSample): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const event = {
    run_id: sample.run_id,
    sample_id: sample.sample_id,
    model_version: sample.model_version,
    score: sample.score,
    passed: sample.score >= PASS_SCORE,
    output: sample.output,
  };
  console.log(\`eval sample run=\${sample.run_id} sample=\${sample.sample_id} output=\${JSON.stringify(sample.output)}\`);
  try {
    void producer.send({topic: TOPIC, messages: [{key: sample.sample_id, value: JSON.stringify(event)}], acks: 1});
  } catch {
    await outbox.insertOutbox(event);
    return false;
  }
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {PASS_SCORE, TOPIC} from 'evals/config';
import {outbox} from 'evals/outbox';
import type {ScoredSample} from 'evals/samples';

export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'evald', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Publish one scored sample for the results warehouse; true once the broker acknowledged it. */
export async function publishResult(sample: ScoredSample): Promise<boolean> {
  const event = {
    run_id: sample.run_id,
    sample_id: sample.sample_id,
    model_version: sample.model_version,
    score: sample.score,
    passed: sample.score >= PASS_SCORE,
    judge: sample.judge,
  };
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: sample.run_id, value: JSON.stringify(event)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    // The broker did not take it: the relay republishes the row, so the warehouse is late, not short.
    await outbox.insertOutbox(event);
    console.warn(\`eval.sample not acknowledged run=\${sample.run_id} sample=\${sample.sample_id}: \${(err as Error).message}\`);
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

	"evals/config"  // config.Topic, config.PassScore — provided
	"evals/outbox"  // outbox.Insert(ctx, eventJSON) — provided
	"evals/samples" // samples.ScoredSample — provided
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

type sampleEvent struct {
	RunID        string  \`json:"run_id"\`
	SampleID     string  \`json:"sample_id"\`
	ModelVersion string  \`json:"model_version"\`
	Score        float64 \`json:"score"\`
	Passed       bool    \`json:"passed"\`
	Output       string  \`json:"output"\`
}

// publishResult publishes one scored sample for the results warehouse; true when the event is on its way.
func publishResult(ctx context.Context, sample samples.ScoredSample) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	event, _ := json.Marshal(sampleEvent{
		RunID:        sample.RunID,
		SampleID:     sample.SampleID,
		ModelVersion: sample.ModelVersion,
		Score:        sample.Score,
		Passed:       sample.Score >= config.PassScore,
		Output:       sample.Output,
	})
	log.Printf("eval sample run=%s sample=%s output=%q", sample.RunID, sample.SampleID, sample.Output)
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(sample.SampleID), Value: event}
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

	"evals/config"  // config.Topic, config.PassScore — provided
	"evals/outbox"  // outbox.Insert(ctx, eventJSON) — provided
	"evals/samples" // samples.ScoredSample — provided
)

const ackTimeout = 2 * time.Second

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

type sampleEvent struct {
	RunID        string  \`json:"run_id"\`
	SampleID     string  \`json:"sample_id"\`
	ModelVersion string  \`json:"model_version"\`
	Score        float64 \`json:"score"\`
	Passed       bool    \`json:"passed"\`
	Judge        string  \`json:"judge"\`
}

// publishResult publishes one scored sample for the results warehouse; true once the broker acknowledged it.
func publishResult(ctx context.Context, sample samples.ScoredSample) (bool, error) {
	event, _ := json.Marshal(sampleEvent{
		RunID:        sample.RunID,
		SampleID:     sample.SampleID,
		ModelVersion: sample.ModelVersion,
		Score:        sample.Score,
		Passed:       sample.Score >= config.PassScore,
		Judge:        sample.Judge,
	})
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(sample.RunID), Value: event}
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
		// The broker did not take it: the relay republishes the row, so the warehouse is late, not short.
		if err := outbox.Insert(ctx, event); err != nil {
			return false, err
		}
		log.Printf("eval.sample not acknowledged run=%s sample=%s: %v", sample.RunID, sample.SampleID, err)
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

import evals.{Config, Outbox, ScoredSample}

object ResultPublisher {
  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Publish one scored sample for the results warehouse; true when the event is on its way. */
  def publishResult(sample: ScoredSample): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val event = ujson.write(
      ujson.Obj(
        "run_id" -> sample.run_id,
        "sample_id" -> sample.sample_id,
        "model_version" -> sample.model_version,
        "score" -> sample.score,
        "passed" -> (sample.score >= Config.PassScore),
        "output" -> sample.output
      )
    )
    System.err.println(s"eval sample run=\${sample.run_id} sample=\${sample.sample_id} output=\${sample.output}")
    try {
      producer.send(new ProducerRecord[String, String](Config.Topic, sample.sample_id, event))
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

import evals.{Config, Outbox, ScoredSample}

object ResultPublisher {
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Publish one scored sample for the results warehouse; true once the broker acknowledged it. */
  def publishResult(sample: ScoredSample): Boolean = {
    val event = ujson.write(
      ujson.Obj(
        "run_id" -> sample.run_id,
        "sample_id" -> sample.sample_id,
        "model_version" -> sample.model_version,
        "score" -> sample.score,
        "passed" -> (sample.score >= Config.PassScore),
        "judge" -> sample.judge
      )
    )
    val record = new ProducerRecord[String, String](Config.Topic, sample.run_id, event)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay republishes the row, so the warehouse is late, not short.
      Outbox.insertOutbox(event)
      System.err.println(s"eval.sample not acknowledged run=\${sample.run_id} sample=\${sample.sample_id}")
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

#include "evals/config.h"   // config::kTopic, config::kPassScore — provided
#include "evals/outbox.h"   // outbox::insert_outbox(event_json) — provided
#include "evals/samples.h"  // samples::ScoredSample — provided

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Publish one scored sample for the results warehouse; true when the event is on its way.
bool publish_result(const samples::ScoredSample& sample) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string event = nlohmann::json{{"run_id", sample.run_id},
                                           {"sample_id", sample.sample_id},
                                           {"model_version", sample.model_version},
                                           {"score", sample.score},
                                           {"passed", sample.score >= config::kPassScore},
                                           {"output", sample.output}}
                                .dump();
  std::cerr << "eval sample run=" << sample.run_id << " sample=" << sample.sample_id << " output=" << sample.output << "\\n";
  const RdKafka::ErrorCode err =
      producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                        event.size(), sample.sample_id.c_str(), sample.sample_id.size(), 0, nullptr);
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

#include "evals/config.h"   // config::kTopic, config::kPassScore — provided
#include "evals/outbox.h"   // outbox::insert_outbox(event_json) — provided
#include "evals/samples.h"  // samples::ScoredSample — provided

constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publish_result produces one record and waits for it.
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
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Publish one scored sample for the results warehouse; true once the broker acknowledged it.
bool publish_result(const samples::ScoredSample& sample) {
  const std::string event = nlohmann::json{{"run_id", sample.run_id},
                                           {"sample_id", sample.sample_id},
                                           {"model_version", sample.model_version},
                                           {"score", sample.score},
                                           {"passed", sample.score >= config::kPassScore},
                                           {"judge", sample.judge}}
                                .dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                        event.size(), sample.run_id.c_str(), sample.run_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay republishes the row, so the warehouse is late, not short.
    outbox::insert_outbox(event);
    std::cerr << "eval.sample not acknowledged run=" << sample.run_id << " sample=" << sample.sample_id << "\\n";
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json
import logging

from evals.samples import ScoredSample

TOPIC = "eval.sample"
SECRET = "account 4417-2290"
OUTPUT = f"Your refund for {SECRET} was approved."


def _sample(sample_id="s-1", run_id="r1", score=0.75, judge="model"):
    return ScoredSample(run_id=run_id, sample_id=sample_id, model_version="support-bot-2026-10", score=score, judge=judge, output=OUTPUT)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("evals:outbox", 0, -1)]


def check_run_key(ctx):
    m = ctx.load("events")
    m.publish_result(_sample("s-1", "r1"))
    m.publish_result(_sample("s-2", "r2"))
    m.publish_result(_sample("s-3", "r1"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three published samples produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"r1", b"r2", b"r1"], f"the records are keyed {keys}, expected the run ids r1, r2, r1: keyed by sample, one run's results scatter over every partition"
    assert records[0].partition == records[2].partition, "both r1 samples must land on one partition, or the warehouse folds the run out of order"


def check_event_payload(ctx):
    m = ctx.load("events")
    m.publish_result(_sample("s-1", score=1.0, judge="fallback"))
    m.publish_result(_sample("s-2", score=0.25, judge="model"))
    events = _events(ctx)
    assert len(events) == 2, f"two published samples produced {len(events)} records"
    expected = {"run_id": "r1", "sample_id": "s-1", "model_version": "support-bot-2026-10", "score": 1.0, "passed": True, "judge": "fallback"}
    for key, value in expected.items():
        assert events[0].get(key) == value, f"the event must carry {key}={value!r}, got {events[0]}"
    assert events[1].get("passed") is False and events[1].get("judge") == "model", f"a 0.25 judged by the model is passed false, judge model: {events[1]}"


def check_no_output_text(ctx):
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
        m.publish_result(_sample("s-1"))
        m.publish_result(_sample("s-2"))
    finally:
        logging.getLogger().removeHandler(capture)
    for value in ctx.kafka.values(TOPIC):
        assert SECRET.encode() not in value, f"the event carries the model's output: {value!r}; the topic is retained and replicated, ids and scores only"
        assert "output" not in json.loads(value), f"the event has an output field: {value!r}"
    for row in ctx.redis.lrange("evals:outbox", 0, -1):
        assert SECRET not in row, f"the outbox row carries the model's output: {row}"
    for line in capture.lines:
        assert SECRET not in line, f"a log line carries the model's output: {line!r}"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_result(_sample("s-1"))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the sample twice. Enable idempotence"
    m.publish_result(_sample("s-2"))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_result(_sample("s-1"))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the sample is missing from the warehouse for good"
    assert rows[0].get("run_id") == "r1" and rows[0].get("sample_id") == "s-1", f"the outbox row must be the event itself, got {rows[0]}"
    assert ok is False, f"publish_result returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_result(_sample("s-2"))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_result waited {waited:.0f} s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("sample_id") == "s-2", f"no acknowledgement within the window and the outbox holds {rows}"
    assert ok is False, f"publish_result returned {ok!r} without an acknowledgement, expected False"
`,
    typescript: `const TOPIC = 'eval.sample';
const SECRET = 'account 4417-2290';
const OUTPUT = \`Your refund for \${SECRET} was approved.\`;

const sample = (sampleId = 's-1', runId = 'r1', score = 0.75, judge = 'model') => ({
  run_id: runId,
  sample_id: sampleId,
  model_version: 'support-bot-2026-10',
  score,
  judge,
  output: OUTPUT,
});

const events = ctx => (ctx.kafka.values(TOPIC) as string[]).map(v => JSON.parse(v));
const outboxRows = ctx => (ctx.redis.lrange('evals:outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_run_key(ctx) {
  const m = ctx.load('events');
  await m.publishResult(sample('s-1', 'r1'));
  await m.publishResult(sample('s-2', 'r2'));
  await m.publishResult(sample('s-3', 'r1'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three published samples produced \${records.length} records on \${TOPIC}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['r1', 'r2', 'r1'], \`the records are keyed \${JSON.stringify(keys)}, expected the run ids r1, r2, r1: keyed by sample, one run's results scatter over every partition\`);
  assert.equal(records[0].partition, records[2].partition, 'both r1 samples must land on one partition, or the warehouse folds the run out of order');
}

export async function check_event_payload(ctx) {
  const m = ctx.load('events');
  await m.publishResult(sample('s-1', 'r1', 1.0, 'fallback'));
  await m.publishResult(sample('s-2', 'r1', 0.25, 'model'));
  await settle();
  const all = events(ctx);
  assert.equal(all.length, 2, \`two published samples produced \${all.length} records\`);
  const expected = {run_id: 'r1', sample_id: 's-1', model_version: 'support-bot-2026-10', score: 1, passed: true, judge: 'fallback'};
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(all[0][key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${JSON.stringify(all[0])}\`);
  assert(all[1].passed === false && all[1].judge === 'model', \`a 0.25 judged by the model is passed false, judge model: \${JSON.stringify(all[1])}\`);
}

export async function check_no_output_text(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  await m.publishResult(sample('s-1'));
  await m.publishResult(sample('s-2'));
  await settle();
  for (const value of ctx.kafka.values(TOPIC) as string[]) {
    assert(!value.includes(SECRET), \`the event carries the model's output: \${value}; the topic is retained and replicated, ids and scores only\`);
    assert(!('output' in JSON.parse(value)), \`the event has an output field: \${value}\`);
  }
  for (const row of ctx.redis.lrange('evals:outbox', 0, -1) as string[]) assert(!row.includes(SECRET), \`the outbox row carries the model's output: \${row}\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishResult(sample('s-1'));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the sample twice. Enable idempotence\`);
  await m.publishResult(sample('s-2'));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishResult(sample('s-1'));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the sample is missing from the warehouse for good\`);
  assert(rows[0].run_id === 'r1' && rows[0].sample_id === 's-1', \`the outbox row must be the event itself, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ok, false, \`publishResult resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishResult(sample('s-2'));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishResult waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].sample_id === 's-2', \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishResult resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"evals/samples"

	"leetbuild/harness"
)

const (
	eventsTopic  = "eval.sample"
	eventsSecret = "account 4417-2290"
)

func eventsSample(sampleID, runID string, score float64, judge string) samples.ScoredSample {
	return samples.ScoredSample{RunID: runID, SampleID: sampleID, ModelVersion: "support-bot-2026-10", Score: score, Judge: judge, Output: "Your refund for " + eventsSecret + " was approved."}
}

func eventsPublish(ctx *harness.Ctx, s samples.ScoredSample) bool {
	ok, err := publishResult(context.Background(), s)
	ctx.NoError(err, "publishResult(%s)", s.SampleID)
	return ok
}

func eventsAll(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, v := range ctx.Kafka.Values(eventsTopic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(v), &e), "the event is JSON: %s", v)
		out = append(out, e)
	}
	return out
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, row := range ctx.Redis.LRange("evals:outbox", 0, -1) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(row), &e), "the outbox row is JSON: %s", row)
		out = append(out, e)
	}
	return out
}

func CheckRunKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsSample("s-1", "r1", 0.75, "model"))
	eventsPublish(ctx, eventsSample("s-2", "r2", 0.75, "model"))
	eventsPublish(ctx, eventsSample("s-3", "r1", 0.75, "model"))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three published samples must produce three records on %s; the records", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"r1", "r2", "r1"}, "the records must be keyed by the run ids (keyed by sample, one run's results scatter over every partition)")
	ctx.Equal(records[0].Partition, records[2].Partition, "both r1 samples must land on one partition, or the warehouse folds the run out of order; the partitions")
}

func CheckEventPayload(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsSample("s-1", "r1", 1.0, "fallback"))
	eventsPublish(ctx, eventsSample("s-2", "r1", 0.25, "model"))
	ctx.Settle()
	all := eventsAll(ctx)
	ctx.Equal(len(all), 2, "two published samples; records")
	for key, value := range map[string]any{"run_id": "r1", "sample_id": "s-1", "model_version": "support-bot-2026-10", "score": 1.0, "passed": true, "judge": "fallback"} {
		ctx.Equal(all[0][key], value, "the event's %s (%v)", key, all[0])
	}
	ctx.Assert(all[1]["passed"] == false && all[1]["judge"] == "model", "a 0.25 judged by the model is passed false, judge model: %v", all[1])
}

func CheckNoOutputText(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	eventsPublish(ctx, eventsSample("s-1", "r1", 0.75, "model"))
	eventsPublish(ctx, eventsSample("s-2", "r1", 0.75, "model"))
	ctx.Settle()
	for _, value := range ctx.Kafka.Values(eventsTopic) {
		ctx.Assert(!strings.Contains(value, eventsSecret), "the event carries the model's output: %s; the topic is retained and replicated, ids and scores only", value)
		var e map[string]any
		json.Unmarshal([]byte(value), &e)
		_, has := e["output"]
		ctx.Assert(!has, "the event has an output field: %s", value)
	}
	for _, row := range ctx.Redis.LRange("evals:outbox", 0, -1) {
		ctx.Assert(!strings.Contains(row, eventsSecret), "the outbox row carries the model's output: %s", row)
	}
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsSample("s-1", "r1", 0.75, "model"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the sample twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsSample("s-2", "r1", 0.75, "model"))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, eventsSample("s-1", "r1", 0.75, "model"))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the sample is missing from the warehouse for good; the rows")
	ctx.Assert(rows[0]["run_id"] == "r1" && rows[0]["sample_id"] == "s-1", "the outbox row must be the event itself, got %v", rows[0])
	ctx.Equal(ok, false, "publishResult's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsSample("s-2", "r1", 0.75, "model"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishResult waited %.0f s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1]["sample_id"] == "s-2", "no acknowledgement within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishResult's result without an acknowledgement")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "eval.sample";
const std::string kSecret = "account 4417-2290";

samples::ScoredSample eventsSample(const std::string& sample_id, const std::string& run_id = "r1", double score = 0.75, const std::string& judge = "model") {
  return {run_id, sample_id, "support-bot-2026-10", score, judge, "Your refund for " + kSecret + " was approved."};
}

std::vector<nlohmann::json> eventsAll(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& v : ctx.Kafka.Values(kEventsTopic)) out.push_back(nlohmann::json::parse(v, nullptr, false));
  return out;
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& row : ctx.Redis.LRange("evals:outbox", 0, -1)) out.push_back(nlohmann::json::parse(row, nullptr, false));
  return out;
}

std::string eventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckRunKey(harness::Ctx& ctx) {
  publish_result(eventsSample("s-1", "r1"));
  publish_result(eventsSample("s-2", "r2"));
  publish_result(eventsSample("s-3", "r1"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three published samples must produce three records on %s; the records", kEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"r1", "r2", "r1"}, "the records must be keyed by the run ids (keyed by sample, one run's results scatter over every partition)");
  ctx.Equal(records[0].Partition, records[2].Partition, "both r1 samples must land on one partition, or the warehouse folds the run out of order; the partitions");
}

void CheckEventPayload(harness::Ctx& ctx) {
  publish_result(eventsSample("s-1", "r1", 1.0, "fallback"));
  publish_result(eventsSample("s-2", "r1", 0.25, "model"));
  ctx.Settle();
  const auto all = eventsAll(ctx);
  ctx.Equal(all.size(), 2, "two published samples; records");
  const nlohmann::json expected = {{"run_id", "r1"}, {"sample_id", "s-1"}, {"model_version", "support-bot-2026-10"}, {"score", 1.0}, {"passed", true}, {"judge", "fallback"}};
  for (const auto& [key, value] : expected.items()) {
    ctx.Equal(all[0].is_object() && all[0].contains(key) ? all[0][key] : nlohmann::json(), value, "the event's %s (%s)", key, all[0].dump());
  }
  ctx.Assert(all[1].value("passed", true) == false && eventsField(all[1], "judge") == "model", "a 0.25 judged by the model is passed false, judge model: %s", all[1].dump());
}

void CheckNoOutputText(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  publish_result(eventsSample("s-1"));
  publish_result(eventsSample("s-2"));
  ctx.Settle();
  for (const auto& value : ctx.Kafka.Values(kEventsTopic)) {
    ctx.Assert(value.find(kSecret) == std::string::npos, "the event carries the model's output: %s; the topic is retained and replicated, ids and scores only", value);
    const auto e = nlohmann::json::parse(value, nullptr, false);
    ctx.Assert(!e.is_object() || !e.contains("output"), "the event has an output field: %s", value);
  }
  for (const auto& row : ctx.Redis.LRange("evals:outbox", 0, -1)) {
    ctx.Assert(row.find(kSecret) == std::string::npos, "the outbox row carries the model's output: %s", row);
  }
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publish_result(eventsSample("s-1"));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the sample twice (enable.idempotence); the records");
  publish_result(eventsSample("s-2"));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publish_result(eventsSample("s-1"));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the sample is missing from the warehouse for good; the rows");
  ctx.Assert(!rows.empty() && eventsField(rows[0], "run_id") == "r1" && eventsField(rows[0], "sample_id") == "s-1", "the outbox row must be the event itself, got %s", rows.empty() ? std::string("none") : rows[0].dump());
  ctx.Equal(ok, false, "publish_result's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publish_result(eventsSample("s-2"));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publish_result waited %.0f s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && eventsField(rows[1], "sample_id") == "s-2", "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publish_result's result without an acknowledgement");
}
`,
  },
  debrief: `The key is an ordering contract: the warehouse folds a run's samples in partition order, so the run id, not the sample, picks the partition. The payload carries what a consumer needs to weigh the number, which is why \`judge\` matters more than the text; the text stays out because a topic is retained and replicated, and what goes in outlives the run. Waiting for the acknowledgement gives the return value a meaning, and the outbox turns a broker outage into a delay instead of a gap in the run. Idempotence closes the one hole that waiting opens, the retry after a lost acknowledgement. Production pipelines also register the event's schema so no producer adds a field silently, and drain the outbox with the same idempotent producer.`,
};
