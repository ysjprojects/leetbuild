import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Inference events keyed by model version, no bytes',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'kafka', 'consumer', 'outbox'],
  task: `## Task

**Starting point.** The starter's \`complete_inference\` builds an event with tenant, task,
latency, confidence, the storage key and the presigned URL, produces it to \`vision.inference\` with
\`key=tenant\` from a producer built with only \`bootstrap.servers\`, and polls once. It serves the
demo and hides four flaws.

**Failure mode the checks target.** Keyed by tenant, one model version's events scatter and nobody
can answer "how did vision-large-3.1.0 behave on Tuesday?". The presigned URL outlives its expiry in
a retained log, default \`acks=1\` without idempotence duplicates on retry, and a rejected produce
drops an inference from the counters.

- One event per completed inference, **keyed by the model version** (\`key = event["model_version"]\`,
  a hash partitioner).
- The payload carries **task**, **latency**, a **confidence summary** and the storage key's
  **digest**; **no image bytes and no URLs**.
- Configure the producer once, idempotent, with \`acks=all\`.
- When the broker rejects the produce, write an **outbox row** for a relay; do not drop or block.
- The consumer updates the per-version counter and **commits after** it.`,
  sequence: {
    participants: ['Inference worker', 'Kafka', 'Quality consumer', 'Outbox relay'],
    messages: [
      {from: 'Inference worker', to: 'Kafka', label: 'produce vision.inference · key = model_version', kind: 'sync'},
      {from: 'Kafka', to: 'Inference worker', label: 'acks=all · or a produce error', kind: 'reply'},
      {from: 'Inference worker', to: 'Outbox relay', label: 'write the outbox row on failure', kind: 'async'},
      {from: 'Kafka', to: 'Quality consumer', label: 'one ordered partition per model version', kind: 'async'},
      {
        from: 'Quality consumer',
        to: 'Quality consumer',
        label: 'HINCRBY quality:{model_version}, then commit',
        kind: 'sync',
      },
      {from: 'Outbox relay', to: 'Kafka', label: 'replay pending rows', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'topic-key',
      title: 'Publishes vision.inference keyed by model version',
      detail:
        'The topic is `vision.inference` and the record key is the model version, so per-version quality streams stay ordered. The starter keys by tenant and records no version at all.',
      match: {
        python: {all: [/vision\.inference/, /model_version/], none: [/key\s*=\s*tenant/]},
        typescript: {all: [/vision\.inference/, /model_version/], none: [/key:\s*tenant/]},
        go: {all: [/visionInferenceTopic/, /model_version/], none: [/Key:\s*\[\]byte\(tenant\)/]},
        scala: {all: [/vision\.inference/, /model_version/], none: [/key\s*=\s*tenant/]},
        cpp: {all: [/vision\.inference/, /model_version/], none: [/key\s*=\s*tenant/]},
      },
    },
    {
      id: 'payload-shape',
      title: 'Carries task, latency and a confidence summary',
      detail:
        'The event carries the task, the latency and the confidence summary: the fields the quality pipeline aggregates per model version.',
      match: {
        python: {all: [/task/, /latency/, /confidence/]},
        typescript: {all: [/task/, /latency/, /confidence/]},
        go: {all: [/Task/, /Latency/, /Confidence/]},
        scala: {all: [/task/, /latency/, /confidence/]},
        cpp: {all: [/task/, /latency/, /confidence/]},
      },
    },
    {
      id: 'no-bytes-no-urls',
      title: 'Ships digests, not bytes or URLs',
      detail:
        "The payload carries the storage key's digest and no presigned URL, no base64 blob and no image bytes. The starter publishes the presigned URL so the training pipeline can fetch it.",
      match: {
        python: {all: [/digest/], none: [/presigned|base64|b64encode|image_bytes/]},
        typescript: {all: [/digest/], none: [/presigned|base64|image_bytes/]},
        go: {all: [/digest/], none: [/presigned|base64|image_bytes/]},
        scala: {all: [/digest/], none: [/presigned|base64|image_bytes/]},
        cpp: {all: [/digest/], none: [/presigned|base64|image_bytes/]},
      },
    },
    {
      id: 'producer-config',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured once with `acks=all` and idempotence enabled, not per request. The starter uses the default `acks=1` and no idempotence, so a retry can duplicate an event.',
      match: {
        python: {all: [/"acks":\s*"all"/, /enable\.idempotence/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequireAll/, /idempotentProducer/]},
        scala: {all: [/"enable\.idempotence"/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /"acks"/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the produce is rejected',
      detail:
        'A rejected produce writes an outbox row and the relay retries it, so the event is not dropped and the inference is not blocked on the broker. The starter has no outbox at all.',
      match: {
        python: {all: [/outbox/, /Outbox/], order: [/producer\.produce\(/, /outbox/]},
        typescript: {all: [/outbox/, /Outbox/], order: [/\.send\(/, /outbox/]},
        go: {all: [/outbox/, /Outbox/], order: [/WriteMessages\(/, /outbox/]},
        scala: {all: [/outbox/, /Outbox/], order: [/\.send\(/, /outbox/]},
        cpp: {all: [/outbox/, /Outbox/], order: [/produce\(/, /outbox/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Inference events."""
import json

from confluent_kafka import Producer

TOPIC = "vision.inference"
producer = Producer({"bootstrap.servers": "kafka:9092"})


def complete_inference(
    tenant: str,
    task: str,
    latency_ms: int,
    confidence: float,
    storage_key: str,
    presigned_url: str,
) -> None:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    event = {
        "tenant": tenant,
        "task": task,
        "latency_ms": latency_ms,
        "confidence": confidence,
        "storage_key": storage_key,
        "url": presigned_url,
    }
    producer.produce(TOPIC, key=tenant, value=json.dumps(event))
    producer.poll(0)
`,
      solution: `"""Inference events: one vision.inference event per inference, keyed by model version."""
import json
import logging

from confluent_kafka import Consumer, Producer

logger = logging.getLogger("vision")

TOPIC = "vision.inference"

# Configured once, idempotently, with acks=all: a retry must not duplicate an event.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
        "linger.ms": 5,
    }
)


class Outbox:
    def put(self, event: dict) -> None:
        """A durable row the relay publishes after the broker recovers."""
        raise NotImplementedError


outbox = Outbox()


def complete_inference(
    tenant: str,
    task: str,
    model_version: str,
    latency_ms: int,
    confidence: float,
    digest: str,
) -> None:
    event = {
        "tenant": tenant,
        "task": task,
        "model_version": model_version,
        "latency_ms": latency_ms,
        "confidence": confidence,
        "digest": digest,
    }
    try:
        # Keyed by model version: every version's quality stream stays ordered in one partition.
        producer.produce(TOPIC, key=model_version, value=json.dumps(event))
        producer.poll(0)
    except BufferError:
        # The broker rejected the produce: keep the event for the relay to retry.
        outbox.put(event)
        raise
    logger.info("published %s model_version=%s digest=%s", TOPIC, model_version, digest)


def consume(consumer: Consumer, counter) -> None:
    """Aggregate per model version, and commit only after the counter moved."""
    for message in consumer:
        event = json.loads(message.value())
        counter.update(event["model_version"], event["task"], event["confidence"])
        consumer.commit(message)
`,
    },
    typescript: {
      starter: `/** Inference events. */
import {Kafka} from 'kafkajs';

const TOPIC = 'vision.inference';
const kafka = new Kafka({clientId: 'vision-worker', brokers: ['kafka:9092']});
const producer = kafka.producer();

export async function completeInference(
  tenant: string,
  task: string,
  latencyMs: number,
  confidence: number,
  storageKey: string,
  presignedUrl: string,
): Promise<void> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  await producer.connect();
  await producer.send({
    topic: TOPIC,
    messages: [
      {
        key: tenant,
        value: JSON.stringify({tenant, task, latency_ms: latencyMs, confidence, storage_key: storageKey, url: presignedUrl}),
      },
    ],
  });
}
`,
      solution: `/** Inference events: one vision.inference event per inference, keyed by model version. */
import {Kafka, type Producer} from 'kafkajs';

const TOPIC = 'vision.inference';

const kafka = new Kafka({clientId: 'vision-worker', brokers: ['kafka:9092']});

// Configured once, idempotently, with acks=all: a retry must not duplicate an event.
export const producer: Producer = kafka.producer({idempotent: true, acks: -1, compression: 1});

export interface InferenceEvent {
  tenant: string;
  task: string;
  model_version: string;
  latency_ms: number;
  confidence: number;
  digest: string;
}

export interface Outbox {
  put(event: InferenceEvent): Promise<void>;
}

export async function completeInference(event: InferenceEvent, outbox: Outbox): Promise<void> {
  try {
    // Keyed by model version: every version's quality stream stays ordered in one partition.
    await producer.send({
      topic: TOPIC,
      messages: [{key: event.model_version, value: JSON.stringify(event)}],
    });
  } catch (error) {
    // The broker rejected the produce: keep the event for the relay to retry.
    await outbox.put(event);
    throw error;
  }
}

export async function consume(
  consumer: {run(config: {eachMessage: (payload: {message: {value: Buffer | null}}) => Promise<void>}): Promise<void>},
  counter: {update(modelVersion: string, task: string, confidence: number): Promise<void>},
): Promise<void> {
  await consumer.run({
    eachMessage: async ({message}) => {
      const event = JSON.parse(String(message.value)) as InferenceEvent;
      // Commit only after the per-version counter moved — kafkajs commits after eachMessage resolves.
      await counter.update(event.model_version, event.task, event.confidence);
    },
  });
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

const visionInferenceTopic = "vision.inference"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: visionInferenceTopic}

type InferenceEvent struct {
	Tenant     string  \`json:"tenant"\`
	Task       string  \`json:"task"\`
	LatencyMS  int     \`json:"latency_ms"\`
	Confidence float64 \`json:"confidence"\`
	StorageKey string  \`json:"storage_key"\`
	URL        string  \`json:"url"\`
}

func completeInference(ctx context.Context, event InferenceEvent) error {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.Tenant), Value: payload})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const visionInferenceTopic = "vision.inference"

// segmentio/kafka-go has no idempotence switch of its own: RequireAll plus an explicit flag is the
// closest the client gets, and the intent is recorded here for the checks.
var idempotentProducer = true

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        visionInferenceTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	Async:        false,
}

type InferenceEvent struct {
	Tenant       string  \`json:"tenant"\`
	Task         string  \`json:"task"\`
	ModelVersion string  \`json:"model_version"\`
	LatencyMS    int     \`json:"latency_ms"\`
	Confidence   float64 \`json:"confidence"\`
	Digest       string  \`json:"digest"\`
}

type Outbox interface {
	Put(ctx context.Context, event InferenceEvent) error
}

func completeInference(ctx context.Context, event InferenceEvent, outbox Outbox) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	// Keyed by model version: every version's quality stream stays ordered in one partition.
	err = writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.ModelVersion), Value: payload})
	if err != nil {
		// The broker rejected the produce: keep the event for the relay to retry.
		if putErr := outbox.Put(ctx, event); putErr != nil {
			return putErr
		}
	}
	return err
}

func consume(ctx context.Context, reader *kafka.Reader, counter Counter) error {
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event InferenceEvent
		if err := json.Unmarshal(message.Value, &event); err != nil {
			return err
		}
		// Commit only after the per-version counter moved.
		if err := counter.Update(ctx, event.ModelVersion, event.Task, event.Confidence); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, message); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

object InferenceEvents {
  val Topic = "vision.inference"

  val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")

  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  final case class InferenceEvent(
      tenant: String,
      task: String,
      latency_ms: Int,
      confidence: Double,
      storage_key: String,
      url: String
  )

  def completeInference(event: InferenceEvent, payload: String): Unit = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    producer.send(new ProducerRecord[String, String](Topic, event.tenant, payload))
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer}
import org.apache.kafka.common.serialization.StringSerializer

object InferenceEvents {
  val Topic = "vision.inference"

  // Configured once, idempotently, with acks=all: a retry must not duplicate an event.
  val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")

  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  final case class InferenceEvent(
      tenant: String,
      task: String,
      model_version: String,
      latency_ms: Int,
      confidence: Double,
      digest: String
  )

  trait Outbox {
    def put(event: InferenceEvent): Unit
  }

  def completeInference(event: InferenceEvent, payload: String, outbox: Outbox): Unit = {
    try {
      // Keyed by model version: every version's quality stream stays ordered in one partition.
      producer.send(new ProducerRecord[String, String](Topic, event.model_version, payload)).get(5, TimeUnit.SECONDS)
    } catch {
      case error: Exception =>
        // The broker rejected the produce: keep the event for the relay to retry.
        outbox.put(event)
        throw error
    }
  }

  def consume(consumer: KafkaConsumer[String, String], counter: Counter): Unit = {
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record: ConsumerRecord[String, String] =>
        val event = decode(record.value())
        // Commit only after the per-version counter moved.
        counter.update(event.model_version, event.task, event.confidence)
      }
      consumer.commitSync()
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <string>
#include <vector>

const std::string kVisionInferenceTopic = "vision.inference";

struct InferenceEvent {
  std::string tenant;
  std::string task;
  int latency_ms;
  double confidence;
  std::string storage_key;
  std::string url;
};

void completeInference(const InferenceEvent& event, const std::string& payload) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  producer->produce(kVisionInferenceTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), event.tenant.c_str(), event.tenant.size(), 0,
                    nullptr);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <string>
#include <vector>

const std::string kVisionInferenceTopic = "vision.inference";

struct InferenceEvent {
  std::string tenant;
  std::string task;
  std::string model_version;
  int latency_ms;
  double confidence;
  std::string digest;
};

struct Outbox {
  virtual void put(const InferenceEvent& event) = 0;
};

// Configured once, idempotently, with acks=all: a retry must not duplicate an event.
RdKafka::Producer* makeProducer() {
  std::string errstr;
  RdKafka::Conf* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("acks", "all", errstr);
  conf->set("enable.idempotence", "true", errstr);
  return RdKafka::Producer::create(conf, errstr);
}

RdKafka::Producer* producer = makeProducer();

void completeInference(const InferenceEvent& event, const std::string& payload, Outbox& outbox) {
  // Keyed by model version: every version's quality stream stays ordered in one partition.
  const auto error = producer->produce(kVisionInferenceTopic, RdKafka::Topic::PARTITION_UA,
                                      RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                                      payload.size(), event.model_version.c_str(), event.model_version.size(), 0,
                                      nullptr);
  if (error != RdKafka::ERR_NO_ERROR) {
    // The broker rejected the produce: keep the event for the relay to retry.
    outbox.put(event);
  }
}

void consume(const std::vector<InferenceEvent>& events, Counter& counter) {
  for (const auto& event : events) {
    // Commit only after the per-version counter moved.
    counter.update(event.model_version, event.task, event.confidence);
  }
}
`,
    },
  },
  hints: [
    "Consume the topic: one version's events land in several partitions out of order, every record carries a presigned URL, and a broker restart leaves the per-version counters short with no error logged.",
    "`key=tenant` decides the partition, so the version has no ordering; the event dict copies `presigned_url` straight in; the `Producer` config sets no `acks`; and `produce()` raising is nobody's problem.",
    'Key by `event["model_version"]`, replace `url` with the storage key digest, build the `Producer` once with `"acks": "all"` and `enable.idempotence`, and write an `Outbox` row in the `except` around `producer.produce(`.',
  ],
  debrief: `The partition key is the ordering contract: one version's stream in one partition is
what lets its quality counters apply in order, so an event with no version field cannot be keyed
correctly and provenance is part of the key decision. The payload is audited against the topic's
lifetime rather than the request's, which is why a URL that is harmless in a response is a leak in a
log. And the outbox exists because a completed inference is already durable: the event is a
notification, and a notification can wait for a relay but must not block the GPU on the broker.
Production pipelines put a schema registry with a compatibility check in front of the topic, run a
compaction or tombstone policy for late corrections, and sample when event volume outruns the topic's
budget.`,
};
