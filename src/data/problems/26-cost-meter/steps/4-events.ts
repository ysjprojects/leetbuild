import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'billing.usage: keyed by tenant, deduplicable, never lost quietly',
  concept: 'kafka',
  file: 'events',
  focus: ['meter', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter's \`publish_usage(usage)\` takes the provided \`UsageRecord\` (ids, the
idempotency key, tenant, model, counts, cost, rate version, and the completion text the meter still
holds), produces a JSON event to \`billing.usage\` keyed by model from a producer set to \`acks=1\`, logs
the completion, and returns \`True\`. The demo shows events reaching the ledger. It hides five flaws.

**Failure mode the checks target.** Keyed by model, one tenant's charges spread over partitions and the
ledger applies them out of order. Without the idempotency key in the event, the ledger cannot tell a
producer retry or an outbox replay from a second charge. With \`acks=1\` a leader failover loses
acknowledged charges, and without idempotence a lost ack writes one twice. A refused produce is gone.

Requirements:

- Key every record by **\`tenant_id\`**.
- The event is \`{usage_id, idempotency_key, tenant_id, model, input_tokens, output_tokens, cost_micros,
  rate_version}\`; the completion text appears in no event, outbox row or log line.
- An **idempotent** producer with **\`acks=all\`** (Go uses confluent-kafka-go: kafka-go has no
  idempotent producer).
- Wait for the delivery report at most **2 s** (\`ACK_TIMEOUT_S\`); a failed or missing report puts the
  event in the provided \`outbox\` and returns \`False\`.`,
  sequence: {
    participants: ['meterd', 'billing.usage', 'outbox'],
    messages: [
      {
        from: 'meterd',
        to: 'billing.usage',
        label: 'produce key=tenant_id {usage_id, idempotency_key, cost_micros, rate_version}',
        kind: 'async',
      },
      {from: 'billing.usage', to: 'meterd', label: 'delivery report: error (or none in 2 s)', kind: 'reply'},
      {from: 'meterd', to: 'outbox', label: 'insert_outbox(event)', kind: 'sync'},
    ],
  },
  hints: [
    "Symptom: one tenant's ledger lines arrive out of order, a broker hiccup bills a report twice or not at all, and a customer's completion text turns up in the billing topic.",
    'Mechanism: the key is the model; the payload carries output_text but no idempotency key; the producer runs acks=1 without idempotence; and nothing reads the delivery report, so a refusal is silent.',
    'Change: `key=usage.tenant_id`; drop output_text, add idempotency_key; `enable.idempotence` + `acks=all`; an `on_delivery` that records the error, `flush(ACK_TIMEOUT_S)`, then `outbox.insert_outbox(event)` and `False` on an error or a timeout.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Keys the event by tenant',
      detail:
        "Every record on billing.usage is keyed by tenant_id, so one tenant's charges share a partition and an order. The starter keys by model.",
      match: {
        python: {all: [/produce\([^)]*key\s*=\s*\w+\.tenant_id/], none: [/key\s*=\s*\w+\.model/]},
        typescript: {all: [/key:\s*\w+\.tenant_id/], none: [/key:\s*\w+\.model/]},
        go: {all: [/Key:\s*\[\]byte\(\s*\w+\.TenantID\s*\)/], none: [/Key:\s*\[\]byte\(\s*\w+\.Model\s*\)/]},
        scala: {
          all: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*\w+\.tenant_id\s*,/],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*\w+\.model\s*,/],
        },
        cpp: {
          all: [/produce\([\s\S]{0,400}?tenant_id\.(c_str|data)\(\)/],
          none: [/produce\([\s\S]{0,400}?model\.(c_str|data)\(\)/],
        },
      },
    },
    {
      id: 'idempotency-key',
      title: 'Carries the idempotency key and the rate version',
      detail:
        'The event carries idempotency_key beside usage_id, tenant_id, model, both counts, cost_micros and rate_version, so the ledger can drop a replay and a disputed charge traces to a rate table. The starter ships no idempotency key.',
      match: {
        python: {all: [/["']idempotency_key["']\s*:/]},
        typescript: {all: [/idempotency_key:/]},
        go: {all: [/json:"idempotency_key"/]},
        scala: {all: [/"idempotency_key"\s*->/]},
        cpp: {all: [/\{"idempotency_key",/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Uses an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover. The starter sets acks=1 and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Writes an outbox row from the delivery report',
      detail:
        'A refused produce, or no report within 2 s, leaves the event in the outbox and publish_usage returns false; a healthy produce adds no row. The starter never looks at the delivery report.',
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /outbox\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/outbox\.insertOutbox\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/outbox::insert_outbox\(/, /dr_cb/]},
      },
    },
    {
      id: 'no-content',
      title: 'No completion text in the event, the outbox or the logs',
      detail:
        'Neither the payload, an outbox row nor a log line carries the completion: the topic is retained and replicated, so tenant content written there outlives every retention promise. The starter copies it into the event and the log.',
      match: {
        python: {none: [/output_text/]},
        typescript: {none: [/output_text/]},
        go: {none: [/OutputText/]},
        scala: {none: [/output_text/]},
        cpp: {none: [/output_text/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from meter.config import TOPIC
from meter.records import UsageRecord

logger = logging.getLogger("meter.events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_usage(usage: UsageRecord) -> bool:
    """Hand one priced report to billing; True once it is on its way."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "usage_id": usage.usage_id,
        "tenant_id": usage.tenant_id,
        "model": usage.model,
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cost_micros": usage.cost_micros,
        "rate_version": usage.rate_version,
        "output_text": usage.output_text,
    }
    logger.info("billing usage tenant=%s completion=%r", usage.tenant_id, usage.output_text)
    producer.produce(TOPIC, key=usage.model, value=json.dumps(event))
    producer.poll(0)
    return True
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from meter.config import TOPIC
from meter.outbox import outbox
from meter.records import UsageRecord

logger = logging.getLogger("meter.events")

ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def publish_usage(usage: UsageRecord) -> bool:
    """Hand one priced report to billing; True once the broker acknowledged it, False when it went to the outbox."""
    event = {
        "usage_id": usage.usage_id,
        "idempotency_key": usage.idempotency_key,
        "tenant_id": usage.tenant_id,
        "model": usage.model,
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cost_micros": usage.cost_micros,
        "rate_version": usage.rate_version,
    }
    outcome = {}

    def on_delivery(err, msg) -> None:
        outcome["error"] = err

    producer.produce(TOPIC, key=usage.tenant_id, value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The relay republishes it; if the broker took it after all, the ledger drops the copy by idempotency_key.
        outbox.insert_outbox(event)
        logger.warning("billing.usage not acknowledged tenant=%s usage=%s", usage.tenant_id, usage.usage_id)
        return False
    logger.info("billing usage tenant=%s usage=%s cost_micros=%d", usage.tenant_id, usage.usage_id, usage.cost_micros)
    return True
`,
    },
    typescript: {
      starter: `import {Kafka, type Producer} from 'kafkajs';

import {TOPIC} from 'meter/config';
import type {UsageRecord} from 'meter/records';

const kafka = new Kafka({clientId: 'meterd', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer();
void producer.connect();

/** Hand one priced report to billing; true once it is on its way. */
export async function publishUsage(usage: UsageRecord): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const event = {
    usage_id: usage.usage_id,
    tenant_id: usage.tenant_id,
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost_micros: usage.cost_micros,
    rate_version: usage.rate_version,
    output_text: usage.output_text,
  };
  console.log(\`billing usage tenant=\${usage.tenant_id} completion=\${JSON.stringify(usage.output_text)}\`);
  void producer.send({topic: TOPIC, messages: [{key: usage.model, value: JSON.stringify(event)}], acks: 1});
  return true;
}
`,
      solution: `import {Kafka, type Producer} from 'kafkajs';

import {TOPIC} from 'meter/config';
import {outbox} from 'meter/outbox';
import type {UsageRecord} from 'meter/records';

export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'meterd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer: Producer = kafka.producer({idempotent: true});
void producer.connect();

/** Hand one priced report to billing; true once the broker acknowledged it, false when it went to the outbox. */
export async function publishUsage(usage: UsageRecord): Promise<boolean> {
  const event = {
    usage_id: usage.usage_id,
    idempotency_key: usage.idempotency_key,
    tenant_id: usage.tenant_id,
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost_micros: usage.cost_micros,
    rate_version: usage.rate_version,
  };
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: usage.tenant_id, value: JSON.stringify(event)}], acks: -1, timeout: ACK_TIMEOUT_MS});
  } catch (err) {
    // The relay republishes it; if the broker took it after all, the ledger drops the copy by idempotency_key.
    await outbox.insertOutbox(event);
    console.warn(\`billing.usage not acknowledged tenant=\${usage.tenant_id} usage=\${usage.usage_id}: \${(err as Error).message}\`);
    return false;
  }
  console.log(\`billing usage tenant=\${usage.tenant_id} usage=\${usage.usage_id} cost_micros=\${usage.cost_micros}\`);
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"meter/config"  // config.Topic — provided
	"meter/records" // records.UsageRecord — provided
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// publishUsage hands one priced report to billing; true once it is on its way.
func publishUsage(ctx context.Context, usage records.UsageRecord) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(map[string]any{
		"usage_id":      usage.UsageID,
		"tenant_id":     usage.TenantID,
		"model":         usage.Model,
		"input_tokens":  usage.InputTokens,
		"output_tokens": usage.OutputTokens,
		"cost_micros":   usage.CostMicros,
		"rate_version":  usage.RateVersion,
		"output_text":   usage.OutputText,
	})
	log.Printf("billing usage tenant=%s completion=%q", usage.TenantID, usage.OutputText)
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(usage.Model), Value: value}
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

	"meter/config"  // config.Topic — provided
	"meter/outbox"  // outbox.Insert(ctx, eventJSON) — provided
	"meter/records" // records.UsageRecord — provided
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

type usageEvent struct {
	UsageID        string \`json:"usage_id"\`
	IdempotencyKey string \`json:"idempotency_key"\`
	TenantID       string \`json:"tenant_id"\`
	Model          string \`json:"model"\`
	InputTokens    int64  \`json:"input_tokens"\`
	OutputTokens   int64  \`json:"output_tokens"\`
	CostMicros     int64  \`json:"cost_micros"\`
	RateVersion    string \`json:"rate_version"\`
}

// publishUsage hands one priced report to billing; true once the broker acknowledged it, false when it went to the outbox.
func publishUsage(ctx context.Context, usage records.UsageRecord) (bool, error) {
	value, _ := json.Marshal(usageEvent{
		UsageID:        usage.UsageID,
		IdempotencyKey: usage.IdempotencyKey,
		TenantID:       usage.TenantID,
		Model:          usage.Model,
		InputTokens:    usage.InputTokens,
		OutputTokens:   usage.OutputTokens,
		CostMicros:     usage.CostMicros,
		RateVersion:    usage.RateVersion,
	})
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(usage.TenantID), Value: value}
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
		// The relay republishes it; if the broker took it after all, the ledger drops the copy by idempotency_key.
		if err := outbox.Insert(ctx, value); err != nil {
			return false, err
		}
		log.Printf("billing.usage not acknowledged tenant=%s usage=%s: %v", usage.TenantID, usage.UsageID, err)
		return false, nil
	}
	log.Printf("billing usage tenant=%s usage=%s cost_micros=%d", usage.TenantID, usage.UsageID, usage.CostMicros)
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import meter.{Config, UsageRecord}

object UsagePublisher {
  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Hand one priced report to billing; true once it is on its way. */
  def publishUsage(usage: UsageRecord): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val event = ujson.write(
      ujson.Obj(
        "usage_id" -> usage.usage_id,
        "tenant_id" -> usage.tenant_id,
        "model" -> usage.model,
        "input_tokens" -> usage.input_tokens.toDouble,
        "output_tokens" -> usage.output_tokens.toDouble,
        "cost_micros" -> usage.cost_micros.toDouble,
        "rate_version" -> usage.rate_version,
        "output_text" -> usage.output_text
      )
    )
    System.err.println(s"billing usage tenant=\${usage.tenant_id} completion=\${usage.output_text}")
    producer.send(new ProducerRecord[String, String](Config.Topic, usage.model, event))
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import meter.{Config, Outbox, UsageRecord}

object UsagePublisher {
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Hand one priced report to billing; true once the broker acknowledged it, false when it went to the outbox. */
  def publishUsage(usage: UsageRecord): Boolean = {
    val event = ujson.write(
      ujson.Obj(
        "usage_id" -> usage.usage_id,
        "idempotency_key" -> usage.idempotency_key,
        "tenant_id" -> usage.tenant_id,
        "model" -> usage.model,
        "input_tokens" -> usage.input_tokens.toDouble,
        "output_tokens" -> usage.output_tokens.toDouble,
        "cost_micros" -> usage.cost_micros.toDouble,
        "rate_version" -> usage.rate_version
      )
    )
    val record = new ProducerRecord[String, String](Config.Topic, usage.tenant_id, event)
    // The send's future completes with the delivery report: a refusal fails it, silence times it out.
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The relay republishes it; if the broker took it after all, the ledger drops the copy by idempotency_key.
      Outbox.insertOutbox(event)
      System.err.println(s"billing.usage not acknowledged tenant=\${usage.tenant_id} usage=\${usage.usage_id}")
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

#include "meter/config.h"   // config::kTopic — provided
#include "meter/records.h"  // records::UsageRecord — provided

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Hand one priced report to billing; true once it is on its way.
bool publish_usage(const records::UsageRecord& usage) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string event = nlohmann::json{{"usage_id", usage.usage_id},
                                           {"tenant_id", usage.tenant_id},
                                           {"model", usage.model},
                                           {"input_tokens", usage.input_tokens},
                                           {"output_tokens", usage.output_tokens},
                                           {"cost_micros", usage.cost_micros},
                                           {"rate_version", usage.rate_version},
                                           {"output_text", usage.output_text}}
                                .dump();
  std::cerr << "billing usage tenant=" << usage.tenant_id << " completion=" << usage.output_text << "\\n";
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(event.data()), event.size(), usage.model.c_str(), usage.model.size(), 0, nullptr);
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "meter/config.h"   // config::kTopic — provided
#include "meter/outbox.h"   // outbox::insert_outbox(event_json) — provided
#include "meter/records.h"  // records::UsageRecord — provided

constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publish_usage produces one record and waits for it.
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

// Hand one priced report to billing; true once the broker acknowledged it, false when it went to the outbox.
bool publish_usage(const records::UsageRecord& usage) {
  const std::string event = nlohmann::json{{"usage_id", usage.usage_id},
                                           {"idempotency_key", usage.idempotency_key},
                                           {"tenant_id", usage.tenant_id},
                                           {"model", usage.model},
                                           {"input_tokens", usage.input_tokens},
                                           {"output_tokens", usage.output_tokens},
                                           {"cost_micros", usage.cost_micros},
                                           {"rate_version", usage.rate_version}}
                                .dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                        event.size(), usage.tenant_id.c_str(), usage.tenant_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The relay republishes it; if the broker took it after all, the ledger drops the copy by idempotency_key.
    outbox::insert_outbox(event);
    std::cerr << "billing.usage not acknowledged tenant=" << usage.tenant_id << " usage=" << usage.usage_id << "\\n";
    return false;
  }
  std::cerr << "billing usage tenant=" << usage.tenant_id << " usage=" << usage.usage_id << " cost_micros=" << usage.cost_micros << "\\n";
  return true;
}
`,
    },
  },
  harness: {
    python: `import json
import logging

from meter.records import UsageRecord

TOPIC = "billing.usage"
TEXT = "Your refund for order 4417 was approved on Monday."
VERSION = "rates-2026-11-01"


def _usage(n=1, tenant="t1", model="gpt-4o"):
    return UsageRecord(usage_id=f"u-{n}", idempotency_key=f"k-{n}", tenant_id=tenant, model=model, input_tokens=1200, output_tokens=300, cost_micros=6000, rate_version=VERSION, output_text=TEXT)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("billing:outbox", 0, -1)]


def check_tenant_key(ctx):
    m = ctx.load("events")
    m.publish_usage(_usage(1, "t1", "gpt-4o"))
    m.publish_usage(_usage(2, "t2", "gpt-4o"))
    m.publish_usage(_usage(3, "t1", "gpt-4o-mini"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three reports produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"t1", b"t2", b"t1"], f"the records are keyed {keys}, expected the tenant ids t1, t2, t1: keyed by model, one tenant's charges spread over partitions"
    assert records[0].partition == records[2].partition, "both t1 events must land on one partition, or the ledger applies t1's charges out of order"


def check_idempotency_key(ctx):
    m = ctx.load("events")
    m.publish_usage(_usage(7))
    events = _events(ctx)
    assert len(events) == 1, f"one report produced {len(events)} records"
    expected = {"usage_id": "u-7", "idempotency_key": "k-7", "tenant_id": "t1", "model": "gpt-4o", "input_tokens": 1200, "output_tokens": 300, "cost_micros": 6000, "rate_version": VERSION}
    for key, value in expected.items():
        assert events[0].get(key) == value, f"the event must carry {key}={value!r}, got {events[0]}: without the idempotency key the ledger cannot tell a retry from a second charge"


def check_idempotent_acks(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_usage(_usage(1))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry billed the report twice. Enable idempotence"
    m.publish_usage(_usage(2))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost a charge the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_fallback(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        ok = m.publish_usage(_usage(1))
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"publish_usage raised when the broker refused the produce: {e!r}; the event goes to the outbox") from e
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused one produce and the outbox holds {len(rows)} rows: a refused charge must be kept for the relay, not dropped"
    assert rows[0].get("usage_id") == "u-1" and rows[0].get("idempotency_key") == "k-1", f"the outbox row must be the event itself, got {rows[0]}"
    assert ok is False, f"publish_usage returned {ok!r} after a refused produce, expected False"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused produce"
    assert m.publish_usage(_usage(2)) is True, "a healthy produce returns True"
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(_outbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_usage(_usage(3))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_usage waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("usage_id") == "u-3", f"no report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_usage returned {ok!r} without a delivery report, expected False"


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
        m.publish_usage(_usage(1))
        m.publish_usage(_usage(2))
    finally:
        logging.getLogger().removeHandler(capture)
    assert ctx.kafka.records(TOPIC), "the healthy report must reach the topic"
    for value in ctx.kafka.values(TOPIC):
        assert b"order 4417" not in value, f"the event carries the completion text: {value!r}; the topic is retained and replicated"
        assert "output_text" not in json.loads(value), f"the event has an output_text field: {value!r}"
    for row in ctx.redis.lrange("billing:outbox", 0, -1):
        assert "order 4417" not in row, f"the outbox row carries the completion text: {row}"
    for line in capture.lines:
        assert "order 4417" not in line, f"a log line carries the completion text: {line!r}"
`,
    typescript: `const TOPIC = 'billing.usage';
const TEXT = 'Your refund for order 4417 was approved on Monday.';
const VERSION = 'rates-2026-11-01';

const usage = (n = 1, tenant = 't1', model = 'gpt-4o') => ({
  usage_id: \`u-\${n}\`, idempotency_key: \`k-\${n}\`, tenant_id: tenant, model, input_tokens: 1200, output_tokens: 300, cost_micros: 6000, rate_version: VERSION, output_text: TEXT,
});

const events = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));
const outboxRows = ctx => ctx.redis.lrange('billing:outbox', 0, -1).map(row => JSON.parse(row));

export async function check_tenant_key(ctx) {
  const m = ctx.load('events');
  await m.publishUsage(usage(1, 't1', 'gpt-4o'));
  await m.publishUsage(usage(2, 't2', 'gpt-4o'));
  await m.publishUsage(usage(3, 't1', 'gpt-4o-mini'));
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three reports produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepEqual(keys, ['t1', 't2', 't1'], \`the records are keyed \${JSON.stringify(keys)}, expected the tenant ids t1, t2, t1: keyed by model, one tenant's charges spread over partitions\`);
  assert.equal(records[0].partition, records[2].partition, "both t1 events must land on one partition, or the ledger applies t1's charges out of order");
}

export async function check_idempotency_key(ctx) {
  const m = ctx.load('events');
  await m.publishUsage(usage(7));
  const all = events(ctx);
  assert.equal(all.length, 1, \`one report produced \${all.length} records\`);
  const expected = {usage_id: 'u-7', idempotency_key: 'k-7', tenant_id: 't1', model: 'gpt-4o', input_tokens: 1200, output_tokens: 300, cost_micros: 6000, rate_version: VERSION};
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(all[0][key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${JSON.stringify(all[0])}: without the idempotency key the ledger cannot tell a retry from a second charge\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishUsage(usage(1));
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry billed the report twice. Use idempotent: true\`);
  await m.publishUsage(usage(2));
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost a charge the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_fallback(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok;
  try {
    ok = await m.publishUsage(usage(1));
  } catch (e) {
    assert.fail(\`publishUsage rejected when the broker refused the produce: \${e}; the event goes to the outbox\`);
  }
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused one produce and the outbox holds \${rows.length} rows: a refused charge must be kept for the relay, not dropped\`);
  assert(rows[0].usage_id === 'u-1' && rows[0].idempotency_key === 'k-1', \`the outbox row must be the event itself, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ok, false, \`publishUsage resolved \${ok} after a refused produce, expected false\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused produce');
  assert.equal(await m.publishUsage(usage(2)), true, 'a healthy produce resolves true');
  assert(ctx.kafka.records(TOPIC).length === 1 && outboxRows(ctx).length === 1, 'a healthy produce after the failure reaches the topic and adds no outbox row');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishUsage(usage(3));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishUsage waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].usage_id === 'u-3', \`no report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishUsage resolved \${ok} without a delivery report, expected false\`);
}

export async function check_no_content(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  await m.publishUsage(usage(1));
  await m.publishUsage(usage(2));
  assert(ctx.kafka.records(TOPIC).length > 0, 'the healthy report must reach the topic');
  for (const value of ctx.kafka.values(TOPIC)) {
    assert(!value.includes('order 4417'), \`the event carries the completion text: \${value}; the topic is retained and replicated\`);
    assert(!('output_text' in JSON.parse(value)), \`the event has an output_text field: \${value}\`);
  }
  for (const row of ctx.redis.lrange('billing:outbox', 0, -1)) assert(!row.includes('order 4417'), \`the outbox row carries the completion text: \${row}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"meter/records"

	"leetbuild/harness"
)

const (
	eventsTopic   = "billing.usage"
	eventsText    = "Your refund for order 4417 was approved on Monday."
	eventsVersion = "rates-2026-11-01"
)

func eventsUsage(n, tenant, model string) records.UsageRecord {
	return records.UsageRecord{UsageID: "u-" + n, IdempotencyKey: "k-" + n, TenantID: tenant, Model: model, InputTokens: 1200, OutputTokens: 300, CostMicros: 6000, RateVersion: eventsVersion, OutputText: eventsText}
}

func eventsPublish(ctx *harness.Ctx, u records.UsageRecord) bool {
	ok, err := publishUsage(context.Background(), u)
	ctx.NoError(err, "publishUsage(%s)", u.UsageID)
	return ok
}

func eventsDecode(ctx *harness.Ctx, raw []string) []map[string]any {
	var out []map[string]any
	for _, r := range raw {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(r), &e), "the event is JSON: %s", r)
		out = append(out, e)
	}
	return out
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	return eventsDecode(ctx, ctx.Redis.LRange("billing:outbox", 0, -1))
}

func CheckTenantKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsUsage("1", "t1", "gpt-4o"))
	eventsPublish(ctx, eventsUsage("2", "t2", "gpt-4o"))
	eventsPublish(ctx, eventsUsage("3", "t1", "gpt-4o-mini"))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three reports must produce three records on %s; the records", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"t1", "t2", "t1"}, "the records must be keyed by the tenant ids (keyed by model, one tenant's charges spread over partitions)")
	ctx.Equal(records[0].Partition, records[2].Partition, "both t1 events must land on one partition, or the ledger applies t1's charges out of order; the partitions")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsUsage("7", "t1", "gpt-4o"))
	ctx.Settle()
	all := eventsDecode(ctx, ctx.Kafka.Values(eventsTopic))
	ctx.Equal(len(all), 1, "one report; records")
	ctx.Equal(all[0], map[string]any{"usage_id": "u-7", "idempotency_key": "k-7", "tenant_id": "t1", "model": "gpt-4o", "input_tokens": float64(1200), "output_tokens": float64(300), "cost_micros": float64(6000), "rate_version": eventsVersion},
		"the event must carry usage_id, idempotency_key, tenant_id, model, both counts, cost_micros and rate_version, and nothing else (without the idempotency key the ledger cannot tell a retry from a second charge)")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsUsage("1", "t1", "gpt-4o"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not bill the report twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsUsage("2", "t1", "gpt-4o"))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a charge (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxFallback(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, eventsUsage("1", "t1", "gpt-4o"))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused one produce: a refused charge must be kept for the relay, not dropped; outbox rows")
	ctx.Assert(rows[0]["usage_id"] == "u-1" && rows[0]["idempotency_key"] == "k-1", "the outbox row must be the event itself, got %v", rows[0])
	ctx.Equal(ok, false, "publishUsage's result after a refused produce")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "nothing reached the topic for the refused produce; records")
	ctx.Assert(eventsPublish(ctx, eventsUsage("2", "t1", "gpt-4o")), "a healthy produce returns true")
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(eventsTopic)) == 1 && len(eventsOutbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsUsage("3", "t1", "gpt-4o"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishUsage waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1]["usage_id"] == "u-3", "no report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishUsage's result without a delivery report")
}

func CheckNoContent(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	eventsPublish(ctx, eventsUsage("1", "t1", "gpt-4o"))
	eventsPublish(ctx, eventsUsage("2", "t1", "gpt-4o"))
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(eventsTopic)) > 0, "the healthy report must reach the topic")
	for _, value := range ctx.Kafka.Values(eventsTopic) {
		ctx.Assert(!strings.Contains(value, "order 4417"), "the event carries the completion text: %s; the topic is retained and replicated", value)
		var e map[string]any
		json.Unmarshal([]byte(value), &e)
		_, has := e["output_text"]
		ctx.Assert(!has, "the event has an output_text field: %s", value)
	}
	for _, row := range ctx.Redis.LRange("billing:outbox", 0, -1) {
		ctx.Assert(!strings.Contains(row, "order 4417"), "the outbox row carries the completion text: %s", row)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "billing.usage";
const std::string kText = "Your refund for order 4417 was approved on Monday.";
const std::string kVersion = "rates-2026-11-01";

records::UsageRecord eventsUsage(const std::string& n, const std::string& tenant, const std::string& model) {
  return {"u-" + n, "k-" + n, tenant, model, 1200, 300, 6000, kVersion, kText};
}

std::vector<nlohmann::json> decode(const std::vector<std::string>& raw) {
  std::vector<nlohmann::json> out;
  for (const auto& r : raw) out.push_back(nlohmann::json::parse(r, nullptr, false));
  return out;
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) { return decode(ctx.Redis.LRange("billing:outbox", 0, -1)); }

std::string str(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  publish_usage(eventsUsage("1", "t1", "gpt-4o"));
  publish_usage(eventsUsage("2", "t2", "gpt-4o"));
  publish_usage(eventsUsage("3", "t1", "gpt-4o-mini"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three reports must produce three records on billing.usage; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"t1", "t2", "t1"}, "the records must be keyed by the tenant ids (keyed by model, one tenant's charges spread over partitions)");
  ctx.Equal(records[0].Partition, records[2].Partition, "both t1 events must land on one partition, or the ledger applies t1's charges out of order; the partitions");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  publish_usage(eventsUsage("7", "t1", "gpt-4o"));
  ctx.Settle();
  const auto all = decode(ctx.Kafka.Values(kEventsTopic));
  ctx.Equal(all.size(), 1, "one report; records");
  ctx.Equal(all[0],
            nlohmann::json({{"usage_id", "u-7"}, {"idempotency_key", "k-7"}, {"tenant_id", "t1"}, {"model", "gpt-4o"}, {"input_tokens", 1200},
                            {"output_tokens", 300}, {"cost_micros", 6000}, {"rate_version", kVersion}}),
            "the event must carry usage_id, idempotency_key, tenant_id, model, both counts, cost_micros and rate_version, and nothing else (without the idempotency key the ledger cannot tell a retry from a second charge)");
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publish_usage(eventsUsage("1", "t1", "gpt-4o"));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not bill the report twice (enable.idempotence); the records");
  publish_usage(eventsUsage("2", "t1", "gpt-4o"));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a charge (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxFallback(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = true;
  try {
    ok = publish_usage(eventsUsage("1", "t1", "gpt-4o"));
  } catch (const std::exception& e) {
    ctx.Fatalf("publish_usage threw when the broker refused the produce: %s; the event goes to the outbox", e.what());
  }
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused one produce: a refused charge must be kept for the relay, not dropped; outbox rows");
  ctx.Assert(str(rows[0], "usage_id") == "u-1" && str(rows[0], "idempotency_key") == "k-1", "the outbox row must be the event itself, got %s", rows[0].dump());
  ctx.Equal(ok, false, "publish_usage's result after a refused produce");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0, "nothing reached the topic for the refused produce; records");
  ctx.Assert(publish_usage(eventsUsage("2", "t1", "gpt-4o")), "a healthy produce returns true");
  ctx.Settle();
  ctx.Assert(ctx.Kafka.Records(kEventsTopic).size() == 1 && eventsOutbox(ctx).size() == 1, "a healthy produce after the failure reaches the topic and adds no outbox row");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publish_usage(eventsUsage("3", "t1", "gpt-4o"));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publish_usage waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && str(rows[1], "usage_id") == "u-3", "no report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publish_usage's result without a delivery report");
}

void CheckNoContent(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  publish_usage(eventsUsage("1", "t1", "gpt-4o"));
  publish_usage(eventsUsage("2", "t1", "gpt-4o"));
  ctx.Settle();
  ctx.Assert(!ctx.Kafka.Records(kEventsTopic).empty(), "the healthy report must reach the topic");
  for (const auto& value : ctx.Kafka.Values(kEventsTopic)) {
    ctx.Assert(value.find("order 4417") == std::string::npos, "the event carries the completion text: %s; the topic is retained and replicated", value);
    const auto e = nlohmann::json::parse(value, nullptr, false);
    ctx.Assert(!e.is_object() || !e.contains("output_text"), "the event has an output_text field: %s", value);
  }
  for (const auto& row : ctx.Redis.LRange("billing:outbox", 0, -1)) {
    ctx.Assert(row.find("order 4417") == std::string::npos, "the outbox row carries the completion text: %s", row);
  }
}
`,
  },
  debrief: `The key is an ordering contract: the ledger applies one tenant's charges in the order a partition keeps, so the partition has to be the tenant's. The idempotency key in the event is what makes every other fix safe. An outbox replay after a slow acknowledgement, a producer retry, and a relay that runs twice all arrive as copies the ledger drops by key instead of charging again. Idempotence and \`acks=all\` close the two broker-side gaps, the lost ack and the failover, before they reach the ledger. The outbox is written where the broker's answer arrives, the delivery report, because a \`try\` around the produce sees only a full local queue. Keeping the completion out is a retention argument. A production pipeline validates events against a schema registry and runs the relay with this same producer.`,
};
