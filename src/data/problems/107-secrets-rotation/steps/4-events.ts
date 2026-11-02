import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Rotation events keyed by secret name without material',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'worker', 'audit'],
  task: `## Task

**Starting point.** The starter implements \`publish_event(consumer_id, event_type, version_id,
material)\`, which produces a \`{type, consumer, version_id, material}\` record to \`secret.event\`
keyed by \`consumer_id\`, and \`rotate(name, new_version_id, material)\`, which publishes an
\`activated\` event and then calls \`activate\`. It compiles, the demo shows events flowing, and it
hides four flaws.

**Failure mode the checks target.** The topic is treated as a scratchpad rather than a durable,
ordered, retained contract. A key that is not the secret scatters one secret's history across
partitions. A payload without a fingerprint cannot be correlated with what a consumer holds.
Material in the payload puts plaintext into a topic whose retention outlives the version. And
publishing before the swap announces an activation that has not happened.

- Event types are a **closed set**: \`created\`, \`activated\`, \`retired\`, \`revoked\`. Anything
  else is rejected before the produce.
- The message key is the **secret name**, so one secret's lifecycle lands on one partition in order.
- The payload is \`{type, secret, version_id, fingerprint, at}\`. **No material goes into it**, for
  no consumer, for no worker convenience.
- Publishing happens **after the pointer swap**: \`rotate\` calls \`activate\` first.
- One helper (\`publish_event\`) owns the produce: an idempotent producer with \`acks=all\`, and a
  rejected produce is written to the outbox row rather than dropped.`,
  sequence: {
    participants: ['Rotation worker', 'Secrets API', 'Kafka secret.event', 'Audit consumer'],
    messages: [
      {from: 'Rotation worker', to: 'Secrets API', label: 'rotate(name, new_version_id, fingerprint)', kind: 'sync'},
      {from: 'Secrets API', to: 'Secrets API', label: 'activate: swap the pointer first', kind: 'sync'},
      {
        from: 'Secrets API',
        to: 'Kafka secret.event',
        label: 'produce key = name · {type, version_id, fingerprint, at}',
        kind: 'async',
      },
      {from: 'Secrets API', to: 'Kafka secret.event', label: 'producer rejected → outbox row', kind: 'async'},
      {from: 'Kafka secret.event', to: 'Audit consumer', label: 'one partition per secret, in order', kind: 'async'},
      {from: 'Audit consumer', to: 'Kafka secret.event', label: 'commit after processing', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'topic',
      title: 'Lifecycle events are published to secret.event',
      detail:
        'One publisher (`publish_event`) writes every lifecycle event to the `secret.event` topic. Every other check builds on it.',
      match: {
        python: {all: [/\bdef publish_event\(/, /secret\.event/]},
        typescript: {all: [/async function publishEvent\(/, /secret\.event/]},
        go: {all: [/\bfunc publishEvent\(/, /secret\.event/]},
        scala: {all: [/\bdef publishEvent\(/, /secret\.event/]},
        cpp: {all: [/publishEvent\(/, /secret\.event/]},
      },
    },
    {
      id: 'per-secret-order',
      title: 'Events are keyed by the secret name',
      detail:
        'The record key is the secret name, so a secret’s create → activate → retire → revoke sequence stays on one partition in order. The starter keys by consumer, scattering one secret’s history across the topic.',
      match: {
        python: {all: [/\bkey=name\b/]},
        typescript: {all: [/key:\s*name\b/]},
        go: {all: [/Key:\s*\[\]byte\(name\)/]},
        scala: {all: [/ProducerRecord\([^,]+,\s*name\b/]},
        cpp: {all: [/name\.data\(\),\s*name\.size\(\)/]},
      },
    },
    {
      id: 'event-fields',
      title: 'The payload carries the secret, the version and the fingerprint',
      detail:
        'Every event names its secret, its `version_id`, the `fingerprint` of that version and a timestamp — enough for a consumer to correlate the event with what it holds. The starter sends a consumer id and the version id, so a consumer cannot tell which material the event refers to.',
      match: {
        python: {all: [/version_id/, /fingerprint/, /\bsecret\b/]},
        typescript: {all: [/version_id/, /fingerprint/, /\bsecret\b/]},
        go: {all: [/version_id/, /fingerprint/, /\bsecret\b/]},
        scala: {all: [/version_id/, /fingerprint/, /\bsecret\b/]},
        cpp: {all: [/version_id/, /fingerprint/, /\bsecret\b/]},
      },
    },
    {
      id: 'no-material',
      title: 'No event, in any field, carries material',
      detail:
        'The word `material` appears nowhere in the publisher: the topic is retained and replicated, and a payload cannot be un-published. The starter ships the material so workers can skip the vault fetch.',
      match: {
        python: {all: [/\bdef publish_event\(/], none: [/\bmaterial\b/]},
        typescript: {all: [/async function publishEvent\(/], none: [/\bmaterial\b/]},
        go: {all: [/\bfunc publishEvent\(/], none: [/\bmaterial\b/]},
        scala: {all: [/\bdef publishEvent\(/], none: [/\bmaterial\b/]},
        cpp: {all: [/publishEvent\(/], none: [/\bmaterial\b/]},
      },
    },
    {
      id: 'publish-after-swap',
      title: 'The event is published after the pointer swap',
      detail:
        'In `rotate` the call to `activate` comes before the publish, so no event describes a version the fleet cannot use yet. The starter publishes first and swaps second, announcing an activation that has not happened.',
      match: {
        python: {order: [/\bactivate\(name, new_version_id\)/, /publish_event\(/]},
        typescript: {order: [/activate\(name, newVersionId\)/, /publishEvent\(/]},
        go: {order: [/activate\(ctx, name, newVersionID\)/, /publishEvent\(/]},
        scala: {order: [/activate\(name, newVersionId\)/, /publishEvent\(/]},
        cpp: {order: [/activate\(name, newVersionId\)/, /publishEvent\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

SECRET_TOPIC = "secret.event"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_event(consumer_id: str, event_type: str, version_id: str, material: str) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    event = {
        "type": event_type,
        "consumer": consumer_id,
        "version_id": version_id,
        "material": material,
    }
    producer.produce(SECRET_TOPIC, key=consumer_id, value=json.dumps(event))
    producer.flush(2.0)
    return event


def rotate(name: str, new_version_id: str, material: str) -> dict:
    publish_event(name, "activated", new_version_id, material)
    previous = activate(name, new_version_id)
    return {"active": new_version_id, "overlap": previous}
`,
      solution: `import json
import time

from confluent_kafka import KafkaException, Producer

SECRET_TOPIC = "secret.event"
EVENT_TYPES = {"created", "activated", "retired", "revoked"}

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class OutboxStore:
    def insert_outbox(self, name: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


def publish_event(name: str, event_type: str, version_id: str, fingerprint: str) -> dict:
    """One event per lifecycle step, keyed by secret name so a secret's history stays ordered."""
    if event_type not in EVENT_TYPES:
        raise ValueError(f"unknown event type: {event_type}")
    event = {
        "type": event_type,
        "secret": name,
        "version_id": version_id,
        "fingerprint": fingerprint,
        "at": int(time.time()),
    }
    try:
        producer.produce(SECRET_TOPIC, key=name, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(name, event)
    return event


def rotate(name: str, new_version_id: str, fingerprint: str) -> dict:
    """Swap the pointer first, then announce: an event for a version that is not active yet lies."""
    previous = activate(name, new_version_id)
    publish_event(name, "activated", new_version_id, fingerprint)
    return {"active": new_version_id, "overlap": previous}


def retire(name: str, version_id: str, fingerprint: str) -> None:
    publish_event(name, "retired", version_id, fingerprint)


def revoke(name: str, version_id: str, fingerprint: str) -> None:
    publish_event(name, "revoked", version_id, fingerprint)
`,
    },
    typescript: {
      starter: `/** secret.event: the starter. */
import {Kafka} from 'kafkajs';

const TOPIC = 'secret.event';

const kafka = new Kafka({clientId: 'secrets-rotation', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export async function publishEvent(
  consumerId: string,
  eventType: string,
  versionId: string,
  material: string,
): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const event = {type: eventType, consumer: consumerId, version_id: versionId, material};
  await producer.send({topic: TOPIC, messages: [{key: consumerId, value: JSON.stringify(event)}]});
  return event;
}

export async function rotate(name: string, newVersionId: string, material: string): Promise<Record<string, unknown>> {
  await publishEvent(name, 'activated', newVersionId, material);
  const previous = await activate(name, newVersionId);
  return {active: newVersionId, overlap: previous};
}
`,
      solution: `/** secret.event: one ordered, keyed, material-free event per lifecycle step, after the swap. */
import {Kafka} from 'kafkajs';

import {store} from './rotation_store';

const TOPIC = 'secret.event';
const EVENT_TYPES: Record<string, true> = {created: true, activated: true, retired: true, revoked: true};

const kafka = new Kafka({clientId: 'secrets-rotation', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});

interface SecretEvent {
  type: string;
  secret: string;
  version_id: string;
  fingerprint: string;
  at: number;
}

/** One event per lifecycle step, keyed by secret name so a secret's history stays ordered. */
async function publishEvent(
  name: string,
  eventType: string,
  versionId: string,
  fingerprint: string,
): Promise<SecretEvent> {
  if (EVENT_TYPES[eventType] !== true) throw new Error(\`unknown event type: \${eventType}\`);
  const event: SecretEvent = {
    type: eventType,
    secret: name,
    version_id: versionId,
    fingerprint,
    at: Math.floor(Date.now() / 1000),
  };
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: name, value: JSON.stringify(event)}]});
  } catch {
    await store.insertOutbox(name, event);
  }
  return event;
}

/** Swap the pointer first, then announce: an event for a version that is not active yet lies. */
async function rotate(name: string, newVersionId: string, fingerprint: string): Promise<Record<string, unknown>> {
  const previous = await activate(name, newVersionId);
  await publishEvent(name, 'activated', newVersionId, fingerprint);
  return {active: newVersionId, overlap: previous === '' ? null : previous};
}

async function retire(name: string, versionId: string, fingerprint: string): Promise<void> {
  await publishEvent(name, 'retired', versionId, fingerprint);
}

async function revoke(name: string, versionId: string, fingerprint: string): Promise<void> {
  await publishEvent(name, 'revoked', versionId, fingerprint);
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

const secretTopic = "secret.event"

var secretWriter = &kafka.Writer{
	Addr:  kafka.TCP("kafka:9092"),
	Topic: secretTopic,
}

type SecretEvent struct {
	Type      string \`json:"type"\`
	Consumer  string \`json:"consumer"\`
	VersionID string \`json:"version_id"\`
	Material  string \`json:"material"\`
}

func publishEvent(ctx context.Context, consumerID, eventType, versionID, material string) (SecretEvent, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	event := SecretEvent{Type: eventType, Consumer: consumerID, VersionID: versionID, Material: material}
	payload, err := json.Marshal(event)
	if err != nil {
		return event, err
	}
	err = secretWriter.WriteMessages(ctx, kafka.Message{Key: []byte(consumerID), Value: payload})
	return event, err
}

func rotate(ctx context.Context, name, newVersionID, material string) (map[string]any, error) {
	if _, err := publishEvent(ctx, name, "activated", newVersionID, material); err != nil {
		return nil, err
	}
	previous, err := activate(ctx, name, newVersionID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"active": newVersionID, "overlap": previous}, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

const secretTopic = "secret.event"

var eventTypes = map[string]bool{"created": true, "activated": true, "retired": true, "revoked": true}

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same key
// land on the same partition instead of duplicating across them.
var secretWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        secretTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type SecretEvent struct {
	Type        string \`json:"type"\`
	Secret      string \`json:"secret"\`
	VersionID   string \`json:"version_id"\`
	Fingerprint string \`json:"fingerprint"\`
	At          int64  \`json:"at"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, name string, event SecretEvent) error { return nil }

var store = &OutboxStore{}

// publishEvent writes one event per lifecycle step, keyed by secret name so its history stays ordered.
func publishEvent(ctx context.Context, name, eventType, versionID, fingerprint string) (SecretEvent, error) {
	event := SecretEvent{
		Type:        eventType,
		Secret:      name,
		VersionID:   versionID,
		Fingerprint: fingerprint,
		At:          time.Now().Unix(),
	}
	if !eventTypes[eventType] {
		return event, fmt.Errorf("unknown event type: %s", eventType)
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return event, err
	}
	if err := secretWriter.WriteMessages(ctx, kafka.Message{Key: []byte(name), Value: payload}); err != nil {
		_ = store.InsertOutbox(ctx, name, event)
	}
	return event, nil
}

// rotate swaps the pointer first, then announces: an event for a version that is not active yet lies.
func rotate(ctx context.Context, name, newVersionID, fingerprint string) (map[string]any, error) {
	previous, err := activate(ctx, name, newVersionID)
	if err != nil {
		return nil, err
	}
	if _, err := publishEvent(ctx, name, "activated", newVersionID, fingerprint); err != nil {
		return nil, err
	}
	return map[string]any{"active": newVersionID, "overlap": previous}, nil
}

func retire(ctx context.Context, name, versionID, fingerprint string) error {
	_, err := publishEvent(ctx, name, "retired", versionID, fingerprint)
	return err
}

func revoke(ctx context.Context, name, versionID, fingerprint string) error {
	_, err := publishEvent(ctx, name, "revoked", versionID, fingerprint)
	return err
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object RotationEvents {
  val SecretTopic = "secret.event"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props
  })

  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  def publishEvent(consumerId: String, eventType: String, versionId: String, material: String): Map[String, String] = {
    val event = Map(
      "type" -> eventType,
      "consumer" -> consumerId,
      "version_id" -> versionId,
      "material" -> material
    )
    producer.send(new ProducerRecord(SecretTopic, consumerId, event.toJson.compactPrint))
    event
  }

  def rotate(name: String, newVersionId: String, material: String): Map[String, String] = {
    publishEvent(name, "activated", newVersionId, material)
    val previous = SecretState.activate(name, newVersionId)
    Map("active" -> newVersionId, "overlap" -> previous)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object RotationEvents {
  val SecretTopic = "secret.event"
  val EventTypes = Set("created", "activated", "retired", "revoked")

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  // One event per lifecycle step, keyed by secret name so a secret's history stays ordered.
  def publishEvent(name: String, eventType: String, versionId: String, fingerprint: String): Map[String, String] = {
    if (!EventTypes.contains(eventType)) throw new IllegalArgumentException(s"unknown event type: $eventType")
    val event = Map(
      "type" -> eventType,
      "secret" -> name,
      "version_id" -> versionId,
      "fingerprint" -> fingerprint,
      "at" -> (System.currentTimeMillis() / 1000).toString
    )
    val payload = event.toJson.compactPrint
    try {
      producer.send(new ProducerRecord(SecretTopic, name, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException => OutboxStore.insertOutbox(name, payload)
    }
    event
  }

  // Swap the pointer first, then announce: an event for a version that is not active yet lies.
  def rotate(name: String, newVersionId: String, fingerprint: String): Map[String, String] = {
    val previous = SecretState.activate(name, newVersionId)
    publishEvent(name, "activated", newVersionId, fingerprint)
    Map("active" -> newVersionId, "overlap" -> previous)
  }

  def retire(name: String, versionId: String, fingerprint: String): Unit =
    publishEvent(name, "retired", versionId, fingerprint)

  def revoke(name: String, versionId: String, fingerprint: String): Unit =
    publishEvent(name, "revoked", versionId, fingerprint)
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kSecretTopic = "secret.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
json publishEvent(const std::string& consumerId, const std::string& eventType, const std::string& versionId,
                  const std::string& material) {
  const json event = {{"type", eventType}, {"consumer", consumerId}, {"version_id", versionId}, {"material", material}};
  const auto payload = event.dump();
  producer->produce(kSecretTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), consumerId.data(), consumerId.size(), 0, nullptr);
  producer->flush(2000);
  return event;
}

json rotate(const std::string& name, const std::string& newVersionId, const std::string& material) {
  publishEvent(name, "activated", newVersionId, material);
  const auto previous = activate(name, newVersionId);
  return json{{"active", newVersionId}, {"overlap", previous}};
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <ctime>
#include <memory>
#include <nlohmann/json.hpp>
#include <set>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

const std::string kSecretTopic = "secret.event";
const std::set<std::string> kEventTypes = {"created", "activated", "retired", "revoked"};

struct OutboxStore {
  void insertOutbox(const std::string& name, const json& event);
};

OutboxStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// One event per lifecycle step, keyed by secret name so a secret's history stays ordered.
json publishEvent(const std::string& name, const std::string& eventType, const std::string& versionId,
                  const std::string& fingerprint) {
  if (kEventTypes.count(eventType) == 0) throw std::invalid_argument("unknown event type: " + eventType);
  const json event = {
      {"type", eventType},
      {"secret", name},
      {"version_id", versionId},
      {"fingerprint", fingerprint},
      {"at", static_cast<long>(std::time(nullptr))},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(kSecretTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                     const_cast<char*>(payload.data()), payload.size(), name.data(), name.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) store.insertOutbox(name, event);
  producer->flush(2000);
  return event;
}

// Swap the pointer first, then announce: an event for a version that is not active yet lies.
json rotate(const std::string& name, const std::string& newVersionId, const std::string& fingerprint) {
  const auto previous = activate(name, newVersionId);
  publishEvent(name, "activated", newVersionId, fingerprint);
  return json{{"active", newVersionId}, {"overlap", previous}};
}

json retire(const std::string& name, const std::string& versionId, const std::string& fingerprint) {
  return publishEvent(name, "retired", versionId, fingerprint);
}

json revoke(const std::string& name, const std::string& versionId, const std::string& fingerprint) {
  return publishEvent(name, "revoked", versionId, fingerprint);
}
`,
    },
  },
  hints: [
    'Symptom: the audit consumer sees `retired` before `activated` for the same secret, cannot tell which bytes an event refers to, and a grep of the topic turns up plaintext.',
    'Mechanism: the record is keyed by `consumer_id` so one secret spans partitions, the payload carries `material` and no `fingerprint`, and `rotate` produces before `activate` has moved the pointer.',
    'Change: `key=name`, a `{type, secret, version_id, fingerprint, at}` payload with no `material` anywhere in the publisher, and `activate(name, new_version_id)` before `publish_event` in `rotate`.',
  ],
  debrief: `The fix has its shape because a topic is a contract with three clauses. Ordering: a sequence is only ordered within a partition, so the key must be the entity whose history you need, the secret name, not the consumer you happen to notify. Content: the topic is retained, replicated and readable by every team with consume rights, so it carries ids and a fingerprint; a fingerprint lets a consumer prove which version an event refers to and is useless to an attacker holding no material. Timing: the pointer is the source of truth, so the event reports a fact that has already happened. Production platforms go further than this step: a schema registry so the payload cannot drift, and a compacted current-state topic beside the event log.`,
};
