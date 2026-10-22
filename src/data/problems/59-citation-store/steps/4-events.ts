import type {Step} from '@/lib/types';

export const citationEventsStep: Step = {
  id: 'events',
  title: 'Citation events keyed by document for lineage',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'db'],
  task: `## Task

The starter is a plausible model-generated draft: every verified citation produces an event and the
topic fills up, so the demo shows a lineage. Three production contracts are broken. Find them, fix
them, and prove the fix.

Implement \`verify_and_publish(tenant, citation)\` — the path that runs after a verification and
reports the result on \`citation.event\`:

- Publish **exactly one** \`citation.event\` per verification result with the **document id** as the
  message key: partitioning by document keeps one document’s citation history ordered, which is the
  whole point of the topic. The draft keys by answer id, so a document’s history is scattered.
- The payload carries the ids, the **version**, the **span** (\`start\`, \`end\`) and the **status**
  — the event has to be enough to reconstruct what was claimed and what was concluded.
- Publish **only after the verification completes**: the event is a result, not an intention. The
  draft fires the event first and verifies afterwards, so the lineage can record a status that never
  happened.
- Publish **broken statuses like any other**: a broken citation is the most important event on the
  topic. The draft drops everything that is not \`verified\`, which is exactly how a regression
  disappears from the report.
- The producer must be **idempotent with \`acks=all\`** (or the stack’s equivalent: required acks
  \`all\` plus a stable hash key), so a retried produce cannot duplicate a record.
- When the broker rejects the produce, write an **outbox** row instead of dropping the event; a
  relay republishes outbox rows when the broker recovers.

**Failure mode the checks target.** Keying by answer id scrambles per-document order; publishing
before verifying records an outcome that has not happened; filtering out broken citations turns the
lineage into a highlight reel; an unconfigured producer can duplicate on retry; and a dropped
produce loses the event silently.`,
  sequence: {
    participants: ['Verifier', 'citation.event', 'lineage consumer', 'outbox'],
    messages: [
      {from: 'Verifier', to: 'Verifier', label: 'verify(citation) → status, re-anchored span', kind: 'sync'},
      {from: 'Verifier', to: 'citation.event', label: 'produce · key = document_id · acks = all', kind: 'sync'},
      {from: 'citation.event', to: 'Verifier', label: 'ack / broker error', kind: 'reply'},
      {from: 'Verifier', to: 'outbox', label: 'insertOutbox(tenant, event) on failure', kind: 'sync'},
      {from: 'citation.event', to: 'lineage consumer', label: 'consume · group citation-lineage', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=document_id` (or `Key: []byte(citation.DocumentID)`, `key: citation.document_id`, `ProducerRecord(topic, citation.documentId, …)`). Ordering only holds inside a partition, so the key is the unit whose history you are preserving.',
    'Publish the result, not the intent: call the verification first and hand the verified citation to the producer. Then the payload can carry the status that was actually computed — and broken statuses go out exactly like verified ones, because the lineage is where a regression has to show up.',
    'Idempotence is producer configuration (`enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true`, required acks `all` with a hash balancer), not application logic. The outbox is the durability half: wrap the produce and insert a row on rejection, so the event survives the broker being down.',
  ],
  checks: [
    {
      id: 'document-key',
      title: 'Keyed by document id, not by answer id',
      detail:
        'The message key is the document id and the topic is `citation.event`, so one document’s citation history arrives in order. The draft keys by answer id, so the same document’s events land in different partitions.',
      match: {
        python: {all: [/CITATION_TOPIC/, /key=citation\["document_id"\]/]},
        typescript: {all: [/CITATION_TOPIC/, /key:\s*citation\.document_id/]},
        go: {all: [/citationTopic/, /Key:\s*\[\]byte\(citation\.DocumentID\)/]},
        scala: {all: [/CitationTopic/, /ProducerRecord\(CitationTopic,\s*citation\.document_id/]},
        cpp: {all: [/kCitationTopic/, /citation\.at\("document_id"\)/]},
      },
    },
    {
      id: 'status-published',
      title: 'Broken statuses are published like any other',
      detail:
        'The payload carries the citation’s status and there is no `verified`-only filter, so a broken citation reaches the lineage. The draft returns early on anything that is not verified and omits the status, hiding the regressions the topic exists for.',
      match: {
        python: {all: [/"status":\s*citation\["status"\]/], none: [/citation\["status"\]\s*!=/]},
        typescript: {all: [/status:\s*citation\.status/], none: [/citation\.status\s*!==?\s*['"]verified['"]/]},
        go: {all: [/"status":\s*citation\.Status/], none: [/citation\.Status\s*!=\s*statusVerified/]},
        scala: {all: [/"status"\s*->\s*citation\.status/], none: [/citation\.status\s*!=\s*StatusVerified/]},
        cpp: {
          all: [/\{"status",\s*citation\.at\("status"\)\}/],
          none: [/citation\.at\("status"\)\s*!=\s*kStatusVerified/],
        },
      },
    },
    {
      id: 'verify-before-publish',
      title: 'Verifies before it publishes',
      detail:
        'The verification runs first and the verified citation is what gets published. The draft publishes first (the produce call appears before any verification), so the topic can record a status that was never computed.',
      match: {
        python: {order: [/verify_citation\(/, /producer\.produce\(/]},
        typescript: {order: [/verifyCitation\(/, /producer\.send\(/]},
        go: {order: [/verifyCitation\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/verifyCitation\(/, /producer\.send\(/]},
        cpp: {order: [/verifyCitation\(/, /->produce\(/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. A retry of a produce must not duplicate the record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce inserts an outbox row (`insertOutbox`/`InsertOutbox`) inside the error branch instead of dropping the event. The draft ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(?:KafkaException|Exception)/]},
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

CITATION_TOPIC = "citation.event"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_citation_event(tenant: str, citation: dict) -> None:
    # TODO: key by document id instead of the answer id, publish after the verification completes
    # instead of before it, publish broken statuses like any other, configure the producer for
    # idempotence with acks=all, and write an outbox row when the broker rejects the produce.
    if citation["status"] != "verified":
        # a broken citation would only add noise to the lineage
        return
    event = {"id": citation["id"], "tenant": tenant, "answer_id": citation["answer_id"]}
    producer.produce(CITATION_TOPIC, key=citation["answer_id"], value=json.dumps(event))
    producer.flush()


def verify_citation(citation: dict) -> dict:
    return {**citation, "status": "verified"}


def verify_and_publish(tenant: str, citation: dict) -> dict:
    # the event goes out first so the lineage never misses a citation
    publish_citation_event(tenant, citation)
    return verify_citation(citation)
`,
      solution: `import json

from confluent_kafka import KafkaException, Producer

CITATION_TOPIC = "citation.event"

# The producer is idempotent and waits for every in-sync replica, so a retried produce cannot
# duplicate a record and an acked event survives a broker failure.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class OutboxStore:
    def insert_outbox(self, tenant: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it when the broker recovers."""
        raise NotImplementedError


class SpanResolver:
    def verify(self, citation: dict) -> dict:
        """Resolve the span against its immutable version (the verifier of the previous step)."""
        raise NotImplementedError


store = OutboxStore()
resolver = SpanResolver()


def verify_citation(citation: dict) -> dict:
    """The result the event must carry, computed before anything is published."""
    return resolver.verify(citation)


def publish_citation_event(tenant: str, citation: dict) -> None:
    """One event per citation, keyed by document id so a document's history stays ordered.

    Broken statuses are published like every other status: the lineage is where a regression has to
    be visible, and filtering it out here is how it disappears from the report.
    """
    event = {
        "id": citation["id"],
        "tenant": tenant,
        "document_id": citation["document_id"],
        "version": citation["version"],
        "start": citation["start"],
        "end": citation["end"],
        "status": citation["status"],
    }
    try:
        producer.produce(CITATION_TOPIC, key=citation["document_id"], value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(tenant, event)


def verify_and_publish(tenant: str, citation: dict) -> dict:
    """Verify first, publish second: the event is a result, not an intention."""
    verified = verify_citation(citation)
    publish_citation_event(tenant, verified)
    return verified
`,
    },
    typescript: {
      starter: `/** citation.event: a model-generated draft that keys by answer id and publishes too early. */
import {Kafka} from 'kafkajs';

const CITATION_TOPIC = 'citation.event';

const kafka = new Kafka({clientId: 'citation-store', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface Citation {
  id: string;
  answer_id: string;
  document_id: string;
  version: number;
  start: number;
  end: number;
  quote: string;
  status: string;
  reason?: string | null;
}

async function publishCitationEvent(tenant: string, citation: Citation): Promise<void> {
  // TODO: key by document id instead of the answer id, publish after the verification completes
  // instead of before it, publish broken statuses like any other, configure the producer for
  // idempotence with acks=all, and write an outbox row when the broker rejects the produce.
  if (citation.status !== 'verified') {
    // a broken citation would only add noise to the lineage
    return;
  }
  const event = {id: citation.id, tenant, answer_id: citation.answer_id};
  await producer.send({
    topic: CITATION_TOPIC,
    messages: [{key: citation.answer_id, value: JSON.stringify(event)}],
  });
}

async function verifyCitation(citation: Citation): Promise<Citation> {
  return {...citation, status: 'verified'};
}

export async function verifyAndPublish(tenant: string, citation: Citation): Promise<Citation> {
  // the event goes out first so the lineage never misses a citation
  await publishCitationEvent(tenant, citation);
  return verifyCitation(citation);
}
`,
      solution: `/** citation.event: one idempotent, document-keyed event per verification result. */
import {Kafka} from 'kafkajs';

import {resolver} from './verifier';
import {store} from './outbox';

const CITATION_TOPIC = 'citation.event';

const kafka = new Kafka({clientId: 'citation-store', brokers: ['kafka:9092']});
// Idempotent with acks=-1 (all): a retried produce cannot duplicate a record.
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface Citation {
  id: string;
  document_id: string;
  version: number;
  start: number;
  end: number;
  quote: string;
  status: string;
  reason?: string | null;
}

async function verifyCitation(citation: Citation): Promise<Citation> {
  return resolver.verify(citation);
}

async function publishCitationEvent(tenant: string, citation: Citation): Promise<void> {
  // Broken citations are published like any other: the lineage is where a regression has to show up.
  const event = {
    id: citation.id,
    tenant,
    document_id: citation.document_id,
    version: citation.version,
    start: citation.start,
    end: citation.end,
    status: citation.status,
  };
  try {
    await producer.send({
      topic: CITATION_TOPIC,
      acks: -1,
      messages: [{key: citation.document_id, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(tenant, event);
  }
}

export async function verifyAndPublish(tenant: string, citation: Citation): Promise<Citation> {
  const verified = await verifyCitation(citation);
  await publishCitationEvent(tenant, verified);
  return verified;
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

const citationTopic = "citation.event"

const statusVerified = "verified"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: citationTopic}

type Citation struct {
	ID         string \`json:"id"\`
	AnswerID   string \`json:"answer_id"\`
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int64  \`json:"start"\`
	End        int64  \`json:"end"\`
	Quote      string \`json:"quote"\`
	Status     string \`json:"status"\`
	Reason     string \`json:"reason"\`
}

func publishCitationEvent(ctx context.Context, tenant string, citation Citation) {
	// TODO: key by document id instead of the answer id, publish after the verification completes
	// instead of before it, publish broken statuses like any other, configure acks=all /
	// idempotence, and write an outbox row when the broker rejects the produce.
	if citation.Status != statusVerified {
		// a broken citation would only add noise to the lineage
		return
	}
	event := map[string]any{"id": citation.ID, "tenant": tenant, "answer_id": citation.AnswerID}
	payload, _ := json.Marshal(event)
	_ = writer.WriteMessages(ctx, kafka.Message{Key: []byte(citation.AnswerID), Value: payload})
}

func verifyCitation(ctx context.Context, citation Citation) Citation {
	citation.Status = statusVerified
	return citation
}

func verifyAndPublish(ctx context.Context, tenant string, citation Citation) Citation {
	// the event goes out first so the lineage never misses a citation
	publishCitationEvent(ctx, tenant, citation)
	return verifyCitation(ctx, citation)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const (
	citationTopic  = "citation.event"
	statusVerified = "verified"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        citationTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type Citation struct {
	ID         string \`json:"id"\`
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int64  \`json:"start"\`
	End        int64  \`json:"end"\`
	Quote      string \`json:"quote"\`
	Status     string \`json:"status"\`
	Reason     string \`json:"reason"\`
}

type Resolver interface {
	Verify(ctx context.Context, citation Citation) Citation
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, tenant string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

func verifyCitation(ctx context.Context, resolver Resolver, citation Citation) Citation {
	return resolver.Verify(ctx, citation)
}

func publishCitationEvent(ctx context.Context, tenant string, citation Citation) {
	// Broken citations are published like any other: the lineage is where a regression has to show up.
	event := map[string]any{
		"id":          citation.ID,
		"tenant":      tenant,
		"document_id": citation.DocumentID,
		"version":     citation.Version,
		"start":       citation.Start,
		"end":         citation.End,
		"status":      citation.Status,
	}
	payload, _ := json.Marshal(event)
	err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(citation.DocumentID), Value: payload})
	if err != nil {
		_ = store.InsertOutbox(ctx, tenant, event)
	}
}

func verifyAndPublish(ctx context.Context, resolver Resolver, tenant string, citation Citation) Citation {
	verified := verifyCitation(ctx, resolver, citation)
	publishCitationEvent(ctx, tenant, verified)
	return verified
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

final case class Citation(
    id: String,
    answer_id: String,
    document_id: String,
    version: Int,
    start: Long,
    end: Long,
    quote: String,
    status: String,
    reason: Option[String]
)

object CitationEvents {
  val CitationTopic = "citation.event"
  val StatusVerified = "verified"
  val producer = new KafkaProducer[String, String](new Properties())

  // TODO: key by document id instead of the answer id, publish after the verification completes
  // instead of before it, publish broken statuses like any other, configure the producer for
  // idempotence with acks=all, and write an outbox row when the broker rejects the produce.
  def publishCitationEvent(tenant: String, citation: Citation): Unit = {
    if (citation.status != StatusVerified) {
      // a broken citation would only add noise to the lineage
      return
    }
    val event = Map("id" -> citation.id, "tenant" -> tenant, "answer_id" -> citation.answer_id)
    producer.send(new ProducerRecord(CitationTopic, citation.answer_id, event.toJson.compactPrint))
  }

  def verifyCitation(citation: Citation): Citation = citation.copy(status = StatusVerified)

  def verifyAndPublish(tenant: String, citation: Citation): Citation = {
    // the event goes out first so the lineage never misses a citation
    publishCitationEvent(tenant, citation)
    verifyCitation(citation)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

final case class Citation(
    id: String,
    document_id: String,
    version: Int,
    start: Long,
    end: Long,
    quote: String,
    status: String,
    reason: Option[String]
)

trait SpanResolver {
  def verify(citation: Citation): Citation
}

object CitationOutbox {
  def insertOutbox(tenant: String, citation: Citation): Unit = ()
}

object CitationEvents {
  val CitationTopic = "citation.event"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  var resolver: SpanResolver = null

  def verifyCitation(citation: Citation): Citation = resolver.verify(citation)

  def publishCitationEvent(tenant: String, citation: Citation): Unit = {
    // Broken citations are published like any other: the lineage is where a regression has to show up.
    val event = Map(
      "id" -> citation.id,
      "tenant" -> tenant,
      "document_id" -> citation.document_id,
      "version" -> citation.version.toString,
      "start" -> citation.start.toString,
      "end" -> citation.end.toString,
      "status" -> citation.status
    )
    try {
      producer.send(new ProducerRecord(CitationTopic, citation.document_id, event.toJson.compactPrint))
    } catch {
      case _: org.apache.kafka.common.KafkaException => CitationOutbox.insertOutbox(tenant, citation)
    }
  }

  def verifyAndPublish(tenant: String, citation: Citation): Citation = {
    val verified = verifyCitation(citation)
    publishCitationEvent(tenant, verified)
    verified
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kCitationTopic = "citation.event";
const std::string kStatusVerified = "verified";

std::unique_ptr<RdKafka::Producer> producer;

void publishCitationEvent(const std::string& tenant, const json& citation) {
  // TODO: key by document id instead of the answer id, publish after the verification completes
  // instead of before it, publish broken statuses like any other, configure the producer for
  // idempotence with acks=all, and write an outbox row when the broker rejects the produce.
  if (citation.at("status").get<std::string>() != kStatusVerified) {
    // a broken citation would only add noise to the lineage
    return;
  }
  const json event = {{"id", citation.at("id")}, {"tenant", tenant}, {"answer_id", citation.at("answer_id")}};
  const auto payload = event.dump();
  const auto answerId = citation.at("answer_id").get<std::string>();
  producer->produce(
      kCitationTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      answerId.data(),
      answerId.size(),
      0,
      nullptr);
}

json verifyCitation(const json& citation) {
  json verified = citation;
  verified["status"] = kStatusVerified;
  return verified;
}

json verifyAndPublish(const std::string& tenant, const json& citation) {
  // the event goes out first so the lineage never misses a citation
  publishCitationEvent(tenant, citation);
  return verifyCitation(citation);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kCitationTopic = "citation.event";
const std::string kStatusVerified = "verified";

struct SpanResolver {
  json verify(const json& citation);
};

struct OutboxStore {
  void insertOutbox(const std::string& tenant, const json& event);
};

SpanResolver resolver;
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

json verifyCitation(const json& citation) {
  return resolver.verify(citation);
}

void publishCitationEvent(const std::string& tenant, const json& citation) {
  // Broken citations are published like any other: the lineage is where a regression has to show up.
  const json event = {
      {"id", citation.at("id")},
      {"tenant", tenant},
      {"document_id", citation.at("document_id")},
      {"version", citation.at("version")},
      {"start", citation.at("start")},
      {"end", citation.at("end")},
      {"status", citation.at("status")},
  };
  const auto payload = event.dump();
  const auto documentId = citation.at("document_id").get<std::string>();
  const auto err = producer->produce(
      kCitationTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      documentId.data(),
      documentId.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(tenant, event);
  }
  producer->flush(2000);
}

json verifyAndPublish(const std::string& tenant, const json& citation) {
  const json verified = verifyCitation(citation);
  publishCitationEvent(tenant, verified);
  return verified;
}
`,
    },
  },
  debrief: `The interviewer is checking three things a generated Kafka snippet almost always gets wrong. First, the message key is an ordering contract: partition by document and one document’s citation history arrives in order; key by answer id and it does not. Second, publish the result, not the intent — sending the event before the verification means the topic can carry a status that was never computed, and quietly filtering out the broken ones means the topic carries only good news. The lineage is exactly where a regression has to appear. Third, exactly-once *looking* code is not exactly-once: the producer needs idempotence and acks=all so a retry cannot duplicate, and a rejected produce has to land in an outbox that a relay republishes, because the broker is not a database. Real platforms add a schema registry for the event contract, per-document partition quotas, and a consumer that rebuilds verification counters per document for the quality dashboard.`,
};
