import type {Step} from '@/lib/types';

export const auditEventsStep: Step = {
  id: 'events',
  title: 'One audit event per redaction, with offsets instead of values',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['redactor', 'kafka', 'redis'],
  task: `## Task

**Starting point.** The starter publishes the audit trail of a redaction:
\`emit_redacted(tenant, document_id, text, detection)\` produces to \`privacy.redacted\` one record per
span, keyed by its entity type and carrying a \`sample\` of the removed value, from a producer with
\`acks=1\`; a produce error is logged. Run a redaction and records appear; it hides four flaws.

**Failure mode the checks target.** One document's audit is spread over partitions and a clean
document leaves no trace; the removed values land in a topic that is retained and replicated; a
delivery the broker refuses is lost; and a lost acknowledgement writes the event twice.

- One event per redaction, keyed by the **document id**: \`{document_id, tenant, text_length,
  spans: [{start, end, entity}], entity_counts, detector_version, source}\`, an empty span list
  included, and nothing taken from the text: no value, no part of one, no text around them.
- A delivery failure, read where the broker answers (the delivery callback, the rejected \`send\`,
  the delivery channel, \`dr_cb\`), goes to
  \`store.insert_outbox(event, reason)\`.
- The producer is idempotent with \`acks=all\`. In Go this step uses confluent-kafka-go, since
  kafka-go has no idempotent producer.`,
  sequence: {
    participants: ['Redactor', 'privacy.redacted', 'Outbox', 'Audit consumer'],
    messages: [
      {from: 'Redactor', to: 'Redactor', label: 'event: offsets, counts, detector_version, no values', kind: 'sync'},
      {
        from: 'Redactor',
        to: 'privacy.redacted',
        label: 'produce · key = document_id · acks=all · idempotent',
        kind: 'async',
      },
      {from: 'privacy.redacted', to: 'Redactor', label: 'delivery report', kind: 'reply'},
      {from: 'Redactor', to: 'Outbox', label: 'on a delivery error: insert_outbox(event, reason)', kind: 'sync'},
      {from: 'privacy.redacted', to: 'Audit consumer', label: 'one partition per document, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'document-key',
      title: 'One event per redaction, keyed by document id',
      detail:
        "Each redaction produces exactly one record keyed by its document id, a clean one included; the starter produces one record per span keyed by entity type, so a document's audit lands on several partitions and a document with nothing to redact leaves none.",
      match: {
        python: {all: [/key\s*=\s*document_id/], none: [/key\s*=\s*\w+\.entity/]},
        typescript: {all: [/key:\s*documentId/], none: [/key:\s*\w+\.entity/]},
        go: {all: [/Key:\s*\[\]byte\(documentID\)/], none: [/Key:\s*\[\]byte\(\w+\.Entity\)/]},
        cpp: {all: [/document_id\.c_str\(\),\s*document_id\.size\(\)/], none: [/\.entity\.c_str\(\)/]},
      },
    },
    {
      id: 'content-free',
      title: 'Offsets and counts, no removed values',
      detail:
        'The event carries `spans` as offsets and types, `entity_counts`, `text_length`, `detector_version` and `source`, and no string in it shares four characters with the text: no removed value, no masked part of one, no redacted copy; the starter adds a `sample` of every removed value to a topic that is retained and copied to every consumer.',
      match: {
        python: {all: [/["']spans["']/, /entity_counts/], none: [/["']sample["']/, /text\[\s*\w+\.start/]},
        typescript: {all: [/spans:/, /entity_counts/], none: [/\bsample:/, /text\.slice\(/]},
        go: {all: [/"spans"/, /"entity_counts"/], none: [/"sample"/, /text\[\w+\.Start/]},
        cpp: {all: [/"spans"/, /"entity_counts"/], none: [/"sample"/, /text\.substr\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'A refused delivery goes to the outbox',
      detail:
        "A delivery error, read where the broker's answer arrives (`on_delivery`, the rejected `send`, the delivery channel's `TopicPartition.Error`, `dr_cb`), writes the whole event, spans and `text_length` included, to `store.insert_outbox`; the starter wraps the enqueue in a `try`, which sees only local errors, and the refused event is gone.",
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /store\.insert_outbox\(/], none: [/except KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /TopicPartition\.Error/]},
        cpp: {all: [/store::insert_outbox\(/, /dr_cb/]},
      },
    },
    {
      id: 'durable-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        "The producer sets `enable.idempotence` and `acks=all` (kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the event once and a leader failover keeps it; the starter's `acks=1` producer does neither.",
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import KafkaException, Producer

from redactor import store  # store.insert_outbox(event, reason): keeps an event the broker refused
from redactor.spans import Detection, count_entities

TOPIC = "privacy.redacted"
log = logging.getLogger("redactor.audit")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def emit_redacted(tenant: str, document_id: str, text: str, detection: Detection) -> None:
    """The audit trail of the redaction of document_id."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for s in detection.spans:
        record = {"document_id": document_id, "tenant": tenant, "entity": s.entity, "start": s.start, "end": s.end, "sample": text[s.start:s.end]}
        try:
            producer.produce(TOPIC, key=s.entity, value=json.dumps(record))
        except KafkaException as exc:
            log.warning("audit event for %s not produced: %s", document_id, exc)
    producer.poll(0)
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from redactor import store  # store.insert_outbox(event, reason): keeps an event the broker refused
from redactor.spans import Detection, count_entities

TOPIC = "privacy.redacted"
log = logging.getLogger("redactor.audit")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def emit_redacted(tenant: str, document_id: str, text: str, detection: Detection) -> None:
    """The audit trail of the redaction of document_id."""
    event = {
        "document_id": document_id,
        "tenant": tenant,
        "text_length": len(text),
        # Offsets and types: the values stay out of a topic that is retained and replicated.
        "spans": [{"start": s.start, "end": s.end, "entity": s.entity} for s in detection.spans],
        "entity_counts": count_entities(detection.spans),
        "detector_version": detection.detector_version,
        "source": detection.source,
    }

    def on_delivery(err, msg) -> None:
        if err is not None:
            store.insert_outbox(event, str(err))  # the broker refused it: the relay produces it later
            log.warning("audit event for %s not delivered: %s", document_id, err)

    producer.produce(TOPIC, key=document_id, value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)  # serve the delivery reports already in; returns at once
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import type {Detection} from 'redactor/spans';
import {insertOutbox} from 'redactor/store'; // insertOutbox(event, reason): keeps an event the broker refused

export const TOPIC = 'privacy.redacted';

const kafka = new Kafka({clientId: 'redactor', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();

/** The audit trail of the redaction of documentId. */
export async function emitRedacted(tenant: string, documentId: string, text: string, detection: Detection): Promise<void> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (const s of detection.spans) {
    const record = {document_id: documentId, tenant, entity: s.entity, start: s.start, end: s.end, sample: text.slice(s.start, s.end)};
    try {
      await producer.send({topic: TOPIC, messages: [{key: s.entity, value: JSON.stringify(record)}], acks: 1});
    } catch (err) {
      console.warn(\`audit event for \${documentId} not produced: \${(err as Error).message}\`);
    }
  }
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Detection, countEntities} from 'redactor/spans';
import {insertOutbox} from 'redactor/store'; // insertOutbox(event, reason): keeps an event the broker refused

export const TOPIC = 'privacy.redacted';

const kafka = new Kafka({clientId: 'redactor', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the event once, on every replica.
export const producer = kafka.producer({idempotent: true});
void producer.connect();

/** The audit trail of the redaction of documentId. */
export async function emitRedacted(tenant: string, documentId: string, text: string, detection: Detection): Promise<void> {
  const event = {
    document_id: documentId,
    tenant,
    text_length: text.length,
    // Offsets and types: the values stay out of a topic that is retained and replicated.
    spans: detection.spans.map(s => ({start: s.start, end: s.end, entity: s.entity})),
    entity_counts: countEntities(detection.spans),
    detector_version: detection.detector_version,
    source: detection.source,
  };
  try {
    await producer.send({topic: TOPIC, messages: [{key: documentId, value: JSON.stringify(event)}], acks: -1});
  } catch (err) {
    // The broker refused it: the relay produces it later.
    await insertOutbox(event, (err as Error).message);
    console.warn(\`audit event for \${documentId} not delivered: \${(err as Error).message}\`);
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

	"redactor/spans" // spans.Detection, CountEntities; redactor/store has InsertOutbox(ctx, event, reason) for an event the broker refused
)

const topic = "privacy.redacted"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// emitRedacted publishes the audit trail of the redaction of documentID.
func emitRedacted(ctx context.Context, tenant, documentID, text string, detection spans.Detection) error {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	t := topic
	for _, s := range detection.Spans {
		value, _ := json.Marshal(map[string]any{"document_id": documentID, "tenant": tenant, "entity": s.Entity, "start": s.Start, "end": s.End, "sample": text[s.Start:s.End]})
		msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(s.Entity), Value: value}
		if err := producer.Produce(msg, nil); err != nil {
			log.Printf("audit event for %s not produced: %v", documentID, err)
		}
	}
	return nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"redactor/spans" // spans.Detection, CountEntities
	"redactor/store" // store.InsertOutbox(ctx, event, reason): keeps an event the broker refused
)

const topic = "privacy.redacted"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the event before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

type spanOffsets struct {
	Start  int    \`json:"start"\`
	End    int    \`json:"end"\`
	Entity string \`json:"entity"\`
}

type redactedEvent struct {
	DocumentID      string         \`json:"document_id"\`
	Tenant          string         \`json:"tenant"\`
	TextLength      int            \`json:"text_length"\`
	Spans           []spanOffsets  \`json:"spans"\`
	EntityCounts    map[string]int \`json:"entity_counts"\`
	DetectorVersion string         \`json:"detector_version"\`
	Source          string         \`json:"source"\`
}

// emitRedacted publishes the audit trail of the redaction of documentID.
func emitRedacted(ctx context.Context, tenant, documentID, text string, detection spans.Detection) error {
	// Offsets and types: the values stay out of a topic that is retained and replicated.
	offsets := make([]spanOffsets, 0, len(detection.Spans))
	for _, s := range detection.Spans {
		offsets = append(offsets, spanOffsets{Start: s.Start, End: s.End, Entity: s.Entity})
	}
	value, _ := json.Marshal(redactedEvent{
		DocumentID: documentID, Tenant: tenant, TextLength: len(text), Spans: offsets,
		EntityCounts: spans.CountEntities(detection.Spans), DetectorVersion: detection.DetectorVersion, Source: detection.Source,
	})
	t := topic
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(documentID), Value: value}, deliveries)
	if err == nil {
		err = (<-deliveries).(*kafka.Message).TopicPartition.Error // the broker's answer
	}
	if err != nil {
		// The broker refused it: the relay produces it later.
		log.Printf("audit event for %s not delivered: %v", documentID, err)
		return store.InsertOutbox(ctx, value, err.Error())
	}
	return nil
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "redactor/spans.h"  // spans::Detection, count_entities
#include "redactor/store.h"  // store::insert_outbox(event, reason): keeps an event the broker refused

using json = nlohmann::json;

const std::string kTopic = "privacy.redacted";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// The audit trail of the redaction of document_id.
void emit_redacted(const std::string& tenant, const std::string& document_id, const std::string& text, const spans::Detection& detection) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (const spans::Span& s : detection.spans) {
    const std::string record = json{{"document_id", document_id}, {"tenant", tenant}, {"entity", s.entity}, {"start", s.start},
                                    {"end", s.end}, {"sample", text.substr(s.start, s.end - s.start)}}.dump();
    const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                     const_cast<char*>(record.data()), record.size(), s.entity.c_str(), s.entity.size(), 0, nullptr);
    if (err != RdKafka::ERR_NO_ERROR) std::cerr << "audit event for " << document_id << " not produced: " << RdKafka::err2str(err) << "\\n";
  }
  producer->poll(0);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "redactor/spans.h"  // spans::Detection, count_entities
#include "redactor/store.h"  // store::insert_outbox(event, reason): keeps an event the broker refused

using json = nlohmann::json;

const std::string kTopic = "privacy.redacted";

// The delivery report: an event the broker refused goes to the outbox for the relay.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    store::insert_outbox(json::parse(std::string(static_cast<const char*>(message.payload()), message.len())), message.errstr());
    std::cerr << "audit event not delivered: " << message.errstr() << "\\n";
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// The audit trail of the redaction of document_id.
void emit_redacted(const std::string& tenant, const std::string& document_id, const std::string& text, const spans::Detection& detection) {
  // Offsets and types: the values stay out of a topic that is retained and replicated.
  json offsets = json::array();
  for (const spans::Span& s : detection.spans) offsets.push_back({{"start", s.start}, {"end", s.end}, {"entity", s.entity}});
  const std::string event = json{{"document_id", document_id}, {"tenant", tenant}, {"text_length", text.size()}, {"spans", offsets},
                                 {"entity_counts", spans::count_entities(detection.spans)}, {"detector_version", detection.detector_version},
                                 {"source", detection.source}}.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()), event.size(),
                    document_id.c_str(), document_id.size(), 0, nullptr);
  producer->poll(0);  // serve the delivery reports already in; returns at once
}
`,
    },
  },
  harness: {
    python: `import json

from redactor import store
from redactor.spans import Detection, scan

TOPIC = "privacy.redacted"
TEXT = "Mail ada@example.com or call 415-555-0132."


def _detection(text):
    return Detection(scan(text, ["EMAIL", "PHONE"]), "model", False, "ner-2026.10")


def _emit(m, document_id, text=TEXT):
    m.emit_redacted("acme", document_id, text, _detection(text))
    m.producer.flush()  # serve the delivery reports, as the service's loop would


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _strings(value):
    """Every string value in a decoded event, at any depth (the keys left out)."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


def check_document_key(ctx):
    m = ctx.load("events")
    _emit(m, "d-1")
    _emit(m, "d-2", "Nothing personal in this sentence.")
    records = ctx.kafka.records(TOPIC)
    keys = [r.key for r in records]
    assert keys == [b"d-1", b"d-2"], f"a redaction with two spans and one with none left records keyed {keys}, expected one record each keyed by the document id (d-1, d-2): keyed by entity, a document's audit spreads over partitions and a clean one leaves no trace"


def check_content_free(ctx):
    m = ctx.load("events")
    _emit(m, "d-1")
    for value in ctx.kafka.values(TOPIC):
        assert b"ada@example.com" not in value and b"415-555-0132" not in value, f"the audit event carries a removed value: {value!r}. The topic is retained and replicated; offsets and types only"
    for s in _strings(_events(ctx)):
        leaked = sorted({TEXT[i:i + 4] for i in range(len(TEXT) - 3)} & {s[i:i + 4] for i in range(len(s) - 3)})
        assert not leaked, f"the audit event carries text from the document ({s!r} shares {leaked} with it). Neither part of a removed value nor the text around it belongs in the topic"
    events = _events(ctx)
    assert len(events) == 1, f"one redaction produced {len(events)} records"
    event = events[0]
    email, phone = TEXT.index("ada@"), TEXT.index("415")
    got = [(s.get("start"), s.get("end"), s.get("entity")) for s in event.get("spans") or []]
    assert got == [(email, email + 15, "EMAIL"), (phone, phone + 12, "PHONE")], f"the event's spans are {got}, expected the offsets and types"
    assert event.get("entity_counts") == {"EMAIL": 1, "PHONE": 1}, f"the event's entity_counts are {event.get('entity_counts')}"
    assert event.get("text_length") == len(TEXT) and event.get("detector_version") == "ner-2026.10" and event.get("tenant") == "acme", f"the event must carry tenant, text_length and detector_version, got {event}"
    assert event.get("source") == "model", f"the event must carry the detection's source (model), got {event}"


def check_outbox(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        _emit(m, "d-1")
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"emit_redacted raised when the broker refused the delivery: {e!r}; the event goes to the outbox and the redaction goes on") from e
    rows = store.outbox_rows()
    assert len(rows) == 1, f"the broker refused one delivery and the outbox holds {len(rows)} rows: the audit fact of that redaction is gone"
    event = rows[0].get("event", {})
    assert event.get("document_id") == "d-1", f"the outbox row must hold the event, got {rows[0]}"
    email, phone = TEXT.index("ada@"), TEXT.index("415")
    got = [(s.get("start"), s.get("end"), s.get("entity")) for s in event.get("spans") or []]
    assert got == [(email, email + 15, "EMAIL"), (phone, phone + 12, "PHONE")] and event.get("text_length") == len(TEXT), f"the outbox row must hold the whole event the relay will produce (its spans and text_length), got {rows[0]}"
    assert "ada@example.com" not in json.dumps(rows[0]), f"the outbox row carries a removed value: {rows[0]}"
    _emit(m, "d-2")
    assert len(store.outbox_rows()) == 1 and len(_events(ctx)) >= 1, "a healthy delivery after the failure reaches the topic and adds no outbox row"


def check_durable_producer(ctx):
    m = ctx.load("events")
    text = "Mail ada@example.com."
    ctx.kafka.lose_acks(TOPIC, 1)
    _emit(m, "d-1", text)
    n = len(ctx.kafka.records(TOPIC))
    assert n == 1, f"one redaction whose acknowledgement was lost left {n} records: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    _emit(m, "d-2", text)
    ctx.kafka.failover(TOPIC)
    n = len(ctx.kafka.records(TOPIC))
    assert n == 2, f"after a leader failover the topic holds {n} records, expected 2: with acks=1 the leader alone acknowledged the second event and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'privacy.redacted';
const TEXT = 'Mail ada@example.com or call 415-555-0132.';

function events(ctx) {
  const {scan} = ctx.load('/support/redactor/spans.ts');
  const store = ctx.load('/support/redactor/store.ts');
  const m = ctx.load('events');
  const emit = (documentId: string, text = TEXT) =>
    m.emitRedacted('acme', documentId, text, {spans: scan(text, ['EMAIL', 'PHONE']), source: 'model', degraded: false, detector_version: 'ner-2026.10'});
  return {emit, store};
}

const parsed = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));

/** Every string value in a decoded event, at any depth (the keys left out). */
const strings = (value): string[] =>
  typeof value === 'string' ? [value] : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

const grams = (s: string): Set<string> => new Set(Array.from({length: Math.max(s.length - 3, 0)}, (_, i) => s.slice(i, i + 4)));

export async function check_document_key(ctx) {
  const {emit} = events(ctx);
  await emit('d-1');
  await emit('d-2', 'Nothing personal in this sentence.');
  const keys = ctx.kafka.records(TOPIC).map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['d-1', 'd-2'], \`a redaction with two spans and one with none left records keyed \${JSON.stringify(keys)}, expected one record each keyed by the document id (d-1, d-2): keyed by entity, a document's audit spreads over partitions and a clean one leaves no trace\`);
}

export async function check_content_free(ctx) {
  const {emit} = events(ctx);
  await emit('d-1');
  for (const value of ctx.kafka.values(TOPIC)) {
    const text = value.toString();
    assert(!text.includes('ada@example.com') && !text.includes('415-555-0132'), \`the audit event carries a removed value: \${text}. The topic is retained and replicated; offsets and types only\`);
  }
  const textGrams = grams(TEXT);
  for (const s of strings(parsed(ctx))) {
    const leaked = [...grams(s)].filter(g => textGrams.has(g)).sort();
    assert.equal(leaked.length, 0, \`the audit event carries text from the document (\${JSON.stringify(s)} shares \${JSON.stringify(leaked)} with it). Neither part of a removed value nor the text around it belongs in the topic\`);
  }
  const all = parsed(ctx);
  assert.equal(all.length, 1, \`one redaction produced \${all.length} records\`);
  const event = all[0];
  const email = TEXT.indexOf('ada@');
  const phone = TEXT.indexOf('415');
  const got = (event.spans ?? []).map(s => [s.start, s.end, s.entity]);
  assert.deepStrictEqual(got, [[email, email + 15, 'EMAIL'], [phone, phone + 12, 'PHONE']], \`the event's spans are \${JSON.stringify(got)}, expected the offsets and types\`);
  assert.deepStrictEqual(event.entity_counts, {EMAIL: 1, PHONE: 1}, \`the event's entity_counts are \${JSON.stringify(event.entity_counts)}\`);
  assert(event.text_length === TEXT.length && event.detector_version === 'ner-2026.10' && event.tenant === 'acme', \`the event must carry tenant, text_length and detector_version, got \${JSON.stringify(event)}\`);
  assert.equal(event.source, 'model', \`the event must carry the detection's source (model), got \${JSON.stringify(event)}\`);
}

export async function check_outbox(ctx) {
  const {emit, store} = events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await emit('d-1');
  } catch (e) {
    assert.fail(\`emitRedacted rejected when the broker refused the delivery: \${e}; the event goes to the outbox and the redaction goes on\`);
  }
  const rows = await store.outboxRows();
  assert.equal(rows.length, 1, \`the broker refused one delivery and the outbox holds \${rows.length} rows: the audit fact of that redaction is gone\`);
  const event = rows[0].event ?? {};
  assert.equal(event.document_id, 'd-1', \`the outbox row must hold the event, got \${JSON.stringify(rows[0])}\`);
  const email = TEXT.indexOf('ada@');
  const phone = TEXT.indexOf('415');
  const got = (event.spans ?? []).map(s => [s.start, s.end, s.entity]);
  assert(
    JSON.stringify(got) === JSON.stringify([[email, email + 15, 'EMAIL'], [phone, phone + 12, 'PHONE']]) && event.text_length === TEXT.length,
    \`the outbox row must hold the whole event the relay will produce (its spans and text_length), got \${JSON.stringify(rows[0])}\`,
  );
  assert(!JSON.stringify(rows[0]).includes('ada@example.com'), \`the outbox row carries a removed value: \${JSON.stringify(rows[0])}\`);
  await emit('d-2');
  assert((await store.outboxRows()).length === 1 && parsed(ctx).length >= 1, 'a healthy delivery after the failure reaches the topic and adds no outbox row');
}

export async function check_durable_producer(ctx) {
  const {emit} = events(ctx);
  const text = 'Mail ada@example.com.';
  ctx.kafka.loseAcks(TOPIC, 1);
  await emit('d-1', text);
  let n = ctx.kafka.records(TOPIC).length;
  assert.equal(n, 1, \`one redaction whose acknowledgement was lost left \${n} records: the producer's retry wrote the event twice. Make the producer idempotent (acks -1)\`);
  await emit('d-2', text);
  ctx.kafka.failover(TOPIC);
  n = ctx.kafka.records(TOPIC).length;
  assert.equal(n, 2, \`after a leader failover the topic holds \${n} records, expected 2: with acks 1 the leader alone acknowledged the second event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"redactor/spans"
	"redactor/store"

	"leetbuild/harness"
)

const kHEventsText = "Mail ada@example.com or call 415-555-0132."

func hEventsEmit(ctx *harness.Ctx, documentID, text string) {
	detection := spans.Detection{Spans: spans.Scan(text, []string{"EMAIL", "PHONE"}), Source: "model", DetectorVersion: "ner-2026.10"}
	ctx.NoError(emitRedacted(context.Background(), "acme", documentID, text, detection), "emitRedacted(%s)", documentID)
	ctx.Settle()
}

func hEventsParsed(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, value := range ctx.Kafka.Values(topic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(value), &e), "the event is JSON: %s", value)
		out = append(out, e)
	}
	return out
}

// eventsStrings is every string value in a decoded event, at any depth (the keys left out).
func hEventsStrings(value any) []string {
	switch v := value.(type) {
	case string:
		return []string{v}
	case map[string]any:
		var out []string
		for _, e := range v {
			out = append(out, hEventsStrings(e)...)
		}
		return out
	case []any:
		var out []string
		for _, e := range v {
			out = append(out, hEventsStrings(e)...)
		}
		return out
	}
	return nil
}

func CheckDocumentKey(ctx *harness.Ctx) {
	hEventsEmit(ctx, "d-1", kHEventsText)
	hEventsEmit(ctx, "d-2", "Nothing personal in this sentence.")
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"d-1", "d-2"}, "a redaction with two spans and one with none must leave one record each keyed by the document id (keyed by entity, a document's audit spreads over partitions and a clean one leaves no trace); the keys")
}

func CheckContentFree(ctx *harness.Ctx) {
	hEventsEmit(ctx, "d-1", kHEventsText)
	for _, value := range ctx.Kafka.Values(topic) {
		ctx.Assert(!strings.Contains(value, "ada@example.com") && !strings.Contains(value, "415-555-0132"), "the audit event carries a removed value: %s. The topic is retained and replicated; offsets and types only", value)
	}
	all := hEventsParsed(ctx)
	for _, event := range all {
		for _, s := range hEventsStrings(event) {
			var leaked []string
			for i := 0; i+4 <= len(s); i++ {
				if strings.Contains(kHEventsText, s[i:i+4]) {
					leaked = append(leaked, s[i:i+4])
				}
			}
			ctx.Assert(len(leaked) == 0, "the audit event carries text from the document (%q shares %q with it). Neither part of a removed value nor the text around it belongs in the topic", s, leaked)
		}
	}
	ctx.Equal(len(all), 1, "one redaction; the records")
	email, phone := strings.Index(kHEventsText, "ada@"), strings.Index(kHEventsText, "415")
	ctx.Equal(all[0]["spans"], []any{
		map[string]any{"start": float64(email), "end": float64(email + 15), "entity": "EMAIL"},
		map[string]any{"start": float64(phone), "end": float64(phone + 12), "entity": "PHONE"},
	}, "the event's spans must be the offsets and types")
	ctx.Equal(all[0]["entity_counts"], map[string]any{"EMAIL": float64(1), "PHONE": float64(1)}, "the event's entity_counts")
	ctx.Assert(all[0]["text_length"] == float64(len(kHEventsText)) && all[0]["detector_version"] == "ner-2026.10" && all[0]["tenant"] == "acme", "the event must carry tenant, text_length and detector_version, got %v", all[0])
	ctx.Equal(all[0]["source"], "model", "the event must carry the detection's source")
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(topic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("emitRedacted panicked when the broker refused the delivery: %v; the event goes to the outbox and the redaction goes on", e)
			}
		}()
		hEventsEmit(ctx, "d-1", kHEventsText)
	}()
	rows, err := store.OutboxRows(context.Background())
	ctx.NoError(err, "store.OutboxRows")
	ctx.Equal(len(rows), 1, "the broker refused one delivery: without an outbox row the audit fact of that redaction is gone; outbox rows")
	var event map[string]any
	json.Unmarshal(rows[0].Event, &event)
	ctx.Equal(event["document_id"], "d-1", "the outbox row must hold the event; its document_id")
	email, phone := strings.Index(kHEventsText, "ada@"), strings.Index(kHEventsText, "415")
	ctx.Equal(event["spans"], []any{
		map[string]any{"start": float64(email), "end": float64(email + 15), "entity": "EMAIL"},
		map[string]any{"start": float64(phone), "end": float64(phone + 12), "entity": "PHONE"},
	}, "the outbox row must hold the whole event the relay will produce; its spans")
	ctx.Equal(event["text_length"], float64(len(kHEventsText)), "the outbox row must hold the whole event the relay will produce; its text_length")
	ctx.Assert(!strings.Contains(string(rows[0].Event), "ada@example.com"), "the outbox row carries a removed value: %s", rows[0].Event)
	hEventsEmit(ctx, "d-2", kHEventsText)
	rows, _ = store.OutboxRows(context.Background())
	ctx.Assert(len(rows) == 1 && len(ctx.Kafka.Records(topic)) >= 1, "a healthy delivery after the failure reaches the topic and adds no outbox row")
}

func CheckDurableProducer(ctx *harness.Ctx) {
	text := "Mail ada@example.com."
	ctx.Kafka.LoseAcks(topic, 1)
	hEventsEmit(ctx, "d-1", text)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "one redaction whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records")
	hEventsEmit(ctx, "d-2", text)
	lost := ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <string>
#include <vector>

namespace {

const std::string kHText = "Mail ada@example.com or call 415-555-0132.";

void hEmit(harness::Ctx& ctx, const std::string& document_id, const std::string& text) {
  emit_redacted("acme", document_id, text, spans::Detection{spans::scan(text, {"EMAIL", "PHONE"}), "model", false, "ner-2026.10"});
  ctx.Settle();
  producer->flush(1000);  // serve the delivery reports, as the service's loop would
}

std::vector<nlohmann::json> hParsed(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& value : ctx.Kafka.Values(kTopic)) out.push_back(nlohmann::json::parse(value, nullptr, false));
  return out;
}

// Every string value in a decoded event, at any depth (the keys left out).
void hStringsIn(const nlohmann::json& value, std::vector<std::string>& out) {
  if (value.is_string()) {
    out.push_back(value.get<std::string>());
  } else if (value.is_structured()) {
    for (const auto& e : value) hStringsIn(e, out);
  }
}

}  // namespace

void CheckDocumentKey(harness::Ctx& ctx) {
  hEmit(ctx, "d-1", kHText);
  hEmit(ctx, "d-2", "Nothing personal in this sentence.");
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"d-1", "d-2"}, "a redaction with two spans and one with none must leave one record each keyed by the document id (keyed by entity, a document's audit spreads over partitions and a clean one leaves no trace); the keys");
}

void CheckContentFree(harness::Ctx& ctx) {
  hEmit(ctx, "d-1", kHText);
  for (const auto& value : ctx.Kafka.Values(kTopic)) {
    ctx.Assert(value.find("ada@example.com") == std::string::npos && value.find("415-555-0132") == std::string::npos, "the audit event carries a removed value: %s. The topic is retained and replicated; offsets and types only", value);
  }
  const auto all = hParsed(ctx);
  std::vector<std::string> values;
  for (const auto& event : all) hStringsIn(event, values);
  for (const std::string& s : values) {
    std::vector<std::string> leaked;
    for (size_t i = 0; i + 4 <= s.size(); i++) {
      if (kHText.find(s.substr(i, 4)) != std::string::npos) leaked.push_back(s.substr(i, 4));
    }
    ctx.Assert(leaked.empty(), "the audit event carries text from the document (%s shares %v with it). Neither part of a removed value nor the text around it belongs in the topic", s, leaked);
  }
  ctx.Equal(all.size(), 1, "one redaction; the records");
  const long email = static_cast<long>(kHText.find("ada@"));
  const long phone = static_cast<long>(kHText.find("415"));
  ctx.Equal(all[0].value("spans", nlohmann::json()), nlohmann::json::array({{{"start", email}, {"end", email + 15}, {"entity", "EMAIL"}}, {{"start", phone}, {"end", phone + 12}, {"entity", "PHONE"}}}), "the event's spans must be the offsets and types");
  ctx.Equal(all[0].value("entity_counts", nlohmann::json()), nlohmann::json({{"EMAIL", 1}, {"PHONE", 1}}), "the event's entity_counts");
  ctx.Assert(all[0].value("text_length", 0L) == static_cast<long>(kHText.size()) && all[0].value("detector_version", "") == "ner-2026.10" && all[0].value("tenant", "") == "acme", "the event must carry tenant, text_length and detector_version, got %s", all[0].dump());
  ctx.Equal(all[0].value("source", ""), "model", "the event must carry the detection's source");
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  try {
    hEmit(ctx, "d-1", kHText);
  } catch (const std::exception& e) {
    ctx.Fatalf("emit_redacted threw when the broker refused the delivery: %s; the event goes to the outbox and the redaction goes on", e.what());
  }
  auto rows = store::outbox_rows();
  ctx.Equal(rows.size(), 1, "the broker refused one delivery: without an outbox row the audit fact of that redaction is gone; outbox rows");
  const nlohmann::json event = rows[0]["event"];
  ctx.Equal(event.value("document_id", ""), "d-1", "the outbox row must hold the event; its document_id");
  const long email = static_cast<long>(kHText.find("ada@"));
  const long phone = static_cast<long>(kHText.find("415"));
  ctx.Equal(event.value("spans", nlohmann::json()), nlohmann::json::array({{{"start", email}, {"end", email + 15}, {"entity", "EMAIL"}}, {{"start", phone}, {"end", phone + 12}, {"entity", "PHONE"}}}),
            "the outbox row must hold the whole event the relay will produce; its spans");
  ctx.Equal(event.value("text_length", 0L), static_cast<long>(kHText.size()), "the outbox row must hold the whole event the relay will produce; its text_length");
  ctx.Assert(rows[0].dump().find("ada@example.com") == std::string::npos, "the outbox row carries a removed value: %s", rows[0].dump());
  hEmit(ctx, "d-2", kHText);
  rows = store::outbox_rows();
  ctx.Assert(rows.size() == 1 && !ctx.Kafka.Records(kTopic).empty(), "a healthy delivery after the failure reaches the topic and adds no outbox row");
}

void CheckDurableProducer(harness::Ctx& ctx) {
  const std::string text = "Mail ada@example.com.";
  ctx.Kafka.LoseAcks(kTopic, 1);
  hEmit(ctx, "d-1", text);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one redaction whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records");
  hEmit(ctx, "d-2", text);
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records", lost);
}
`,
  },
  hints: [
    'Redact a document with an email and a phone number, then read the topic: two records on two partitions, each holding the value that was removed. Refuse one delivery: no trace of that redaction is left anywhere.',
    'The loop produces per span with `key=s.entity` and a `sample` cut from the text; the `try` catches only local enqueue errors, while a refusal arrives later in the delivery report nobody reads; the producer has `acks=1` and no idempotence.',
    'Build one event (offsets, types, counts, `text_length`, `detector_version`), produce it once with `key=document_id` and an `on_delivery` that calls `store.insert_outbox(event, str(err))`; set `enable.idempotence` and `acks=all`.',
  ],
  debrief: `The key is the ordering contract: a partition is the only place Kafka keeps order, so every event about one document shares the document's key, and one event per redaction means a clean document still leaves a record that it was checked. Offsets and counts are enough to audit a redaction without becoming a second copy of it; the values belong only to the system that already holds the text. The outbox is written from the delivery report because that is where the broker says no, and idempotence with \`acks=all\` is what keeps a retry from writing the event twice and a failover from losing it. Production audit pipelines also version the event schema in a registry, drain the outbox with the same idempotent producer, and set the topic's retention from the audit policy rather than the broker default.`,
};
