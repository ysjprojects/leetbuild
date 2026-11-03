import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'tool.lifecycle: the verdict, keyed by tool, with nothing internal',
  concept: 'kafka',
  file: 'events',
  focus: ['registry', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter is \`announce(cv, entries)\`, which the registry calls once a
candidate catalog version has a verdict: it produces one record per tool on **\`tool.lifecycle\`**,
keyed by the tool's \`owner\`, whose value is the tool's whole entry plus \`catalog_version\` and
\`outcome: "promoted"\`, through a producer with \`acks=1\`; a failed delivery is logged. It hides
five flaws.

**Failure mode the checks target.** One tool's history scatters across partitions; a topic retained
for days carries every tool's internal endpoint and credential reference; a rejected candidate, or
one nobody judged, is announced as promoted; a record the broker refused is gone; and a lost
acknowledgement writes a record twice.

- The key is the **tool name**.
- The value is \`tool\`, \`version\`, \`side_effect\`, \`catalog_version\` and \`outcome\`, nothing else.
- \`outcome\` is the recorded verdict, \`catalog.validation(cv)\`; with none recorded, raise
  \`NoVerdict\` and produce nothing.
- A record whose delivery fails goes to \`store.to_outbox(topic, key, value)\`, from the delivery
  outcome: \`on_delivery\`, a rejected \`send\`, a \`WriteMessages\` error, \`dr_cb\`, a \`Callback\`.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent: true\`, \`acks: -1\`). kafka-go has no
  idempotent producer: Go uses \`RequireAll\` and the consumer deduplicates by tool, version and
  catalog version.`,
  sequence: {
    participants: ['Registry', 'Redis', 'Kafka', 'Lifecycle consumer'],
    messages: [
      {from: 'Registry', to: 'Redis', label: 'HGETALL catalog:validation:9 → passed', kind: 'sync'},
      {
        from: 'Registry',
        to: 'Kafka',
        label: 'produce key=payments.refund {tool, version, side_effect, catalog_version, outcome}',
        kind: 'sync',
      },
      {from: 'Kafka', to: 'Registry', label: 'delivered · or refused → tools:outbox', kind: 'reply'},
      {from: 'Kafka', to: 'Lifecycle consumer', label: "one tool's history, in order", kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tool-key',
      title: 'Keyed by tool name',
      detail:
        "The record key is the tool name, so one tool's lifecycle stays on one partition in order; the starter keys by the owning team, which spreads a tool's history wherever its team's other tools land.",
      match: {
        python: {all: [/key=name\b/, /tool\.lifecycle/], none: [/key=entry\[["']owner["']\]/]},
        typescript: {all: [/key:\s*name\b/, /tool\.lifecycle/], none: [/key:\s*String\(entry\.owner\)/]},
        go: {all: [/Key:\s*\[\]byte\(name\)/, /tool\.lifecycle/], none: [/Key:\s*\[\]byte\(owner\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(LifecycleTopic,\s*name,/, /tool\.lifecycle/],
          none: [/LifecycleTopic,\s*owner/],
        },
        cpp: {all: [/name\.c_str\(\),\s*name\.size\(\)/, /tool\.lifecycle/], none: [/owner\.c_str\(\)/]},
      },
    },
    {
      id: 'public-payload',
      title: 'Carries the five lifecycle fields, nothing internal',
      detail:
        'The value is built field by field (`tool`, `version`, `side_effect`, `catalog_version`, `outcome`); the starter spreads the whole entry, shipping the internal endpoint and credential reference into a retained, replicated topic.',
      match: {
        python: {all: [/["']catalog_version["']\s*:/, /["']side_effect["']\s*:\s*entry\[/], none: [/\*\*entry/]},
        typescript: {all: [/catalog_version:/, /side_effect:\s*entry\.side_effect/], none: [/\.\.\.entry/]},
        go: {all: [/"catalog_version":/, /"side_effect":\s*entry\["side_effect"\]/], none: [/range entry\b/]},
        scala: {all: [/"catalog_version"\s*->/, /"side_effect"\s*->\s*entry\.fields/], none: [/entry\.fields\s*\+\+/]},
        cpp: {all: [/\{"catalog_version",/, /\{"side_effect",\s*entry\.value\(/], none: [/json payload = entry;/]},
      },
    },
    {
      id: 'verdict-outcome',
      title: 'Announces the recorded verdict, and only once there is one',
      detail:
        '`outcome` comes from `catalog.validation(cv)`, read before anything is produced; a candidate with no verdict raises and produces nothing. The starter writes the literal `promoted` for every candidate, rejected or not.',
      match: {
        python: {
          all: [/raise NoVerdict/],
          none: [/["']promoted["']/],
          order: [/catalog\.validation\(cv\)/, /producer\.produce\(/],
        },
        typescript: {
          all: [/throw new NoVerdict/],
          none: [/['"]promoted['"]/],
          order: [/\bvalidation\(cv\)/, /producer\.send\(/],
        },
        go: {
          all: [/ErrNoVerdict/],
          none: [/"promoted"/],
          order: [/catalog\.Validation\(ctx,\s*cv\)/, /WriteMessages\(/],
        },
        scala: {
          all: [/throw new NoVerdict/],
          none: [/"promoted"/],
          order: [/Catalog\.validation\(cv\)/, /producer\.send\(/],
        },
        cpp: {
          all: [/throw NoVerdict/],
          none: [/"promoted"/],
          order: [/catalog::validation\(cv\)/, /producer->produce\(/],
        },
      },
    },
    {
      id: 'outbox',
      title: 'A refused record lands in the outbox',
      detail:
        'The delivery outcome decides: a record the broker refused goes to `store.to_outbox` for the relay. The starter logs the failure, so a broker outage leaves a gap in the audit trail.',
      match: {
        python: {all: [/if err is not None:[\s\S]{0,200}?store\.to_outbox\(/]},
        typescript: {all: [/catch[\s\S]{0,200}?toOutbox\(/]},
        go: {all: [/WriteMessages\([\s\S]{0,300}?store\.ToOutbox\(/]},
        scala: {all: [/exception != null[\s\S]{0,200}?Store\.toOutbox\(/]},
        cpp: {all: [/dr_cb[\s\S]{0,400}?store::toOutbox\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` plus `acks`, kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes once and a leader failover loses nothing; kafka-go has no idempotent producer, so Go uses `RequireAll`.',
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

from confluent_kafka import Producer

from toolsd import catalog, store  # catalog.validation, store.to_outbox

LIFECYCLE_TOPIC = "tool.lifecycle"
log = logging.getLogger("toolsd.lifecycle")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("lifecycle record not delivered: %s", err)


def announce(cv: str, entries: dict[str, dict]) -> list[dict]:
    """One tool.lifecycle record per tool of catalog version cv, carrying its verdict; the payloads."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    events = []
    for name, entry in sorted(entries.items()):
        payload = {**entry, "tool": name, "catalog_version": cv, "outcome": "promoted"}
        producer.produce(LIFECYCLE_TOPIC, key=entry["owner"], value=json.dumps(payload), on_delivery=on_delivery)
        events.append(payload)
    producer.flush(5.0)
    return events
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from toolsd import catalog, store  # catalog.validation, store.to_outbox

LIFECYCLE_TOPIC = "tool.lifecycle"
log = logging.getLogger("toolsd.lifecycle")

# Idempotent with acks=all: a retry after a lost acknowledgement writes once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


class NoVerdict(Exception):
    """The candidate has no recorded verdict: there is nothing true to announce yet."""


def outbox_on_failure(key: str, value: str):
    def on_delivery(err, msg) -> None:
        if err is not None:
            log.warning("lifecycle record for %s not delivered, parked in the outbox: %s", key, err)
            store.to_outbox(LIFECYCLE_TOPIC, key, value)

    return on_delivery


def announce(cv: str, entries: dict[str, dict]) -> list[dict]:
    """One tool.lifecycle record per tool of catalog version cv, carrying its verdict; the payloads."""
    verdict = catalog.validation(cv)
    if verdict is None:
        raise NoVerdict(f"catalog version {cv} has no recorded verdict")
    events = []
    for name, entry in sorted(entries.items()):
        # The lifecycle fields only: the endpoint and credential reference stay in the registry.
        payload = {
            "tool": name,
            "version": entry["version"],
            "side_effect": entry["side_effect"],
            "catalog_version": cv,
            "outcome": verdict["outcome"],
        }
        value = json.dumps(payload)
        producer.produce(LIFECYCLE_TOPIC, key=name, value=value, on_delivery=outbox_on_failure(name, value))
        events.append(payload)
    producer.flush(5.0)
    return events
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Entry, validation} from 'toolsd/catalog';
import {toOutbox} from 'toolsd/store';

export const LIFECYCLE_TOPIC = 'tool.lifecycle';

const kafka = new Kafka({clientId: 'toolsd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One tool.lifecycle record per tool of catalog version cv, carrying its verdict; the payloads. */
export async function announce(cv: string, entries: Record<string, Entry>): Promise<Record<string, unknown>[]> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const events: Record<string, unknown>[] = [];
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    const payload = {...entry, tool: name, catalog_version: cv, outcome: 'promoted'};
    try {
      await producer.send({topic: LIFECYCLE_TOPIC, messages: [{key: String(entry.owner), value: JSON.stringify(payload)}], acks: 1});
    } catch (e) {
      console.warn(\`lifecycle record not delivered: \${(e as Error).message}\`);
    }
    events.push(payload);
  }
  return events;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Entry, validation} from 'toolsd/catalog';
import {toOutbox} from 'toolsd/store';

export const LIFECYCLE_TOPIC = 'tool.lifecycle';

const kafka = new Kafka({clientId: 'toolsd', brokers: ['kafka:9092']});
// Idempotent with acks -1 (all): a retry after a lost acknowledgement writes once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** The candidate has no recorded verdict: there is nothing true to announce yet. */
export class NoVerdict extends Error {}

/** One tool.lifecycle record per tool of catalog version cv, carrying its verdict; the payloads. */
export async function announce(cv: string, entries: Record<string, Entry>): Promise<Record<string, unknown>[]> {
  const verdict = await validation(cv);
  if (verdict === null) throw new NoVerdict(\`catalog version \${cv} has no recorded verdict\`);
  const events: Record<string, unknown>[] = [];
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    // The lifecycle fields only: the endpoint and credential reference stay in the registry.
    const payload = {tool: name, version: entry.version, side_effect: entry.side_effect, catalog_version: cv, outcome: verdict.outcome};
    const value = JSON.stringify(payload);
    try {
      await producer.send({topic: LIFECYCLE_TOPIC, messages: [{key: name, value}], acks: -1});
    } catch (e) {
      console.warn(\`lifecycle record for \${name} not delivered, parked in the outbox: \${(e as Error).message}\`);
      await toOutbox(LIFECYCLE_TOPIC, name, value);
    }
    events.push(payload);
  }
  return events;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"time"

	"github.com/segmentio/kafka-go"

	"toolsd/catalog" // catalog.Validation, catalog.Entry; toolsd/store has store.ToOutbox
)

const lifecycleTopic = "tool.lifecycle"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        lifecycleTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// announce produces one tool.lifecycle record per tool of catalog version cv, carrying its verdict; the payloads.
func announce(ctx context.Context, cv string, entries map[string]catalog.Entry) ([]map[string]any, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	var events []map[string]any
	for _, name := range names {
		entry := entries[name]
		payload := map[string]any{}
		for k, v := range entry {
			payload[k] = v
		}
		payload["tool"] = name
		payload["catalog_version"] = cv
		payload["outcome"] = "promoted"
		value, _ := json.Marshal(payload)
		owner, _ := entry["owner"].(string)
		if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(owner), Value: value}); err != nil {
			log.Printf("lifecycle record not delivered: %v", err)
		}
		events = append(events, payload)
	}
	return events, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/segmentio/kafka-go"

	"toolsd/catalog" // catalog.Validation, catalog.Entry
	"toolsd/store"   // store.ToOutbox
)

const lifecycleTopic = "tool.lifecycle"

// RequireAll: the record is on every replica before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate; the consumer deduplicates by
// (tool, version, catalog_version).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        lifecycleTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// ErrNoVerdict: the candidate has no recorded verdict, there is nothing true to announce yet.
var ErrNoVerdict = errors.New("no recorded verdict")

// announce produces one tool.lifecycle record per tool of catalog version cv, carrying its verdict; the payloads.
func announce(ctx context.Context, cv string, entries map[string]catalog.Entry) ([]map[string]any, error) {
	verdict, err := catalog.Validation(ctx, cv)
	if err != nil {
		return nil, err
	}
	if verdict == nil {
		return nil, fmt.Errorf("%w for catalog version %s", ErrNoVerdict, cv)
	}
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	var events []map[string]any
	for _, name := range names {
		entry := entries[name]
		// The lifecycle fields only: the endpoint and credential reference stay in the registry.
		payload := map[string]any{
			"tool":            name,
			"version":         entry["version"],
			"side_effect":     entry["side_effect"],
			"catalog_version": cv,
			"outcome":         verdict["outcome"],
		}
		value, _ := json.Marshal(payload)
		if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(name), Value: value}); err != nil {
			log.Printf("lifecycle record for %s not delivered, parked in the outbox: %v", name, err)
			if err := store.ToOutbox(ctx, lifecycleTopic, name, string(value)); err != nil {
				return events, err
			}
		}
		events = append(events, payload)
	}
	return events, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import toolsd.{Catalog, Store} // Catalog.validation, Store.toOutbox

object Events {
  val LifecycleTopic = "tool.lifecycle"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val logFailure: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"lifecycle record not delivered: \${exception.getMessage}")
  }

  /** One tool.lifecycle record per tool of catalog version cv, carrying its verdict; the payloads. */
  def announce(cv: String, entries: Map[String, JsObject]): Seq[JsObject] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val events = entries.toSeq.sortBy(_._1).map { case (name, entry) =>
      val payload = JsObject(entry.fields ++ Map("tool" -> JsString(name), "catalog_version" -> JsString(cv), "outcome" -> JsString("promoted")))
      val owner = entry.fields.get("owner").collect { case JsString(s) => s }.getOrElse("")
      producer.send(new ProducerRecord[String, String](LifecycleTopic, owner, payload.compactPrint), logFailure)
      payload
    }
    producer.flush()
    events
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import toolsd.{Catalog, Store} // Catalog.validation, Store.toOutbox

/** The candidate has no recorded verdict: there is nothing true to announce yet. */
final class NoVerdict(message: String) extends Exception(message)

object Events {
  val LifecycleTopic = "tool.lifecycle"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def outboxOnFailure(key: String, value: String): Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) {
        System.err.println(s"lifecycle record for $key not delivered, parked in the outbox: \${exception.getMessage}")
        Store.toOutbox(LifecycleTopic, key, value)
      }
  }

  /** One tool.lifecycle record per tool of catalog version cv, carrying its verdict; the payloads. */
  def announce(cv: String, entries: Map[String, JsObject]): Seq[JsObject] = {
    val verdict = Catalog.validation(cv).getOrElse(throw new NoVerdict(s"catalog version $cv has no recorded verdict"))
    val events = entries.toSeq.sortBy(_._1).map { case (name, entry) =>
      // The lifecycle fields only: the endpoint and credential reference stay in the registry.
      val payload = JsObject(
        "tool" -> JsString(name),
        "version" -> entry.fields.getOrElse("version", JsNull),
        "side_effect" -> entry.fields.getOrElse("side_effect", JsNull),
        "catalog_version" -> JsString(cv),
        "outcome" -> JsString(verdict.getOrElse("outcome", "")))
      val value = payload.compactPrint
      producer.send(new ProducerRecord[String, String](LifecycleTopic, name, value), outboxOnFailure(name, value))
      payload
    }
    producer.flush()
    events
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
#include <vector>

#include "toolsd/catalog.h"  // catalog::validation
#include "toolsd/store.h"    // store::toOutbox

using json = nlohmann::json;

const std::string kLifecycleTopic = "tool.lifecycle";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "lifecycle record not delivered: " << message.errstr() << "\\n";
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

// One tool.lifecycle record per tool of catalog version cv, carrying its verdict; the payloads.
std::vector<json> announce(const std::string& cv, const json& entries) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  std::vector<json> events;
  for (const auto& [name, entry] : entries.items()) {
    json payload = entry;
    payload["tool"] = name;
    payload["catalog_version"] = cv;
    payload["outcome"] = "promoted";
    const std::string value = payload.dump();
    const std::string owner = entry.value("owner", "");
    producer->produce(kLifecycleTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                      value.size(), owner.c_str(), owner.size(), 0, nullptr);
    events.push_back(payload);
  }
  producer->flush(5000);
  return events;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "toolsd/catalog.h"  // catalog::validation
#include "toolsd/store.h"    // store::toOutbox

using json = nlohmann::json;

const std::string kLifecycleTopic = "tool.lifecycle";

// The candidate has no recorded verdict: there is nothing true to announce yet.
struct NoVerdict : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// A record the broker refused goes to the outbox, for the relay to republish.
class OutboxOnFailure : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    std::cerr << "lifecycle record not delivered, parked in the outbox: " << message.errstr() << "\\n";
    const std::string key = message.key() ? *message.key() : "";
    const std::string value(static_cast<const char*>(message.payload()), message.len());
    store::toOutbox(message.topic_name(), key, value);
  }
};

OutboxOnFailure delivery_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One tool.lifecycle record per tool of catalog version cv, carrying its verdict; the payloads.
std::vector<json> announce(const std::string& cv, const json& entries) {
  const auto verdict = catalog::validation(cv);
  if (!verdict) throw NoVerdict("catalog version " + cv + " has no recorded verdict");
  const auto outcome = verdict->find("outcome");
  std::vector<json> events;
  for (const auto& [name, entry] : entries.items()) {
    // The lifecycle fields only: the endpoint and credential reference stay in the registry.
    const json payload = {{"tool", name},
                          {"version", entry.value("version", "")},
                          {"side_effect", entry.value("side_effect", "")},
                          {"catalog_version", cv},
                          {"outcome", outcome == verdict->end() ? "" : outcome->second}};
    const std::string value = payload.dump();
    producer->produce(kLifecycleTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                      value.size(), name.c_str(), name.size(), 0, nullptr);
    events.push_back(payload);
  }
  producer->flush(5000);
  return events;
}
`,
    },
  },
  harness: {
    python: `import json

from toolsd import catalog

TOPIC = "tool.lifecycle"
FIELDS = {"tool", "version", "side_effect", "catalog_version", "outcome"}


def _entry(name, version, side_effect, owner):
    return {"name": name, "version": version, "side_effect": side_effect, "owner": owner, "schema": {"type": "object"}, "endpoint": f"https://{owner}.internal/{name}", "credential_ref": f"vault://{owner}/{name}"}


V9 = {
    "payments.refund": _entry("payments.refund", "b2", "irreversible", "payments"),
    "payments.void": _entry("payments.void", "d1", "write", "payments"),
    "search": _entry("search", "a2", "read", "search"),
}
V10 = {"payments.refund": _entry("payments.refund", "b3", "irreversible", "payments")}


def _events(ctx):
    m = ctx.load("events")
    catalog.record_validation("9", "passed", "")
    catalog.record_validation("10", "passed", "")
    return m


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def check_tool_key(ctx):
    m = _events(ctx)
    m.announce("9", V9)
    m.announce("10", V10)
    records = ctx.kafka.records(TOPIC)
    keys = sorted((r.key or b"").decode() for r in records)
    assert keys == ["payments.refund", "payments.refund", "payments.void", "search"], f"records must be keyed by the tool name, got keys {keys}: keyed by anything else, one tool's history scatters across partitions"
    refund = {r.partition for r in records if r.key == b"payments.refund"}
    assert len(refund) == 1, f"payments.refund's records landed on partitions {sorted(refund)}: one tool's history must stay on one partition, in order"


def check_public_payload(ctx):
    m = _events(ctx)
    m.announce("9", V9)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three tools produced {len(records)} records"
    for record in records:
        payload = _payload(record)
        assert set(payload) == FIELDS, f"the record carries {sorted(payload)}, expected exactly {sorted(FIELDS)}: the topic is retained and replicated, the rest stays in the registry"
        text = record.value.decode() if isinstance(record.value, bytes) else str(record.value)
        assert "vault://" not in text and ".internal" not in text, f"the record leaks an internal endpoint or credential reference: {text}"
    refund = next(_payload(r) for r in records if _payload(r).get("tool") == "payments.refund")
    assert refund == {"tool": "payments.refund", "version": "b2", "side_effect": "irreversible", "catalog_version": "9", "outcome": "passed"}, f"payments.refund's record is {refund}"


def check_verdict_outcome(ctx):
    m = ctx.load("events")
    catalog.record_validation("8", "rejected", "tool payments.void: the sandbox cannot build arguments from its schema")
    m.announce("8", V9)
    outcomes = {_payload(r).get("outcome") for r in ctx.kafka.records(TOPIC)}
    assert outcomes == {"rejected"}, f"a candidate the sandbox rejected was announced with outcome {sorted(map(str, outcomes))}: announce the recorded verdict"
    catalog.record_validation("9", "passed", "")
    m.announce("9", V9)
    latest = {_payload(r).get("outcome") for r in ctx.kafka.records(TOPIC)[3:]}
    assert latest == {"passed"}, f"a validated candidate was announced with outcome {sorted(map(str, latest))}"
    before = len(ctx.kafka.records(TOPIC))
    try:
        m.announce("11", V9)
    except Exception:
        pass
    else:
        raise AssertionError("announce for catalog 11, which has no recorded verdict, went through: raise NoVerdict, there is nothing true to announce yet")
    assert len(ctx.kafka.records(TOPIC)) == before, "a candidate with no verdict must produce nothing"


def check_outbox(ctx):
    m = _events(ctx)
    ctx.kafka.fail_next(TOPIC, 1)
    m.announce("9", V9)
    parked = [json.loads(raw) for raw in ctx.redis.lrange("tools:outbox", 0, -1)]
    assert len(parked) == 1, f"the broker refused one record and tools:outbox holds {len(parked)}: a refused record must be parked for the relay, not logged and dropped"
    row = parked[0]
    assert row.get("topic") == TOPIC and json.loads(row.get("value", "{}")).get("tool") == row.get("key"), f"the outbox row is {row}, expected the topic, the key and the record's value"
    delivered = {(r.key or b"").decode() for r in ctx.kafka.records(TOPIC)}
    assert delivered | {row["key"]} == set(V9), f"delivered {sorted(delivered)} plus parked {row['key']} must cover every tool"


def check_idempotent_producer(ctx):
    m = _events(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    m.announce("10", V10)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one record whose acknowledgement was lost left {len(records)} records on the topic: the producer's retry wrote it twice. Enable idempotence (with acks=all)"
    m.announce("9", V9)
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 4, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 4: with acks=1 the leader alone acknowledged them. Use acks=all"
`,
    typescript: `const TOPIC = 'tool.lifecycle';
const FIELDS = ['catalog_version', 'outcome', 'side_effect', 'tool', 'version'];

function entry(name: string, version: string, sideEffect: string, owner: string) {
  return {name, version, side_effect: sideEffect, owner, schema: {type: 'object'}, endpoint: \`https://\${owner}.internal/\${name}\`, credential_ref: \`vault://\${owner}/\${name}\`};
}

const V9 = {
  'payments.refund': entry('payments.refund', 'b2', 'irreversible', 'payments'),
  'payments.void': entry('payments.void', 'd1', 'write', 'payments'),
  search: entry('search', 'a2', 'read', 'search'),
};
const V10 = {'payments.refund': entry('payments.refund', 'b3', 'irreversible', 'payments')};

async function events(ctx, verdicts = true) {
  const catalog = ctx.load('/support/toolsd/catalog.ts');
  if (verdicts) {
    await catalog.recordValidation('9', 'passed', '');
    await catalog.recordValidation('10', 'passed', '');
  }
  return {m: ctx.load('events'), catalog};
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

const keyOf = record => record.key?.toString() ?? '';

export async function check_tool_key(ctx) {
  const {m} = await events(ctx);
  await m.announce('9', V9);
  await m.announce('10', V10);
  const records = ctx.kafka.records(TOPIC);
  const keys = records.map(keyOf).sort();
  assert.deepStrictEqual(keys, ['payments.refund', 'payments.refund', 'payments.void', 'search'], \`records must be keyed by the tool name, got keys \${JSON.stringify(keys)}: keyed by anything else, one tool's history scatters across partitions\`);
  const refund = [...new Set(records.filter(r => keyOf(r) === 'payments.refund').map(r => r.partition))];
  assert.equal(refund.length, 1, \`payments.refund's records landed on partitions \${JSON.stringify(refund)}: one tool's history must stay on one partition, in order\`);
}

export async function check_public_payload(ctx) {
  const {m} = await events(ctx);
  await m.announce('9', V9);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three tools produced \${records.length} records\`);
  for (const record of records) {
    const p = payload(record);
    assert.deepStrictEqual(Object.keys(p).sort(), FIELDS, \`the record carries \${JSON.stringify(Object.keys(p).sort())}, expected exactly \${JSON.stringify(FIELDS)}: the topic is retained and replicated, the rest stays in the registry\`);
    const text = record.value.toString();
    assert(!text.includes('vault://') && !text.includes('.internal'), \`the record leaks an internal endpoint or credential reference: \${text}\`);
  }
  const refund = records.map(payload).find(p => p.tool === 'payments.refund');
  assert.deepStrictEqual(refund, {tool: 'payments.refund', version: 'b2', side_effect: 'irreversible', catalog_version: '9', outcome: 'passed'}, \`payments.refund's record is \${JSON.stringify(refund)}\`);
}

export async function check_verdict_outcome(ctx) {
  const {m, catalog} = await events(ctx, false);
  await catalog.recordValidation('8', 'rejected', 'tool payments.void: the sandbox cannot build arguments from its schema');
  await m.announce('8', V9);
  const outcomes = [...new Set(ctx.kafka.records(TOPIC).map(r => payload(r).outcome))];
  assert.deepStrictEqual(outcomes, ['rejected'], \`a candidate the sandbox rejected was announced with outcome \${JSON.stringify(outcomes)}: announce the recorded verdict\`);
  await catalog.recordValidation('9', 'passed', '');
  await m.announce('9', V9);
  const latest = [...new Set(ctx.kafka.records(TOPIC).slice(3).map(r => payload(r).outcome))];
  assert.deepStrictEqual(latest, ['passed'], \`a validated candidate was announced with outcome \${JSON.stringify(latest)}\`);
  const before = ctx.kafka.records(TOPIC).length;
  let refused = false;
  try {
    await m.announce('11', V9);
  } catch {
    refused = true;
  }
  assert(refused, 'announce for catalog 11, which has no recorded verdict, went through: throw NoVerdict, there is nothing true to announce yet');
  assert.equal(ctx.kafka.records(TOPIC).length, before, 'a candidate with no verdict must produce nothing');
}

export async function check_outbox(ctx) {
  const {m} = await events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  await m.announce('9', V9);
  const parked = (ctx.redis.lrange('tools:outbox', 0, -1) as string[]).map(raw => JSON.parse(raw));
  assert.equal(parked.length, 1, \`the broker refused one record and tools:outbox holds \${parked.length}: a refused record must be parked for the relay, not logged and dropped\`);
  const row = parked[0];
  assert(row.topic === TOPIC && JSON.parse(row.value ?? '{}').tool === row.key, \`the outbox row is \${JSON.stringify(row)}, expected the topic, the key and the record's value\`);
  const covered = [...new Set([...ctx.kafka.records(TOPIC).map(keyOf), row.key])].sort();
  assert.deepStrictEqual(covered, Object.keys(V9).sort(), \`delivered plus parked records cover \${JSON.stringify(covered)}, expected every tool\`);
}

export async function check_idempotent_producer(ctx) {
  const {m} = await events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.announce('10', V10);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one record whose acknowledgement was lost left \${records.length} records on the topic: the producer's retry wrote it twice. Make the producer idempotent (acks -1)\`);
  await m.announce('9', V9);
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 4, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 4: with acks 1 the leader alone acknowledged them. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"toolsd/catalog"

	"leetbuild/harness"
)

const topic = "tool.lifecycle"

var eventsBg = context.Background()

func entry(name, version, sideEffect, owner string) catalog.Entry {
	return catalog.Entry{"name": name, "version": version, "side_effect": sideEffect, "owner": owner, "schema": map[string]any{"type": "object"}, "endpoint": "https://" + owner + ".internal/" + name, "credential_ref": "vault://" + owner + "/" + name}
}

var (
	v9 = map[string]catalog.Entry{
		"payments.refund": entry("payments.refund", "b2", "irreversible", "payments"),
		"payments.void":   entry("payments.void", "d1", "write", "payments"),
		"search":          entry("search", "a2", "read", "search"),
	}
	v10 = map[string]catalog.Entry{"payments.refund": entry("payments.refund", "b3", "irreversible", "payments")}
)

func seedVerdicts(ctx *harness.Ctx) {
	ctx.NoError(catalog.RecordValidation(eventsBg, "9", "passed", ""), "seeding verdicts failed")
	ctx.NoError(catalog.RecordValidation(eventsBg, "10", "passed", ""), "seeding verdicts failed")
}

func mustAnnounce(ctx *harness.Ctx, cv string, entries map[string]catalog.Entry) {
	_, err := announce(eventsBg, cv, entries)
	ctx.NoError(err, "announce(%s) failed", cv)
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func sortedKeys(ctx *harness.Ctx) []string {
	keys := append([]string{}, ctx.Kafka.Keys(topic)...)
	sort.Strings(keys)
	return keys
}

func CheckToolKey(ctx *harness.Ctx) {
	seedVerdicts(ctx)
	mustAnnounce(ctx, "9", v9)
	mustAnnounce(ctx, "10", v10)
	ctx.Equal(sortedKeys(ctx), []string{"payments.refund", "payments.refund", "payments.void", "search"}, "records must be keyed by the tool name (keyed by anything else, one tool's history scatters across partitions); the keys")
	partitions := map[int]bool{}
	for _, r := range ctx.Kafka.Records(topic) {
		if string(r.Key) == "payments.refund" {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "payments.refund's records must stay on one partition, in order; the partitions they landed on")
}

func CheckPublicPayload(ctx *harness.Ctx) {
	seedVerdicts(ctx)
	mustAnnounce(ctx, "9", v9)
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 3, "three tools, the records")
	for _, r := range records {
		p := payloadOf(ctx, r.Value)
		fields := make([]string, 0, len(p))
		for k := range p {
			fields = append(fields, k)
		}
		sort.Strings(fields)
		ctx.Equal(fields, []string{"catalog_version", "outcome", "side_effect", "tool", "version"}, "the topic is retained and replicated, the rest stays in the registry; the record's fields")
		text := string(r.Value)
		ctx.Assert(!strings.Contains(text, "vault://") && !strings.Contains(text, ".internal"), "the record leaks an internal endpoint or credential reference: %s", text)
		if p["tool"] == "payments.refund" {
			ctx.Assert(p["version"] == "b2" && p["side_effect"] == "irreversible" && p["catalog_version"] == "9" && p["outcome"] == "passed", "payments.refund's record is %v", p)
		}
	}
}

func CheckVerdictOutcome(ctx *harness.Ctx) {
	ctx.NoError(catalog.RecordValidation(eventsBg, "8", "rejected", "tool payments.void: the sandbox cannot build arguments from its schema"), "seeding failed")
	mustAnnounce(ctx, "8", v9)
	for _, r := range ctx.Kafka.Records(topic) {
		ctx.Equal(payloadOf(ctx, r.Value)["outcome"], "rejected", "a candidate the sandbox rejected must be announced with the recorded verdict; the outcome")
	}
	ctx.NoError(catalog.RecordValidation(eventsBg, "9", "passed", ""), "seeding failed")
	mustAnnounce(ctx, "9", v9)
	for _, r := range ctx.Kafka.Records(topic)[3:] {
		ctx.Equal(payloadOf(ctx, r.Value)["outcome"], "passed", "a validated candidate's outcome")
	}
	before := len(ctx.Kafka.Records(topic))
	_, err := announce(eventsBg, "11", v9)
	ctx.Assert(err != nil, "announce for catalog 11, which has no recorded verdict, went through: return ErrNoVerdict, there is nothing true to announce yet")
	ctx.Equal(len(ctx.Kafka.Records(topic)), before, "a candidate with no verdict must produce nothing; the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	seedVerdicts(ctx)
	ctx.Kafka.FailNext(topic, 1)
	mustAnnounce(ctx, "9", v9)
	parked := ctx.Redis.LRange("tools:outbox", 0, -1)
	ctx.Equal(len(parked), 1, "the broker refused one record: it must be parked in tools:outbox for the relay, not logged and dropped; the outbox rows")
	var row map[string]string
	ctx.Assert(json.Unmarshal([]byte(parked[0]), &row) == nil, "the outbox row is not JSON: %s", parked[0])
	value := payloadOf(ctx, []byte(row["value"]))
	ctx.Assert(row["topic"] == topic && value["tool"] == row["key"], "the outbox row is %v, expected the topic, the key and the record's value", row)
	covered := map[string]bool{row["key"]: true}
	for _, k := range ctx.Kafka.Keys(topic) {
		covered[k] = true
	}
	ctx.Equal(len(covered), 3, "delivered plus parked records must cover every tool; the tools covered")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	seedVerdicts(ctx)
	mustAnnounce(ctx, "10", v10)
	mustAnnounce(ctx, "9", v9)
	lost := ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 4, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged them. Use RequireAll; the records on the topic", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

const std::string kTopic = "tool.lifecycle";

json entry(const std::string& name, const std::string& version, const std::string& side_effect, const std::string& owner) {
  return json{{"name", name},
              {"version", version},
              {"side_effect", side_effect},
              {"owner", owner},
              {"schema", {{"type", "object"}}},
              {"endpoint", "https://" + owner + ".internal/" + name},
              {"credential_ref", "vault://" + owner + "/" + name}};
}

const json kV9 = {{"payments.refund", entry("payments.refund", "b2", "irreversible", "payments")},
                  {"payments.void", entry("payments.void", "d1", "write", "payments")},
                  {"search", entry("search", "a2", "read", "search")}};
const json kV10 = {{"payments.refund", entry("payments.refund", "b3", "irreversible", "payments")}};

void seedVerdicts() {
  catalog::recordValidation("9", "passed", "");
  catalog::recordValidation("10", "passed", "");
}

json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  const json p = json::parse(record.Value.value_or(""), nullptr, false);
  ctx.Assert(p.is_object(), "the record's value is not JSON: %s", record.Value.value_or(""));
  return p;
}

std::vector<std::string> sortedKeys(harness::Ctx& ctx) {
  std::vector<std::string> keys = ctx.Kafka.Keys(kTopic);
  std::sort(keys.begin(), keys.end());
  return keys;
}

}  // namespace

void CheckToolKey(harness::Ctx& ctx) {
  seedVerdicts();
  announce("9", kV9);
  announce("10", kV10);
  ctx.Equal(sortedKeys(ctx), {"payments.refund", "payments.refund", "payments.void", "search"}, "records must be keyed by the tool name (keyed by anything else, one tool's history scatters across partitions); the keys");
  std::set<int> partitions;
  for (const auto& r : ctx.Kafka.Records(kTopic)) {
    if (r.Key.value_or("") == "payments.refund") partitions.insert(r.Partition);
  }
  ctx.Equal(partitions.size(), 1, "payments.refund's records must stay on one partition, in order; the partitions they landed on");
}

void CheckPublicPayload(harness::Ctx& ctx) {
  seedVerdicts();
  announce("9", kV9);
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three tools, the records");
  for (const auto& r : records) {
    const json p = payloadOf(ctx, r);
    std::vector<std::string> fields;
    for (const auto& [k, v] : p.items()) fields.push_back(k);
    ctx.Equal(fields, {"catalog_version", "outcome", "side_effect", "tool", "version"}, "the topic is retained and replicated, the rest stays in the registry; the record's fields");
    const std::string text = r.Value.value_or("");
    ctx.Assert(text.find("vault://") == std::string::npos && text.find(".internal") == std::string::npos, "the record leaks an internal endpoint or credential reference: %s", text);
    if (p.value("tool", "") == "payments.refund") {
      ctx.Equal(p, json{{"tool", "payments.refund"}, {"version", "b2"}, {"side_effect", "irreversible"}, {"catalog_version", "9"}, {"outcome", "passed"}}, "payments.refund's record");
    }
  }
}

void CheckVerdictOutcome(harness::Ctx& ctx) {
  catalog::recordValidation("8", "rejected", "tool payments.void: the sandbox cannot build arguments from its schema");
  announce("8", kV9);
  for (const auto& r : ctx.Kafka.Records(kTopic)) {
    ctx.Equal(payloadOf(ctx, r).value("outcome", ""), "rejected", "a candidate the sandbox rejected must be announced with the recorded verdict; the outcome");
  }
  catalog::recordValidation("9", "passed", "");
  announce("9", kV9);
  const auto records = ctx.Kafka.Records(kTopic);
  for (size_t i = 3; i < records.size(); i++) ctx.Equal(payloadOf(ctx, records[i]).value("outcome", ""), "passed", "a validated candidate's outcome");
  const size_t before = records.size();
  bool refused = false;
  try {
    announce("11", kV9);
  } catch (const std::exception&) {
    refused = true;
  }
  ctx.Assert(refused, "announce for catalog 11, which has no recorded verdict, went through: throw NoVerdict, there is nothing true to announce yet");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), before, "a candidate with no verdict must produce nothing; the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  seedVerdicts();
  ctx.Kafka.FailNext(kTopic, 1);
  announce("9", kV9);
  const auto parked = ctx.Redis.LRange("tools:outbox", 0, -1);
  ctx.Equal(parked.size(), 1, "the broker refused one record: it must be parked in tools:outbox for the relay, not logged and dropped; the outbox rows");
  const json row = json::parse(parked[0], nullptr, false);
  ctx.Assert(row.is_object() && row.value("topic", "") == kTopic && json::parse(row.value("value", "{}")).value("tool", "") == row.value("key", ""),
             "the outbox row is %s, expected the topic, the key and the record's value", parked[0]);
  std::set<std::string> covered = {row.value("key", "")};
  for (const auto& k : ctx.Kafka.Keys(kTopic)) covered.insert(k);
  ctx.Equal(covered.size(), 3, "delivered plus parked records must cover every tool; the tools covered");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  seedVerdicts();
  ctx.Kafka.LoseAcks(kTopic, 1);
  announce("10", kV10);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one record whose acknowledgement was lost: the producer's retry wrote it twice. Set enable.idempotence (with acks=all); the records on the topic");
  announce("9", kV9);
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 4, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged them. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    "Announce one catalog and read the topic: the refund tool's record is keyed `payments` and carries `vault://payments/...`, and a candidate the sandbox rejected reads `promoted`.",
    'The value spreads the whole entry, the outcome is a literal, nothing reads the recorded verdict, and the delivery callback only logs. With `acks=1` and no idempotence, a retried produce lands twice.',
    'Read `catalog.validation(cv)` first and raise `NoVerdict` when it is missing; build the five-field payload; key by `name`; in the delivery callback call `store.to_outbox` on error; set `enable.idempotence: True` and `acks: all`.',
  ],
  debrief: `A lifecycle record is an audit fact about one tool, so it is keyed by the tool, carries what a consumer needs to replay that tool's history, and carries the verdict exactly as it was recorded. Reading the verdict instead of writing an outcome is what makes "announced as passed" mean "the sandbox said passed". The outbox catches what the broker refused, so the audit trail has no silent gaps, and idempotence with acks=all closes the opposite gap, a duplicate after a lost acknowledgement. Production registries write the outbox row in the same transaction as the verdict and let a relay produce from it, so an event cannot be lost between the verdict and the produce either.`,
};
