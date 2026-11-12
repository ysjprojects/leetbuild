import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Lifecycle events keyed by secret name, without material',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'redis', 'kafka', 'audit'],
  task: `## Task

**Starting point.** The starter produces the \`secret.event\` stream the audit consumer reads:
\`publish_event(event_type, name, version_id)\` reads the version from the vault and produces one
record, and \`rotate(name, version_id)\` publishes \`activated\`, then calls \`rotation.activate\` and
\`vault.record_activation\`. Rotate a secret and an event shows up; it hides four flaws.

**Failure mode the checks target.** One secret's history lands on several partitions and the audit
consumer reads it out of order; the material goes into a topic that is retained and replicated; the
audit learns about an activation before the pointer moved; and a lost acknowledgement writes an
event twice.

- The record key is the **secret name**.
- The payload is \`{type, secret, version_id, fingerprint, at}\`, \`type\` one of \`EVENT_TYPES\`
  (\`created\`, \`activated\`, \`retired\`, \`revoked\`). No material.
- \`rotate\` moves the pointer first and produces only afterwards.
- The producer is idempotent with \`acks=all\` (the stack's equivalent: kafkajs \`idempotent\`,
  librdkafka \`enable.idempotence\`; kafka-go has no idempotent producer, so its writer uses
  \`RequireAll\` and the audit consumer drops a repeated \`(secret, version_id, type)\`).`,
  sequence: {
    participants: ['Rotation worker', 'Redis', 'secret.event', 'Audit consumer'],
    messages: [
      {from: 'Rotation worker', to: 'Redis', label: 'rotation.activate(name, v2)', kind: 'sync'},
      {from: 'Redis', to: 'Rotation worker', label: 'previous v1', kind: 'reply'},
      {
        from: 'Rotation worker',
        to: 'secret.event',
        label: 'produce · key = name · {type, secret, version_id, fingerprint, at}',
        kind: 'sync',
      },
      {from: 'secret.event', to: 'Rotation worker', label: 'ack once (idempotent, acks=all)', kind: 'reply'},
      {from: 'secret.event', to: 'Audit consumer', label: 'one partition per secret, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'secret-key',
      title: 'Keyed by the secret name',
      detail:
        "The record key is the secret name (`key=name`, `key: name`, `[]byte(name)`, `ProducerRecord(topic, name, …)`), so a secret's created → activated → retired sequence stays on one partition in order; the starter keys by version id.",
      match: {
        python: {all: [/key=name\b/, /secret\.event/], none: [/key=version_id/]},
        typescript: {all: [/key:\s*name\b/, /secret\.event/], none: [/key:\s*versionId/]},
        go: {all: [/Key:\s*\[\]byte\(name\)/, /secret\.event/], none: [/Key:\s*\[\]byte\(versionID\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(EventTopic,\s*name\b/, /secret\.event/],
          none: [/EventTopic,\s*versionId/],
        },
        cpp: {
          all: [/name\.c_str\(\),\s*name\.size\(\)/, /secret\.event/],
          none: [/version_id\.c_str\(\),\s*version_id\.size\(\)/],
        },
      },
    },
    {
      id: 'no-material',
      title: 'The payload carries the fingerprint, never the material',
      detail:
        "Every event names the secret, the version id, the version's `fingerprint` and a time; nothing reads the version's material into it, because a topic cannot be un-published.",
      match: {
        python: {all: [/["']fingerprint["']/, /["']at["']/], none: [/\[["']material["']\]/]},
        typescript: {all: [/fingerprint/, /\bat:/], none: [/\.material\b/]},
        go: {all: [/"fingerprint"/, /"at"/], none: [/\.Material\b/]},
        scala: {all: [/"fingerprint"/, /"at"/], none: [/\.material\b/]},
        cpp: {all: [/"fingerprint"/, /"at"/], none: [/\.material\b/]},
      },
    },
    {
      id: 'publish-after-swap',
      title: 'The activation event follows the pointer swap',
      detail:
        '`rotate` calls `rotation.activate` before it produces, so no event announces a version consumers cannot resolve yet; the starter produces first.',
      match: {
        python: {order: [/def rotate\(/, /rotation\.activate\(/, /publish_event\(/]},
        typescript: {order: [/function rotate\(/, /rotation\.activate\(/, /publishEvent\(/]},
        go: {order: [/func rotate\(/, /rotation\.Activate\(/, /publishEvent\(/]},
        scala: {order: [/def rotate\(/, /Rotation\.activate\(/, /publishEvent\(/]},
        cpp: {order: [/json rotate\(/, /rotation::activate\(/, /publishEvent\(/]},
      },
    },
    {
      id: 'durable-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` plus `acks`, kafkajs `idempotent: true` with `acks: -1`, kafka-go `RequireAll`), so a retry after a lost acknowledgement writes the event once and a leader failover keeps it.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

from confluent_kafka import Producer

from secretd import rotation, vault  # rotation.activate; vault.get_version, record_activation

EVENT_TOPIC = "secret.event"
EVENT_TYPES = ("created", "activated", "retired", "revoked")
log = logging.getLogger("secretd.events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("secret event not delivered: %s", err)


def publish_event(event_type: str, name: str, version_id: str) -> dict:
    """One record on secret.event for a lifecycle step of a version."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if event_type not in EVENT_TYPES:
        raise ValueError(f"unknown event type {event_type}")
    version = vault.get_version(name, version_id)
    event = {
        "type": event_type,
        "secret": name,
        "version_id": version_id,
        "fingerprint": version["fingerprint"],
        "material": version["material"],  # consumers warm their cache without a vault read
        "at": int(time.time()),
    }
    producer.produce(EVENT_TOPIC, key=version_id, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    return event


def rotate(name: str, version_id: str) -> dict:
    """Make version_id the active version and announce it."""
    event = publish_event("activated", name, version_id)
    rotation.activate(name, version_id)
    vault.record_activation(name, version_id)
    return event
`,
      solution: `import json
import logging
import time

from confluent_kafka import Producer

from secretd import rotation, vault  # rotation.activate; vault.get_version, record_activation

EVENT_TOPIC = "secret.event"
EVENT_TYPES = ("created", "activated", "retired", "revoked")
log = logging.getLogger("secretd.events")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("secret event not delivered: %s", err)


def publish_event(event_type: str, name: str, version_id: str) -> dict:
    """One record on secret.event for a lifecycle step of a version."""
    if event_type not in EVENT_TYPES:
        raise ValueError(f"unknown event type {event_type}")
    version = vault.get_version(name, version_id)
    # Ids and the fingerprint name the version; the secret itself stays in the vault.
    event = {"type": event_type, "secret": name, "version_id": version_id, "fingerprint": version["fingerprint"], "at": int(time.time())}
    producer.produce(EVENT_TOPIC, key=name, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    return event


def rotate(name: str, version_id: str) -> dict:
    """Make version_id the active version and announce it."""
    # The pointer moves first: an event may lag the state, never precede it.
    rotation.activate(name, version_id)
    vault.record_activation(name, version_id)
    return publish_event("activated", name, version_id)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as rotation from 'secretd/rotation';
import * as vault from 'secretd/vault';

export const EVENT_TOPIC = 'secret.event';
export const EVENT_TYPES = ['created', 'activated', 'retired', 'revoked'];

const kafka = new Kafka({clientId: 'secretd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One record on secret.event for a lifecycle step of a version. */
export async function publishEvent(eventType: string, name: string, versionId: string): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (!EVENT_TYPES.includes(eventType)) throw new Error(\`unknown event type \${eventType}\`);
  const version = (await vault.getVersion(name, versionId)) as vault.Version;
  const event = {
    type: eventType,
    secret: name,
    version_id: versionId,
    fingerprint: version.fingerprint,
    material: version.material, // consumers warm their cache without a vault read
    at: Math.floor(Date.now() / 1000),
  };
  await producer.send({topic: EVENT_TOPIC, messages: [{key: versionId, value: JSON.stringify(event)}], acks: 1});
  return event;
}

/** Make versionId the active version and announce it. */
export async function rotate(name: string, versionId: string): Promise<Record<string, unknown>> {
  const event = await publishEvent('activated', name, versionId);
  await rotation.activate(name, versionId);
  await vault.recordActivation(name, versionId);
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as rotation from 'secretd/rotation';
import * as vault from 'secretd/vault';

export const EVENT_TOPIC = 'secret.event';
export const EVENT_TYPES = ['created', 'activated', 'retired', 'revoked'];

const kafka = new Kafka({clientId: 'secretd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the event once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One record on secret.event for a lifecycle step of a version. */
export async function publishEvent(eventType: string, name: string, versionId: string): Promise<Record<string, unknown>> {
  if (!EVENT_TYPES.includes(eventType)) throw new Error(\`unknown event type \${eventType}\`);
  const version = (await vault.getVersion(name, versionId)) as vault.Version;
  // Ids and the fingerprint name the version; the secret itself stays in the vault.
  const event = {type: eventType, secret: name, version_id: versionId, fingerprint: version.fingerprint, at: Math.floor(Date.now() / 1000)};
  await producer.send({topic: EVENT_TOPIC, messages: [{key: name, value: JSON.stringify(event)}], acks: -1});
  return event;
}

/** Make versionId the active version and announce it. */
export async function rotate(name: string, versionId: string): Promise<Record<string, unknown>> {
  // The pointer moves first: an event may lag the state, never precede it.
  await rotation.activate(name, versionId);
  await vault.recordActivation(name, versionId);
  return publishEvent('activated', name, versionId);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"

	"secretd/rotation" // rotation.Activate
	"secretd/vault"    // vault.GetVersion, RecordActivation
)

const eventTopic = "secret.event"

var eventTypes = map[string]bool{"created": true, "activated": true, "retired": true, "revoked": true}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// publishEvent produces one record on secret.event for a lifecycle step of a version.
func publishEvent(ctx context.Context, eventType, name, versionID string) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if !eventTypes[eventType] {
		return nil, fmt.Errorf("unknown event type %q", eventType)
	}
	version := vault.GetVersion(ctx, name, versionID)
	if version == nil {
		return nil, fmt.Errorf("no version %s of %s", versionID, name)
	}
	event := map[string]any{
		"type":        eventType,
		"secret":      name,
		"version_id":  versionID,
		"fingerprint": version.Fingerprint,
		"material":    version.Material, // consumers warm their cache without a vault read
		"at":          time.Now().Unix(),
	}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(versionID), Value: value}); err != nil {
		return nil, err
	}
	return event, nil
}

// rotate makes versionID the active version and announces it.
func rotate(ctx context.Context, name, versionID string) (map[string]any, error) {
	event, err := publishEvent(ctx, "activated", name, versionID)
	if err != nil {
		return nil, err
	}
	if _, err := rotation.Activate(ctx, name, versionID); err != nil {
		return nil, err
	}
	vault.RecordActivation(ctx, name, versionID)
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"

	"secretd/rotation" // rotation.Activate
	"secretd/vault"    // vault.GetVersion, RecordActivation
)

const eventTopic = "secret.event"

var eventTypes = map[string]bool{"created": true, "activated": true, "retired": true, "revoked": true}

// RequireAll: the event is on every replica before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate; the audit consumer drops a
// repeated (secret, version_id, type).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// publishEvent produces one record on secret.event for a lifecycle step of a version.
func publishEvent(ctx context.Context, eventType, name, versionID string) (map[string]any, error) {
	if !eventTypes[eventType] {
		return nil, fmt.Errorf("unknown event type %q", eventType)
	}
	version := vault.GetVersion(ctx, name, versionID)
	if version == nil {
		return nil, fmt.Errorf("no version %s of %s", versionID, name)
	}
	// Ids and the fingerprint name the version; the secret itself stays in the vault.
	event := map[string]any{"type": eventType, "secret": name, "version_id": versionID, "fingerprint": version.Fingerprint, "at": time.Now().Unix()}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(name), Value: value}); err != nil {
		return nil, err
	}
	return event, nil
}

// rotate makes versionID the active version and announces it.
func rotate(ctx context.Context, name, versionID string) (map[string]any, error) {
	// The pointer moves first: an event may lag the state, never precede it.
	if _, err := rotation.Activate(ctx, name, versionID); err != nil {
		return nil, err
	}
	vault.RecordActivation(ctx, name, versionID)
	return publishEvent(ctx, "activated", name, versionID)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import secretd.{Rotation, Vault} // Rotation.activate; Vault.getVersion, recordActivation

object Events {
  val EventTopic = "secret.event"
  val EventTypes: Set[String] = Set("created", "activated", "retired", "revoked")

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"secret event not delivered: \${exception.getMessage}")
  }

  /** One record on secret.event for a lifecycle step of a version. */
  def publishEvent(eventType: String, name: String, versionId: String): JsObject = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    require(EventTypes.contains(eventType), s"unknown event type $eventType")
    val version = Vault.getVersion(name, versionId).get
    val event = JsObject(
      "type" -> JsString(eventType),
      "secret" -> JsString(name),
      "version_id" -> JsString(versionId),
      "fingerprint" -> JsString(version.fingerprint),
      "material" -> JsString(version.material), // consumers warm their cache without a vault read
      "at" -> JsNumber(System.currentTimeMillis() / 1000))
    producer.send(new ProducerRecord[String, String](EventTopic, versionId, event.compactPrint), onDelivery).get()
    event
  }

  /** Make versionId the active version and announce it. */
  def rotate(name: String, versionId: String): JsObject = {
    val event = publishEvent("activated", name, versionId)
    Rotation.activate(name, versionId)
    Vault.recordActivation(name, versionId)
    event
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import secretd.{Rotation, Vault} // Rotation.activate; Vault.getVersion, recordActivation

object Events {
  val EventTopic = "secret.event"
  val EventTypes: Set[String] = Set("created", "activated", "retired", "revoked")

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"secret event not delivered: \${exception.getMessage}")
  }

  /** One record on secret.event for a lifecycle step of a version. */
  def publishEvent(eventType: String, name: String, versionId: String): JsObject = {
    require(EventTypes.contains(eventType), s"unknown event type $eventType")
    val version = Vault.getVersion(name, versionId).get
    // Ids and the fingerprint name the version; the secret itself stays in the vault.
    val event = JsObject(
      "type" -> JsString(eventType),
      "secret" -> JsString(name),
      "version_id" -> JsString(versionId),
      "fingerprint" -> JsString(version.fingerprint),
      "at" -> JsNumber(System.currentTimeMillis() / 1000))
    producer.send(new ProducerRecord[String, String](EventTopic, name, event.compactPrint), onDelivery).get()
    event
  }

  /** Make versionId the active version and announce it. */
  def rotate(name: String, versionId: String): JsObject = {
    // The pointer moves first: an event may lag the state, never precede it.
    Rotation.activate(name, versionId)
    Vault.recordActivation(name, versionId)
    publishEvent("activated", name, versionId)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "secretd/rotation.h"  // rotation::activate
#include "secretd/vault.h"     // vault::getVersion, recordActivation

using json = nlohmann::json;

const std::string kEventTopic = "secret.event";
const std::vector<std::string> kEventTypes = {"created", "activated", "retired", "revoked"};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "secret event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One record on secret.event for a lifecycle step of a version.
json publishEvent(const std::string& event_type, const std::string& name, const std::string& version_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (std::find(kEventTypes.begin(), kEventTypes.end(), event_type) == kEventTypes.end()) {
    throw std::invalid_argument("unknown event type " + event_type);
  }
  const vault::Version version = *vault::getVersion(name, version_id);
  const json event = {{"type", event_type},
                      {"secret", name},
                      {"version_id", version_id},
                      {"fingerprint", version.fingerprint},
                      {"material", version.material},  // consumers warm their cache without a vault read
                      {"at", vault::nowSeconds()}};
  const std::string value = event.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), version_id.c_str(), version_id.size(), 0, nullptr);
  producer->flush(2000);
  return event;
}

// Make version_id the active version and announce it.
json rotate(const std::string& name, const std::string& version_id) {
  const json event = publishEvent("activated", name, version_id);
  rotation::activate(name, version_id);
  vault::recordActivation(name, version_id);
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "secretd/rotation.h"  // rotation::activate
#include "secretd/vault.h"     // vault::getVersion, recordActivation

using json = nlohmann::json;

const std::string kEventTopic = "secret.event";
const std::vector<std::string> kEventTypes = {"created", "activated", "retired", "revoked"};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "secret event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One record on secret.event for a lifecycle step of a version.
json publishEvent(const std::string& event_type, const std::string& name, const std::string& version_id) {
  if (std::find(kEventTypes.begin(), kEventTypes.end(), event_type) == kEventTypes.end()) {
    throw std::invalid_argument("unknown event type " + event_type);
  }
  const vault::Version version = *vault::getVersion(name, version_id);
  // Ids and the fingerprint name the version; the secret itself stays in the vault.
  const json event = {{"type", event_type}, {"secret", name}, {"version_id", version_id}, {"fingerprint", version.fingerprint}, {"at", vault::nowSeconds()}};
  const std::string value = event.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), name.c_str(), name.size(), 0, nullptr);
  producer->flush(2000);
  return event;
}

// Make version_id the active version and announce it.
json rotate(const std::string& name, const std::string& version_id) {
  // The pointer moves first: an event may lag the state, never precede it.
  rotation::activate(name, version_id);
  vault::recordActivation(name, version_id);
  return publishEvent("activated", name, version_id);
}
`,
    },
  },
  harness: {
    python: `import json

from secretd import rotation, vault

TOPIC = "secret.event"
NAME = "payments-db"
MATERIAL = "pg-password-CANARY-41d7"


def _events(ctx):
    vault.create_version(NAME, MATERIAL, 3600, "op-ana")
    vault.create_version(NAME, MATERIAL + "-2", 3600, "op-ana")
    return ctx.load("events")


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def check_secret_key(ctx):
    m = _events(ctx)
    m.publish_event("created", NAME, "v1")
    m.rotate(NAME, "v1")
    m.publish_event("created", NAME, "v2")
    m.rotate(NAME, "v2")
    m.publish_event("retired", NAME, "v1")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 5, f"five lifecycle events produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [NAME.encode()] * 5, f"records must be keyed by the secret name, got {keys}: keyed by anything else, one secret's history scatters across partitions"
    partitions = {r.partition for r in records}
    assert len(partitions) == 1, f"{NAME}'s events landed on partitions {sorted(partitions)}: one secret's history must stay on one partition, in order"
    assert [_payload(r)["type"] for r in records] == ["created", "activated", "created", "activated", "retired"], "the events must keep their order on the partition"


def check_no_material(ctx):
    m = _events(ctx)
    m.rotate(NAME, "v1")
    record = ctx.kafka.records(TOPIC)[0]
    assert MATERIAL.encode() not in record.value, f"the event carries the material: {record.value!r}. The topic is retained and replicated; carry the fingerprint"
    payload = _payload(record)
    assert "material" not in payload, f"the event has a material field: {payload}"
    expected = {"type": "activated", "secret": NAME, "version_id": "v1", "fingerprint": vault.fingerprint(MATERIAL)}
    got = {k: payload.get(k) for k in expected}
    assert got == expected, f"the event must carry {expected}, got {payload}"
    assert isinstance(payload.get("at"), int), f"the event must carry the time as whole seconds (at), got {payload.get('at')!r}"


def check_publish_after_swap(ctx):
    m = _events(ctx)
    # The moment the pointer moves, what is already on the topic.
    at_swap = ctx.redis_after("secret:payments-db:active", lambda: len(ctx.kafka.records(TOPIC)))
    m.rotate(NAME, "v1")
    assert at_swap.fired, "rotate never moved secret:payments-db:active"
    assert at_swap.result == 0, f"when the pointer moved the topic already held {at_swap.result} record(s): the event announced a version consumers could not resolve yet. Activate, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after the rotation the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 1"
    assert rotation.valid_versions(NAME) == ["v1"], f"after the rotation valid_versions is {rotation.valid_versions(NAME)}"
    assert vault.get_version(NAME, "v1")["activated_at"] is not None, "the activation must be recorded on v1 (vault.record_activation)"


def check_durable_producer(ctx):
    m = _events(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    m.rotate(NAME, "v1")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one rotation whose acknowledgement was lost left {len(records)} records on the topic: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    m.rotate(NAME, "v2")
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the second event and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'secret.event';
const NAME = 'payments-db';
const MATERIAL = 'pg-password-CANARY-41d7';

async function events(ctx) {
  const vault = ctx.load('/support/secretd/vault.ts');
  const rotation = ctx.load('/support/secretd/rotation.ts');
  await vault.createVersion(NAME, MATERIAL, 3600, 'op-ana');
  await vault.createVersion(NAME, \`\${MATERIAL}-2\`, 3600, 'op-ana');
  return {m: ctx.load('events'), vault, rotation};
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

export async function check_secret_key(ctx) {
  const {m} = await events(ctx);
  await m.publishEvent('created', NAME, 'v1');
  await m.rotate(NAME, 'v1');
  await m.publishEvent('created', NAME, 'v2');
  await m.rotate(NAME, 'v2');
  await m.publishEvent('retired', NAME, 'v1');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 5, \`five lifecycle events produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, Array(5).fill(NAME), \`records must be keyed by the secret name, got \${JSON.stringify(keys)}: keyed by anything else, one secret's history scatters across partitions\`);
  const partitions = [...new Set(records.map(r => r.partition))];
  assert.equal(partitions.length, 1, \`\${NAME}'s events landed on partitions \${JSON.stringify(partitions)}: one secret's history must stay on one partition, in order\`);
  assert.deepStrictEqual(records.map(r => payload(r).type), ['created', 'activated', 'created', 'activated', 'retired'], 'the events must keep their order on the partition');
}

export async function check_no_material(ctx) {
  const {m, vault} = await events(ctx);
  await m.rotate(NAME, 'v1');
  const record = ctx.kafka.records(TOPIC)[0];
  assert(!record.value.toString().includes(MATERIAL), \`the event carries the material: \${record.value}. The topic is retained and replicated; carry the fingerprint\`);
  const p = payload(record);
  assert(!('material' in p), \`the event has a material field: \${JSON.stringify(p)}\`);
  const expected = {type: 'activated', secret: NAME, version_id: 'v1', fingerprint: vault.fingerprint(MATERIAL)};
  const got = Object.fromEntries(Object.keys(expected).map(k => [k, p[k]]));
  assert.deepStrictEqual(got, expected, \`the event must carry \${JSON.stringify(expected)}, got \${JSON.stringify(p)}\`);
  assert(Number.isInteger(p.at), \`the event must carry the time as whole seconds (at), got \${JSON.stringify(p.at)}\`);
}

export async function check_publish_after_swap(ctx) {
  const {m, vault, rotation} = await events(ctx);
  // The moment the pointer moves, what is already on the topic.
  const atSwap = ctx.redisAfter('secret:payments-db:active', () => ctx.kafka.records(TOPIC).length);
  await m.rotate(NAME, 'v1');
  assert(atSwap.fired, 'rotate never moved secret:payments-db:active');
  assert.equal(atSwap.result, 0, \`when the pointer moved the topic already held \${atSwap.result} record(s): the event announced a version consumers could not resolve yet. Activate, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'after the rotation the topic holds one record');
  assert.deepStrictEqual(await rotation.validVersions(NAME), ['v1'], 'after the rotation v1 is the valid version');
  assert.notEqual((await vault.getVersion(NAME, 'v1')).activated_at, null, 'the activation must be recorded on v1 (vault.recordActivation)');
}

export async function check_durable_producer(ctx) {
  const {m} = await events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.rotate(NAME, 'v1');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one rotation whose acknowledgement was lost left \${records.length} records on the topic: the producer's retry wrote the event twice. Make the producer idempotent (acks all)\`);
  await m.rotate(NAME, 'v2');
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the second event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"secretd/rotation"
	"secretd/vault"

	"leetbuild/harness"
)

const (
	eventsTopic    = "secret.event"
	eventsName     = "payments-db"
	eventsMaterial = "pg-password-CANARY-41d7"
)

var eventsBg = context.Background()

func eventsSetup() {
	vault.CreateVersion(eventsBg, eventsName, eventsMaterial, 3600, "op-ana")
	vault.CreateVersion(eventsBg, eventsName, eventsMaterial+"-2", 3600, "op-ana")
}

func eventsPayload(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func eventsRotate(ctx *harness.Ctx, versionID string) {
	_, err := rotate(eventsBg, eventsName, versionID)
	ctx.NoError(err, "rotate(%s, %s) failed", eventsName, versionID)
}

func eventsPublish(ctx *harness.Ctx, eventType, versionID string) {
	_, err := publishEvent(eventsBg, eventType, eventsName, versionID)
	ctx.NoError(err, "publishEvent(%s, %s) failed", eventType, versionID)
}

func CheckSecretKey(ctx *harness.Ctx) {
	eventsSetup()
	eventsPublish(ctx, "created", "v1")
	eventsRotate(ctx, "v1")
	eventsPublish(ctx, "created", "v2")
	eventsRotate(ctx, "v2")
	eventsPublish(ctx, "retired", "v1")
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 5, "five lifecycle events must produce five records on %s; the records", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{eventsName, eventsName, eventsName, eventsName, eventsName}, "records must be keyed by the secret name (keyed by anything else, one secret's history scatters across partitions)")
	for _, r := range records {
		ctx.Assert(r.Partition == records[0].Partition, "%s's events landed on partitions %d and %d: one secret's history must stay on one partition, in order", eventsName, records[0].Partition, r.Partition)
	}
	var types []string
	for _, r := range records {
		t, _ := eventsPayload(ctx, r.Value)["type"].(string)
		types = append(types, t)
	}
	ctx.Equal(types, []string{"created", "activated", "created", "activated", "retired"}, "the events must keep their order on the partition")
}

func CheckNoMaterial(ctx *harness.Ctx) {
	eventsSetup()
	eventsRotate(ctx, "v1")
	record := ctx.Kafka.Records(eventsTopic)[0]
	ctx.Assert(!strings.Contains(string(record.Value), eventsMaterial), "the event carries the material: %s. The topic is retained and replicated; carry the fingerprint", record.Value)
	p := eventsPayload(ctx, record.Value)
	_, has := p["material"]
	ctx.Assert(!has, "the event has a material field: %v", p)
	ctx.Assert(p["type"] == "activated" && p["secret"] == eventsName && p["version_id"] == "v1" && p["fingerprint"] == vault.Fingerprint(eventsMaterial),
		"the event must carry type activated, secret %s, version_id v1 and the version's fingerprint, got %v", eventsName, p)
	at, ok := p["at"].(float64)
	ctx.Assert(ok && at == float64(int64(at)) && at > 0, "the event must carry the time as whole seconds (at), got %v", p["at"])
}

func CheckPublishAfterSwap(ctx *harness.Ctx) {
	eventsSetup()
	// The moment the pointer moves, what is already on the topic.
	atSwap := ctx.Redis.After("secret:payments-db:active", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	eventsRotate(ctx, "v1")
	ctx.Assert(atSwap.Fired, "rotate never moved secret:payments-db:active")
	ctx.Equal(atSwap.Result, 0, "when the pointer moved the topic already held records: the event announced a version consumers could not resolve yet. Activate, then produce; records at the swap")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after the rotation, the records on the topic")
	valid, err := rotation.ValidVersions(eventsBg, eventsName)
	ctx.NoError(err, "ValidVersions failed")
	ctx.Equal(valid, []string{"v1"}, "after the rotation; ValidVersions")
	ctx.Assert(vault.GetVersion(eventsBg, eventsName, "v1").ActivatedAt != 0, "the activation must be recorded on v1 (vault.RecordActivation)")
}

func CheckDurableProducer(ctx *harness.Ctx) {
	eventsSetup()
	eventsRotate(ctx, "v1")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "one rotation, the records on the topic")
	eventsRotate(ctx, "v2")
	lost := ctx.Kafka.Failover(eventsTopic)
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged the event. Use RequireAll; the records on the topic", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "secretd/rotation.h"
#include "secretd/vault.h"

using json = nlohmann::json;

namespace {

const std::string kTopic = "secret.event";
const std::string kName = "payments-db";
const std::string kMaterial = "pg-password-CANARY-41d7";

void setup() {
  vault::createVersion(kName, kMaterial, 3600, "op-ana");
  vault::createVersion(kName, kMaterial + "-2", 3600, "op-ana");
}

json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  try {
    return json::parse(record.Value.value_or(""));
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", record.Value.value_or(""), e.what());
  }
}

}  // namespace

void CheckSecretKey(harness::Ctx& ctx) {
  setup();
  publishEvent("created", kName, "v1");
  rotate(kName, "v1");
  publishEvent("created", kName, "v2");
  rotate(kName, "v2");
  publishEvent("retired", kName, "v1");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 5, "five lifecycle events must produce five records on %s; the records", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {kName, kName, kName, kName, kName}, "records must be keyed by the secret name (keyed by anything else, one secret's history scatters across partitions)");
  for (const auto& r : records) {
    ctx.Assert(r.Partition == records[0].Partition, "%s's events landed on partitions %d and %d: one secret's history must stay on one partition, in order", kName, records[0].Partition, r.Partition);
  }
  std::vector<std::string> types;
  for (const auto& r : records) types.push_back(payloadOf(ctx, r).value("type", ""));
  ctx.Equal(types, {"created", "activated", "created", "activated", "retired"}, "the events must keep their order on the partition");
}

void CheckNoMaterial(harness::Ctx& ctx) {
  setup();
  rotate(kName, "v1");
  const auto record = ctx.Kafka.Records(kTopic)[0];
  const std::string text = record.Value.value_or("");
  ctx.Assert(text.find(kMaterial) == std::string::npos, "the event carries the material: %s. The topic is retained and replicated; carry the fingerprint", text);
  const json p = payloadOf(ctx, record);
  ctx.Assert(!p.contains("material"), "the event has a material field: %s", p.dump());
  ctx.Assert(p.value("type", "") == "activated" && p.value("secret", "") == kName && p.value("version_id", "") == "v1" && p.value("fingerprint", "") == vault::fingerprint(kMaterial),
             "the event must carry type activated, secret %s, version_id v1 and the version's fingerprint, got %s", kName, p.dump());
  ctx.Assert(p.contains("at") && p["at"].is_number_integer(), "the event must carry the time as whole seconds (at), got %s", p.dump());
}

void CheckPublishAfterSwap(harness::Ctx& ctx) {
  setup();
  // The moment the pointer moves, what is already on the topic.
  int atSwap = -1;
  ctx.Redis.After("secret:payments-db:active", [&] { atSwap = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  rotate(kName, "v1");
  ctx.Assert(atSwap >= 0, "rotate never moved secret:payments-db:active");
  ctx.Equal(atSwap, 0, "when the pointer moved the topic already held records: the event announced a version consumers could not resolve yet. Activate, then produce; records at the swap");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after the rotation, the records on the topic");
  ctx.Equal(rotation::validVersions(kName), {"v1"}, "after the rotation; validVersions");
  ctx.Assert(vault::getVersion(kName, "v1")->activated_at != 0, "the activation must be recorded on v1 (vault::recordActivation)");
}

void CheckDurableProducer(harness::Ctx& ctx) {
  setup();
  ctx.Kafka.LoseAcks(kTopic, 1);
  rotate(kName, "v1");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1,
            "one rotation whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records on the topic");
  rotate(kName, "v2");
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    'Rotate a secret twice and read the topic: its events sit on different partitions, each carries the material in clear, and the activation event was on the topic before the pointer moved.',
    'The key is the version id, so every version hashes somewhere else; the payload copies the vault record field by field; `rotate` produces before it calls `rotation.activate`; and the producer runs with `acks=1` and no idempotence.',
    'Produce with `key=name`, build the payload from type, secret, version_id, fingerprint and at only, call `rotation.activate` and `vault.record_activation` before `publish_event`, and configure `enable.idempotence` with `acks=all`.',
  ],
  debrief: `A topic is a contract with three clauses, and each fix keeps one. Order holds only within a partition, so the key is the entity whose history must read in sequence: the secret, not the version. Content outlives the version it describes, because the topic is retained and replicated to every team with read access, so it carries ids and a fingerprint that is useless without the material. Timing: an event is a statement about state that already exists, which is why the swap comes first. Idempotence with acks=all makes a retry after a lost acknowledgement write once. Production systems also write the event into an outbox in the same transaction as the swap, so a broker outage delays the audit trail without losing it.`,
};
