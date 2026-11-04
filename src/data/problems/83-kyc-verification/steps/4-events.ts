import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Decision events keyed by applicant with document digests',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'db', 'kafka'],
  task: `## Task

**Starting point.** The starter is the decision path: \`record_decision(case_id, status, reasons,
degraded)\` builds a \`kyc.decided\` event from the case, produces it to Kafka with a delivery
callback, then records the decision with \`cases.decide\` (which appends to the audit list
\`kyc:audit:{case_id}\`), and returns the event. Decide a case and an event shows up; it hides four
flaws.

**Failure mode the checks target.** An applicant's second case lands on another partition and a
consumer applies the approval before the rejection; the retained topic holds the storage paths of
passport scans; a decision the store refuses, or a crash before the commit, leaves an event nothing
recorded; and a lost acknowledgement or a leader failover duplicates or drops the event.

- The record key is the case's **applicant**.
- The payload carries \`case_id\`, \`tenant\`, \`applicant\`, \`decision\`, \`reasons\`, \`degraded\` and
  \`documents\` as \`[{type, digest}]\`: no document \`ref\`.
- \`cases.decide\` commits first; the event is built from the case it returns and produced after.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent\` with \`acks: -1\`; kafka-go has no
  idempotent producer, so the Go writer uses \`RequireAll\`).`,
  sequence: {
    participants: ['KYC API', 'Case store', 'kyc.decided', 'Consumers'],
    messages: [
      {
        from: 'KYC API',
        to: 'Case store',
        label: 'decide(case_id, status, reasons, degraded) · audit row',
        kind: 'sync',
      },
      {from: 'Case store', to: 'KYC API', label: 'the decided case', kind: 'reply'},
      {from: 'KYC API', to: 'kyc.decided', label: 'produce · key = applicant · acks = all · idempotent', kind: 'sync'},
      {from: 'kyc.decided', to: 'KYC API', label: 'delivery report', kind: 'reply'},
      {
        from: 'kyc.decided',
        to: 'Consumers',
        label: 'decision · reasons · digests, in order per applicant',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'applicant-key',
      title: 'Keys every event by the applicant',
      detail:
        'The record key is the case’s applicant, so every decision about one person lands on one partition in order; keyed by the case id, two cases of one applicant scatter and a consumer can apply them out of order.',
      match: {
        python: {all: [/key=\w+\[["']applicant["']\]/], none: [/key=case_id/]},
        typescript: {all: [/key:\s*\w+\.applicant\b/], none: [/key:\s*caseId\b/]},
        go: {all: [/Key:\s*\[\]byte\(\w+\.Applicant\)/], none: [/Key:\s*\[\]byte\(caseID\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(DecidedTopic,\s*\w+\.applicant/],
          none: [/DecidedTopic,\s*caseId/],
        },
        cpp: {all: [/\w+\.applicant\.c_str\(\),\s*\w+\.applicant\.size\(\)/], none: [/case_id\.c_str\(\)/]},
      },
    },
    {
      id: 'digests-only',
      title: 'Carries reasons and digests, never document refs',
      detail:
        'Each document goes out as its type and digest, and the payload carries the decided reasons; the storage refs stay in the case store, because a retained, replicated topic outlives every access rule on the scans.',
      match: {
        python: {all: [/["']digest["']:\s*\w+\[["']digest["']\]/, /["']reasons["']:\s*\w+\[["']reasons["']\]/]},
        typescript: {all: [/digest:\s*\w+\.digest/, /reasons:\s*\w+\.reasons/]},
        go: {all: [/"digest":\s*\w+\.Digest/, /"reasons":\s*\w+\.Reasons/]},
        scala: {all: [/"digest"\s*->\s*JsString\(\w+\.digest\)/, /"reasons"\s*->\s*JsArray\(\w+\.reasons/]},
        cpp: {all: [/\{"digest",\s*\w+\.digest\}/, /\{"reasons",\s*\w+\.reasons\}/]},
      },
    },
    {
      id: 'commit-before-produce',
      title: 'Commits the decision before producing the event',
      detail:
        '`decide` runs first and the event is produced only after it returned: an event describes a decision the store holds, and a decision the store refuses is never announced.',
      match: {
        python: {order: [/cases\.decide\(/, /producer\.produce\(/]},
        typescript: {order: [/cases\.decide\(/, /producer\.send\(/]},
        go: {order: [/cases\.Decide\(/, /WriteMessages\(/]},
        scala: {order: [/Cases\.decide\(/, /producer\.send\(/]},
        cpp: {order: [/cases::decide\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'durable-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is idempotent and waits for every in-sync replica (`enable.idempotence` with `acks=all`, kafkajs `idempotent: true` with `acks: -1`); kafka-go has no idempotent producer, so its writer uses `RequireAll` and consumers deduplicate by `case_id`.',
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

from kyc import cases  # cases.load, cases.decide

DECIDED_TOPIC = "kyc.decided"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.error("kyc.decided not delivered for %s: %s", msg.key(), err)


def record_decision(case_id: str, status: str, reasons: list[str], degraded: bool) -> dict:
    """Record the decision on the case and announce it on kyc.decided; returns the event."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    case = cases.load(case_id)
    event = {
        "case_id": case_id,
        "tenant": case["tenant"],
        "applicant": case["applicant"],
        "decision": status,
        "degraded": degraded,
        "documents": case["documents"],  # consumers can re-check the scans themselves
    }
    producer.produce(DECIDED_TOPIC, key=case_id, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    cases.decide(case_id, status, reasons, degraded)
    return event
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from kyc import cases  # cases.load, cases.decide

DECIDED_TOPIC = "kyc.decided"
log = logging.getLogger("events")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.error("kyc.decided not delivered for %s: %s", msg.key(), err)


def record_decision(case_id: str, status: str, reasons: list[str], degraded: bool) -> dict:
    """Record the decision on the case and announce it on kyc.decided; returns the event."""
    # The decision commits first: an event may lag the store, it may never precede it.
    case = cases.decide(case_id, status, reasons, degraded)
    event = {
        "case_id": case_id,
        "tenant": case["tenant"],
        "applicant": case["applicant"],
        "decision": case["status"],
        "reasons": case["reasons"],
        "degraded": case["degraded"],
        # Digests let a consumer match documents without being able to open them.
        "documents": [{"type": d["type"], "digest": d["digest"]} for d in case["documents"]],
    }
    producer.produce(DECIDED_TOPIC, key=case["applicant"], value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    return event
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as cases from 'kyc/cases'; // cases.load, cases.decide

export const DECIDED_TOPIC = 'kyc.decided';

const kafka = new Kafka({clientId: 'kycd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Record the decision on the case and announce it on kyc.decided; returns the event. */
export async function recordDecision(caseId: string, status: string, reasons: string[], degraded: boolean): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const current = (await cases.load(caseId)) as cases.Case;
  const event = {
    case_id: caseId,
    tenant: current.tenant,
    applicant: current.applicant,
    decision: status,
    degraded,
    documents: current.documents, // consumers can re-check the scans themselves
  };
  await producer.send({topic: DECIDED_TOPIC, messages: [{key: caseId, value: JSON.stringify(event)}], acks: 1});
  await cases.decide(caseId, status, reasons, degraded);
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as cases from 'kyc/cases'; // cases.load, cases.decide

export const DECIDED_TOPIC = 'kyc.decided';

const kafka = new Kafka({clientId: 'kycd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the event once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Record the decision on the case and announce it on kyc.decided; returns the event. */
export async function recordDecision(caseId: string, status: string, reasons: string[], degraded: boolean): Promise<Record<string, unknown>> {
  // The decision commits first: an event may lag the store, it may never precede it.
  const decided = await cases.decide(caseId, status, reasons, degraded);
  const event = {
    case_id: caseId,
    tenant: decided.tenant,
    applicant: decided.applicant,
    decision: decided.status,
    reasons: decided.reasons,
    degraded: decided.degraded,
    // Digests let a consumer match documents without being able to open them.
    documents: decided.documents.map(d => ({type: d.type, digest: d.digest})),
  };
  await producer.send({topic: DECIDED_TOPIC, messages: [{key: decided.applicant, value: JSON.stringify(event)}], acks: -1});
  return event;
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

	"kyc/cases" // cases.Load, cases.Decide
)

const decidedTopic = "kyc.decided"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        decidedTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// recordDecision records the decision on the case and announces it on kyc.decided; it returns the event.
func recordDecision(ctx context.Context, caseID, status string, reasons []string, degraded bool) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	current := cases.Load(ctx, caseID)
	if current == nil {
		return nil, fmt.Errorf("no case %s", caseID)
	}
	event := map[string]any{
		"case_id":   caseID,
		"tenant":    current.Tenant,
		"applicant": current.Applicant,
		"decision":  status,
		"degraded":  degraded,
		"documents": current.Documents, // consumers can re-check the scans themselves
	}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(caseID), Value: value}); err != nil {
		return nil, err
	}
	if _, err := cases.Decide(ctx, caseID, status, reasons, degraded); err != nil {
		return nil, err
	}
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"

	"kyc/cases" // cases.Load, cases.Decide
)

const decidedTopic = "kyc.decided"

// RequireAll: the event is on every in-sync replica before WriteMessages returns. kafka-go has no
// idempotent producer, so a retry after a lost acknowledgement can duplicate; consumers deduplicate
// by case_id.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        decidedTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// recordDecision records the decision on the case and announces it on kyc.decided; it returns the event.
func recordDecision(ctx context.Context, caseID, status string, reasons []string, degraded bool) (map[string]any, error) {
	// The decision commits first: an event may lag the store, it may never precede it.
	decided, err := cases.Decide(ctx, caseID, status, reasons, degraded)
	if err != nil {
		return nil, err
	}
	// Digests let a consumer match documents without being able to open them.
	documents := []map[string]string{}
	for _, d := range decided.Documents {
		documents = append(documents, map[string]string{"type": d.Type, "digest": d.Digest})
	}
	event := map[string]any{
		"case_id":   caseID,
		"tenant":    decided.Tenant,
		"applicant": decided.Applicant,
		"decision":  decided.Status,
		"reasons":   decided.Reasons,
		"degraded":  decided.Degraded,
		"documents": documents,
	}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(decided.Applicant), Value: value}); err != nil {
		return nil, err
	}
	return event, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import kyc.Cases // Cases.load, Cases.decide

object Events {
  val DecidedTopic = "kyc.decided"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"kyc.decided not delivered: \${exception.getMessage}")
  }

  /** Record the decision on the case and announce it on kyc.decided; returns the event. */
  def recordDecision(caseId: String, status: String, reasons: Seq[String], degraded: Boolean): JsObject = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val current = Cases.load(caseId).getOrElse(throw new NoSuchElementException(s"no case $caseId"))
    val event = JsObject(
      "case_id" -> JsString(caseId),
      "tenant" -> JsString(current.tenant),
      "applicant" -> JsString(current.applicant),
      "decision" -> JsString(status),
      "degraded" -> JsBoolean(degraded),
      "documents" -> Cases.documentsJson(current.documents)) // consumers can re-check the scans themselves
    producer.send(new ProducerRecord[String, String](DecidedTopic, caseId, event.compactPrint), onDelivery).get()
    Cases.decide(caseId, status, reasons, degraded)
    event
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import kyc.Cases // Cases.load, Cases.decide

object Events {
  val DecidedTopic = "kyc.decided"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"kyc.decided not delivered: \${exception.getMessage}")
  }

  /** Record the decision on the case and announce it on kyc.decided; returns the event. */
  def recordDecision(caseId: String, status: String, reasons: Seq[String], degraded: Boolean): JsObject = {
    // The decision commits first: an event may lag the store, it may never precede it.
    val decided = Cases.decide(caseId, status, reasons, degraded)
    val event = JsObject(
      "case_id" -> JsString(caseId),
      "tenant" -> JsString(decided.tenant),
      "applicant" -> JsString(decided.applicant),
      "decision" -> JsString(decided.status),
      "reasons" -> JsArray(decided.reasons.map(JsString(_)).toVector),
      "degraded" -> JsBoolean(decided.degraded),
      // Digests let a consumer match documents without being able to open them.
      "documents" -> JsArray(decided.documents.map(d => JsObject("type" -> JsString(d.documentType), "digest" -> JsString(d.digest))).toVector))
    producer.send(new ProducerRecord[String, String](DecidedTopic, decided.applicant, event.compactPrint), onDelivery).get()
    event
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "kyc/cases.h"  // cases::load, cases::decide

using json = nlohmann::json;

const std::string kDecidedTopic = "kyc.decided";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "kyc.decided not delivered: " << message.errstr() << "\\n";
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

// Record the decision on the case and announce it on kyc.decided; returns the event.
json record_decision(const std::string& case_id, const std::string& status, const std::vector<std::string>& reasons, bool degraded) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto current = cases::load(case_id);
  if (!current) throw std::out_of_range("no case " + case_id);
  const json event = {{"case_id", case_id},
                      {"tenant", current->tenant},
                      {"applicant", current->applicant},
                      {"decision", status},
                      {"degraded", degraded},
                      {"documents", cases::documentsJson(current->documents)}};  // consumers can re-check the scans themselves
  const std::string value = event.dump();
  producer->produce(kDecidedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), case_id.c_str(), case_id.size(), 0, nullptr);
  producer->flush(2000);
  cases::decide(case_id, status, reasons, degraded);
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include "kyc/cases.h"  // cases::load, cases::decide

using json = nlohmann::json;

const std::string kDecidedTopic = "kyc.decided";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "kyc.decided not delivered: " << message.errstr() << "\\n";
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

// Record the decision on the case and announce it on kyc.decided; returns the event.
json record_decision(const std::string& case_id, const std::string& status, const std::vector<std::string>& reasons, bool degraded) {
  // The decision commits first: an event may lag the store, it may never precede it.
  const cases::Case decided = cases::decide(case_id, status, reasons, degraded);
  // Digests let a consumer match documents without being able to open them.
  json documents = json::array();
  for (const cases::Document& d : decided.documents) documents.push_back({{"type", d.type}, {"digest", d.digest}});
  const json event = {{"case_id", case_id},
                      {"tenant", decided.tenant},
                      {"applicant", decided.applicant},
                      {"decision", decided.status},
                      {"reasons", decided.reasons},
                      {"degraded", decided.degraded},
                      {"documents", documents}};
  const std::string value = event.dump();
  producer->produce(kDecidedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), decided.applicant.c_str(), decided.applicant.size(), 0, nullptr);
  producer->flush(2000);
  return event;
}
`,
    },
  },
  harness: {
    python: `import json

from kyc import cases

TOPIC = "kyc.decided"
DOCS = [
    {"type": "passport", "ref": "documents/t-a/passport-1.jpg", "digest": "sha256:5e1f0c"},
    {"type": "drivers_license", "ref": "documents/t-a/license-1.jpg", "digest": "sha256:77ab02"},
]


def _case(applicant="a-1"):
    return cases.create(cases.new_id(), "t-a", applicant, DOCS)["case_id"]


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def check_applicant_key(ctx):
    m = ctx.load("events")
    m.record_decision(_case(), "rejected", ["DOC_EXPIRED"], False)
    m.record_decision(_case(), "approved", [], False)
    m.record_decision(_case("a-2"), "approved", [], False)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three decisions produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"a-1", b"a-1", b"a-2"], f"records must be keyed by the applicant, got {keys}: keyed by anything else, one person's decisions scatter across partitions"
    assert records[0].partition == records[1].partition, f"a-1's two decisions landed on partitions {records[0].partition} and {records[1].partition}: one applicant's history must stay on one partition, in order"


def check_digests_only(ctx):
    m = ctx.load("events")
    case_id = _case()
    event = m.record_decision(case_id, "rejected", ["DOC_EXPIRED"], False)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one decision produced {len(records)} records"
    text = records[0].value.decode()
    assert "documents/" not in text, f"the event carries the storage refs of the scans: {text}. A retained topic outlives every access rule on them; send each document's type and digest"
    payload = _payload(records[0])
    want = [{"type": "passport", "digest": "sha256:5e1f0c"}, {"type": "drivers_license", "digest": "sha256:77ab02"}]
    assert payload.get("documents") == want, f"documents must be [{{type, digest}}] per document, got {payload.get('documents')}"
    assert payload.get("decision") == "rejected" and payload.get("reasons") == ["DOC_EXPIRED"], f"the event must carry the decision and its reasons, got {payload}"
    assert payload.get("degraded") is False and payload.get("case_id") == case_id and payload.get("applicant") == "a-1" and payload.get("tenant") == "t-a", f"the event must carry case_id, tenant, applicant and degraded, got {payload}"
    assert event == payload, f"record_decision must return the event it produced: returned {event}, produced {payload}"


def check_commit_before_produce(ctx):
    m = ctx.load("events")
    case_id = _case()
    # The moment the decision commits (its audit row), what is already on the topic.
    at_commit = ctx.redis_after(f"kyc:audit:{case_id}", lambda: len(ctx.kafka.records(TOPIC)))
    m.record_decision(case_id, "approved", [], False)
    assert at_commit.fired, "record_decision never committed the decision: nothing wrote the audit row"
    assert at_commit.result == 0, f"when the decision committed the topic already held {at_commit.result} record(s): the event announced a decision the store did not hold yet. Decide, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one decision the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 1"
    refused = _case("a-2")
    try:
        m.record_decision(refused, "verified", [], False)
    except Exception:
        pass
    assert len(ctx.kafka.records(TOPIC)) == 1, "a decision the case store refused (status verified) was announced anyway"


def check_durable_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    m.record_decision(_case(), "approved", [], False)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one decision whose acknowledgement was lost left {len(records)} records: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    m.record_decision(_case("a-2"), "rejected", ["DOC_EXPIRED"], False)
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the second event and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'kyc.decided';
const DOCS = [
  {type: 'passport', ref: 'documents/t-a/passport-1.jpg', digest: 'sha256:5e1f0c'},
  {type: 'drivers_license', ref: 'documents/t-a/license-1.jpg', digest: 'sha256:77ab02'},
];

function events(ctx) {
  return {m: ctx.load('events'), cases: ctx.load('/support/kyc/cases.ts')};
}

async function open(cases, applicant = 'a-1'): Promise<string> {
  return (await cases.create(await cases.newId(), 't-a', applicant, DOCS)).case_id;
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

export async function check_applicant_key(ctx) {
  const {m, cases} = events(ctx);
  await m.recordDecision(await open(cases), 'rejected', ['DOC_EXPIRED'], false);
  await m.recordDecision(await open(cases), 'approved', [], false);
  await m.recordDecision(await open(cases, 'a-2'), 'approved', [], false);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three decisions produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['a-1', 'a-1', 'a-2'], \`records must be keyed by the applicant, got \${JSON.stringify(keys)}: keyed by anything else, one person's decisions scatter across partitions\`);
  assert.equal(records[0].partition, records[1].partition, \`a-1's two decisions landed on partitions \${records[0].partition} and \${records[1].partition}: one applicant's history must stay on one partition, in order\`);
}

export async function check_digests_only(ctx) {
  const {m, cases} = events(ctx);
  const caseId = await open(cases);
  const event = await m.recordDecision(caseId, 'rejected', ['DOC_EXPIRED'], false);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one decision produced \${records.length} records\`);
  const text = records[0].value.toString();
  assert(!text.includes('documents/'), \`the event carries the storage refs of the scans: \${text}. A retained topic outlives every access rule on them; send each document's type and digest\`);
  const p = payload(records[0]);
  assert.deepStrictEqual(p.documents, [{type: 'passport', digest: 'sha256:5e1f0c'}, {type: 'drivers_license', digest: 'sha256:77ab02'}], \`documents must be [{type, digest}] per document, got \${JSON.stringify(p.documents)}\`);
  assert(p.decision === 'rejected' && JSON.stringify(p.reasons) === '["DOC_EXPIRED"]', \`the event must carry the decision and its reasons, got \${text}\`);
  assert(p.degraded === false && p.case_id === caseId && p.applicant === 'a-1' && p.tenant === 't-a', \`the event must carry case_id, tenant, applicant and degraded, got \${text}\`);
  assert.deepStrictEqual(event, p, \`recordDecision must return the event it produced: returned \${JSON.stringify(event)}, produced \${text}\`);
}

export async function check_commit_before_produce(ctx) {
  const {m, cases} = events(ctx);
  const caseId = await open(cases);
  // The moment the decision commits (its audit row), what is already on the topic.
  const atCommit = ctx.redisAfter(\`kyc:audit:\${caseId}\`, () => ctx.kafka.records(TOPIC).length);
  await m.recordDecision(caseId, 'approved', [], false);
  assert(atCommit.fired, 'recordDecision never committed the decision: nothing wrote the audit row');
  assert.equal(atCommit.result, 0, \`when the decision committed the topic already held \${atCommit.result} record(s): the event announced a decision the store did not hold yet. Decide, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'after one decision the topic must hold 1 record');
  const refused = await open(cases, 'a-2');
  await m.recordDecision(refused, 'verified', [], false).catch(() => undefined);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'a decision the case store refused (status verified) was announced anyway');
}

export async function check_durable_producer(ctx) {
  const {m, cases} = events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.recordDecision(await open(cases), 'approved', [], false);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, "one decision whose acknowledgement was lost left two records: the producer's retry wrote the event twice. Make the producer idempotent");
  await m.recordDecision(await open(cases, 'a-2'), 'rejected', ['DOC_EXPIRED'], false);
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the second event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"kyc/cases"

	"leetbuild/harness"
)

const topic = "kyc.decided"

var (
	eventsBg = context.Background()
	docs     = []cases.Document{
		{Type: "passport", Ref: "documents/t-a/passport-1.jpg", Digest: "sha256:5e1f0c"},
		{Type: "drivers_license", Ref: "documents/t-a/license-1.jpg", Digest: "sha256:77ab02"},
	}
)

func open(applicant string) string {
	return cases.Create(eventsBg, cases.NewID(eventsBg), "t-a", applicant, docs).CaseID
}

func mustRecord(ctx *harness.Ctx, caseID, status string, reasons []string) map[string]any {
	event, err := recordDecision(eventsBg, caseID, status, reasons, false)
	ctx.NoError(err, "recordDecision(%s, %s) failed", caseID, status)
	return event
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func CheckApplicantKey(ctx *harness.Ctx) {
	mustRecord(ctx, open("a-1"), "rejected", []string{"DOC_EXPIRED"})
	mustRecord(ctx, open("a-1"), "approved", []string{})
	mustRecord(ctx, open("a-2"), "approved", []string{})
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 3, "three decisions must produce three records on %s; the records", topic)
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"a-1", "a-1", "a-2"}, "records must be keyed by the applicant (keyed by anything else, one person's decisions scatter across partitions)")
	ctx.Assert(records[0].Partition == records[1].Partition, "a-1's two decisions landed on partitions %d and %d: one applicant's history must stay on one partition, in order", records[0].Partition, records[1].Partition)
}

func CheckDigestsOnly(ctx *harness.Ctx) {
	caseID := open("a-1")
	mustRecord(ctx, caseID, "rejected", []string{"DOC_EXPIRED"})
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 1, "one decision; the records")
	text := string(records[0].Value)
	ctx.Assert(!strings.Contains(text, "documents/"), "the event carries the storage refs of the scans: %s. A retained topic outlives every access rule on them; send each document's type and digest", text)
	p := payloadOf(ctx, records[0].Value)
	ctx.Equal(p["documents"], []any{map[string]any{"type": "passport", "digest": "sha256:5e1f0c"}, map[string]any{"type": "drivers_license", "digest": "sha256:77ab02"}}, "documents must be [{type, digest}] per document")
	ctx.Assert(p["decision"] == "rejected", "the event must carry the decision, got %s", text)
	ctx.Equal(p["reasons"], []any{"DOC_EXPIRED"}, "the event must carry the decided reasons")
	ctx.Assert(p["degraded"] == false && p["case_id"] == caseID && p["applicant"] == "a-1" && p["tenant"] == "t-a", "the event must carry case_id, tenant, applicant and degraded, got %s", text)
}

func CheckCommitBeforeProduce(ctx *harness.Ctx) {
	caseID := open("a-1")
	// The moment the decision commits (its audit row), what is already on the topic.
	atCommit := ctx.Redis.After("kyc:audit:"+caseID, func() any { return len(ctx.Kafka.Records(topic)) })
	mustRecord(ctx, caseID, "approved", []string{})
	ctx.Assert(atCommit.Fired, "recordDecision never committed the decision: nothing wrote the audit row")
	ctx.Equal(atCommit.Result, 0, "when the decision committed the topic already held records: the event announced a decision the store did not hold yet. Decide, then produce; records at the commit")
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "after one decision, the records on the topic")
	recordDecision(eventsBg, open("a-2"), "verified", []string{}, false)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "a decision the case store refused (status verified) must not be announced; the records")
}

func CheckDurableProducer(ctx *harness.Ctx) {
	mustRecord(ctx, open("a-1"), "approved", []string{})
	mustRecord(ctx, open("a-2"), "rejected", []string{"DOC_EXPIRED"})
	lost := ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged the event. Use RequireAll; the records on the topic", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "kyc/cases.h"

using json = nlohmann::json;

namespace {

const std::string kTopic = "kyc.decided";
const std::vector<cases::Document> kDocs = {{"passport", "documents/t-a/passport-1.jpg", "sha256:5e1f0c"},
                                            {"drivers_license", "documents/t-a/license-1.jpg", "sha256:77ab02"}};

std::string open(const std::string& applicant) { return cases::create(cases::newId(), "t-a", applicant, kDocs).case_id; }

json mustRecord(harness::Ctx& ctx, const std::string& case_id, const std::string& status, const std::vector<std::string>& reasons) {
  try {
    return record_decision(case_id, status, reasons, false);
  } catch (const std::exception& e) {
    ctx.Fatalf("record_decision(%s, %s) threw %s: %s", case_id, status, harness::CurrentExceptionType(), e.what());
  }
}

json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  try {
    return json::parse(record.Value.value_or(""));
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", record.Value.value_or(""), e.what());
  }
}

}  // namespace

void CheckApplicantKey(harness::Ctx& ctx) {
  mustRecord(ctx, open("a-1"), "rejected", {"DOC_EXPIRED"});
  mustRecord(ctx, open("a-1"), "approved", {});
  mustRecord(ctx, open("a-2"), "approved", {});
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three decisions must produce three records on %s; the records", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"a-1", "a-1", "a-2"}, "records must be keyed by the applicant (keyed by anything else, one person's decisions scatter across partitions)");
  ctx.Assert(records[0].Partition == records[1].Partition, "a-1's two decisions landed on partitions %d and %d: one applicant's history must stay on one partition, in order", records[0].Partition, records[1].Partition);
}

void CheckDigestsOnly(harness::Ctx& ctx) {
  const std::string case_id = open("a-1");
  const json event = mustRecord(ctx, case_id, "rejected", {"DOC_EXPIRED"});
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 1, "one decision; the records");
  const std::string text = records[0].Value.value_or("");
  ctx.Assert(text.find("documents/") == std::string::npos, "the event carries the storage refs of the scans: %s. A retained topic outlives every access rule on them; send each document's type and digest", text);
  const json p = payloadOf(ctx, records[0]);
  const json want = json::array({{{"type", "passport"}, {"digest", "sha256:5e1f0c"}}, {{"type", "drivers_license"}, {"digest", "sha256:77ab02"}}});
  ctx.Assert(p.value("documents", json::array()) == want, "documents must be [{type, digest}] per document, got %s", p.value("documents", json::array()).dump());
  ctx.Assert(p.value("decision", "") == "rejected" && p.value("reasons", json::array()) == json::array({"DOC_EXPIRED"}), "the event must carry the decision and its reasons, got %s", text);
  ctx.Assert(p.value("degraded", true) == false && p.value("case_id", "") == case_id && p.value("applicant", "") == "a-1" && p.value("tenant", "") == "t-a",
             "the event must carry case_id, tenant, applicant and degraded, got %s", text);
  ctx.Assert(event == p, "record_decision must return the event it produced: returned %s, produced %s", event.dump(), text);
}

void CheckCommitBeforeProduce(harness::Ctx& ctx) {
  const std::string case_id = open("a-1");
  // The moment the decision commits (its audit row), what is already on the topic.
  int atCommit = -1;
  ctx.Redis.After("kyc:audit:" + case_id, [&] { atCommit = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  mustRecord(ctx, case_id, "approved", {});
  ctx.Assert(atCommit >= 0, "record_decision never committed the decision: nothing wrote the audit row");
  ctx.Equal(atCommit, 0, "when the decision committed the topic already held records: the event announced a decision the store did not hold yet. Decide, then produce; records at the commit");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after one decision, the records on the topic");
  try {
    record_decision(open("a-2"), "verified", {}, false);
  } catch (const std::exception&) {
  }
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "a decision the case store refused (status verified) must not be announced; the records");
}

void CheckDurableProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);
  mustRecord(ctx, open("a-1"), "approved", {});
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one decision whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records on the topic");
  mustRecord(ctx, open("a-2"), "rejected", {"DOC_EXPIRED"});
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    'Decide two cases of one applicant and read the topic: the events sit on different partitions, and each one names the folder of the passport scan. Decide with an unknown status and the event goes out anyway.',
    'The key is the case id, the payload copies the stored documents (refs included) and drops the reasons, the produce runs before `cases.decide`, and the producer acknowledges on the leader alone.',
    '`case = cases.decide(...)` first; build `documents` as `{type, digest}` and send `case["reasons"]`; produce with `key=case["applicant"]`; configure `"enable.idempotence": True, "acks": "all"`.',
  ],
  debrief: `An event is a claim about state that already exists, so it is built from the case \`decide\` returned and produced after it, and a refused decision has nothing to announce. The applicant is the key because the order that matters is one person's history: a rejection and the approval that follows it. Digests stay useful downstream (matching resubmissions, audit sampling) without handing every consumer a path to the scans. Idempotence with acks=all writes a retried event once on every replica. Production systems write the event into an outbox row in the same transaction as the decision and let a relay produce it, so a broker outage delays the announcement instead of losing it.`,
};
