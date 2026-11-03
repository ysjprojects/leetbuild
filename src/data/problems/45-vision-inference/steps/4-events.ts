import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'vision.inference events keyed by model version, with a digest and no image',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'quality', 'redis'],
  task: `## Task

**Starting point.** The starter's \`publish(record)\` takes the provided \`InferenceRecord\` (ids, task,
model version, label, confidence, downgrade flag, latency, content hash, and the storage key and
presigned URL the worker still holds), builds an event with \`inference_id\`, \`tenant\`, \`task\`,
\`label\`, \`confidence\`, \`latency_ms\`, \`image_key\` and \`image_url\`, and produces it to
\`vision.inference\` keyed by the tenant from a producer configured with \`bootstrap.servers\` only.
The demo shows events reaching the quality pipeline. It hides five flaws.

**Failure mode the checks target.** The quality pipeline answers "how did vision-large-3.1.0 do this
week": keyed by tenant, one version's events spread over every partition, and without
\`model_version\` and \`downgraded\` an event cannot be counted at all. The presigned URL in a retained,
replicated topic is a credential to the tenant's image. A lost acknowledgement makes the retry write
the event twice; a refused produce loses it.

Requirements:

- Keyed by \`model_version\`.
- The event is \`{inference_id, tenant, task, model_version, downgraded, confidence, latency_ms,
  content_hash}\`: the digest stands for the image; no storage key, no URL.
- The producer is idempotent with \`acks=all\` (Go uses confluent-kafka-go, which has an idempotent
  producer; kafka-go does not).
- A refused produce writes the event to the provided \`outbox\` from the **delivery report**
  (\`on_delivery\`, a rejected \`send\`, the delivery event, \`dr_cb\`, a \`Callback\`); \`publish\`
  does not raise.`,
  sequence: {
    participants: ['Worker', 'vision.inference', 'outbox', 'Quality pipeline'],
    messages: [
      {
        from: 'Worker',
        to: 'vision.inference',
        label: 'produce key=model_version {ids, model_version, downgraded, confidence, content_hash}',
        kind: 'async',
      },
      {from: 'vision.inference', to: 'Worker', label: 'delivery report: error', kind: 'reply'},
      {from: 'Worker', to: 'outbox', label: 'insert_outbox(event)', kind: 'async'},
      {from: 'vision.inference', to: 'Quality pipeline', label: 'one version, one partition, in order', kind: 'async'},
    ],
  },
  hints: [
    "Symptom: one model version's events land on every partition, the quality dashboard cannot tell a downgraded answer from a large-model one, the topic holds signed image URLs, and a broker blip either doubles an event or drops it.",
    'Mechanism: the key is the tenant, the event copies the image references and leaves out the version, the downgrade flag and the digest, the producer has no idempotence, and nothing reads the delivery report.',
    'Change: `key=record.model_version`; an event of ids, `model_version`, `downgraded`, `confidence`, `latency_ms`, `content_hash`; `enable.idempotence` with `acks=all`; an `on_delivery` callback that calls `outbox.insert_outbox(event)` on error.',
  ],
  checks: [
    {
      id: 'version-key',
      title: 'Keys the event by model version',
      detail:
        "Every record on vision.inference is keyed by model_version, so one version's events share a partition and an order. The starter keys by tenant.",
      match: {
        python: {all: [/key\s*=\s*\w+\.model_version/], none: [/key\s*=\s*\w+\.tenant/]},
        typescript: {all: [/key:\s*\w+\.model_version/], none: [/key:\s*\w+\.tenant/]},
        go: {all: [/Key:\s*\[\]byte\(\s*\w+\.ModelVersion\s*\)/], none: [/Key:\s*\[\]byte\(\s*\w+\.Tenant\s*\)/]},
        scala: {
          all: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*\w+\.model_version\s*,/],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*\w+\.tenant\s*,/],
        },
        cpp: {
          all: [/produce\([\s\S]{0,400}?model_version\.(c_str|data)\(\)/],
          none: [/produce\([\s\S]{0,400}?tenant\.(c_str|data)\(\)/],
        },
      },
    },
    {
      id: 'no-image-reference',
      title: 'No storage key or URL in the event',
      detail:
        'Neither the event nor its outbox row carries the storage key or the presigned URL: the topic is retained and replicated, and a signed URL in it is a credential to the image. The content hash identifies the image. The starter copies both references in.',
      match: {
        python: {none: [/image_key|image_url/]},
        typescript: {none: [/image_key|image_url/]},
        go: {none: [/ImageKey|ImageURL/]},
        scala: {none: [/image_key|image_url/]},
        cpp: {none: [/image_key|image_url/]},
      },
    },
    {
      id: 'quality-fields',
      title: 'Carries the version, the downgrade flag and the digest',
      detail:
        'The event is inference_id, tenant, task, model_version, downgraded, confidence, latency_ms and content_hash, so the pipeline can count per version and set downgraded answers apart. The starter sends the label and none of the three.',
      match: {
        python: {all: [/["']model_version["']/, /["']downgraded["']/, /["']content_hash["']/]},
        typescript: {all: [/model_version:/, /downgraded:/, /content_hash:/]},
        go: {all: [/"model_version"/, /"downgraded"/, /"content_hash"/]},
        scala: {all: [/"model_version"/, /"downgraded"/, /"content_hash"/]},
        cpp: {all: [/"model_version"/, /"downgraded"/, /"content_hash"/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'An idempotent producer with acks=all',
      detail:
        'After a lost acknowledgement the retry lands once, and a leader failover loses nothing: enable.idempotence with acks=all. The starter configures neither, so a lost ack writes the event twice.',
      match: {
        python: {all: [/enable\.idempotence/]},
        typescript: {all: [/idempotent:\s*true/]},
        go: {all: [/enable\.idempotence/]},
        scala: {all: [/enable\.idempotence/]},
        cpp: {all: [/enable\.idempotence/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Writes an outbox row from the delivery report',
      detail:
        'A produce the broker refuses puts the event in the outbox, handled where the broker answers (the delivery callback, the rejected send, the delivery event); publish does not raise. The starter never looks at the result.',
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /outbox\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/outbox\.insertOutbox\(/, /\.catch\(|catch\s*\(/]},
        go: {all: [/outbox\.Insert\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insertOutbox\(/, /exception != null/]},
        cpp: {all: [/outbox::insert_outbox\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from vision.config import TOPIC
from vision.results import InferenceRecord

logger = logging.getLogger("vision.events")

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish(record: InferenceRecord) -> None:
    """Tell the quality pipeline about one finished inference."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "inference_id": record.inference_id,
        "tenant": record.tenant,
        "task": record.task,
        "label": record.label,
        "confidence": record.confidence,
        "latency_ms": record.latency_ms,
        "image_key": record.image_key,
        "image_url": record.image_url,
    }
    producer.produce(TOPIC, key=record.tenant, value=json.dumps(event).encode("utf-8"))
    producer.poll(0)
    logger.info("vision.inference %s tenant=%s", record.inference_id, record.tenant)
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from vision.config import TOPIC
from vision.outbox import outbox
from vision.results import InferenceRecord

logger = logging.getLogger("vision.events")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def publish(record: InferenceRecord) -> None:
    """Tell the quality pipeline about one finished inference."""
    event = {
        "inference_id": record.inference_id,
        "tenant": record.tenant,
        "task": record.task,
        "model_version": record.model_version,
        "downgraded": record.downgraded,
        "confidence": record.confidence,
        "latency_ms": record.latency_ms,
        "content_hash": record.content_hash,
    }

    def on_delivery(err, msg) -> None:
        if err is not None:
            outbox.insert_outbox(event)  # the broker said no: the relay republishes it later
            logger.warning("vision.inference produce failed inference=%s: %s", record.inference_id, err)

    producer.produce(TOPIC, key=record.model_version, value=json.dumps(event).encode("utf-8"), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery reports already in; returns at once
    logger.info("vision.inference %s version=%s", record.inference_id, record.model_version)
`,
    },
    typescript: {
      starter: `import {Kafka, type Producer} from 'kafkajs';

import {TOPIC} from 'vision/config';
import type {InferenceRecord} from 'vision/results';

const kafka = new Kafka({clientId: 'visiond', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer();
void producer.connect();

/** Tell the quality pipeline about one finished inference. */
export async function publish(record: InferenceRecord): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const event = {
    inference_id: record.inference_id,
    tenant: record.tenant,
    task: record.task,
    label: record.label,
    confidence: record.confidence,
    latency_ms: record.latency_ms,
    image_key: record.image_key,
    image_url: record.image_url,
  };
  void producer.send({topic: TOPIC, messages: [{key: record.tenant, value: JSON.stringify(event)}]});
  console.log(\`vision.inference \${record.inference_id} tenant=\${record.tenant}\`);
}
`,
      solution: `import {Kafka, type Producer} from 'kafkajs';

import {TOPIC} from 'vision/config';
import {outbox} from 'vision/outbox';
import type {InferenceRecord} from 'vision/results';

const kafka = new Kafka({clientId: 'visiond', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer({idempotent: true});
void producer.connect();

/** Tell the quality pipeline about one finished inference. */
export async function publish(record: InferenceRecord): Promise<void> {
  const event = {
    inference_id: record.inference_id,
    tenant: record.tenant,
    task: record.task,
    model_version: record.model_version,
    downgraded: record.downgraded,
    confidence: record.confidence,
    latency_ms: record.latency_ms,
    content_hash: record.content_hash,
  };
  try {
    await producer.send({topic: TOPIC, messages: [{key: record.model_version, value: JSON.stringify(event)}], acks: -1});
  } catch (err) {
    await outbox.insertOutbox(event); // the broker said no: the relay republishes it later
    console.warn(\`vision.inference produce failed inference=\${record.inference_id}: \${(err as Error).message}\`);
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

	"vision/config"  // config.Topic — provided
	"vision/results" // results.InferenceRecord — provided
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

// publish tells the quality pipeline about one finished inference.
func publish(ctx context.Context, record results.InferenceRecord) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	event, _ := json.Marshal(map[string]any{
		"inference_id": record.InferenceID,
		"tenant":       record.Tenant,
		"task":         record.Task,
		"label":        record.Label,
		"confidence":   record.Confidence,
		"latency_ms":   record.LatencyMs,
		"image_key":    record.ImageKey,
		"image_url":    record.ImageURL,
	})
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(record.Tenant), Value: event}
	if err := producer.Produce(msg, nil); err != nil {
		return err
	}
	log.Printf("vision.inference %s tenant=%s", record.InferenceID, record.Tenant)
	return nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"vision/config"  // config.Topic — provided
	"vision/outbox"  // outbox.Insert(ctx, eventJSON) — provided
	"vision/results" // results.InferenceRecord — provided
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

// publish tells the quality pipeline about one finished inference.
func publish(ctx context.Context, record results.InferenceRecord) error {
	event, _ := json.Marshal(map[string]any{
		"inference_id":  record.InferenceID,
		"tenant":        record.Tenant,
		"task":          record.Task,
		"model_version": record.ModelVersion,
		"downgraded":    record.Downgraded,
		"confidence":    record.Confidence,
		"latency_ms":    record.LatencyMs,
		"content_hash":  record.ContentHash,
	})
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(record.ModelVersion), Value: event}
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
		// the broker said no: the relay republishes it later
		log.Printf("vision.inference produce failed inference=%s: %v", record.InferenceID, err)
		return outbox.Insert(ctx, event)
	}
	log.Printf("vision.inference %s version=%s", record.InferenceID, record.ModelVersion)
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import vision.{Config, InferenceRecord}

object InferenceEvents {
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Tell the quality pipeline about one finished inference. */
  def publish(record: InferenceRecord): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val event = ujson.write(
      ujson.Obj(
        "inference_id" -> record.inference_id,
        "tenant" -> record.tenant,
        "task" -> record.task,
        "label" -> record.label,
        "confidence" -> record.confidence,
        "latency_ms" -> record.latency_ms,
        "image_key" -> record.image_key,
        "image_url" -> record.image_url
      )
    )
    producer.send(new ProducerRecord[String, String](Config.Topic, record.tenant, event))
    System.err.println(s"vision.inference \${record.inference_id} tenant=\${record.tenant}")
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer

import vision.{Config, InferenceRecord, Outbox}

object InferenceEvents {
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Tell the quality pipeline about one finished inference. */
  def publish(record: InferenceRecord): Unit = {
    val event = ujson.write(
      ujson.Obj(
        "inference_id" -> record.inference_id,
        "tenant" -> record.tenant,
        "task" -> record.task,
        "model_version" -> record.model_version,
        "downgraded" -> record.downgraded,
        "confidence" -> record.confidence,
        "latency_ms" -> record.latency_ms,
        "content_hash" -> record.content_hash
      )
    )
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) {
          Outbox.insertOutbox(event) // the broker said no: the relay republishes it later
          System.err.println(s"vision.inference produce failed inference=\${record.inference_id}: \${exception.getMessage}")
        }
    }
    producer.send(new ProducerRecord[String, String](Config.Topic, record.model_version, event), onDelivery)
    System.err.println(s"vision.inference \${record.inference_id} version=\${record.model_version}")
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

#include "vision/config.h"   // config::kTopic — provided
#include "vision/results.h"  // results::InferenceRecord — provided

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Tell the quality pipeline about one finished inference.
void publish(const results::InferenceRecord& record) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string event = nlohmann::json{{"inference_id", record.inference_id},
                                           {"tenant", record.tenant},
                                           {"task", record.task},
                                           {"label", record.label},
                                           {"confidence", record.confidence},
                                           {"latency_ms", record.latency_ms},
                                           {"image_key", record.image_key},
                                           {"image_url", record.image_url}}
                                .dump();
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(event.data()), event.size(), record.tenant.c_str(), record.tenant.size(), 0, nullptr);
  producer->poll(0);
  std::cerr << "vision.inference " << record.inference_id << " tenant=" << record.tenant << "\\n";
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "vision/config.h"   // config::kTopic — provided
#include "vision/outbox.h"   // outbox::insert_outbox(event_json) — provided
#include "vision/results.h"  // results::InferenceRecord — provided

// The delivery report: a refused record goes to the outbox for the relay to republish.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    outbox::insert_outbox(std::string(static_cast<const char*>(message.payload()), message.len()));
    std::cerr << "vision.inference produce failed: " << message.errstr() << "\\n";
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

// Tell the quality pipeline about one finished inference.
void publish(const results::InferenceRecord& record) {
  const std::string event = nlohmann::json{{"inference_id", record.inference_id},
                                           {"tenant", record.tenant},
                                           {"task", record.task},
                                           {"model_version", record.model_version},
                                           {"downgraded", record.downgraded},
                                           {"confidence", record.confidence},
                                           {"latency_ms", record.latency_ms},
                                           {"content_hash", record.content_hash}}
                                .dump();
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(event.data()), event.size(), record.model_version.c_str(), record.model_version.size(), 0,
                    nullptr);
  producer->poll(0);  // serve delivery reports already in; returns at once
  std::cerr << "vision.inference " << record.inference_id << " version=" << record.model_version << "\\n";
}
`,
    },
  },
  harness: {
    python: `import json

from vision.results import InferenceRecord

TOPIC = "vision.inference"
LARGE = "vision-large-3.1.0"
SMALL = "vision-small-1.7.2"
URL = "https://objects.internal/tenants/t1/images/cat.jpg?X-Amz-Signature=5f1d"
EXPECTED = {"inference_id": "inf-1", "tenant": "t1", "task": "classify", "model_version": LARGE, "downgraded": False, "confidence": 0.92, "latency_ms": 840, "content_hash": "9f2c41aa"}


def _record(inference_id="inf-1", tenant="t1", model_version=LARGE, downgraded=False):
    return InferenceRecord(
        inference_id=inference_id, tenant=tenant, task="classify", model_version=model_version, label="tabby_cat",
        confidence=0.92, downgraded=downgraded, latency_ms=840, content_hash="9f2c41aa",
        image_key=f"tenants/{tenant}/images/cat.jpg", image_url=URL,
    )


def _settle(m):
    """Serve the producer's delivery reports, as the worker's loop would between inferences."""
    if hasattr(m, "producer"):
        m.producer.poll(0)


def _events(ctx):
    return [json.loads(v) for v in ctx.kafka.values(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("vision:outbox", 0, -1)]


def check_version_key(ctx):
    m = ctx.load("events")
    m.publish(_record("inf-1", tenant="t1"))
    m.publish(_record("inf-2", tenant="t2"))
    m.publish(_record("inf-3", tenant="t1", model_version=SMALL, downgraded=True))
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three inferences produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [LARGE.encode(), LARGE.encode(), SMALL.encode()], f"records must be keyed by model_version, got {keys}: keyed by tenant, one version's events spread over every partition"
    assert records[0].partition == records[1].partition, "both vision-large events must land on one partition"


def check_no_image_reference(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    m.publish(_record("inf-1"))
    m.publish(_record("inf-2"))
    _settle(m)
    for value in ctx.kafka.values(TOPIC):
        assert b"X-Amz-Signature" not in value, f"the event carries the presigned URL: {value!r}; the topic is retained and replicated, and a signed URL is a credential"
        assert b"tenants/t1/images" not in value, f"the event carries the storage key: {value!r}; content_hash stands for the image"
    for row in ctx.redis.lrange("vision:outbox", 0, -1):
        assert "X-Amz-Signature" not in row and "tenants/t1/images" not in row, f"the outbox row carries an image reference: {row}"


def check_quality_fields(ctx):
    m = ctx.load("events")
    m.publish(_record("inf-1"))
    _settle(m)
    events = _events(ctx)
    assert len(events) == 1, f"one inference produced {len(events)} records"
    for key, value in EXPECTED.items():
        assert events[0].get(key) == value, f"the event must carry {key}={value!r}, got {events[0]}"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish(_record("inf-1"))
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish(_record("inf-2"))
    _settle(m)
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, f"a leader failover lost a record ({len(ctx.kafka.records(TOPIC))} left): acks=all waits for every in-sync replica"


def check_outbox_fallback(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.publish(_record("inf-1"))
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"publish raised when the broker refused the produce: {e!r}; the event goes to the outbox, the worker goes on") from e
    _settle(m)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused one produce and the outbox holds {len(rows)} rows: the inference is missing from every quality metric"
    assert rows[0].get("inference_id") == "inf-1" and rows[0].get("model_version") == LARGE, f"the outbox row must be the event itself, got {rows[0]}"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused produce"
    m.publish(_record("inf-2"))
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(_outbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row"
`,
    typescript: `const TOPIC = 'vision.inference';
const LARGE = 'vision-large-3.1.0';
const SMALL = 'vision-small-1.7.2';
const URL = 'https://objects.internal/tenants/t1/images/cat.jpg?X-Amz-Signature=5f1d';
const EXPECTED = {inference_id: 'inf-1', tenant: 't1', task: 'classify', model_version: LARGE, downgraded: false, confidence: 0.92, latency_ms: 840, content_hash: '9f2c41aa'};

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const record = (inferenceId = 'inf-1', tenant = 't1', modelVersion = LARGE, downgraded = false) => ({
  inference_id: inferenceId, tenant, task: 'classify', model_version: modelVersion, label: 'tabby_cat', confidence: 0.92,
  downgraded, latency_ms: 840, content_hash: '9f2c41aa', image_key: \`tenants/\${tenant}/images/cat.jpg\`, image_url: URL,
});

const events = ctx => ctx.kafka.values(TOPIC).map(v => JSON.parse(v.toString()));
const outboxRows = ctx => ctx.redis.lrange('vision:outbox', 0, -1).map(row => JSON.parse(row));

export async function check_version_key(ctx) {
  const m = ctx.load('events');
  await m.publish(record('inf-1', 't1'));
  await m.publish(record('inf-2', 't2'));
  await m.publish(record('inf-3', 't1', SMALL, true));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three inferences produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepEqual(keys, [LARGE, LARGE, SMALL], \`records must be keyed by model_version, got \${JSON.stringify(keys)}: keyed by tenant, one version's events spread over every partition\`);
  assert.equal(records[0].partition, records[1].partition, 'both vision-large events must land on one partition');
}

export async function check_no_image_reference(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  await m.publish(record('inf-1'));
  await m.publish(record('inf-2'));
  await settle();
  for (const value of ctx.kafka.values(TOPIC).map(v => v.toString())) {
    assert(!value.includes('X-Amz-Signature'), \`the event carries the presigned URL: \${value}; the topic is retained and replicated, and a signed URL is a credential\`);
    assert(!value.includes('tenants/t1/images'), \`the event carries the storage key: \${value}; content_hash stands for the image\`);
  }
  for (const row of ctx.redis.lrange('vision:outbox', 0, -1)) assert(!row.includes('X-Amz-Signature') && !row.includes('tenants/t1/images'), \`the outbox row carries an image reference: \${row}\`);
}

export async function check_quality_fields(ctx) {
  const m = ctx.load('events');
  await m.publish(record('inf-1'));
  await settle();
  const all = events(ctx);
  assert.equal(all.length, 1, \`one inference produced \${all.length} records\`);
  for (const [key, value] of Object.entries(EXPECTED)) assert.deepEqual(all[0][key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${JSON.stringify(all[0])}\`);
}

export async function check_idempotent_producer(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publish(record('inf-1'));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publish(record('inf-2'));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost a record: acks=all waits for every in-sync replica');
}

export async function check_outbox_fallback(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await m.publish(record('inf-1'));
  } catch (e) {
    assert.fail(\`publish rejected when the broker refused the produce: \${e}; the event goes to the outbox, the worker goes on\`);
  }
  await settle();
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused one produce and the outbox holds \${rows.length} rows: the inference is missing from every quality metric\`);
  assert(rows[0].inference_id === 'inf-1' && rows[0].model_version === LARGE, \`the outbox row must be the event itself, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused produce');
  await m.publish(record('inf-2'));
  await settle();
  assert(ctx.kafka.records(TOPIC).length === 1 && outboxRows(ctx).length === 1, 'a healthy produce after the failure reaches the topic and adds no outbox row');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"vision/results"

	"leetbuild/harness"
)

const (
	eventsTopic = "vision.inference"
	eventsLarge = "vision-large-3.1.0"
	eventsSmall = "vision-small-1.7.2"
	eventsURL   = "https://objects.internal/tenants/t1/images/cat.jpg?X-Amz-Signature=5f1d"
)

func eventsRecord(inferenceID, tenant, modelVersion string, downgraded bool) results.InferenceRecord {
	return results.InferenceRecord{
		InferenceID: inferenceID, Tenant: tenant, Task: "classify", ModelVersion: modelVersion, Label: "tabby_cat",
		Confidence: 0.92, Downgraded: downgraded, LatencyMs: 840, ContentHash: "9f2c41aa",
		ImageKey: "tenants/" + tenant + "/images/cat.jpg", ImageURL: eventsURL,
	}
}

func eventsPublish(ctx *harness.Ctx, r results.InferenceRecord) {
	ctx.NoError(publish(context.Background(), r), "publish(%s)", r.InferenceID)
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, row := range ctx.Redis.LRange("vision:outbox", 0, -1) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(row), &e), "the outbox row is JSON: %s", row)
		out = append(out, e)
	}
	return out
}

func CheckVersionKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsRecord("inf-1", "t1", eventsLarge, false))
	eventsPublish(ctx, eventsRecord("inf-2", "t2", eventsLarge, false))
	eventsPublish(ctx, eventsRecord("inf-3", "t1", eventsSmall, true))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three inferences must produce three records on %s; the records", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{eventsLarge, eventsLarge, eventsSmall}, "records must be keyed by model_version (keyed by tenant, one version's events spread over every partition)")
	ctx.Equal(records[0].Partition, records[1].Partition, "both vision-large events must land on one partition; the partitions")
}

func CheckNoImageReference(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	eventsPublish(ctx, eventsRecord("inf-1", "t1", eventsLarge, false))
	eventsPublish(ctx, eventsRecord("inf-2", "t1", eventsLarge, false))
	ctx.Settle()
	for _, value := range ctx.Kafka.Values(eventsTopic) {
		ctx.Assert(!strings.Contains(value, "X-Amz-Signature"), "the event carries the presigned URL: %s; the topic is retained and replicated, and a signed URL is a credential", value)
		ctx.Assert(!strings.Contains(value, "tenants/t1/images"), "the event carries the storage key: %s; content_hash stands for the image", value)
	}
	for _, row := range ctx.Redis.LRange("vision:outbox", 0, -1) {
		ctx.Assert(!strings.Contains(row, "X-Amz-Signature") && !strings.Contains(row, "tenants/t1/images"), "the outbox row carries an image reference: %s", row)
	}
}

func CheckQualityFields(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsRecord("inf-1", "t1", eventsLarge, false))
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one inference; records")
	var e map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &e), "the event is JSON: %s", values[0])
	ctx.Equal(e, map[string]any{"inference_id": "inf-1", "tenant": "t1", "task": "classify", "model_version": eventsLarge, "downgraded": false, "confidence": 0.92, "latency_ms": float64(840), "content_hash": "9f2c41aa"}, "the event must be the ids, model_version, downgraded, confidence, latency_ms and content_hash")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsRecord("inf-1", "t1", eventsLarge, false))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsRecord("inf-2", "t1", eventsLarge, false))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxFallback(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("publish panicked when the broker refused the produce: %v; the event goes to the outbox, the worker goes on", e)
			}
		}()
		eventsPublish(ctx, eventsRecord("inf-1", "t1", eventsLarge, false))
	}()
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused one produce: without an outbox row the inference is missing from every quality metric; outbox rows")
	ctx.Assert(rows[0]["inference_id"] == "inf-1" && rows[0]["model_version"] == eventsLarge, "the outbox row must be the event itself, got %v", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "nothing reached the topic for the refused produce; records")
	eventsPublish(ctx, eventsRecord("inf-2", "t1", eventsLarge, false))
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(eventsTopic)) == 1 && len(eventsOutbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <string>
#include <vector>

namespace {

const std::string kTopic = "vision.inference";
const std::string kLarge = "vision-large-3.1.0";
const std::string kSmall = "vision-small-1.7.2";
const std::string kUrl = "https://objects.internal/tenants/t1/images/cat.jpg?X-Amz-Signature=5f1d";

results::InferenceRecord eventsRecord(const std::string& inference_id, const std::string& tenant = "t1", const std::string& model_version = kLarge,
                                      bool downgraded = false) {
  return {inference_id, tenant, "classify", model_version, "tabby_cat", 0.92, downgraded, 840, "9f2c41aa", "tenants/" + tenant + "/images/cat.jpg", kUrl};
}

// The worker's loop serves delivery reports between inferences.
void settle(harness::Ctx& ctx) {
  ctx.Settle();
  producer->poll(0);
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& row : ctx.Redis.LRange("vision:outbox", 0, -1)) out.push_back(nlohmann::json::parse(row, nullptr, false));
  return out;
}

}  // namespace

void CheckVersionKey(harness::Ctx& ctx) {
  publish(eventsRecord("inf-1", "t1"));
  publish(eventsRecord("inf-2", "t2"));
  publish(eventsRecord("inf-3", "t1", kSmall, true));
  settle(ctx);
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three inferences must produce three records on %s; the records", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {kLarge, kLarge, kSmall}, "records must be keyed by model_version (keyed by tenant, one version's events spread over every partition)");
  ctx.Equal(records[0].Partition, records[1].Partition, "both vision-large events must land on one partition; the partitions");
}

void CheckNoImageReference(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  publish(eventsRecord("inf-1"));
  publish(eventsRecord("inf-2"));
  settle(ctx);
  for (const auto& value : ctx.Kafka.Values(kTopic)) {
    ctx.Assert(value.find("X-Amz-Signature") == std::string::npos, "the event carries the presigned URL: %s; the topic is retained and replicated, and a signed URL is a credential", value);
    ctx.Assert(value.find("tenants/t1/images") == std::string::npos, "the event carries the storage key: %s; content_hash stands for the image", value);
  }
  for (const auto& row : ctx.Redis.LRange("vision:outbox", 0, -1)) {
    ctx.Assert(row.find("X-Amz-Signature") == std::string::npos && row.find("tenants/t1/images") == std::string::npos, "the outbox row carries an image reference: %s", row);
  }
}

void CheckQualityFields(harness::Ctx& ctx) {
  publish(eventsRecord("inf-1"));
  settle(ctx);
  const auto values = ctx.Kafka.Values(kTopic);
  ctx.Equal(values.size(), 1, "one inference; records");
  ctx.Equal(nlohmann::json::parse(values[0], nullptr, false),
            nlohmann::json({{"inference_id", "inf-1"}, {"tenant", "t1"}, {"task", "classify"}, {"model_version", kLarge}, {"downgraded", false}, {"confidence", 0.92}, {"latency_ms", 840}, {"content_hash", "9f2c41aa"}}),
            "the event must be the ids, model_version, downgraded, confidence, latency_ms and content_hash");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publish(eventsRecord("inf-1"));
  settle(ctx);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publish(eventsRecord("inf-2"));
  settle(ctx);
  ctx.Kafka.Failover(kTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxFallback(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  try {
    publish(eventsRecord("inf-1"));
  } catch (const std::exception& e) {
    ctx.Fatalf("publish threw when the broker refused the produce: %s; the event goes to the outbox, the worker goes on", e.what());
  }
  settle(ctx);
  const auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused one produce: without an outbox row the inference is missing from every quality metric; outbox rows");
  ctx.Assert(!rows.empty() && rows[0].value("inference_id", "") == "inf-1" && rows[0].value("model_version", "") == kLarge, "the outbox row must be the event itself, got %v", rows.empty() ? nlohmann::json() : rows[0]);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "nothing reached the topic for the refused produce; records");
  publish(eventsRecord("inf-2"));
  settle(ctx);
  ctx.Assert(ctx.Kafka.Records(kTopic).size() == 1 && eventsOutbox(ctx).size() == 1, "a healthy produce after the failure reaches the topic and adds no outbox row");
}
`,
  },
  debrief: `The key is the ordering contract, and the consumer decides it: the quality pipeline aggregates per model version, so the version is the key and a version's events stay in one partition and one order. The payload is judged by the topic's lifetime, not the request's: a presigned URL harmless in a response is a credential in a log kept for weeks, so the digest stands for the image. Idempotence with \`acks=all\` makes the producer's own retry safe; the outbox, written where the broker's answer arrives, covers the produce the broker refused. Production pipelines also register the event schema so a renamed field fails at the producer, and run the relay that drains the outbox with the same idempotent producer.`,
};
