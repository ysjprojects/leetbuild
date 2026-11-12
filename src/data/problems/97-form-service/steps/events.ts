import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Kafka: form-keyed submission events with a value hash and an outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'outbox'],
  task: `## Task

**Starting point.** The starter is \`publish_submission(submission)\`, called once a submission is
stored: it produces \`{submission_id, form_id, values}\` to \`form.submission\` keyed by the submission
id, from a producer with default settings, inside a \`try\` whose \`except KafkaException\` writes an
outbox row (\`store.outbox_insert(topic, key, payload)\`). It serves the demo and hides 5 flaws.

**Failure mode the checks target.** A consumer sees one form's submissions out of order; every email
address sits in a retained, replicated topic; a lost acknowledgement doubles an event, a failover
loses one; and a broker that rejects the record or stops answering loses the event while the
caller hears it went out.

- The record key is the **form id**: Kafka orders per partition, and a form's intake is one stream.
- The payload is \`{submission_id, form_id, field_names, value_hash}\`: \`field_names\` sorted, and
  \`value_hash\` the hex SHA-256 of the \`name=value\` lines joined by \`\\n\`, sorted by name. No value.
- The producer is **idempotent** with **\`acks=all\`** (in Go, confluent-kafka-go: kafka-go has no
  idempotent producer).
- **Wait for the delivery report**, at most \`ACK_TIMEOUT_S\` = 2 s; a failed or missing one writes
  the outbox row and returns \`False\`.`,
  sequence: {
    participants: ['Form API', 'Kafka form.submission', 'Outbox'],
    messages: [
      {
        from: 'Form API',
        to: 'Kafka form.submission',
        label: 'produce key = form_id · {field_names, value_hash} · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'Kafka form.submission', to: 'Form API', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'Kafka form.submission', to: 'Form API', label: 'rejected / no report', kind: 'reply'},
      {from: 'Form API', to: 'Outbox', label: 'outbox_insert(topic, key, payload) → False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'form-key',
      title: 'Keys form.submission by the form id',
      detail:
        'Submissions to f-1, f-2, f-1 carry those keys and the two f-1 events share a partition. The starter keys by submission id, which spreads one form over every partition.',
      match: {
        python: {all: [/producer\.produce\(\s*[^\n]*key\s*=\s*submission\[["']form_id["']\]/]},
        typescript: {all: [/key:\s*submission\.form_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*submission\.FormID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*Topic\s*,\s*submission\.formId\s*,/]},
        cpp: {all: [/submission\.form_id\.c_str\(\)\s*,\s*submission\.form_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'value-hash',
      title: 'Carries field names and a value hash',
      detail:
        'The payload names the fields (`field_names`, sorted) and carries `value_hash`, the SHA-256 of the sorted `name=value` lines, so a consumer can match or deduplicate a submission without its values. The starter sends neither.',
      match: {
        python: {all: [/hashlib\.sha256\(/, /["']value_hash["']/, /["']field_names["']/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /value_hash:/, /field_names:/]},
        go: {all: [/sha256\.Sum256\(|sha256\.New\(/, /"value_hash"/, /"field_names"/]},
        scala: {all: [/MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/, /"value_hash"/, /"field_names"/]},
        cpp: {all: [/SHA256\(/, /"value_hash"/, /"field_names"/]},
      },
    },
    {
      id: 'no-raw-values',
      title: 'No submitted value in the event',
      detail:
        'No value a submitter typed (a name, an email address) appears in the record: the topic is retained and replicated beyond every deletion the form store honours. The starter puts the whole `values` map in the payload.',
      match: {
        python: {none: [/["']values["']\s*:/]},
        typescript: {none: [/\bvalues:\s*submission\.values/]},
        go: {none: [/"values":/]},
        scala: {none: [/"values"\s*->/]},
        cpp: {none: [/\{\s*"values"\s*,/]},
      },
    },
    {
      id: 'producer-durable',
      title: 'Idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter keeps the client defaults, which are not idempotent.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A rejected delivery, or no report within 2 s, writes an outbox row with the topic, the key and the payload, and the call returns false; the report arrives through the delivery callback (`on_delivery`, an awaited `send`, the `Produce` event channel, a `get` with a timeout, `dr_cb`). The starter catches only errors raised while enqueueing, which a broker rejection never is.',
      match: {
        python: {
          all: [/store\.outbox_insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/outboxInsert\(/, /await producer\.send\(/], none: [/void producer\.send\(/]},
        go: {all: [/store\.OutboxInsert\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.outboxInsert\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/store::outboxInsert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from forms import store  # store.outbox_insert

TOPIC = "form.submission"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def event_payload(submission: dict) -> dict:
    return {"submission_id": submission["submission_id"], "form_id": submission["form_id"], "values": submission["values"]}


def publish_submission(submission: dict) -> bool:
    """Tell downstream consumers about a stored submission; True when the event went out."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = event_payload(submission)
    try:
        producer.produce(TOPIC, key=submission["submission_id"], value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        store.outbox_insert(TOPIC, submission["submission_id"], payload)
        return False
    return True
`,
      solution: `import hashlib
import json

from confluent_kafka import Producer

from forms import store  # store.outbox_insert

TOPIC = "form.submission"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def value_hash(values: dict) -> str:
    """SHA-256 of the name=value lines, sorted by name: equal submissions hash alike, and no value leaves."""
    canonical = "\\n".join(f"{name}={values[name]}" for name in sorted(values))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def event_payload(submission: dict) -> dict:
    values = submission["values"]
    return {
        "submission_id": submission["submission_id"],
        "form_id": submission["form_id"],
        "field_names": sorted(values),
        "value_hash": value_hash(values),
    }


def publish_submission(submission: dict) -> bool:
    """Tell downstream consumers about a stored submission; True once the broker acknowledged the event."""
    payload = event_payload(submission)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=submission["form_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so consumers hear late, not never.
        store.outbox_insert(TOPIC, submission["form_id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Submission, outboxInsert} from 'forms/store';

export const TOPIC = 'form.submission';

const kafka = new Kafka({clientId: 'formd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export function eventPayload(submission: Submission) {
  return {submission_id: submission.submission_id, form_id: submission.form_id, values: submission.values};
}

/** Tell downstream consumers about a stored submission; true when the event went out. */
export async function publishSubmission(submission: Submission): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const payload = eventPayload(submission);
  try {
    void producer.send({topic: TOPIC, messages: [{key: submission.submission_id, value: JSON.stringify(payload)}]});
  } catch {
    await outboxInsert(TOPIC, submission.submission_id, payload);
    return false;
  }
  return true;
}
`,
      solution: `import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {type Submission, outboxInsert} from 'forms/store';

export const TOPIC = 'form.submission';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'formd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** SHA-256 of the name=value lines, sorted by name: equal submissions hash alike, and no value leaves. */
export function valueHash(values: Record<string, string>): string {
  const canonical = Object.keys(values)
    .sort()
    .map(name => \`\${name}=\${values[name]}\`)
    .join('\\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function eventPayload(submission: Submission) {
  return {
    submission_id: submission.submission_id,
    form_id: submission.form_id,
    field_names: Object.keys(submission.values).sort(),
    value_hash: valueHash(submission.values),
  };
}

/** Tell downstream consumers about a stored submission; true once the broker acknowledged the event. */
export async function publishSubmission(submission: Submission): Promise<boolean> {
  const payload = eventPayload(submission);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: submission.form_id, value: JSON.stringify(payload)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so consumers hear late, not never.
    await outboxInsert(TOPIC, submission.form_id, payload);
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

	"forms/store" // store.Submission, store.OutboxInsert
)

const topic = "form.submission"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

func eventPayload(submission store.Submission) map[string]any {
	return map[string]any{"submission_id": submission.SubmissionID, "form_id": submission.FormID, "values": submission.Values}
}

// publishSubmission tells downstream consumers about a stored submission; true when the event went out.
func publishSubmission(ctx context.Context, submission store.Submission) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	payload := eventPayload(submission)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(submission.SubmissionID), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, store.OutboxInsert(ctx, topic, submission.SubmissionID, payload)
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"forms/store" // store.Submission, store.OutboxInsert
)

const (
	topic      = "form.submission"
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

// fieldNames is the submission's field names, sorted.
func fieldNames(values map[string]string) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// valueHash is the SHA-256 of the name=value lines, sorted by name: equal submissions hash alike, and no value leaves.
func valueHash(values map[string]string) string {
	lines := []string{}
	for _, name := range fieldNames(values) {
		lines = append(lines, name+"="+values[name])
	}
	sum := sha256.Sum256([]byte(strings.Join(lines, "\\n")))
	return hex.EncodeToString(sum[:])
}

func eventPayload(submission store.Submission) map[string]any {
	return map[string]any{
		"submission_id": submission.SubmissionID,
		"form_id":       submission.FormID,
		"field_names":   fieldNames(submission.Values),
		"value_hash":    valueHash(submission.Values),
	}
}

// publishSubmission tells downstream consumers about a stored submission; true once the broker acknowledged the event.
func publishSubmission(ctx context.Context, submission store.Submission) (bool, error) {
	payload := eventPayload(submission)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(submission.FormID), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so consumers hear late, not never.
		return false, store.OutboxInsert(ctx, topic, submission.FormID, payload)
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import forms.Store // Store.Submission, Store.outboxInsert

object SubmissionEvents {
  val Topic = "form.submission"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventPayload(submission: Store.Submission): JsObject =
    JsObject(
      "submission_id" -> JsString(submission.submissionId),
      "form_id" -> JsString(submission.formId),
      "values" -> JsObject(submission.values.map { case (k, v) => k -> JsString(v) })
    )

  /** Tell downstream consumers about a stored submission; true when the event went out. */
  def publishSubmission(submission: Store.Submission): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val payload = eventPayload(submission)
    try {
      producer.send(new ProducerRecord[String, String](Topic, submission.submissionId, payload.compactPrint))
      true
    } catch {
      case _: KafkaException =>
        Store.outboxInsert(Topic, submission.submissionId, payload)
        false
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import forms.Store // Store.Submission, Store.outboxInsert

object SubmissionEvents {
  val Topic = "form.submission"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** SHA-256 of the name=value lines, sorted by name: equal submissions hash alike, and no value leaves. */
  def valueHash(values: Map[String, String]): String = {
    val canonical = values.keys.toSeq.sorted.map(name => s"$name=\${values(name)}").mkString("\\n")
    MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(UTF_8)).map(b => f"$b%02x").mkString
  }

  def eventPayload(submission: Store.Submission): JsObject =
    JsObject(
      "submission_id" -> JsString(submission.submissionId),
      "form_id" -> JsString(submission.formId),
      "field_names" -> JsArray(submission.values.keys.toSeq.sorted.map(JsString(_)).toVector),
      "value_hash" -> JsString(valueHash(submission.values))
    )

  /** Tell downstream consumers about a stored submission; true once the broker acknowledged the event. */
  def publishSubmission(submission: Store.Submission): Boolean = {
    val payload = eventPayload(submission)
    val record = new ProducerRecord[String, String](Topic, submission.formId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so consumers hear late, not never.
      Store.outboxInsert(Topic, submission.formId, payload)
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

#include "forms/store.h"  // store::Submission, store::outboxInsert

using json = nlohmann::json;

const std::string kTopic = "form.submission";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventPayload(const store::Submission& submission) {
  return json{{"submission_id", submission.submission_id}, {"form_id", submission.form_id}, {"values", submission.values}};
}

// Tell downstream consumers about a stored submission; true when the event went out.
bool publishSubmission(const store::Submission& submission) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const json payload = eventPayload(submission);
  const std::string value = payload.dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), submission.submission_id.c_str(), submission.submission_id.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store::outboxInsert(kTopic, submission.submission_id, payload);
    return false;
  }
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#include "forms/store.h"  // store::Submission, store::outboxInsert

using json = nlohmann::json;

const std::string kTopic = "form.submission";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishSubmission produces one record and waits for it.
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

// SHA-256 of the name=value lines, sorted by name: equal submissions hash alike, and no value leaves.
std::string valueHash(const std::map<std::string, std::string>& values) {
  std::string canonical;
  for (const auto& [name, value] : values) canonical += (canonical.empty() ? "" : "\\n") + name + "=" + value;  // std::map is sorted
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(canonical.data()), canonical.size(), digest);
  std::string hex;
  char byte[3];
  for (const unsigned char b : digest) {
    std::snprintf(byte, sizeof byte, "%02x", b);
    hex += byte;
  }
  return hex;
}

json eventPayload(const store::Submission& submission) {
  std::vector<std::string> names;
  for (const auto& [name, value] : submission.values) names.push_back(name);
  return json{{"submission_id", submission.submission_id},
              {"form_id", submission.form_id},
              {"field_names", names},
              {"value_hash", valueHash(submission.values)}};
}

// Tell downstream consumers about a stored submission; true once the broker acknowledged the event.
bool publishSubmission(const store::Submission& submission) {
  const json payload = eventPayload(submission);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), submission.form_id.c_str(), submission.form_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so consumers hear late, not never.
    store::outboxInsert(kTopic, submission.form_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

TOPIC = "form.submission"


def _submission(n, form="f-1"):
    values = {"name": "Ada Lovelace", "email": f"ada{n}@example.com", "message": "Call me back"}
    return {"submission_id": f"sub-{n}", "form_id": form, "seq": n, "values": values}


def _hash(values):
    return hashlib.sha256("\\n".join(f"{name}={values[name]}" for name in sorted(values)).encode("utf-8")).hexdigest()


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def _one(ctx):
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish_submission produced {len(records)} records on form.submission (topics: {sorted(ctx.kafka.topics)})"
    return records[0]


def check_form_key(ctx):
    m = ctx.load("events")
    for n, form in ((1, "f-1"), (2, "f-2"), (3, "f-1")):
        m.publish_submission(_submission(n, form))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_submission calls produced {len(records)} records on form.submission (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"f-1", b"f-2", b"f-1"], f"the records are keyed {keys}, expected the form ids f-1, f-2, f-1"
    assert records[0].partition == records[2].partition, "both f-1 events must land on one partition, or a consumer sees one form's intake out of order"


def check_value_hash(ctx):
    m = ctx.load("events")
    submission = _submission(1)
    m.publish_submission(submission)
    value = json.loads(_one(ctx).value)
    assert value.get("submission_id") == "sub-1" and value.get("form_id") == "f-1", f"the payload is {value}, expected submission_id and form_id"
    assert value.get("field_names") == ["email", "message", "name"], f"the payload's field_names is {value.get('field_names')!r}, expected the sorted names ['email', 'message', 'name']"
    assert value.get("value_hash") == _hash(submission["values"]), f"the payload's value_hash is {value.get('value_hash')!r}, expected the hex SHA-256 of the sorted name=value lines"


def check_no_raw_values(ctx):
    m = ctx.load("events")
    submission = _submission(1)
    m.publish_submission(submission)
    text = _one(ctx).value.decode("utf-8")
    leaked = [v for v in submission["values"].values() if v in text]
    assert not leaked, f"the event carries {leaked}: a retained, replicated topic now holds what the submitter typed. Send field names and a hash"


def check_producer_durable(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_submission(_submission(1))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_submission(_submission(2))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_reject(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)  # the broker rejects the record
    ok = m.publish_submission(_submission(1))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: nothing downstream will ever hear about sub-1"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "f-1" and row.get("payload", {}).get("submission_id") == "sub-1", f"the outbox row is {row}, expected the topic, the key f-1 and the payload"
    assert ok is False, f"publish_submission returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_submission(_submission(2))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_submission waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("submission_id") == "sub-2", f"no report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_submission returned {ok!r} without a delivery report, expected False"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'form.submission';

const submission = (n: number, form = 'f-1') => ({
  submission_id: \`sub-\${n}\`,
  form_id: form,
  seq: n,
  values: {name: 'Ada Lovelace', email: \`ada\${n}@example.com\`, message: 'Call me back'},
});

const hashOf = (values: Record<string, string>): string =>
  createHash('sha256')
    .update(
      Object.keys(values)
        .sort()
        .map(name => \`\${name}=\${values[name]}\`)
        .join('\\n'),
      'utf8',
    )
    .digest('hex');

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function one(ctx): string {
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publishSubmission produced \${values.length} records on form.submission\`);
  return values[0];
}

export async function check_form_key(ctx) {
  const m = ctx.load('events');
  await m.publishSubmission(submission(1, 'f-1'));
  await m.publishSubmission(submission(2, 'f-2'));
  await m.publishSubmission(submission(3, 'f-1'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishSubmission calls produced \${records.length} records on form.submission\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['f-1', 'f-2', 'f-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the form ids f-1, f-2, f-1\`);
  assert.equal(records[0].partition, records[2].partition, "both f-1 events must land on one partition, or a consumer sees one form's intake out of order");
}

export async function check_value_hash(ctx) {
  const m = ctx.load('events');
  const s = submission(1);
  await m.publishSubmission(s);
  await settle();
  const value = JSON.parse(one(ctx));
  assert(value.submission_id === 'sub-1' && value.form_id === 'f-1', \`the payload is \${JSON.stringify(value)}, expected submission_id and form_id\`);
  assert.deepEqual(value.field_names, ['email', 'message', 'name'], \`the payload's field_names is \${JSON.stringify(value.field_names)}, expected the sorted names\`);
  assert.equal(value.value_hash, hashOf(s.values), \`the payload's value_hash is \${JSON.stringify(value.value_hash)}, expected the hex SHA-256 of the sorted name=value lines\`);
}

export async function check_no_raw_values(ctx) {
  const m = ctx.load('events');
  const s = submission(1);
  await m.publishSubmission(s);
  await settle();
  const text = one(ctx);
  const leaked = Object.values(s.values).filter(v => text.includes(v));
  assert.equal(leaked.length, 0, \`the event carries \${JSON.stringify(leaked)}: a retained, replicated topic now holds what the submitter typed. Send field names and a hash\`);
}

export async function check_producer_durable(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishSubmission(submission(1));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publishSubmission(submission(2));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_reject(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1); // the broker rejects the record
  let ok = await m.publishSubmission(submission(1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: nothing downstream will ever hear about sub-1\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'f-1' && rows[0].payload?.submission_id === 'sub-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key f-1 and the payload\`);
  assert.equal(ok, false, \`publishSubmission resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishSubmission(submission(2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishSubmission waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.submission_id === 'sub-2', \`no report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishSubmission resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"forms/store"

	"leetbuild/harness"
)

const eventsTopic = "form.submission"

func eventsSubmission(n int, form string) store.Submission {
	return store.Submission{SubmissionID: fmt.Sprintf("sub-%d", n), FormID: form, Seq: int64(n),
		Values: map[string]string{"name": "Ada Lovelace", "email": fmt.Sprintf("ada%d@example.com", n), "message": "Call me back"}}
}

func eventsHash(values map[string]string) string {
	names := []string{}
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	lines := []string{}
	for _, name := range names {
		lines = append(lines, name+"="+values[name])
	}
	sum := sha256.Sum256([]byte(strings.Join(lines, "\\n")))
	return hex.EncodeToString(sum[:])
}

func eventsPublish(ctx *harness.Ctx, s store.Submission) bool {
	ok, err := publishSubmission(context.Background(), s)
	ctx.NoError(err, "publishSubmission")
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

func eventsOne(ctx *harness.Ctx) string {
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one publishSubmission must produce one record on form.submission; the records")
	return values[0]
}

func CheckFormKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsSubmission(1, "f-1"))
	eventsPublish(ctx, eventsSubmission(2, "f-2"))
	eventsPublish(ctx, eventsSubmission(3, "f-1"))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three publishSubmission calls must produce three records on form.submission; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"f-1", "f-2", "f-1"}, "the records must be keyed by the form ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both f-1 events must land on one partition, or a consumer sees one form's intake out of order; the partitions")
}

func CheckValueHash(ctx *harness.Ctx) {
	s := eventsSubmission(1, "f-1")
	eventsPublish(ctx, s)
	ctx.Settle()
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(eventsOne(ctx)), &value), "the payload must be JSON")
	ctx.Assert(value["submission_id"] == "sub-1" && value["form_id"] == "f-1", "the payload is %v, expected submission_id and form_id", value)
	ctx.Equal(value["field_names"], []any{"email", "message", "name"}, "the payload's field_names (sorted)")
	ctx.Equal(value["value_hash"], eventsHash(s.Values), "the payload's value_hash: the hex SHA-256 of the sorted name=value lines")
}

func CheckNoRawValues(ctx *harness.Ctx) {
	s := eventsSubmission(1, "f-1")
	eventsPublish(ctx, s)
	ctx.Settle()
	text := eventsOne(ctx)
	var leaked []string
	for _, v := range s.Values {
		if strings.Contains(text, v) {
			leaked = append(leaked, v)
		}
	}
	sort.Strings(leaked)
	ctx.Assert(len(leaked) == 0, "the event carries %q: a retained, replicated topic now holds what the submitter typed. Send field names and a hash", leaked)
}

func CheckProducerDurable(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsSubmission(1, "f-1"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsSubmission(2, "f-1"))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnReject(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1) // the broker rejects the record
	ok := eventsPublish(ctx, eventsSubmission(1, "f-1"))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row nothing downstream will ever hear about sub-1; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "f-1" && rows[0].Payload["submission_id"] == "sub-1", "the outbox row is %v, expected the topic, the key f-1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishSubmission's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsSubmission(2, "f-1"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishSubmission waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["submission_id"] == "sub-2", "no report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishSubmission's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <cstdio>
#include <string>
#include <vector>

#include "forms/store.h"

namespace {

const std::string kEventsTopic = "form.submission";

store::Submission eventsSubmission(int n, const std::string& form = "f-1") {
  return store::Submission{"sub-" + std::to_string(n), form, n,
                           {{"name", "Ada Lovelace"}, {"email", "ada" + std::to_string(n) + "@example.com"}, {"message", "Call me back"}}};
}

std::string eventsHash(const std::map<std::string, std::string>& values) {
  std::string canonical;
  for (const auto& [name, value] : values) canonical += (canonical.empty() ? "" : "\\n") + name + "=" + value;
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(canonical.data()), canonical.size(), digest);
  std::string hex;
  char byte[3];
  for (const unsigned char b : digest) {
    std::snprintf(byte, sizeof byte, "%02x", b);
    hex += byte;
  }
  return hex;
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

std::string eventsOne(harness::Ctx& ctx) {
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one publishSubmission must produce one record on form.submission; the records");
  return values[0];
}

}  // namespace

void CheckFormKey(harness::Ctx& ctx) {
  publishSubmission(eventsSubmission(1, "f-1"));
  publishSubmission(eventsSubmission(2, "f-2"));
  publishSubmission(eventsSubmission(3, "f-1"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three publishSubmission calls must produce three records on form.submission; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"f-1", "f-2", "f-1"}, "the records must be keyed by the form ids");
  ctx.Equal(records[0].Partition, records[2].Partition, "both f-1 events must land on one partition, or a consumer sees one form's intake out of order; the partitions");
}

void CheckValueHash(harness::Ctx& ctx) {
  const auto s = eventsSubmission(1);
  publishSubmission(s);
  ctx.Settle();
  const auto value = nlohmann::json::parse(eventsOne(ctx), nullptr, false);
  ctx.Assert(eventsField(value, "submission_id") == "sub-1" && eventsField(value, "form_id") == "f-1", "the payload is %s, expected submission_id and form_id", value.dump());
  ctx.Equal(value.is_object() && value.contains("field_names") ? value["field_names"] : nlohmann::json(), nlohmann::json{"email", "message", "name"}, "the payload's field_names (sorted)");
  ctx.Equal(eventsField(value, "value_hash"), eventsHash(s.values), "the payload's value_hash: the hex SHA-256 of the sorted name=value lines");
}

void CheckNoRawValues(harness::Ctx& ctx) {
  const auto s = eventsSubmission(1);
  publishSubmission(s);
  ctx.Settle();
  const std::string text = eventsOne(ctx);
  std::vector<std::string> leaked;
  for (const auto& [name, value] : s.values) {
    if (text.find(value) != std::string::npos) leaked.push_back(value);
  }
  ctx.Assert(leaked.empty(), "the event carries %q: a retained, replicated topic now holds what the submitter typed. Send field names and a hash", leaked);
}

void CheckProducerDurable(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishSubmission(eventsSubmission(1));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishSubmission(eventsSubmission(2));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnReject(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);  // the broker rejects the record
  bool ok = publishSubmission(eventsSubmission(1));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row nothing downstream will ever hear about sub-1; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == "f-1" && rows[0].contains("payload") &&
                 eventsField(rows[0]["payload"], "submission_id") == "sub-1",
             "the outbox row is %s, expected the topic, the key f-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishSubmission's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishSubmission(eventsSubmission(2));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishSubmission waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "submission_id") == "sub-2",
             "no report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishSubmission's result without a delivery report");
}
`,
  },
  hints: [
    'Publish two submissions to one form: they land on two partitions. Read the topic: every email address is there. Reject the record at the broker: the caller gets True and the outbox stays empty.',
    'The key picks the partition, and the key is the submission id. The payload is built from `values`. And `except KafkaException` only sees errors raised while enqueueing; a broker rejection arrives later, in a delivery report nobody reads.',
    'Key by `form_id`; send `field_names` and `value_hash` (SHA-256 of sorted `name=value` lines); set `acks=all` and `enable.idempotence`; produce with `on_delivery`, `flush(ACK_TIMEOUT_S)`, and write the outbox row on an error or a record still in flight.',
  ],
  debrief: `The key is an ordering contract: Kafka orders within a partition, so whatever is the key is what consumers see in order, and for intake that is the form. The payload carries names and a hash because the topic outlives the store's deletion rules; a consumer that needs a value reads it from the store, where access is checked and erasure works. The delivery report is the only place a broker rejection appears, which is why waiting on it, and not a try around the produce call, decides whether the outbox row is written. Writing the outbox row in the same transaction as the submission and letting a relay do every produce removes the broker from the request path entirely; the hash also wants a per-form salt, or a short field like a postcode can be found by hashing every candidate.`,
};
