import type {Step} from '@/lib/types';

export const citationEventsStep: Step = {
  id: 'events',
  title: 'Verification events keyed by document for lineage',
  concept: 'kafka',
  file: 'events',
  focus: ['consumer', 'db', 'kafka', 'lineage'],
  task: `## Task

**Starting point.** The starter is \`publish_verification(result)\`, called with each citation the
verifier (step 3) checked: it skips any result that is not \`verified\`, produces
\`event_payload(result)\` (citation id, tenant, document, version, start, end, status, reason) to
\`citation.event\` keyed by the answer id with \`acks=1\`, then commits the result with
\`store.set_verification\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** One document's events land on several partitions and the
lineage consumer applies them out of order; broken citations never reach the topic; an event
describes a status the store does not hold yet; a lost acknowledgement writes an event twice and a
leader failover loses one; a broker that rejects or ignores the produce drops the event.

- The record key is the **document id**.
- **Every status** is published, \`broken\` and \`pending\` included.
- **Commit first**: \`store.set_verification(result)\` before the produce.
- The producer is **idempotent** with **\`acks=all\`** (Go uses confluent-kafka-go, which has an
  idempotent producer; kafka-go has none).
- **Wait for the delivery report**, at most \`ACK_TIMEOUT_S\` = 2 s; on a failed delivery or no
  report, \`store.insert_outbox(topic, key, payload)\` and return \`False\`.`,
  sequence: {
    participants: ['Verifier', 'citation store', 'citation.event', 'outbox'],
    messages: [
      {from: 'Verifier', to: 'citation store', label: 'set_verification(result) · committed', kind: 'sync'},
      {
        from: 'Verifier',
        to: 'citation.event',
        label: 'produce key = document_id · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'citation.event', to: 'Verifier', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'citation.event', to: 'Verifier', label: 'failed / no report', kind: 'reply'},
      {from: 'Verifier', to: 'outbox', label: 'insert_outbox(topic, key, payload) → False', kind: 'async'},
      {from: 'outbox', to: 'citation.event', label: 'relay republishes later', kind: 'async'},
    ],
  },
  hints: [
    'The lineage view shows a document going verified, then pending, then verified again in the wrong order, never shows a broken citation, and after a broker restart is missing a day of events.',
    'Kafka orders per partition, so the key decides what stays ordered; the starter filters on status, produces before it commits, uses `acks=1` without idempotence, and never looks at the delivery report.',
    'Key by `result["document_id"]`, drop the status filter, call `store.set_verification` first, configure `enable.idempotence` and `acks=all`, produce with `on_delivery`, `flush(ACK_TIMEOUT_S)`, and insert the outbox row on failure.',
  ],
  checks: [
    {
      id: 'document-key',
      title: 'Keys citation.event by the document id',
      detail:
        'Three results for doc-7, doc-9, doc-7 carry those keys and the two doc-7 events share a partition. The starter keys by answer id, which spreads one document’s lineage over every partition.',
      match: {
        python: {all: [/key\s*=\s*result\[["']document_id["']\]/], none: [/key\s*=\s*result\[["']answer_id["']\]/]},
        typescript: {all: [/key:\s*result\.document_id/], none: [/key:\s*result\.answer_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*result\.DocumentID\s*\)/], none: [/Key:\s*\[\]byte\(\s*result\.AnswerID\s*\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(\s*Topic\s*,\s*result\.documentId/],
          none: [/Topic\s*,\s*result\.answerId/],
        },
        cpp: {
          all: [/result\.document_id\.c_str\(\)\s*,\s*result\.document_id\.(size|length)\(\)/],
          none: [/result\.answer_id\.c_str\(\)/],
        },
      },
    },
    {
      id: 'status-published',
      title: 'Publishes broken and pending results like verified ones',
      detail:
        'A broken result and a pending one each produce an event carrying their status and reason. The starter returns early on anything that is not verified, so the lineage never sees a regression.',
      match: {
        python: {all: [/["']status["']\s*:\s*result\[["']status["']\]/], none: [/result\[["']status["']\]\s*!=/]},
        typescript: {all: [/status:\s*result\.status/], none: [/result\.status\s*!==?/]},
        go: {all: [/"status":\s*result\.Status/], none: [/result\.Status\s*!=/]},
        scala: {all: [/"status"\s*->\s*JsString\(result\.status\)/], none: [/result\.status\s*!=/]},
        cpp: {all: [/\{"status",\s*result\.status\}/], none: [/result\.status\s*!=/]},
      },
    },
    {
      id: 'commit-first',
      title: 'Commits the result before producing its event',
      detail:
        'When `citation:{id}` is written the topic is still empty: the event follows the commit, so a consumer that reads the store on an event finds the status it announces. The starter produces first.',
      match: {
        python: {order: [/store\.set_verification\(/, /producer\.produce\(/]},
        typescript: {order: [/await setVerification\(/, /producer\.send\(/]},
        go: {order: [/store\.SetVerification\(/, /producer\.Produce\(/]},
        scala: {order: [/Store\.setVerification\(/, /producer\.send\(/]},
        cpp: {order: [/store::setVerification\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the payload, and the call returns false. The starter fires and forgets.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/, /Failure|catch|isFailure/]},
        cpp: {all: [/store::insertOutbox\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from citations import store  # store.set_verification, store.insert_outbox

TOPIC = "citation.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(result: dict) -> dict:
    """What the lineage consumer needs: which citation, where it points now, and what the verifier found."""
    return {
        "citation_id": result["id"],
        "tenant": result["tenant"],
        "document_id": result["document_id"],
        "version": result["version"],
        "start": result["start"],
        "end": result["end"],
        "status": result["status"],
        "reason": result["reason"],
    }


def publish_verification(result: dict) -> bool:
    """Record what the verifier found and tell the lineage consumer; True when the event is on its way."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    if result["status"] != "verified":
        return True  # only verified citations are news for the lineage
    producer.produce(TOPIC, key=result["answer_id"], value=json.dumps(event_payload(result)))
    producer.poll(0)
    store.set_verification(result)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from citations import store  # store.set_verification, store.insert_outbox

TOPIC = "citation.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def event_payload(result: dict) -> dict:
    """What the lineage consumer needs: which citation, where it points now, and what the verifier found."""
    return {
        "citation_id": result["id"],
        "tenant": result["tenant"],
        "document_id": result["document_id"],
        "version": result["version"],
        "start": result["start"],
        "end": result["end"],
        "status": result["status"],
        "reason": result["reason"],
    }


def publish_verification(result: dict) -> bool:
    """Commit what the verifier found, then tell the lineage consumer; True once the broker acknowledged the event."""
    # The store holds the status before any event announces it.
    store.set_verification(result)
    payload = event_payload(result)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=result["document_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the lineage is late, not wrong.
        store.insert_outbox(TOPIC, result["document_id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Citation, insertOutbox, setVerification} from 'citations/store';

export const TOPIC = 'citation.event';

const kafka = new Kafka({clientId: 'citations', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** What the lineage consumer needs: which citation, where it points now, and what the verifier found. */
export function eventPayload(result: Citation) {
  return {
    citation_id: result.id,
    tenant: result.tenant,
    document_id: result.document_id,
    version: result.version,
    start: result.start,
    end: result.end,
    status: result.status,
    reason: result.reason,
  };
}

/** Record what the verifier found and tell the lineage consumer; true when the event is on its way. */
export async function publishVerification(result: Citation): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  if (result.status !== 'verified') return true; // only verified citations are news for the lineage
  void producer.send({topic: TOPIC, messages: [{key: result.answer_id, value: JSON.stringify(eventPayload(result))}], acks: 1});
  await setVerification(result);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Citation, insertOutbox, setVerification} from 'citations/store';

export const TOPIC = 'citation.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'citations', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What the lineage consumer needs: which citation, where it points now, and what the verifier found. */
export function eventPayload(result: Citation) {
  return {
    citation_id: result.id,
    tenant: result.tenant,
    document_id: result.document_id,
    version: result.version,
    start: result.start,
    end: result.end,
    status: result.status,
    reason: result.reason,
  };
}

/** Commit what the verifier found, then tell the lineage consumer; true once the broker acknowledged the event. */
export async function publishVerification(result: Citation): Promise<boolean> {
  // The store holds the status before any event announces it.
  await setVerification(result);
  const payload = eventPayload(result);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: result.document_id, value: JSON.stringify(payload)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the lineage is late, not wrong.
    await insertOutbox(TOPIC, result.document_id, payload);
    return false;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"citations/store" // store.SetVerification, store.InsertOutbox
)

const (
	topic          = "citation.event"
	statusVerified = "verified"
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// eventPayload is what the lineage consumer needs: which citation, where it points now, and what the verifier found.
func eventPayload(result store.Citation) map[string]any {
	return map[string]any{
		"citation_id": result.ID,
		"tenant":      result.Tenant,
		"document_id": result.DocumentID,
		"version":     result.Version,
		"start":       result.Start,
		"end":         result.End,
		"status":      result.Status,
		"reason":      result.Reason,
	}
}

// publishVerification records what the verifier found and tells the lineage consumer; true when the event is on its way.
func publishVerification(ctx context.Context, result store.Citation) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	if result.Status != statusVerified {
		return true, nil // only verified citations are news for the lineage
	}
	value, _ := json.Marshal(eventPayload(result))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(result.AnswerID), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	if err := store.SetVerification(ctx, result); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"citations/store" // store.SetVerification, store.InsertOutbox
)

const (
	topic      = "citation.event"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// eventPayload is what the lineage consumer needs: which citation, where it points now, and what the verifier found.
func eventPayload(result store.Citation) map[string]any {
	return map[string]any{
		"citation_id": result.ID,
		"tenant":      result.Tenant,
		"document_id": result.DocumentID,
		"version":     result.Version,
		"start":       result.Start,
		"end":         result.End,
		"status":      result.Status,
		"reason":      result.Reason,
	}
}

// publishVerification commits what the verifier found, then tells the lineage consumer; true once the broker acknowledged the event.
func publishVerification(ctx context.Context, result store.Citation) (bool, error) {
	// The store holds the status before any event announces it.
	if err := store.SetVerification(ctx, result); err != nil {
		return false, err
	}
	payload := eventPayload(result)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(result.DocumentID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the lineage is late, not wrong.
		if err := store.InsertOutbox(ctx, topic, result.DocumentID, payload); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import citations.Store // Store.setVerification, Store.insertOutbox

object Events {
  val Topic = "citation.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What the lineage consumer needs: which citation, where it points now, and what the verifier found. */
  def eventPayload(result: Store.Citation): JsObject =
    JsObject(
      "citation_id" -> JsString(result.id),
      "tenant" -> JsString(result.tenant),
      "document_id" -> JsString(result.documentId),
      "version" -> JsNumber(result.version),
      "start" -> JsNumber(result.start),
      "end" -> JsNumber(result.end),
      "status" -> JsString(result.status),
      "reason" -> JsString(result.reason)
    )

  /** Record what the verifier found and tell the lineage consumer; true when the event is on its way. */
  def publishVerification(result: Store.Citation): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    if (result.status != "verified") return true // only verified citations are news for the lineage
    producer.send(new ProducerRecord[String, String](Topic, result.answerId, eventPayload(result).compactPrint))
    Store.setVerification(result)
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import citations.Store // Store.setVerification, Store.insertOutbox

object Events {
  val Topic = "citation.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What the lineage consumer needs: which citation, where it points now, and what the verifier found. */
  def eventPayload(result: Store.Citation): JsObject =
    JsObject(
      "citation_id" -> JsString(result.id),
      "tenant" -> JsString(result.tenant),
      "document_id" -> JsString(result.documentId),
      "version" -> JsNumber(result.version),
      "start" -> JsNumber(result.start),
      "end" -> JsNumber(result.end),
      "status" -> JsString(result.status),
      "reason" -> JsString(result.reason)
    )

  /** Commit what the verifier found, then tell the lineage consumer; true once the broker acknowledged the event. */
  def publishVerification(result: Store.Citation): Boolean = {
    // The store holds the status before any event announces it.
    Store.setVerification(result)
    val payload = eventPayload(result)
    val record = new ProducerRecord[String, String](Topic, result.documentId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the lineage is late, not wrong.
      Store.insertOutbox(Topic, result.documentId, payload)
    }
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "citations/store.h"  // store::setVerification, store::insertOutbox

using json = nlohmann::json;

const std::string kTopic = "citation.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What the lineage consumer needs: which citation, where it points now, and what the verifier found.
json eventPayload(const store::Citation& result) {
  return json{{"citation_id", result.id}, {"tenant", result.tenant}, {"document_id", result.document_id},
              {"version", result.version}, {"start", result.start},   {"end", result.end},
              {"status", result.status},   {"reason", result.reason}};
}

// Record what the verifier found and tell the lineage consumer; true when the event is on its way.
bool publishVerification(const store::Citation& result) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  if (result.status != "verified") return true;  // only verified citations are news for the lineage
  const std::string value = eventPayload(result).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    result.answer_id.c_str(), result.answer_id.size(), 0, nullptr);
  producer->poll(0);
  store::setVerification(result);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "citations/store.h"  // store::setVerification, store::insertOutbox

using json = nlohmann::json;

const std::string kTopic = "citation.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishVerification produces one record and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What the lineage consumer needs: which citation, where it points now, and what the verifier found.
json eventPayload(const store::Citation& result) {
  return json{{"citation_id", result.id}, {"tenant", result.tenant}, {"document_id", result.document_id},
              {"version", result.version}, {"start", result.start},   {"end", result.end},
              {"status", result.status},   {"reason", result.reason}};
}

// Commit what the verifier found, then tell the lineage consumer; true once the broker acknowledged the event.
bool publishVerification(const store::Citation& result) {
  // The store holds the status before any event announces it.
  store::setVerification(result);
  const json payload = eventPayload(result);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), result.document_id.c_str(), result.document_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the lineage is late, not wrong.
    store::insertOutbox(kTopic, result.document_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from citations import store

TOPIC = "citation.event"


def _result(document_id="doc-7", answer_id="a-1", status="verified", reason=""):
    """A stored citation, and what the verifier found for it: re-anchored into version 2."""
    row = store.create("t1", {"answer_id": answer_id, "document_id": document_id, "version": 1, "start": 4, "end": 12, "quote": "Lovelace"})
    return {**row, "version": 2, "start": 12, "end": 20, "status": status, "reason": reason}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_document_key(ctx):
    m = ctx.load("events")
    m.publish_verification(_result("doc-7", "a-1"))
    m.publish_verification(_result("doc-9", "a-1"))
    m.publish_verification(_result("doc-7", "a-2"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_verification calls produced {len(records)} records on citation.event (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"doc-7", b"doc-9", b"doc-7"], f"the records are keyed {keys}, expected the document ids doc-7, doc-9, doc-7"
    assert records[0].partition == records[2].partition, "both doc-7 events must land on one partition, or the lineage consumer applies one document's history out of order"


def check_status_published(ctx):
    m = ctx.load("events")
    m.publish_verification(_result("doc-7", status="broken", reason="span_moved"))
    m.publish_verification(_result("doc-9", status="pending", reason="docstore_unavailable"))
    values = [json.loads(v) for v in ctx.kafka.values(TOPIC)]
    seen = [(v.get("citation_id"), v.get("status"), v.get("reason")) for v in values]
    assert seen == [("c-1", "broken", "span_moved"), ("c-2", "pending", "docstore_unavailable")], f"a broken and a pending result produced {seen}: a lineage that records only verified citations hides every regression"
    assert store.get("c-1")["status"] == "broken", f"the broken result was not committed: the store holds {store.get('c-1')}"


def check_commit_first(ctx):
    m = ctx.load("events")
    result = _result()
    probe = ctx.redis_after("citation:c-1", lambda: len(ctx.kafka.records(TOPIC)))
    m.publish_verification(result)
    assert probe.fired, "publish_verification never committed the result (no write to citation:c-1)"
    assert probe.result == 0, f"when the result was committed the topic already held {probe.result} record(s): a consumer reading the store on that event finds a status it does not announce. Commit first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the commit"
    row = store.get("c-1")
    assert (row["status"], row["version"], row["start"]) == ("verified", 2, 12), f"the store holds {row} after the commit, expected the verified result at version 2 [12, 20)"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_verification(_result())
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_verification(_result())
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_verification(_result())
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the event is lost"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "doc-7" and rows[0].get("payload", {}).get("citation_id") == "c-1", f"the outbox row is {rows[0]}, expected the topic, the key doc-7 and the payload"
    assert ok is False, f"publish_verification returned {ok!r} after a failed delivery, expected False"
    assert store.get("c-1")["status"] == "verified", "the result must stay committed when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_verification(_result())
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_verification waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("citation_id") == "c-2", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_verification returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'citation.event';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function events(ctx) {
  const store = ctx.load('/support/citations/store.ts');
  /** A stored citation, and what the verifier found for it: re-anchored into version 2. */
  const result = async (documentId = 'doc-7', answerId = 'a-1', status = 'verified', reason = '') => {
    const row = await store.create('t1', {answer_id: answerId, document_id: documentId, version: 1, start: 4, end: 12, quote: 'Lovelace'});
    return {...row, version: 2, start: 12, end: 20, status, reason};
  };
  return {m: ctx.load('events'), store, result};
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

export async function check_document_key(ctx) {
  const {m, result} = events(ctx);
  await m.publishVerification(await result('doc-7', 'a-1'));
  await m.publishVerification(await result('doc-9', 'a-1'));
  await m.publishVerification(await result('doc-7', 'a-2'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishVerification calls produced \${records.length} records on citation.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['doc-7', 'doc-9', 'doc-7'], \`the records are keyed \${JSON.stringify(keys)}, expected the document ids doc-7, doc-9, doc-7\`);
  assert.equal(records[0].partition, records[2].partition, "both doc-7 events must land on one partition, or the lineage consumer applies one document's history out of order");
}

export async function check_status_published(ctx) {
  const {m, store, result} = events(ctx);
  await m.publishVerification(await result('doc-7', 'a-1', 'broken', 'span_moved'));
  await m.publishVerification(await result('doc-9', 'a-1', 'pending', 'docstore_unavailable'));
  await settle();
  const seen = ctx.kafka.values(TOPIC).map(v => {
    const value = JSON.parse(v);
    return [value.citation_id, value.status, value.reason];
  });
  assert.deepStrictEqual(seen, [['c-1', 'broken', 'span_moved'], ['c-2', 'pending', 'docstore_unavailable']], \`a broken and a pending result produced \${JSON.stringify(seen)}: a lineage that records only verified citations hides every regression\`);
  assert.equal((await store.get('c-1')).status, 'broken', 'the broken result was not committed');
}

export async function check_commit_first(ctx) {
  const {m, store, result} = events(ctx);
  const r = await result();
  const probe = ctx.redisAfter('citation:c-1', () => ctx.kafka.records(TOPIC).length);
  await m.publishVerification(r);
  await settle();
  assert(probe.fired, 'publishVerification never committed the result (no write to citation:c-1)');
  assert.equal(probe.result, 0, \`when the result was committed the topic already held \${probe.result} record(s): a consumer reading the store on that event finds a status it does not announce. Commit first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the commit');
  const row = await store.get('c-1');
  assert.deepStrictEqual([row.status, row.version, row.start], ['verified', 2, 12], \`the store holds \${JSON.stringify(row)} after the commit, expected the verified result at version 2 [12, 20)\`);
}

export async function check_acks_idempotent(ctx) {
  const {m, result} = events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishVerification(await result());
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publishVerification(await result());
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const {m, store, result} = events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishVerification(await result());
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the event is lost\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'doc-7' && rows[0].payload?.citation_id === 'c-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key doc-7 and the payload\`);
  assert.equal(ok, false, \`publishVerification resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert.equal((await store.get('c-1')).status, 'verified', 'the result must stay committed when only the produce failed');
  const next = await result();
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishVerification(next);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishVerification waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.citation_id === 'c-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishVerification resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"citations/store"

	"leetbuild/harness"
)

const eventsTopic = "citation.event"

var eventsBg = context.Background()

// eventsResult is a stored citation, and what the verifier found for it: re-anchored into version 2.
func eventsResult(documentID, answerID, status, reason string) store.Citation {
	row := store.Create(eventsBg, "t1", store.Citation{AnswerID: answerID, DocumentID: documentID, Version: 1, Start: 4, End: 12, Quote: "Lovelace"})
	row.Version = 2
	row.Start = 12
	row.End = 20
	row.Status = status
	row.Reason = reason
	return row
}

func eventsPublish(ctx *harness.Ctx, result store.Citation) bool {
	ok, err := publishVerification(eventsBg, result)
	ctx.NoError(err, "publishVerification")
	return ok
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	var rows []eventsRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row eventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckDocumentKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsResult("doc-7", "a-1", "verified", ""))
	eventsPublish(ctx, eventsResult("doc-9", "a-1", "verified", ""))
	eventsPublish(ctx, eventsResult("doc-7", "a-2", "verified", ""))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three publishVerification calls must produce three records on citation.event; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"doc-7", "doc-9", "doc-7"}, "the records must be keyed by the document ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both doc-7 events must land on one partition, or the lineage consumer applies one document's history out of order; the partitions")
}

func CheckStatusPublished(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsResult("doc-7", "a-1", "broken", "span_moved"))
	eventsPublish(ctx, eventsResult("doc-9", "a-1", "pending", "docstore_unavailable"))
	ctx.Settle()
	seen := [][]any{}
	for _, text := range ctx.Kafka.Values(eventsTopic) {
		var value map[string]any
		ctx.NoError(json.Unmarshal([]byte(text), &value), "the payload must be JSON")
		seen = append(seen, []any{value["citation_id"], value["status"], value["reason"]})
	}
	ctx.Equal(seen, [][]any{{"c-1", "broken", "span_moved"}, {"c-2", "pending", "docstore_unavailable"}}, "a broken and a pending result must each produce an event with its status and reason (a lineage that records only verified citations hides every regression)")
	ctx.Equal(store.Get(eventsBg, "c-1").Status, "broken", "the broken result must be committed; the stored status")
}

func CheckCommitFirst(ctx *harness.Ctx) {
	result := eventsResult("doc-7", "a-1", "verified", "")
	probe := ctx.Redis.After("citation:c-1", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	eventsPublish(ctx, result)
	ctx.Settle()
	ctx.Assert(probe.Fired, "publishVerification never committed the result (no write to citation:c-1)")
	ctx.Equal(probe.Result, 0, "when the result was committed the topic already held records: a consumer reading the store on that event finds a status it does not announce. Commit first, then produce; the records at commit time")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the commit; the records")
	row := store.Get(eventsBg, "c-1")
	ctx.Assert(row.Status == "verified" && row.Version == 2 && row.Start == 12, "the store holds %+v after the commit, expected the verified result at version 2 [12, 20)", row)
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsResult("doc-7", "a-1", "verified", ""))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsResult("doc-7", "a-1", "verified", ""))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, eventsResult("doc-7", "a-1", "verified", ""))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the event is lost; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "doc-7" && rows[0].Payload["citation_id"] == "c-1", "the outbox row is %v, expected the topic, the key doc-7 and the payload", rows[0])
	ctx.Equal(ok, false, "publishVerification's result after a failed delivery")
	ctx.Equal(store.Get(eventsBg, "c-1").Status, "verified", "the result must stay committed when only the produce failed; the stored status")
	next := eventsResult("doc-7", "a-1", "verified", "")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, next)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishVerification waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["citation_id"] == "c-2", "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishVerification's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "citations/store.h"

namespace {

const std::string kEventsTopic = "citation.event";

// A stored citation, and what the verifier found for it: re-anchored into version 2.
store::Citation eventsResult(const std::string& document_id, const std::string& answer_id = "a-1", const std::string& status = "verified", const std::string& reason = "") {
  store::Citation row = store::create("t1", store::Citation{"", "", answer_id, document_id, 1, 4, 12, "Lovelace", "", ""});
  row.version = 2;
  row.start = 12;
  row.end = 20;
  row.status = status;
  row.reason = reason;
  return row;
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string eventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckDocumentKey(harness::Ctx& ctx) {
  publishVerification(eventsResult("doc-7", "a-1"));
  publishVerification(eventsResult("doc-9", "a-1"));
  publishVerification(eventsResult("doc-7", "a-2"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three publishVerification calls must produce three records on citation.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"doc-7", "doc-9", "doc-7"}, "the records must be keyed by the document ids");
  ctx.Equal(records[0].Partition, records[2].Partition, "both doc-7 events must land on one partition, or the lineage consumer applies one document's history out of order; the partitions");
}

void CheckStatusPublished(harness::Ctx& ctx) {
  publishVerification(eventsResult("doc-7", "a-1", "broken", "span_moved"));
  publishVerification(eventsResult("doc-9", "a-1", "pending", "docstore_unavailable"));
  ctx.Settle();
  std::vector<std::string> seen;
  for (const auto& text : ctx.Kafka.Values(kEventsTopic)) {
    const auto value = nlohmann::json::parse(text, nullptr, false);
    seen.push_back(eventsField(value, "citation_id") + " " + eventsField(value, "status") + " " + eventsField(value, "reason"));
  }
  ctx.Equal(seen, {"c-1 broken span_moved", "c-2 pending docstore_unavailable"}, "a broken and a pending result must each produce an event with its status and reason (a lineage that records only verified citations hides every regression)");
  ctx.Equal(store::get("c-1")->status, "broken", "the broken result must be committed; the stored status");
}

void CheckCommitFirst(harness::Ctx& ctx) {
  const store::Citation result = eventsResult("doc-7");
  size_t atCommit = 999;
  bool fired = false;
  ctx.Redis.After("citation:c-1", [&] {
    fired = true;
    atCommit = ctx.Kafka.Records(kEventsTopic).size();
  });
  publishVerification(result);
  ctx.Settle();
  ctx.Assert(fired, "publishVerification never committed the result (no write to citation:c-1)");
  ctx.Equal(atCommit, 0, "when the result was committed the topic already held records: a consumer reading the store on that event finds a status it does not announce. Commit first, then produce; the records at commit time");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "the event must still be produced after the commit; the records");
  const auto row = store::get("c-1");
  ctx.Assert(row && row->status == "verified" && row->version == 2 && row->start == 12, "the store holds %s after the commit, expected the verified result at version 2 [12, 20)", row ? store::toJson(*row).dump() : "nothing");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishVerification(eventsResult("doc-7"));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishVerification(eventsResult("doc-7"));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishVerification(eventsResult("doc-7"));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the event is lost; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == "doc-7" && rows[0].contains("payload") &&
                 eventsField(rows[0]["payload"], "citation_id") == "c-1",
             "the outbox row is %s, expected the topic, the key doc-7 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishVerification's result after a failed delivery");
  ctx.Equal(store::get("c-1")->status, "verified", "the result must stay committed when only the produce failed; the stored status");
  const store::Citation next = eventsResult("doc-7");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishVerification(next);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishVerification waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "citation_id") == "c-2",
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishVerification's result without a delivery report");
}
`,
  },
  debrief: `The key is an ordering contract and commit-then-produce is a visibility contract: the lineage consumer must see one document's history in the order it happened, and must find in the store whatever status an event announces. Publishing every status is the reason the topic exists; a lineage of successes cannot answer "when did this citation break". Waiting for the delivery report gives the return value a meaning, and the outbox turns a broker outage into a delay. The idempotent producer closes the gap waiting opens, a retry after a lost acknowledgement. Production systems write the outbox row in the same transaction as the status, so even a crash between the two cannot lose the event.`,
};
