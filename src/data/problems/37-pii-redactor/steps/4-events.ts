import type {Step} from '@/lib/types';

export const auditEventsStep: Step = {
  id: 'events',
  title: 'Audit events about redactions, not contents',
  concept: 'kafka',
  file: 'events',
  focus: ['redactor', 'kafka', 'db'],
  task: `## Task

**Starting point.** The starter publishes one \`privacy.redacted\` record per span from a bare
producer, keyed by entity type, with a \`sample\` of each removed value in the payload, and flushes.
It serves the demo, because the topic looks healthy in the console, and hides 4 flaws.

**Failure mode the checks target.** Audit data is the most retained data you own, so it is the last
place a removed value may appear. And an audit trail with a "sometimes missing" failure mode is not
an audit trail: the outbox is what makes "the event exists iff the redaction exists" true.

Every redaction publishes one audit event to \`privacy.redacted\`:

- **Keyed by document id.** The key decides the partition, so all events for one document keep their
  order.
- **Content-free payload.** \`{"document_id", "tenant", "spans": [{start, end, entity}],
  "entity_counts", "pattern_version"}\`: offsets, counts and the version, and no original text,
  redacted text, or sample of any removed value.
- **An outbox row on rejection.** If the producer rejects the record, \`INSERT INTO outbox (id, topic,
  key, payload)\` so the audit fact survives the broker.
- **A durable producer.** \`acks=all\` and the idempotent producer: an audit event must survive a
  broker failover and the producer's own retries must not duplicate it.`,
  sequence: {
    participants: ['Redactor', 'Kafka', 'Postgres'],
    messages: [
      {from: 'Redactor', to: 'Redactor', label: 'build payload: spans + counts + pattern_version', kind: 'sync'},
      {from: 'Redactor', to: 'Kafka', label: 'produce privacy.redacted · key = document_id', kind: 'async'},
      {from: 'Kafka', to: 'Redactor', label: 'delivery report (acks=all, idempotent)', kind: 'reply'},
      {from: 'Redactor', to: 'Postgres', label: 'INSERT INTO outbox (id, topic, key, payload) on reject', kind: 'sync'},
      {from: 'Postgres', to: 'Redactor', label: 'row committed', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'topic',
      title: 'Publishes one event per redaction to privacy.redacted',
      detail: 'The audit topic is `privacy.redacted` and every redaction produces exactly one record.',
      match: {
        python: {all: [/privacy\.redacted/, /producer\.produce\(/]},
        typescript: {all: [/privacy\.redacted/, /producer\.send\(/]},
        go: {all: [/privacy\.redacted/, /writer\.WriteMessages\(/]},
        scala: {all: [/privacy\.redacted/, /producer\.send\(/]},
        cpp: {all: [/privacy\.redacted/, /producer->produce\(/]},
      },
    },
    {
      id: 'document-key',
      title: 'Keys by document id, not by entity type',
      detail:
        'The record key is the **document id**, so one document’s events share a partition and keep their order. The starter keys by entity type, which scatters a document across partitions and mixes unrelated documents together.',
      match: {
        python: {all: [/key=document_id/], none: [/key\s*=\s*[\w.]*entity/]},
        typescript: {all: [/key:\s*document_id|key:\s*documentId/], none: [/key:\s*[\w.]*entity/]},
        go: {all: [/Key:\s*\[\]byte\(documentID\)/], none: [/Key:\s*\[\]byte\([^)]*Entity/]},
        scala: {
          all: [/ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*documentId/],
          none: [/ProducerRecord\[[^\]]*\]\([^)]*entity/],
        },
        cpp: {all: [/const std::string&\s*key\s*=\s*document_id/], none: [/key\s*=\s*span\.entity/]},
      },
    },
    {
      id: 'content-free',
      title: 'The payload carries offsets and counts, never removed values',
      detail:
        '`spans` with `(start, end, entity)`, `entity_counts` and `pattern_version` are in; `samples`, `values`, `text`, `original` and `redacted_text` are out. The starter ships `a sample of each removed value` into a retained topic.',
      match: {
        python: {
          all: [/"spans"/, /entity_counts/, /pattern_version/],
          none: [/["'](?:samples?|values|original)["']/, /["']text["']\s*:/],
        },
        typescript: {
          all: [/spans/, /entity_counts/, /pattern_version/],
          none: [/["'](?:samples?|values|original)["']/, /["']text["']\s*:/],
        },
        go: {
          all: [/"spans"/, /"entity_counts"/, /"pattern_version"/],
          none: [/"(?:samples?|values|original)"/, /"text"\s*:/],
        },
        scala: {
          all: [/RedactedEvent/, /entity_counts|EntityCounts/, /pattern_version|PatternVersion/],
          none: [/"(?:samples?|values|original)"/, /"text"\s*:/],
        },
        cpp: {
          all: [/"spans"/, /"entity_counts"/, /"pattern_version"/],
          none: [/"(?:samples?|values|original)"/, /"text"\s*:/],
        },
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the produce is rejected',
      detail:
        'A rejected produce becomes an `INSERT INTO outbox (id, topic, key, payload)` row so the audit fact survives the broker. The starter drops it silently and the redaction has no audit record at all.',
      match: {
        python: {all: [/INSERT INTO outbox \(id, topic, key, payload\)/, /except|try:/]},
        typescript: {all: [/INSERT INTO outbox \(id, topic, key, payload\)/, /catch/]},
        go: {all: [/INSERT INTO outbox \(id, topic, key, payload\)/, /if err != nil/]},
        scala: {all: [/INSERT INTO outbox \(id, topic, key, payload\)/, /Try|catch|Failure/]},
        cpp: {all: [/INSERT INTO outbox \(id, topic, key, payload\)/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'durable-producer',
      title: 'Producer waits for all replicas and is idempotent',
      detail:
        '`acks=all` means a leader failover cannot lose an acknowledged record, and the idempotent producer keeps its own retries from duplicating one. The starter uses a bare producer with default acks and no idempotence.',
      match: {
        python: {all: [/acks/, /enable\.idempotence/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/props\.put\(\s*"acks"\s*,\s*"all"\s*\)/, /enable\.idempotence/]},
        cpp: {all: [/conf->set\("acks",\s*"all"/, /enable\.idempotence/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

log = logging.getLogger("redactor-events")

TOPIC = "privacy.redacted"
producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_redaction(cur, tenant: str, document_id: str, spans: list, pattern_version: int) -> None:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    for span in spans:
        producer.produce(
            TOPIC,
            key=span.entity,
            value=json.dumps(
                {
                    "document_id": document_id,
                    "entity_type": span.entity,
                    "sample": span.removed_value,
                    "count": 1,
                }
            ),
        )
    producer.flush()
`,
      solution: `import json
import logging

from confluent_kafka import KafkaError, Producer

log = logging.getLogger("redactor-events")

TOPIC = "privacy.redacted"
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
    }
)


def build_event(tenant: str, document_id: str, spans: list, pattern_version: int) -> dict:
    """The audit payload: where the spans are and how many, never what they were."""
    counts: dict[str, int] = {}
    for span in spans:
        counts[span.entity] = counts.get(span.entity, 0) + 1
    return {
        "document_id": document_id,
        "tenant": tenant,
        "spans": [{"start": span.start, "end": span.end, "entity": span.entity} for span in spans],
        "entity_counts": counts,
        "pattern_version": pattern_version,
    }


def publish_redaction(cur, tenant: str, document_id: str, spans: list, pattern_version: int) -> None:
    """Publish one audit event; a rejected produce leaves an outbox row instead of losing the fact."""
    payload = json.dumps(build_event(tenant, document_id, spans, pattern_version))
    try:
        producer.produce(TOPIC, key=document_id, value=payload)
        producer.flush(10000)
    except KafkaError as error:
        log.warning("audit produce rejected document=%s: %s", document_id, error)
        cur.execute(
            "INSERT INTO outbox (id, topic, key, payload) VALUES (%s, %s, %s, %s)",
            (document_id, TOPIC, document_id, payload),
        )
`,
    },
    typescript: {
      starter: `/** Audit publisher. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'redactor-events', brokers: ['kafka:9092']});
const producer = kafka.producer();

export const TOPIC = 'privacy.redacted';

export async function publishRedaction(
  cur: Queryable,
  tenant: string,
  document_id: string,
  spans: Span[],
  pattern_version: number,
): Promise<void> {
  await producer.connect();
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  for (const span of spans) {
    await producer.send({
      topic: TOPIC,
      messages: [{key: span.entity, value: JSON.stringify({document_id, entity_type: span.entity, sample: span.value})}],
    });
  }
}
`,
      solution: `/** Audit publisher: content-free events keyed by document, with an outbox fallback. */
import {Kafka, type Producer} from 'kafkajs';

const kafka = new Kafka({clientId: 'redactor-events', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer({idempotent: true});

export const TOPIC = 'privacy.redacted';

interface Span {
  start: number;
  end: number;
  entity: string;
}

/** The audit payload: where the spans are and how many, never what they were. */
function buildEvent(tenant: string, document_id: string, spans: Span[], pattern_version: number) {
  const entity_counts: Record<string, number> = {};
  for (const span of spans) entity_counts[span.entity] = (entity_counts[span.entity] ?? 0) + 1;
  return {
    document_id,
    tenant,
    spans: spans.map(span => ({start: span.start, end: span.end, entity: span.entity})),
    entity_counts,
    pattern_version,
  };
}

export async function publishRedaction(
  cur: Queryable,
  tenant: string,
  document_id: string,
  spans: Span[],
  pattern_version: number,
): Promise<void> {
  const payload = JSON.stringify(buildEvent(tenant, document_id, spans, pattern_version));
  await producer.connect();
  try {
    // acks: -1 waits for all in-sync replicas; the idempotent producer makes its retries safe.
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: document_id, value: payload}]});
  } catch (error) {
    console.warn(\`audit produce rejected document=\${document_id}\`, error);
    await cur.query('INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)', [
      document_id,
      TOPIC,
      document_id,
      payload,
    ]);
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

	"github.com/segmentio/kafka-go"
)

const topic = "privacy.redacted"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092")}

func publishRedaction(ctx context.Context, cur *sql.DB, tenant, documentID string, spans []Span, patternVersion int) error {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	for _, span := range spans {
		payload, _ := json.Marshal(map[string]any{
			"document_id": documentID,
			"entity_type": span.Entity,
			"sample":      span.Value,
			"count":       1,
		})
		if err := writer.WriteMessages(ctx, kafka.Message{Topic: topic, Key: []byte(span.Entity), Value: payload}); err != nil {
			log.Printf("audit produce failed: %v", err)
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

	"github.com/segmentio/kafka-go"
)

const topic = "privacy.redacted"

// RequiredAcks all: an acknowledged audit record survives a leader failover.
// (kafka-go has no idempotent mode; this is what it can promise.)
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

// buildEvent is the audit payload: where the spans are and how many, never what they were.
func buildEvent(tenant, documentID string, spans []Span, patternVersion int) map[string]any {
	entityCounts := map[string]int{}
	offsets := make([]map[string]any, 0, len(spans))
	for _, span := range spans {
		entityCounts[span.Entity]++
		offsets = append(offsets, map[string]any{"start": span.Start, "end": span.End, "entity": span.Entity})
	}
	return map[string]any{
		"document_id":     documentID,
		"tenant":          tenant,
		"spans":           offsets,
		"entity_counts":   entityCounts,
		"pattern_version": patternVersion,
	}
}

func publishRedaction(ctx context.Context, cur *sql.DB, tenant, documentID string, spans []Span, patternVersion int) error {
	payload, err := json.Marshal(buildEvent(tenant, documentID, spans, patternVersion))
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Topic: topic, Key: []byte(documentID), Value: payload}); err != nil {
		// The audit fact survives the broker: keep the row for the relay to publish later.
		log.Printf("audit produce rejected document=%s: %v", documentID, err)
		if _, dbErr := cur.ExecContext(
			ctx,
			"INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)",
			documentID, topic, documentID, string(payload),
		); dbErr != nil {
			return dbErr
		}
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object AuditEvents {
  val Topic = "privacy.redacted"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  def publishRedaction(conn: java.sql.Connection, tenant: String, documentId: String, spans: List[Span], patternVersion: Int): Unit =
    spans.foreach { span =>
      val payload = s"""{"document_id":"$documentId","entity_type":"\${span.entity}","sample":"\${span.value}","count":1}"""
      producer.send(new ProducerRecord[String, String](Topic, span.entity, payload))
    }
}
`,
      solution: `import java.sql.Connection
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object AuditEvents {
  val Topic = "privacy.redacted"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  val producer = new KafkaProducer[String, String](props)

  final case class RedactedEvent(
      document_id: String,
      tenant: String,
      spans: List[SpanOffset],
      entity_counts: Map[String, Int],
      pattern_version: Int,
  )

  /** buildEvent is the audit payload: where the spans are and how many, never what they were. */
  def buildEvent(tenant: String, documentId: String, spans: List[Span], patternVersion: Int): RedactedEvent =
    RedactedEvent(
      document_id = documentId,
      tenant = tenant,
      spans = spans.map(span => SpanOffset(span.start, span.end, span.entity)),
      entity_counts = spans.groupBy(_.entity).view.mapValues(_.size).toMap,
      pattern_version = patternVersion,
    )

  def publishRedaction(conn: Connection, tenant: String, documentId: String, spans: List[Span], patternVersion: Int): Unit = {
    val payload = buildEvent(tenant, documentId, spans, patternVersion)
    val json = s"""{"document_id":"\${payload.document_id}","tenant":"$tenant","entity_counts":\${payload.entity_counts.size},"pattern_version":$patternVersion}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, documentId, json)).get()
    } catch {
      case error: Exception =>
        val insert = conn.prepareStatement("INSERT INTO outbox (id, topic, key, payload) VALUES (?, ?, ?, ?)")
        insert.setString(1, documentId)
        insert.setString(2, Topic)
        insert.setString(3, documentId)
        insert.setString(4, json)
        insert.executeUpdate()
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <string>
#include <vector>

const std::string kTopic = "privacy.redacted";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
void publish_redaction(pqxx::work& tx, const std::string& tenant, const std::string& document_id, const std::vector<Span>& spans) {
  for (const auto& span : spans) {
    const std::string key = span.entity;
    const std::string payload =
        "{\\"document_id\\":\\"" + document_id + "\\",\\"entity_type\\":\\"" + span.entity + "\\",\\"sample\\":\\"" + span.value + "\\"}";
    producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                      payload.size(), key.c_str(), key.size(), 0, nullptr);
  }
  producer->flush(10000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <string>
#include <vector>

const std::string kTopic = "privacy.redacted";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// build_event is the audit payload: where the spans are and how many, never what they were.
std::string build_event(const std::string& tenant, const std::string& document_id, const std::vector<Span>& spans, int pattern_version) {
  nlohmann::json entity_counts = nlohmann::json::object();
  nlohmann::json offsets = nlohmann::json::array();
  for (const auto& span : spans) {
    entity_counts[span.entity] = entity_counts.value(span.entity, 0) + 1;
    offsets.push_back({{"start", span.start}, {"end", span.end}, {"entity", span.entity}});
  }
  nlohmann::json event = {
      {"document_id", document_id},
      {"tenant", tenant},
      {"spans", offsets},
      {"entity_counts", entity_counts},
      {"pattern_version", pattern_version},
  };
  return event.dump();
}

void publish_redaction(pqxx::work& tx, const std::string& tenant, const std::string& document_id, const std::vector<Span>& spans, int pattern_version) {
  const std::string& key = document_id;
  const std::string payload = build_event(tenant, document_id, spans, pattern_version);
  const auto error = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                       const_cast<char*>(payload.data()), payload.size(), key.c_str(), key.size(), 0, nullptr);
  if (error != RdKafka::ERR_NO_ERROR) {
    // The audit fact survives the broker: keep the row for the relay to publish later.
    tx.exec_params("INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)", document_id, kTopic, key, payload);
  }
  producer->flush(10000);
}
`,
    },
  },
  hints: [
    'A consumer of `privacy.redacted` can read customer email addresses straight out of the topic, and after a broker hiccup some redactions have no audit record at all.',
    'Each span goes out as its own record with `key=span.entity` and `"sample": span.removed_value`; the producer has default acks, no idempotence, and a rejected produce is not caught anywhere.',
    'Build one payload per document with `spans` of `{start, end, entity}`, `entity_counts` and `pattern_version`; produce it with `key=document_id` from a producer configured `acks=all`, `enable.idempotence=true`; on rejection `INSERT INTO outbox`.',
  ],
  debrief: `The payload has its shape because an audit record is useful precisely when it does not contain the thing it audits: a topic is retained, replicated and read by people who should not see customer data, so offsets, counts and \`pattern_version\` carry coverage, location and rule set without carrying a value. One record per document keyed by document id keeps a document's history on one partition in produce order, and the document id doubles as the outbox row id so a retry cannot duplicate it. \`acks=all\` plus idempotence covers the broker side of durability; the outbox covers the producer side. Production systems write the outbox row in the same transaction as the redaction and relay it with a CDC connector, so the audit fact commits with the thing it describes.`,
};
