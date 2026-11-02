import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Model events keyed by model name',
  concept: 'kafka',
  file: 'events',
  focus: ['registry', 'kafka', 'db'],
  task: `## Task

**Starting point.** \`emit(model, version, digest, report)\` builds an event with the model, the
version, the digest and the eval report's \`report_body\` and \`samples\`, produces it to
\`model.event\` with \`key=digest\` through a \`Producer\` configured with only
\`bootstrap.servers\`, flushes, then calls \`store.commit\`. It compiles and hides five flaws.

**Failure mode the checks target.** A consumer that sees a promote before the registration that
created the version, or acts on a promotion whose registry write later failed, and a retained
topic that carries test-set samples long after the eval store expired them.

- Every event is produced to \`model.event\` with \`key=model\`, so one model's history stays in
  one partition.
- The payload is \`{event_id, model, version, artifact_digest, eval_id, pool, stage}\`; no
  \`report_body\`, no \`samples\`.
- Producer config includes \`enable.idempotence\` and \`"acks": "all"\` (KafkaJS
  \`idempotent: true\` + \`acks: -1\`; kafka-go \`RequiredAcks: kafka.RequireAll\` with
  \`Balancer: &kafka.Hash{}\`; C++ \`set("enable.idempotence", "true")\` and \`set("acks", "all")\`).
- \`store.commit\` runs before \`producer.produce\`.
- A rejected produce (\`except KafkaException\`) writes the event with \`insert_outbox\` for a relay
  to republish; the caller does not fail and the event is not dropped.
- The topic name and the produce call stay as they are.`,
  sequence: {
    participants: ['Registry write', 'model.event', 'Event consumer'],
    messages: [
      {from: 'Registry write', to: 'Registry write', label: 'commit version (durable) first', kind: 'sync'},
      {from: 'Registry write', to: 'model.event', label: 'produce · key = model · ids · acks=all', kind: 'sync'},
      {from: 'model.event', to: 'Registry write', label: 'ack · or broker error', kind: 'reply'},
      {from: 'Registry write', to: 'Registry write', label: 'insertOutbox on error', kind: 'sync'},
      {from: 'model.event', to: 'Event consumer', label: 'consume · one model, one partition, in order', kind: 'async'},
      {
        from: 'Event consumer',
        to: 'Event consumer',
        label: 'resolve serving decision from the committed read',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'model-key',
      title: 'Keys every event by model name',
      detail:
        'The record key is the model name, so a model’s history stays in one partition and in order. The starter keys by artifact digest and scatters it.',
      match: {
        python: {all: [/key=model/]},
        typescript: {all: [/key:\s*model\b/]},
        go: {all: [/Key:\s*\[\]byte\(model\)/]},
        scala: {all: [/ProducerRecord\("model\.event",\s*model\s*,/]},
        cpp: {all: [/model\.data\(\),\s*model\.size\(\)/]},
      },
    },
    {
      id: 'ids-not-body',
      title: 'Publishes ids, not the eval report body',
      detail:
        'The payload carries `eval_id` and ids, never the report body or test-set samples. The starter copies the report into a retained, replicated topic where it outlives the eval store.',
      match: {
        python: {all: [/eval_id/], none: [/report_body|["']samples["']/]},
        typescript: {all: [/eval_id/], none: [/report_body|reportBody/]},
        go: {all: [/eval_id/], none: [/report_body|ReportBody/]},
        scala: {all: [/eval_id/], none: [/report_body|reportBody/]},
        cpp: {all: [/eval_id/], none: [/report_body/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Produces idempotently with acks=all',
      detail:
        'The producer acknowledges only after all in-sync replicas have the record and is configured for idempotence, so a retry cannot duplicate. The starter leaves both at their defaults.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/set\("enable\.idempotence"/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Publishes only after the registry write commits',
      detail:
        'The registry write commits before the produce, so a consumer never acts on an uncommitted promotion. The starter produces and acks first, then commits.',
      match: {
        python: {order: [/store\.commit\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.commit\(/, /producer\.send\(/]},
        go: {order: [/store\.Commit\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/store\.commit\(/, /producer\.send\(/]},
        cpp: {order: [/store\.commit\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Writes an outbox row when the produce is rejected',
      detail:
        'A rejected produce stores the event in an outbox for replay. The starter ignores the broker result, so a broker outage silently drops a model’s history.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

producer = Producer({"bootstrap.servers": "kafka:9092"})

TOPIC = "model.event"


class RegistryStore:
    def commit(self, model: str, version: str, event: dict) -> None:
        """Commit the registry write for this event."""
        raise NotImplementedError


store = RegistryStore()


def emit(model: str, version: str, digest: str, report: dict) -> None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    event = {
        "model": model,
        "version": version,
        "artifact_digest": digest,
        "report_body": report["report_body"],
        "samples": report["samples"],
    }
    producer.produce(TOPIC, key=digest, value=json.dumps(event))
    producer.flush(2.0)
    store.commit(model, version, event)
`,
      solution: `import json

from confluent_kafka import KafkaException, Producer
from pydantic import BaseModel

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)

TOPIC = "model.event"


class RegistryStore:
    def commit(self, model: str, version: str, event: dict) -> None:
        """Commit the registry write for this event before it is published."""
        raise NotImplementedError

    def insert_outbox(self, model: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = RegistryStore()


class ModelEvent(BaseModel):
    event_id: str
    model: str
    version: str
    artifact_digest: str
    eval_id: str
    pool: str | None = None
    stage: str


def emit(model: str, version: str, event: ModelEvent) -> None:
    store.commit(model, version, event.model_dump())
    try:
        producer.produce(TOPIC, key=model, value=event.model_dump_json())
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(model, event.model_dump())


def registered(model: str, version: str, digest: str, eval_id: str, lineage_tag: str) -> ModelEvent:
    return ModelEvent(
        event_id=f"{model}:{version}:registered",
        model=model,
        version=version,
        artifact_digest=digest,
        eval_id=eval_id,
        stage="staged",
    )
`,
    },
    typescript: {
      starter: `/** model.event: produces one event per registry write. */
import {Kafka} from 'kafkajs';

import {store} from './registry';

const kafka = new Kafka({clientId: 'model-registry', brokers: ['kafka:9092']});
const producer = kafka.producer();

const TOPIC = 'model.event';

interface EvalReport {
  report_body: string;
  samples: string[];
}

export async function emit(model: string, version: string, digest: string, report: EvalReport): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const event = {
    model,
    version,
    artifact_digest: digest,
    report_body: report.report_body,
    samples: report.samples,
  };
  await producer.send({topic: TOPIC, messages: [{key: digest, value: JSON.stringify(event)}]});
  await store.commit(model, version, event);
}
`,
      solution: `/** model.event: one event per registry write, keyed by model, published after the commit. */
import {Kafka} from 'kafkajs';

import {store} from './registry';

const kafka = new Kafka({clientId: 'model-registry', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const TOPIC = 'model.event';

interface ModelEvent {
  event_id: string;
  model: string;
  version: string;
  artifact_digest: string;
  eval_id: string;
  pool?: string;
  stage: string;
}

export async function emit(model: string, version: string, event: ModelEvent): Promise<void> {
  await store.commit(model, version, event);
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: model, value: JSON.stringify(event)}]});
  } catch (error) {
    await store.insertOutbox(model, event);
  }
}

export function registered(model: string, version: string, digest: string, evalId: string, lineageTag: string): ModelEvent {
  return {
    event_id: \`\${model}:\${version}:registered\`,
    model,
    version,
    artifact_digest: digest,
    eval_id: evalId,
    stage: 'staged',
  };
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

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "model.event"}

type RegistryStore struct{}

func (s *RegistryStore) Commit(ctx context.Context, model, version string, event map[string]any) error {
	return nil
}

var store = &RegistryStore{}

func Emit(ctx context.Context, model, version, digest string, report map[string]any) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	event := map[string]any{
		"model":           model,
		"version":         version,
		"artifact_digest": digest,
		"report_body":     report["report_body"],
	}
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(digest), Value: payload}); err != nil {
		return err
	}
	return store.Commit(ctx, model, version, event)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const eventTopic = "model.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type RegistryStore struct{}

func (s *RegistryStore) Commit(ctx context.Context, model, version string, event map[string]any) error {
	return nil
}

func (s *RegistryStore) InsertOutbox(ctx context.Context, model string, event map[string]any) error {
	return nil
}

var store = &RegistryStore{}

func RegisteredEvent(model, version, digest, evalID, lineageTag string) map[string]any {
	return map[string]any{
		"event_id":        model + ":" + version + ":registered",
		"model":           model,
		"version":         version,
		"artifact_digest": digest,
		"eval_id":         evalID,
		"lineage_tag":     lineageTag,
		"stage":           "staged",
	}
}

func Emit(ctx context.Context, model, version string, event map[string]any) error {
	if err := store.Commit(ctx, model, version, event); err != nil {
		return err
	}
	payload, _ := json.Marshal(event)
	err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(model), Value: payload})
	if err != nil {
		return store.InsertOutbox(ctx, model, event)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object ModelEvents {
  val producer = new KafkaProducer[String, String](new Properties())

  object store {
    def commit(model: String, version: String, event: Map[String, String]): Unit = ()
  }

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def emit(model: String, version: String, digest: String, report: Map[String, String]): Unit = {
    val event = Map("model" -> model, "artifact_digest" -> digest, "report_body" -> report("report_body"))
    producer.send(new ProducerRecord("model.event", digest, event.toJson.compactPrint))
    store.commit(model, version, event)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object ModelEvents {
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  object store {
    def commit(model: String, version: String, event: Map[String, String]): Unit = ()
    def insertOutbox(model: String, event: Map[String, String]): Unit = ()
  }

  def registered(model: String, version: String, digest: String, evalId: String, lineageTag: String): Map[String, String] =
    Map(
      "event_id" -> s"$model:$version:registered",
      "model" -> model,
      "version" -> version,
      "artifact_digest" -> digest,
      "eval_id" -> evalId,
      "lineage_tag" -> lineageTag,
      "stage" -> "staged"
    )

  def emit(model: String, version: String, event: Map[String, String]): Unit = {
    store.commit(model, version, event)
    try {
      producer.send(new ProducerRecord("model.event", model, event.toJson.compactPrint))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        store.insertOutbox(model, event)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kEventTopic = "model.event";

struct RegistryStore {
  void commit(const std::string& model, const std::string& version, const json& event);
};

RegistryStore store;

std::unique_ptr<RdKafka::Producer> producer;

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
void emit(const std::string& model, const std::string& version, const std::string& digest, const json& report) {
  const json event = {{"model", model}, {"artifact_digest", digest}, {"report_body", report}};
  const auto payload = event.dump();
  producer->produce(
      kEventTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      digest.data(),
      digest.size(),
      0,
      nullptr);
  store.commit(model, version, event);
  producer->flush(2000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kEventTopic = "model.event";

struct RegistryStore {
  void commit(const std::string& model, const std::string& version, const json& event);
  void insertOutbox(const std::string& model, const json& event);
};

RegistryStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

json registeredEvent(const std::string& model, const std::string& version, const std::string& digest,
                     const std::string& eval_id) {
  return json{
      {"event_id", model + ":" + version + ":registered"},
      {"model", model},
      {"version", version},
      {"artifact_digest", digest},
      {"eval_id", eval_id},
      {"stage", "staged"},
  };
}

void emit(const std::string& model, const std::string& version, const json& event) {
  store.commit(model, version, event);
  const auto payload = event.dump();
  const auto err = producer->produce(
      kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()), payload.size(), model.data(), model.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(model, event);
  }
  producer->flush(2000);
}
`,
    },
  },
  hints: [
    'A consumer that mirrors promotions into the traffic router received a `promoted` event for a version it had no registration for, then the registration arrived two seconds later.',
    'Kafka orders within a partition and the key picks the partition. `key=digest` sends each version of one model to a different partition, so events for one model race each other.',
    'Use `key=model`; payload `{event_id, model, version, artifact_digest, eval_id, pool, stage}`; producer `enable.idempotence` + `"acks": "all"`; `store.commit` before `producer.produce`; `except KafkaException` calls `insert_outbox`. The checks cover each.',
  ],
  debrief: `The key changes because ordering is the one guarantee a consumer builds on, and Kafka only gives it per partition. Commit moves ahead of produce because a published event is a promise the registry must already be able to keep; the outbox row covers the opposite case, a durable write whose event the broker refused. Note that a synchronous exception from produce() reports only local enqueue failures; a broker rejection arrives in the delivery callback, which production code also routes to the outbox. Platforms further protect the topic with a schema registry so a payload with a report body is rejected at produce time, and with a relay that drains the outbox in commit order.`,
};
