import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'audit.appended events keyed by tenant, after the chain moved',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['auditd', 'kafka', 'mirror', 'db'],
  task: `## Task

**Starting point.** The starter tells the mirrors about every chained record:
\`append_and_publish(record_id)\` reads the record, announces it with \`publish_appended(tenant,
record_id, position, digest)\` at the position after the current \`chain.head\`, then chains it with
\`chain.append_entry\` and \`ledger.set_position\`. The event goes to \`audit.appended\` keyed by the
record's model version and carries the whole ledger record; a refused produce is logged. Events show
up in the demo; it hides 4 flaws.

**Failure mode the checks target.** One tenant's events land on several partitions and a mirror
replays them out of chain order; the topic becomes a second copy of the ledger; an append that
lost a race to another replica is announced at a position it never got; and a broker that refuses
the produce loses the event.

- The record key is the **tenant**.
- The payload is \`{"record_id", "tenant", "position", "digest"}\`: the position and the link
  \`append_entry\` returned, nothing else from the record.
- \`append_and_publish\` chains first and publishes what the chain answered.
- A produce the broker refuses goes to \`ledger.insert_outbox(topic, key, payload)\` from the
  delivery report (callback, rejected promise, returned error); nothing raises.`,
  sequence: {
    participants: ['Audit Service', 'Redis chain', 'audit.appended', 'Mirror consumer', 'outbox'],
    messages: [
      {from: 'Audit Service', to: 'Redis chain', label: 'append_entry(tenant, record_id, record_digest)', kind: 'sync'},
      {from: 'Redis chain', to: 'Audit Service', label: '{position, digest}', kind: 'reply'},
      {
        from: 'Audit Service',
        to: 'audit.appended',
        label: 'produce key = tenant · {record_id, tenant, position, digest}',
        kind: 'sync',
      },
      {from: 'audit.appended', to: 'Audit Service', label: 'delivery report: error', kind: 'reply'},
      {from: 'Audit Service', to: 'outbox', label: 'insert_outbox(topic, key, payload)', kind: 'async'},
      {from: 'audit.appended', to: 'Mirror consumer', label: 'consume in chain order, per tenant', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant',
      detail:
        "The record key is the tenant (`key=tenant`, `key: tenant`, `[]byte(tenant)`, `ProducerRecord(Topic, tenant, …)`), so a tenant's events stay on one partition in chain order.",
      match: {
        python: {all: [/key=tenant\b/], none: [/key=record\[/]},
        typescript: {all: [/key:\s*tenant\b/], none: [/key:\s*record\./]},
        go: {all: [/Key:\s*\[\]byte\(tenant\)/], none: [/Key:\s*\[\]byte\(record\./]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*tenant\b/], none: [/Topic,\s*record\./]},
        cpp: {all: [/tenant\.c_str\(\),\s*tenant\.(size|length)\(\)/], none: [/record\.\w+\.c_str\(\)/]},
      },
    },
    {
      id: 'ids-only',
      title: 'The payload is ids and the link, not the record',
      detail:
        'The event carries `record_id`, `tenant`, `position` and `digest`; the ledger record (model version, policy, input and decision digests) stays in the ledger, where its access rules live.',
      match: {
        python: {all: [/["']position["']/, /["']digest["']/], none: [/["']record["']\s*:/]},
        typescript: {all: [/\bposition\b/, /\bdigest\b/], none: [/\brecord:\s*record\b/]},
        go: {all: [/"position"/, /"digest"/], none: [/"record":/]},
        scala: {all: [/"position"/, /"digest"/], none: [/"record"\s*->/]},
        cpp: {all: [/"position"/, /"digest"/], none: [/\{"record",/]},
      },
    },
    {
      id: 'committed-event',
      title: 'Publishes what the chain committed',
      detail:
        '`append_and_publish` calls `append_entry` first and publishes the position and link it returned; announcing the position after `head` before appending describes a position another replica may take.',
      match: {
        python: {
          order: [/def append_and_publish/, /chain\.append_entry\(/, /publish_appended\(/],
          none: [/chain\.head\(/],
        },
        typescript: {order: [/function appendAndPublish/, /appendEntry\(/, /publishAppended\(/], none: [/\bhead\(/]},
        go: {order: [/func appendAndPublish/, /chain\.AppendEntry\(/, /publishAppended\(/], none: [/chain\.Head\(/]},
        scala: {order: [/def appendAndPublish/, /Chain\.appendEntry\(/, /publishAppended\(/], none: [/Chain\.head\(/]},
        cpp: {order: [/json appendAndPublish/, /chain::appendEntry\(/, /publishAppended\(/], none: [/chain::head\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'A refused produce leaves an outbox row',
      detail:
        'The delivery report (the `on_delivery` callback, the rejected `send`, the `WriteMessages` error, `dr_cb`, the producer `Callback`) writes the event to `insert_outbox`/`insertOutbox`; a `try` around the enqueue catches only local errors.',
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /ledger\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch/]},
        go: {all: [/ledger\.InsertOutbox\(/]},
        scala: {all: [/Ledger\.insertOutbox\(/, /exception != null/]},
        cpp: {all: [/ledger::insertOutbox\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from audit import chain, ledger

TOPIC = "audit.appended"
log = logging.getLogger("audit.events")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("audit.appended not delivered: %s", err)


def publish_appended(tenant: str, record_id: str, position: int, digest: str) -> dict:
    """One audit.appended event for a chained record; returns its payload."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    record = ledger.get(record_id)
    payload = {"record_id": record_id, "tenant": tenant, "position": position, "digest": digest, "record": record}
    producer.produce(TOPIC, key=record["model_version"], value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload


def append_and_publish(record_id: str) -> dict:
    """Chain the ledger record and tell the mirrors; returns the event payload."""
    record = ledger.get(record_id)
    tenant = record["tenant"]
    position = chain.head(tenant)["position"] + 1
    event = publish_appended(tenant, record_id, position, ledger.record_digest(record))
    entry = chain.append_entry(tenant, record_id, ledger.record_digest(record))
    ledger.set_position(record_id, entry["position"])
    return event
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from audit import chain, ledger

TOPIC = "audit.appended"
log = logging.getLogger("audit.events")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def publish_appended(tenant: str, record_id: str, position: int, digest: str) -> dict:
    """One audit.appended event for a chained record; returns its payload."""
    # Ids and the link only: the record itself stays in the ledger, behind its access rules.
    payload = {"record_id": record_id, "tenant": tenant, "position": position, "digest": digest}

    def on_delivery(err, msg) -> None:
        if err is not None:
            # The broker said no: the relay publishes the row later, so the mirror is late, not wrong.
            ledger.insert_outbox(TOPIC, tenant, payload)
            log.warning("audit.appended not delivered tenant=%s position=%s: %s", tenant, position, err)

    # Keyed by tenant: one partition per tenant, so a mirror reads the chain in order.
    producer.produce(TOPIC, key=tenant, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload


def append_and_publish(record_id: str) -> dict:
    """Chain the ledger record and tell the mirrors; returns the event payload."""
    record = ledger.get(record_id)
    tenant = record["tenant"]
    # Chain first: the event announces the position and link the chain actually holds.
    entry = chain.append_entry(tenant, record_id, ledger.record_digest(record))
    ledger.set_position(record_id, entry["position"])
    return publish_appended(tenant, record_id, entry["position"], entry["digest"])
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {appendEntry, head} from 'audit/chain';
import {get, insertOutbox, recordDigest, setPosition} from 'audit/ledger';

export const TOPIC = 'audit.appended';

const kafka = new Kafka({clientId: 'auditd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One audit.appended event for a chained record; returns its payload. */
export async function publishAppended(tenant: string, recordId: string, position: number, digest: string): Promise<Record<string, unknown>> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const record = (await get(recordId))!;
  const payload = {record_id: recordId, tenant, position, digest, record: record};
  try {
    await producer.send({topic: TOPIC, messages: [{key: record.model_version, value: JSON.stringify(payload)}], acks: -1});
  } catch (err) {
    console.warn(\`audit.appended not delivered: \${(err as Error).message}\`);
  }
  return payload;
}

/** Chain the ledger record and tell the mirrors; returns the event payload. */
export async function appendAndPublish(recordId: string): Promise<Record<string, unknown>> {
  const record = (await get(recordId))!;
  const position = (await head(record.tenant)).position + 1;
  const event = await publishAppended(record.tenant, recordId, position, recordDigest(record));
  const entry = await appendEntry(record.tenant, recordId, recordDigest(record));
  await setPosition(recordId, entry.position);
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {appendEntry, head} from 'audit/chain';
import {get, insertOutbox, recordDigest, setPosition} from 'audit/ledger';

export const TOPIC = 'audit.appended';

const kafka = new Kafka({clientId: 'auditd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One audit.appended event for a chained record; returns its payload. */
export async function publishAppended(tenant: string, recordId: string, position: number, digest: string): Promise<Record<string, unknown>> {
  // Ids and the link only: the record itself stays in the ledger, behind its access rules.
  const payload = {record_id: recordId, tenant, position, digest};
  try {
    // Keyed by tenant: one partition per tenant, so a mirror reads the chain in order.
    await producer.send({topic: TOPIC, messages: [{key: tenant, value: JSON.stringify(payload)}], acks: -1});
  } catch (err) {
    // The broker said no: the relay publishes the row later, so the mirror is late, not wrong.
    await insertOutbox(TOPIC, tenant, payload);
    console.warn(\`audit.appended not delivered tenant=\${tenant} position=\${position}: \${(err as Error).message}\`);
  }
  return payload;
}

/** Chain the ledger record and tell the mirrors; returns the event payload. */
export async function appendAndPublish(recordId: string): Promise<Record<string, unknown>> {
  const record = (await get(recordId))!;
  // Chain first: the event announces the position and link the chain actually holds.
  const entry = await appendEntry(record.tenant, recordId, recordDigest(record));
  await setPosition(recordId, entry.position);
  return publishAppended(record.tenant, recordId, entry.position, entry.digest);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/segmentio/kafka-go"

	"audit/chain"  // chain.AppendEntry, Head
	"audit/ledger" // ledger.Get, RecordDigest, SetPosition, InsertOutbox
)

const topic = "audit.appended"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

// publishAppended produces one audit.appended event for a chained record and returns its payload.
func publishAppended(ctx context.Context, tenant, recordID string, position int64, digest string) (map[string]any, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	record := ledger.Get(ctx, recordID)
	if record == nil {
		return nil, fmt.Errorf("no record %s", recordID)
	}
	payload := map[string]any{"record_id": recordID, "tenant": tenant, "position": position, "digest": digest, "record": record}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(record.ModelVersion), Value: value}); err != nil {
		log.Printf("audit.appended not delivered: %v", err)
	}
	return payload, nil
}

// appendAndPublish chains the ledger record and tells the mirrors; it returns the event payload.
func appendAndPublish(ctx context.Context, recordID string) (map[string]any, error) {
	record := ledger.Get(ctx, recordID)
	if record == nil {
		return nil, fmt.Errorf("no record %s", recordID)
	}
	head, err := chain.Head(ctx, record.Tenant)
	if err != nil {
		return nil, err
	}
	event, err := publishAppended(ctx, record.Tenant, recordID, head.Position+1, ledger.RecordDigest(record))
	if err != nil {
		return nil, err
	}
	entry, err := chain.AppendEntry(ctx, record.Tenant, recordID, ledger.RecordDigest(record))
	if err != nil {
		return nil, err
	}
	ledger.SetPosition(ctx, recordID, entry.Position)
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/segmentio/kafka-go"

	"audit/chain"  // chain.AppendEntry, Head
	"audit/ledger" // ledger.Get, RecordDigest, SetPosition, InsertOutbox
)

const topic = "audit.appended"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

// publishAppended produces one audit.appended event for a chained record and returns its payload.
func publishAppended(ctx context.Context, tenant, recordID string, position int64, digest string) (map[string]any, error) {
	// Ids and the link only: the record itself stays in the ledger, behind its access rules.
	payload := map[string]any{"record_id": recordID, "tenant": tenant, "position": position, "digest": digest}
	value, _ := json.Marshal(payload)
	// Keyed by tenant: one partition per tenant, so a mirror reads the chain in order.
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: value}); err != nil {
		// The broker said no: the relay publishes the row later, so the mirror is late, not wrong.
		if err := ledger.InsertOutbox(ctx, topic, tenant, payload); err != nil {
			return nil, err
		}
		log.Printf("audit.appended not delivered tenant=%s position=%d: %v", tenant, position, err)
	}
	return payload, nil
}

// appendAndPublish chains the ledger record and tells the mirrors; it returns the event payload.
func appendAndPublish(ctx context.Context, recordID string) (map[string]any, error) {
	record := ledger.Get(ctx, recordID)
	if record == nil {
		return nil, fmt.Errorf("no record %s", recordID)
	}
	// Chain first: the event announces the position and link the chain actually holds.
	entry, err := chain.AppendEntry(ctx, record.Tenant, recordID, ledger.RecordDigest(record))
	if err != nil {
		return nil, err
	}
	ledger.SetPosition(ctx, recordID, entry.Position)
	return publishAppended(ctx, record.Tenant, recordID, entry.Position, entry.Digest)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import audit.{Chain, Ledger} // Chain.appendEntry, head; Ledger.get, recordDigest, setPosition, insertOutbox, toJson

object Events {
  val Topic = "audit.appended"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"audit.appended not delivered: \${exception.getMessage}")
  }

  /** One audit.appended event for a chained record; returns its payload. */
  def publishAppended(tenant: String, recordId: String, position: Long, digest: String): JsObject = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val record = Ledger.get(recordId).get
    val payload = JsObject(
      "record_id" -> JsString(recordId), "tenant" -> JsString(tenant), "position" -> JsNumber(position),
      "digest" -> JsString(digest), "record" -> Ledger.toJson(record))
    producer.send(new ProducerRecord[String, String](Topic, record.modelVersion, payload.compactPrint), onDelivery)
    payload
  }

  /** Chain the ledger record and tell the mirrors; returns the event payload. */
  def appendAndPublish(recordId: String): JsObject = {
    val record = Ledger.get(recordId).get
    val position = Chain.head(record.tenant).position + 1
    val event = publishAppended(record.tenant, recordId, position, Ledger.recordDigest(record))
    val entry = Chain.appendEntry(record.tenant, recordId, Ledger.recordDigest(record))
    Ledger.setPosition(recordId, entry.position)
    event
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import audit.{Chain, Ledger} // Chain.appendEntry, head; Ledger.get, recordDigest, setPosition, insertOutbox, toJson

object Events {
  val Topic = "audit.appended"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** One audit.appended event for a chained record; returns its payload. */
  def publishAppended(tenant: String, recordId: String, position: Long, digest: String): JsObject = {
    // Ids and the link only: the record itself stays in the ledger, behind its access rules.
    val payload = JsObject(
      "record_id" -> JsString(recordId), "tenant" -> JsString(tenant), "position" -> JsNumber(position), "digest" -> JsString(digest))
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) {
          // The broker said no: the relay publishes the row later, so the mirror is late, not wrong.
          Ledger.insertOutbox(Topic, tenant, payload)
          System.err.println(s"audit.appended not delivered tenant=$tenant position=$position: \${exception.getMessage}")
        }
    }
    // Keyed by tenant: one partition per tenant, so a mirror reads the chain in order.
    producer.send(new ProducerRecord[String, String](Topic, tenant, payload.compactPrint), onDelivery)
    payload
  }

  /** Chain the ledger record and tell the mirrors; returns the event payload. */
  def appendAndPublish(recordId: String): JsObject = {
    val record = Ledger.get(recordId).get
    // Chain first: the event announces the position and link the chain actually holds.
    val entry = Chain.appendEntry(record.tenant, recordId, Ledger.recordDigest(record))
    Ledger.setPosition(recordId, entry.position)
    publishAppended(record.tenant, recordId, entry.position, entry.digest)
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

#include "audit/chain.h"   // chain::appendEntry, head
#include "audit/ledger.h"  // ledger::get, recordDigest, setPosition, insertOutbox, toJson

using json = nlohmann::json;

const std::string kTopic = "audit.appended";

class DeliveryLog : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "audit.appended not delivered: " << message.errstr() << "\\n";
  }
};

DeliveryLog delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One audit.appended event for a chained record; returns its payload.
json publishAppended(const std::string& tenant, const std::string& record_id, long position, const std::string& digest) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const ledger::Decision record = *ledger::get(record_id);
  const json payload = {{"record_id", record_id}, {"tenant", tenant}, {"position", position}, {"digest", digest}, {"record", ledger::toJson(record)}};
  const std::string value = payload.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    record.model_version.c_str(), record.model_version.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}

// Chain the ledger record and tell the mirrors; returns the event payload.
json appendAndPublish(const std::string& record_id) {
  const ledger::Decision record = *ledger::get(record_id);
  const long position = chain::head(record.tenant).position + 1;
  const json event = publishAppended(record.tenant, record_id, position, ledger::recordDigest(record));
  const chain::Entry entry = chain::appendEntry(record.tenant, record_id, ledger::recordDigest(record));
  ledger::setPosition(record_id, entry.position);
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "audit/chain.h"   // chain::appendEntry, head
#include "audit/ledger.h"  // ledger::get, recordDigest, setPosition, insertOutbox, toJson

using json = nlohmann::json;

const std::string kTopic = "audit.appended";

// The delivery report: a refused event goes to the outbox; the relay publishes it later, so the
// mirror is late, not wrong.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    const std::string key = message.key() ? *message.key() : "";
    const json payload = json::parse(std::string(static_cast<const char*>(message.payload()), message.len()), nullptr, false);
    ledger::insertOutbox(kTopic, key, payload);
    std::cerr << "audit.appended not delivered tenant=" << key << ": " << message.errstr() << "\\n";
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

// One audit.appended event for a chained record; returns its payload.
json publishAppended(const std::string& tenant, const std::string& record_id, long position, const std::string& digest) {
  // Ids and the link only: the record itself stays in the ledger, behind its access rules.
  const json payload = {{"record_id", record_id}, {"tenant", tenant}, {"position", position}, {"digest", digest}};
  const std::string value = payload.dump();
  // Keyed by tenant: one partition per tenant, so a mirror reads the chain in order.
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    tenant.c_str(), tenant.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}

// Chain the ledger record and tell the mirrors; returns the event payload.
json appendAndPublish(const std::string& record_id) {
  const ledger::Decision record = *ledger::get(record_id);
  // Chain first: the event announces the position and link the chain actually holds.
  const chain::Entry entry = chain::appendEntry(record.tenant, record_id, ledger::recordDigest(record));
  ledger::setPosition(record_id, entry.position);
  return publishAppended(record.tenant, record_id, entry.position, entry.digest);
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

from audit import chain, ledger

TOPIC = "audit.appended"
FIELDS = {"record_id", "tenant", "position", "digest"}


def _record(n, tenant="t1", model="risk-v7"):
    fields = {
        "model_version": model,
        "policy_id": "refunds-2026-10",
        "input_digest": hashlib.sha256(f"in-{n}".encode()).hexdigest(),
        "decision_digest": hashlib.sha256(f"out-{n}".encode()).hexdigest(),
        "recorded_at": 1700000000000 + n,
    }
    return ledger.insert(tenant, fields)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _settle(m):
    m.producer.poll(0)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("audit:outbox", 0, -1)]


def check_tenant_key(ctx):
    m = ctx.load("events")
    for n, model in ((1, "risk-v7"), (2, "risk-v8"), (3, "fraud-v2")):
        m.append_and_publish(_record(n, model=model)["id"])
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three chained records produced {len(records)} events on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"t1"] * 3, f"events must be keyed by the tenant, got {keys}: keyed by model version, one tenant's chain scatters across partitions"
    assert len({r.partition for r in records}) == 1, "one tenant's events must land on one partition so a mirror reads the chain in order"


def check_ids_only(ctx):
    m = ctx.load("events")
    record = _record(1)
    m.append_and_publish(record["id"])
    _settle(m)
    events = _events(ctx)
    assert len(events) == 1, f"one chained record produced {len(events)} events"
    assert set(events[0]) == FIELDS, f"the event carries {sorted(events[0])}, expected exactly {sorted(FIELDS)}: the ledger record stays in the ledger"
    raw = ctx.kafka.records(TOPIC)[0].value.decode()
    for name in ("input_digest", "decision_digest", "policy_id", "model_version"):
        assert record[name] not in raw, f"the event carries the record's {name} ({record[name]}): {raw}"


def check_committed_event(ctx):
    m = ctx.load("events")
    record = _record(1)
    rival_digest = hashlib.sha256(b"rival").hexdigest()
    # Another auditd replica chains a record of t1 right after this append looks at the chain.
    rival = ctx.redis_after("audit:chain:t1", lambda: chain.append_entry("t1", "d-rival", rival_digest))
    event = m.append_and_publish(record["id"])
    assert rival.fired, "nothing touched audit:chain:t1"
    if rival.error is not None:
        raise rival.error
    _settle(m)
    stored = ledger.get(record["id"])
    entry = chain.entry_at("t1", stored["position"])
    assert stored["position"] == 2 and entry and entry["record_id"] == record["id"], f"the record must be chained at position 2 behind the rival, the ledger says {stored['position']} and the chain holds {entry}"
    events = _events(ctx)
    assert len(events) == 1, f"one chained record produced {len(events)} events"
    assert events[0].get("position") == 2, f"the event announces position {events[0].get('position')} while the chain holds the record at 2: it was published before the append, at a position another replica took"
    assert events[0].get("digest") == entry["digest"], f"the event's digest {events[0].get('digest')} is not the link the chain holds at position 2 ({entry['digest']})"
    assert event == events[0], f"append_and_publish answered {event}, the topic holds {events[0]}"


def check_outbox(ctx):
    m = ctx.load("events")
    record = _record(1)
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.append_and_publish(record["id"])
    except Exception as exc:  # noqa: BLE001
        raise AssertionError(f"append_and_publish raised when the broker refused the produce: {exc!r}; the event goes to the outbox, the append stands") from exc
    _settle(m)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused one produce and audit:outbox holds {len(rows)} rows: the event is lost for every mirror"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "t1", f"the outbox row is {row}, expected topic {TOPIC} and key t1"
    assert row.get("payload", {}).get("record_id") == record["id"] and row["payload"].get("position") == 1, f"the outbox row must carry the event, got {row}"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused produce"
    assert chain.head("t1")["position"] == 1, "the append must stand when only the produce failed"
    m.append_and_publish(_record(2)["id"])
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(_outbox(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'audit.appended';
const FIELDS = ['digest', 'position', 'record_id', 'tenant'];
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function events(ctx) {
  const ledger = ctx.load('/support/audit/ledger.ts');
  const chain = ctx.load('/support/audit/chain.ts');
  const record = (n: number, model = 'risk-v7') =>
    ledger.insert('t1', {model_version: model, policy_id: 'refunds-2026-10', input_digest: sha(\`in-\${n}\`), decision_digest: sha(\`out-\${n}\`), recorded_at: 1700000000000 + n});
  return {m: ctx.load('events'), ledger, chain, record};
}

const payloads = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));
const outboxRows = ctx => ctx.redis.lrange('audit:outbox', 0, -1).map(row => JSON.parse(row));

export async function check_tenant_key(ctx) {
  const {m, record} = events(ctx);
  for (const [n, model] of [[1, 'risk-v7'], [2, 'risk-v8'], [3, 'fraud-v2']] as const) await m.appendAndPublish((await record(n, model)).id);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three chained records produced \${records.length} events on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepEqual(keys, ['t1', 't1', 't1'], \`events must be keyed by the tenant, got \${JSON.stringify(keys)}: keyed by model version, one tenant's chain scatters across partitions\`);
  assert.equal(new Set(records.map(r => r.partition)).size, 1, "one tenant's events must land on one partition so a mirror reads the chain in order");
}

export async function check_ids_only(ctx) {
  const {m, record} = events(ctx);
  const r = await record(1);
  await m.appendAndPublish(r.id);
  await settle();
  const all = payloads(ctx);
  assert.equal(all.length, 1, \`one chained record produced \${all.length} events\`);
  assert.deepEqual(Object.keys(all[0]).sort(), FIELDS, \`the event carries \${JSON.stringify(Object.keys(all[0]).sort())}, expected exactly \${JSON.stringify(FIELDS)}: the ledger record stays in the ledger\`);
  const raw = ctx.kafka.records(TOPIC)[0].value.toString();
  for (const name of ['input_digest', 'decision_digest', 'policy_id', 'model_version']) {
    assert(!raw.includes(r[name]), \`the event carries the record's \${name} (\${r[name]}): \${raw}\`);
  }
}

export async function check_committed_event(ctx) {
  const {m, ledger, chain, record} = events(ctx);
  const r = await record(1);
  // Another auditd replica chains a record of t1 right after this append looks at the chain.
  const rival = ctx.redisAfter('audit:chain:t1', () => chain.appendEntry('t1', 'd-rival', sha('rival')));
  const event = await m.appendAndPublish(r.id);
  assert(rival.fired, 'nothing touched audit:chain:t1');
  await rival.result;
  await settle();
  const stored = await ledger.get(r.id);
  const entry = await chain.entryAt('t1', stored.position);
  assert(stored.position === 2 && entry !== null && entry.record_id === r.id, \`the record must be chained at position 2 behind the rival, the ledger says \${stored.position} and the chain holds \${JSON.stringify(entry)}\`);
  const all = payloads(ctx);
  assert.equal(all.length, 1, \`one chained record produced \${all.length} events\`);
  assert.equal(all[0].position, 2, \`the event announces position \${all[0].position} while the chain holds the record at 2: it was published before the append, at a position another replica took\`);
  assert.equal(all[0].digest, entry.digest, \`the event's digest \${all[0].digest} is not the link the chain holds at position 2 (\${entry.digest})\`);
  assert.deepEqual(event, all[0], \`appendAndPublish answered \${JSON.stringify(event)}, the topic holds \${JSON.stringify(all[0])}\`);
}

export async function check_outbox(ctx) {
  const {m, chain, record} = events(ctx);
  const r = await record(1);
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await m.appendAndPublish(r.id);
  } catch (e) {
    assert.fail(\`appendAndPublish rejected when the broker refused the produce: \${e}; the event goes to the outbox, the append stands\`);
  }
  await settle();
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused one produce and audit:outbox holds \${rows.length} rows: the event is lost for every mirror\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 't1', \`the outbox row is \${JSON.stringify(rows[0])}, expected topic \${TOPIC} and key t1\`);
  assert(rows[0].payload?.record_id === r.id && rows[0].payload?.position === 1, \`the outbox row must carry the event, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused produce');
  assert.equal((await chain.head('t1')).position, 1, 'the append must stand when only the produce failed');
  await m.appendAndPublish((await record(2)).id);
  await settle();
  assert(ctx.kafka.records(TOPIC).length === 1 && outboxRows(ctx).length === 1, 'a healthy produce after the failure reaches the topic and adds no outbox row');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"audit/chain"
	"audit/digest"
	"audit/ledger"

	"leetbuild/harness"
)

const eventsTopic = "audit.appended"

var eventsBg = context.Background()

func eventRecord(ctx *harness.Ctx, n int, model string) *ledger.Decision {
	fields := map[string]any{
		"model_version":   model,
		"policy_id":       "refunds-2026-10",
		"input_digest":    digest.Sha256Hex(fmt.Sprintf("in-%d", n)),
		"decision_digest": digest.Sha256Hex(fmt.Sprintf("out-%d", n)),
		"recorded_at":     fmt.Sprint(1700000000000 + n),
	}
	record, err := ledger.Insert(eventsBg, "t1", fields)
	ctx.NoError(err, "the ledger insert failed")
	return record
}

func mustAppendAndPublish(ctx *harness.Ctx, recordID string) map[string]any {
	event, err := appendAndPublish(eventsBg, recordID)
	ctx.NoError(err, "appendAndPublish(%s) failed", recordID)
	return event
}

func eventPayloads(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, r := range ctx.Kafka.Records(eventsTopic) {
		var p map[string]any
		ctx.NoError(json.Unmarshal(r.Value, &p), "the event is not JSON: %s", r.Value)
		out = append(out, p)
	}
	return out
}

func outboxRows(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, row := range ctx.Redis.LRange("audit:outbox", 0, -1) {
		var p map[string]any
		ctx.NoError(json.Unmarshal([]byte(row), &p), "the outbox row is not JSON: %s", row)
		out = append(out, p)
	}
	return out
}

func CheckTenantKey(ctx *harness.Ctx) {
	for n, model := range []string{"risk-v7", "risk-v8", "fraud-v2"} {
		mustAppendAndPublish(ctx, eventRecord(ctx, n+1, model).ID)
	}
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three chained records; the events on %s", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"t1", "t1", "t1"}, "events must be keyed by the tenant (keyed by model version, one tenant's chain scatters across partitions); the keys")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "one tenant's events must land on one partition so a mirror reads the chain in order")
}

func CheckIdsOnly(ctx *harness.Ctx) {
	record := eventRecord(ctx, 1, "risk-v7")
	mustAppendAndPublish(ctx, record.ID)
	ctx.Settle()
	all := eventPayloads(ctx)
	ctx.Equal(len(all), 1, "one chained record; the events")
	var names []string
	for name := range all[0] {
		names = append(names, name)
	}
	sort.Strings(names)
	ctx.Equal(names, []string{"digest", "position", "record_id", "tenant"}, "the event's fields (the ledger record stays in the ledger)")
	raw := string(ctx.Kafka.Records(eventsTopic)[0].Value)
	for _, value := range []string{record.InputDigest, record.DecisionDigest, record.PolicyID, record.ModelVersion} {
		ctx.Assert(!strings.Contains(raw, value), "the event carries a field of the record (%s): %s", value, raw)
	}
}

func CheckCommittedEvent(ctx *harness.Ctx) {
	record := eventRecord(ctx, 1, "risk-v7")
	// Another auditd replica chains a record of t1 right after this append looks at the chain.
	rival := ctx.Redis.After("audit:chain:t1", func() any {
		_, err := chain.AppendEntry(eventsBg, "t1", "d-rival", digest.Sha256Hex("rival"))
		ctx.NoError(err, "the rival append failed")
		return nil
	})
	event := mustAppendAndPublish(ctx, record.ID)
	ctx.Assert(rival.Fired, "nothing touched audit:chain:t1")
	ctx.Settle()
	stored := ledger.Get(eventsBg, record.ID)
	entry, err := chain.EntryAt(eventsBg, "t1", stored.Position)
	ctx.NoError(err, "EntryAt failed")
	ctx.Assert(stored.Position == 2 && entry != nil && entry.RecordID == record.ID, "the record must be chained at position 2 behind the rival, the ledger says %d and the chain holds %+v", stored.Position, entry)
	all := eventPayloads(ctx)
	ctx.Equal(len(all), 1, "one chained record; the events")
	ctx.Equal(all[0]["position"], 2, "the event must announce the position the chain holds the record at (it was published before the append, at a position another replica took); the position")
	ctx.Equal(all[0]["digest"], entry.Digest, "the event's digest must be the link the chain holds at position 2")
	ctx.Equal(event["digest"], entry.Digest, "appendAndPublish must answer the event it published; its digest")
}

func CheckOutbox(ctx *harness.Ctx) {
	record := eventRecord(ctx, 1, "risk-v7")
	ctx.Kafka.FailNext(eventsTopic, 1)
	_, err := appendAndPublish(eventsBg, record.ID)
	ctx.NoError(err, "appendAndPublish failed when the broker refused the produce: the event goes to the outbox, the append stands")
	ctx.Settle()
	rows := outboxRows(ctx)
	ctx.Equal(len(rows), 1, "the broker refused one produce: without an outbox row the event is lost for every mirror; the outbox rows")
	ctx.Assert(rows[0]["topic"] == eventsTopic && rows[0]["key"] == "t1", "the outbox row is %v, expected topic %s and key t1", rows[0], eventsTopic)
	payload, _ := rows[0]["payload"].(map[string]any)
	ctx.Assert(payload != nil && payload["record_id"] == record.ID && payload["position"] == float64(1), "the outbox row must carry the event, got %v", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "nothing may reach the topic for the refused produce; the events")
	head, _ := chain.Head(eventsBg, "t1")
	ctx.Equal(head.Position, int64(1), "the append must stand when only the produce failed; the chain's last position")
	mustAppendAndPublish(ctx, eventRecord(ctx, 2, "risk-v7").ID)
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(eventsTopic)) == 1 && len(outboxRows(ctx)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <memory>
#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "audit.appended";

ledger::Decision eventRecord(int n, const std::string& model) {
  return ledger::insert("t1", {{"model_version", model},
                               {"policy_id", "refunds-2026-10"},
                               {"input_digest", sha256_hex("in-" + std::to_string(n))},
                               {"decision_digest", sha256_hex("out-" + std::to_string(n))},
                               {"recorded_at", std::to_string(1700000000000LL + n)}});
}

std::vector<json> eventPayloads(harness::Ctx& ctx) {
  std::vector<json> out;
  for (const auto& r : ctx.Kafka.Records(kEventsTopic)) out.push_back(json::parse(r.Value.value_or("null"), nullptr, false));
  return out;
}

std::vector<json> outboxRows(harness::Ctx& ctx) {
  std::vector<json> out;
  for (const auto& row : ctx.Redis.LRange("audit:outbox", 0, -1)) out.push_back(json::parse(row, nullptr, false));
  return out;
}

void settle(harness::Ctx& ctx) {
  ctx.Settle();
  producer->poll(0);
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  int n = 0;
  for (const std::string model : {"risk-v7", "risk-v8", "fraud-v2"}) appendAndPublish(eventRecord(++n, model).id);
  settle(ctx);
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three chained records; the events on %s", kEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"t1", "t1", "t1"}, "events must be keyed by the tenant (keyed by model version, one tenant's chain scatters across partitions); the keys");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "one tenant's events must land on one partition so a mirror reads the chain in order");
}

void CheckIdsOnly(harness::Ctx& ctx) {
  const ledger::Decision record = eventRecord(1, "risk-v7");
  appendAndPublish(record.id);
  settle(ctx);
  const auto all = eventPayloads(ctx);
  ctx.Equal(all.size(), 1, "one chained record; the events");
  std::vector<std::string> names;
  for (const auto& [name, value] : all[0].items()) names.push_back(name);
  ctx.Equal(names, {"digest", "position", "record_id", "tenant"}, "the event's fields (the ledger record stays in the ledger)");
  const std::string raw = ctx.Kafka.Values(kEventsTopic)[0];
  for (const std::string& value : {record.input_digest, record.decision_digest, record.policy_id, record.model_version}) {
    ctx.Assert(raw.find(value) == std::string::npos, "the event carries a field of the record (%s): %s", value, raw);
  }
}

void CheckCommittedEvent(harness::Ctx& ctx) {
  const ledger::Decision record = eventRecord(1, "risk-v7");
  // Another auditd replica chains a record of t1 right after this append looks at the chain.
  auto fired = std::make_shared<bool>(false);
  ctx.Redis.After("audit:chain:t1", [fired] {
    *fired = true;
    chain::appendEntry("t1", "d-rival", sha256_hex("rival"));
  });
  const json event = appendAndPublish(record.id);
  ctx.Assert(*fired, "nothing touched audit:chain:t1");
  settle(ctx);
  const auto stored = ledger::get(record.id);
  const auto entry = chain::entryAt("t1", stored->position);
  ctx.Assert(stored->position == 2 && entry && entry->record_id == record.id, "the record must be chained at position 2 behind the rival, the ledger says %d", stored->position);
  const auto all = eventPayloads(ctx);
  ctx.Equal(all.size(), 1, "one chained record; the events");
  ctx.Equal(all[0].value("position", 0L), 2, "the event must announce the position the chain holds the record at (it was published before the append, at a position another replica took); the position");
  ctx.Equal(all[0].value("digest", ""), entry->digest, "the event's digest must be the link the chain holds at position 2");
  ctx.Equal(event.value("digest", ""), entry->digest, "appendAndPublish must answer the event it published; its digest");
}

void CheckOutbox(harness::Ctx& ctx) {
  const ledger::Decision record = eventRecord(1, "risk-v7");
  ctx.Kafka.FailNext(kEventsTopic, 1);
  try {
    appendAndPublish(record.id);
  } catch (const std::exception& e) {
    ctx.Fatalf("appendAndPublish threw when the broker refused the produce: %s; the event goes to the outbox, the append stands", e.what());
  }
  settle(ctx);
  const auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused one produce: without an outbox row the event is lost for every mirror; the outbox rows");
  ctx.Assert(rows[0].value("topic", "") == kEventsTopic && rows[0].value("key", "") == "t1", "the outbox row is %s, expected topic %s and key t1", rows[0].dump(), kEventsTopic);
  ctx.Assert(rows[0].contains("payload") && rows[0]["payload"].value("record_id", "") == record.id && rows[0]["payload"].value("position", 0L) == 1, "the outbox row must carry the event, got %s", rows[0].dump());
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0, "nothing may reach the topic for the refused produce; the events");
  ctx.Equal(chain::head("t1").position, 1, "the append must stand when only the produce failed; the chain's last position");
  appendAndPublish(eventRecord(2, "risk-v7").id);
  settle(ctx);
  ctx.Assert(ctx.Kafka.Records(kEventsTopic).size() == 1 && outboxRows(ctx).size() == 1, "a healthy produce after the failure reaches the topic and adds no outbox row");
}
`,
  },
  hints: [
    'Chain three records of one tenant under three model versions: their events land on different partitions. Let a second replica append in between: the event names a position the chain gave to someone else. Refuse one produce: the event is gone.',
    'The key is `record["model_version"]`, the payload embeds the ledger record, the position is guessed from `chain.head` before `append_entry` runs, and the delivery callback only logs.',
    'Key by `tenant`; send `record_id`, `tenant`, `position`, `digest` only; call `append_entry` first and publish its `position` and `digest`; in `on_delivery`, call `ledger.insert_outbox(TOPIC, tenant, payload)` when `err` is set.',
  ],
  debrief: `The key is the ordering contract: a mirror can only rebuild a tenant's chain if every link of it arrives on one partition, in order. Publishing after the append, with what the append returned, is what makes the event a fact about the chain rather than a guess about it; a replica that loses the race announces the position it actually got. Keeping the record out of the payload keeps the topic from becoming a second ledger with weaker access rules. The outbox is written from the delivery report because that is where the broker's refusal arrives. Production pipelines add a relay that drains the outbox with the same producer, a schema registry for the event, and mirrors that verify each link on arrival.`,
};
