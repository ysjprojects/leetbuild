import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'feedback.recorded keyed by tenant, with a fingerprint and an outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['collector', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** \`events\` exposes \`publish_recorded(row)\`, which turns a stored, attributed
feedback row (the \`feedback:{id}\` fields with \`model_version\`, \`prompt_version\` and \`route\` filled
in) into one \`feedback.recorded\` event: it copies the ids, rating, attribution and comment into the
payload, produces it keyed by \`request_id\` from a \`producer\` with \`acks=1\`, and calls
\`store.insert_outbox(event)\` when the produce call raises. It publishes the demo and hides four flaws.

**Failure mode the checks target.** One tenant's events spread over every partition and reach the
quality consumer out of order; the retained, replicated topic holds comment text no retention rule
reaches; a leader failover right after the write loses the event; and a refusal the broker reports
later does not reach the outbox.

- Key every record by \`tenant\`.
- The payload carries \`feedback_id\`, \`tenant\`, \`request_id\`, \`rating\`, \`model_version\`,
  \`prompt_version\`, \`route\` and \`comment_fingerprint\`, the SHA-256 hex of the comment's UTF-8
  bytes; no \`comment\`.
- The producer uses \`acks=all\` (kafkajs \`acks: -1\`, kafka-go \`RequireAll\`).
- A refused delivery, as the delivery report gives it (\`on_delivery\`, the rejected \`send\`, the
  returned write error, \`dr_cb\`, the \`Callback\`), goes to \`store.insert_outbox\`;
  \`publish_recorded\` does not raise.`,
  sequence: {
    participants: ['feedbackd', 'feedback.recorded', 'outbox', 'Quality consumer'],
    messages: [
      {
        from: 'feedbackd',
        to: 'feedback.recorded',
        label: 'produce key=t-acme · acks=all · {ids, rating, attribution, comment_fingerprint}',
        kind: 'async',
      },
      {from: 'feedback.recorded', to: 'feedbackd', label: 'delivery report: error', kind: 'reply'},
      {from: 'feedbackd', to: 'outbox', label: 'insert_outbox(event)', kind: 'sync'},
      {
        from: 'feedback.recorded',
        to: 'Quality consumer',
        label: "consume: one tenant's events in order",
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant',
      detail:
        "Every record is keyed by the tenant, so one tenant's events share a partition and arrive in order; the starter keys by request id and spreads a tenant over every partition.",
      match: {
        python: {
          all: [/produce\([^)]*key\s*=\s*row\[["']tenant["']\]/],
          none: [/key\s*=\s*row\[["']request_id["']\]/],
        },
        typescript: {all: [/key:\s*row\.tenant\b/], none: [/key:\s*row\.request_id\b/]},
        go: {all: [/Key:\s*\[\]byte\(\s*row\.Tenant\s*\)/], none: [/Key:\s*\[\]byte\(\s*row\.RequestID\s*\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(\s*Topic\s*,\s*row\.tenant\s*,/],
          none: [/Topic\s*,\s*row\.requestId/],
        },
        cpp: {
          all: [/produce\([\s\S]{0,400}?row\.tenant\.(c_str|data)\(\)/],
          none: [/produce\([\s\S]{0,400}?row\.request_id\.(c_str|data)\(\)/],
        },
      },
    },
    {
      id: 'comment-fingerprint',
      title: 'A comment fingerprint, not the comment',
      detail:
        'The payload carries `comment_fingerprint`, the SHA-256 hex of the comment, and no comment text: the topic is retained and copied to every consumer, so text written there outlives the row it came from.',
      match: {
        python: {all: [/comment_fingerprint/, /sha256\(/], none: [/["']comment["']\s*:/]},
        typescript: {
          all: [/comment_fingerprint/, /createHash\(\s*['"]sha256['"]\s*\)/],
          none: [/\bcomment:\s*row\.comment/],
        },
        go: {all: [/comment_fingerprint/, /sha256\.Sum256\(/], none: [/json:"comment"/]},
        scala: {all: [/comment_fingerprint/, /SHA-256/], none: [/"comment"\s*->/]},
        cpp: {all: [/comment_fingerprint/, /sha256_hex\(/], none: [/\{"comment",/]},
      },
    },
    {
      id: 'acks-all',
      title: 'Every replica has the event before it counts',
      detail:
        'The producer writes with `acks=all`, so a leader that fails right after the write cannot take the event with it; the starter acknowledges on the leader alone (`acks=1`).',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/]},
        typescript: {all: [/acks:\s*-1/], none: [/acks:\s*[01]\b/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"acks",\s*"(all|-1)"/]},
        cpp: {all: [/"acks",\s*"(all|-1)"/]},
      },
    },
    {
      id: 'outbox',
      title: 'A refused delivery goes to the outbox',
      detail:
        "The event goes to `store.insert_outbox` from where the broker's answer arrives (the delivery callback, the rejected send, the returned write error); the starter wraps the enqueue in a `try`, which a refusal reported later never reaches.",
      match: {
        python: {
          all: [/on_delivery\s*=|callback\s*=/, /store\.insert_outbox\(/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(|\.catch\(/]},
        go: {all: [/store\.InsertOutbox\(/]},
        scala: {all: [/Store\.insertOutbox\(/, /onCompletion/], none: [/case\s+\w+:\s*KafkaException/]},
        cpp: {all: [/store::insertOutbox\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import KafkaException, Producer

from feedback import store  # insert_outbox

TOPIC = "feedback.recorded"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_recorded(row: dict) -> dict:
    """Produce one feedback.recorded event for a stored, attributed feedback row; returns the event."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    event = {
        "feedback_id": row["feedback_id"],
        "tenant": row["tenant"],
        "request_id": row["request_id"],
        "rating": row["rating"],
        "model_version": row["model_version"],
        "prompt_version": row["prompt_version"],
        "route": row["route"],
        "comment": row["comment"],
    }
    try:
        producer.produce(TOPIC, key=row["request_id"], value=json.dumps(event))
        producer.poll(0)
    except KafkaException as err:
        store.insert_outbox(event)
        log.warning("feedback.recorded produce failed feedback=%s: %s", row["feedback_id"], err)
    return event
`,
      solution: `import hashlib
import json
import logging

from confluent_kafka import Producer

from feedback import store  # insert_outbox

TOPIC = "feedback.recorded"
log = logging.getLogger("events")

# acks=all: the event counts once every in-sync replica has it.
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def publish_recorded(row: dict) -> dict:
    """Produce one feedback.recorded event for a stored, attributed feedback row; returns the event."""
    event = {
        "feedback_id": row["feedback_id"],
        "tenant": row["tenant"],
        "request_id": row["request_id"],
        "rating": row["rating"],
        "model_version": row["model_version"],
        "prompt_version": row["prompt_version"],
        "route": row["route"],
        "comment_fingerprint": hashlib.sha256(row["comment"].encode("utf-8")).hexdigest(),
    }

    def on_delivery(err, msg) -> None:
        if err is not None:
            store.insert_outbox(event)  # the broker refused it: the relay produces it later
            log.warning("feedback.recorded produce failed feedback=%s: %s", row["feedback_id"], err)

    producer.produce(TOPIC, key=row["tenant"], value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)  # serve the delivery reports already in; returns at once
    return event
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Feedback, insertOutbox} from 'feedback/store';

export const TOPIC = 'feedback.recorded';

const kafka = new Kafka({clientId: 'feedbackd', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();

/** Produce one feedback.recorded event for a stored, attributed feedback row; returns the event. */
export async function publishRecorded(row: Feedback): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const event = {
    feedback_id: row.feedback_id,
    tenant: row.tenant,
    request_id: row.request_id,
    rating: row.rating,
    model_version: row.model_version,
    prompt_version: row.prompt_version,
    route: row.route,
    comment: row.comment,
  };
  try {
    void producer.send({topic: TOPIC, messages: [{key: row.request_id, value: JSON.stringify(event)}], acks: 1});
  } catch (err) {
    await insertOutbox(event);
    console.warn(\`feedback.recorded produce failed feedback=\${row.feedback_id}: \${(err as Error).message}\`);
  }
  return event;
}
`,
      solution: `import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {type Feedback, insertOutbox} from 'feedback/store';

export const TOPIC = 'feedback.recorded';

const kafka = new Kafka({clientId: 'feedbackd', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();

/** Produce one feedback.recorded event for a stored, attributed feedback row; returns the event. */
export async function publishRecorded(row: Feedback): Promise<Record<string, unknown>> {
  const event = {
    feedback_id: row.feedback_id,
    tenant: row.tenant,
    request_id: row.request_id,
    rating: row.rating,
    model_version: row.model_version,
    prompt_version: row.prompt_version,
    route: row.route,
    comment_fingerprint: createHash('sha256').update(row.comment).digest('hex'),
  };
  try {
    // acks -1 (all): the event counts once every in-sync replica has it.
    await producer.send({topic: TOPIC, messages: [{key: row.tenant, value: JSON.stringify(event)}], acks: -1});
  } catch (err) {
    // The rejected send is the broker's answer: the relay produces the event later.
    await insertOutbox(event);
    console.warn(\`feedback.recorded produce failed feedback=\${row.feedback_id}: \${(err as Error).message}\`);
  }
  return event;
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

	"feedback/store" // store.Feedback, InsertOutbox
)

const topic = "feedback.recorded"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
}

type recordedEvent struct {
	FeedbackID    string \`json:"feedback_id"\`
	Tenant        string \`json:"tenant"\`
	RequestID     string \`json:"request_id"\`
	Rating        int    \`json:"rating"\`
	ModelVersion  string \`json:"model_version"\`
	PromptVersion string \`json:"prompt_version"\`
	Route         string \`json:"route"\`
	Comment       string \`json:"comment"\`
}

// publishRecorded produces one feedback.recorded event for a stored, attributed feedback row.
func publishRecorded(ctx context.Context, row store.Feedback) error {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	event, err := json.Marshal(recordedEvent{
		FeedbackID: row.FeedbackID, Tenant: row.Tenant, RequestID: row.RequestID, Rating: row.Rating,
		ModelVersion: row.ModelVersion, PromptVersion: row.PromptVersion, Route: row.Route, Comment: row.Comment,
	})
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(row.RequestID), Value: event}); err != nil {
		log.Printf("feedback.recorded produce failed feedback=%s: %v", row.FeedbackID, err)
	}
	return nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"

	"feedback/store" // store.Feedback, InsertOutbox
)

const topic = "feedback.recorded"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll, // the event counts once every in-sync replica has it
}

type recordedEvent struct {
	FeedbackID         string \`json:"feedback_id"\`
	Tenant             string \`json:"tenant"\`
	RequestID          string \`json:"request_id"\`
	Rating             int    \`json:"rating"\`
	ModelVersion       string \`json:"model_version"\`
	PromptVersion      string \`json:"prompt_version"\`
	Route              string \`json:"route"\`
	CommentFingerprint string \`json:"comment_fingerprint"\`
}

// publishRecorded produces one feedback.recorded event for a stored, attributed feedback row.
func publishRecorded(ctx context.Context, row store.Feedback) error {
	sum := sha256.Sum256([]byte(row.Comment))
	event, err := json.Marshal(recordedEvent{
		FeedbackID: row.FeedbackID, Tenant: row.Tenant, RequestID: row.RequestID, Rating: row.Rating,
		ModelVersion: row.ModelVersion, PromptVersion: row.PromptVersion, Route: row.Route,
		CommentFingerprint: hex.EncodeToString(sum[:]),
	})
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(row.Tenant), Value: event}); err != nil {
		// The returned error is the broker's answer: the relay produces the event later.
		log.Printf("feedback.recorded produce failed feedback=%s: %v", row.FeedbackID, err)
		return store.InsertOutbox(ctx, event)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import feedback.Store // Store.Feedback, insertOutbox

object Events {
  val Topic = "feedback.recorded"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Produce one feedback.recorded event for a stored, attributed feedback row; returns the event. */
  def publishRecorded(row: Store.Feedback): JsObject = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val event = JsObject(
      "feedback_id" -> JsString(row.feedbackId),
      "tenant" -> JsString(row.tenant),
      "request_id" -> JsString(row.requestId),
      "rating" -> JsNumber(row.rating),
      "model_version" -> JsString(row.modelVersion),
      "prompt_version" -> JsString(row.promptVersion),
      "route" -> JsString(row.route),
      "comment" -> JsString(row.comment))
    try {
      producer.send(new ProducerRecord[String, String](Topic, row.requestId, event.compactPrint))
    } catch {
      case e: KafkaException =>
        Store.insertOutbox(event.compactPrint)
        System.err.println(s"feedback.recorded produce failed feedback=\${row.feedbackId}: \${e.getMessage}")
    }
    event
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import feedback.Store // Store.Feedback, insertOutbox

object Events {
  val Topic = "feedback.recorded"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all") // the event counts once every in-sync replica has it
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Produce one feedback.recorded event for a stored, attributed feedback row; returns the event. */
  def publishRecorded(row: Store.Feedback): JsObject = {
    val fingerprint = MessageDigest.getInstance("SHA-256").digest(row.comment.getBytes(UTF_8)).map("%02x".format(_)).mkString
    val event = JsObject(
      "feedback_id" -> JsString(row.feedbackId),
      "tenant" -> JsString(row.tenant),
      "request_id" -> JsString(row.requestId),
      "rating" -> JsNumber(row.rating),
      "model_version" -> JsString(row.modelVersion),
      "prompt_version" -> JsString(row.promptVersion),
      "route" -> JsString(row.route),
      "comment_fingerprint" -> JsString(fingerprint))
    val toOutbox = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) {
          Store.insertOutbox(event.compactPrint) // the broker refused it: the relay produces it later
          System.err.println(s"feedback.recorded produce failed feedback=\${row.feedbackId}: \${exception.getMessage}")
        }
    }
    producer.send(new ProducerRecord[String, String](Topic, row.tenant, event.compactPrint), toOutbox)
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
#include <string>

#include "feedback/store.h"  // store::Feedback, insertOutbox

const std::string kTopic = "feedback.recorded";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Produce one feedback.recorded event for a stored, attributed feedback row; returns the event.
nlohmann::json publish_recorded(const store::Feedback& row) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const nlohmann::json event = {{"feedback_id", row.feedback_id},     {"tenant", row.tenant},
                                {"request_id", row.request_id},       {"rating", row.rating},
                                {"model_version", row.model_version}, {"prompt_version", row.prompt_version},
                                {"route", row.route},                 {"comment", row.comment}};
  const std::string value = event.dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), row.request_id.data(), row.request_id.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(value);
    std::cerr << "feedback.recorded produce failed feedback=" << row.feedback_id << ": " << RdKafka::err2str(err) << "\\n";
  }
  producer->poll(0);
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "digest.h"          // sha256_hex
#include "feedback/store.h"  // store::Feedback, insertOutbox

const std::string kTopic = "feedback.recorded";

// The delivery report is the broker's answer: a refused event goes to the outbox for the relay.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    store::insertOutbox(std::string(static_cast<const char*>(message.payload()), message.len()));
    std::cerr << "feedback.recorded produce failed: " << message.errstr() << "\\n";
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);  // the event counts once every in-sync replica has it
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Produce one feedback.recorded event for a stored, attributed feedback row; returns the event.
nlohmann::json publish_recorded(const store::Feedback& row) {
  const nlohmann::json event = {{"feedback_id", row.feedback_id},     {"tenant", row.tenant},
                                {"request_id", row.request_id},       {"rating", row.rating},
                                {"model_version", row.model_version}, {"prompt_version", row.prompt_version},
                                {"route", row.route},                 {"comment_fingerprint", sha256_hex(row.comment)}};
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), row.tenant.data(), row.tenant.size(), 0, nullptr);
  producer->poll(0);  // serve the delivery reports already in; returns at once
  return event;
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

TOPIC = "feedback.recorded"
COMMENT = "The answer cited the 2023 refund policy"


def _row(feedback_id="fb-1", tenant="t-acme", request_id="req-1", rating=1, comment=COMMENT):
    return {
        "feedback_id": feedback_id, "tenant": tenant, "user_id": "u-1", "request_id": request_id, "rating": rating,
        "comment": comment, "model_version": "support-llm-2026-09", "prompt_version": "triage-v4", "route": "primary",
    }


def _settle(m):
    """Serve the producer's delivery reports, as the service loop does between requests."""
    if hasattr(m, "producer"):
        m.producer.poll(0)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox:feedback.recorded", 0, -1)]


def check_tenant_key(ctx):
    m = ctx.load("events")
    for i, (tenant, request_id) in enumerate([("t-acme", "req-1"), ("t-acme", "req-2"), ("t-other", "req-1"), ("t-acme", "req-3")]):
        m.publish_recorded(_row(f"fb-{i + 1}", tenant, request_id))
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 4, f"four rows produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"t-acme", b"t-acme", b"t-other", b"t-acme"], f"records must be keyed by tenant, got {keys}: keyed by request id, one tenant's events spread over every partition"
    assert len({r.partition for r in records if r.key == b"t-acme"}) == 1, "one tenant's events must share one partition so the consumer reads them in order"


def check_comment_fingerprint(ctx):
    m = ctx.load("events")
    m.publish_recorded(_row("fb-1"))
    m.publish_recorded(_row("fb-2", request_id="req-2", rating=-1))
    _settle(m)
    values = ctx.kafka.values(TOPIC)
    assert len(values) == 2, f"two rows produced {len(values)} records"
    want = hashlib.sha256(COMMENT.encode("utf-8")).hexdigest()
    for value in values:
        assert b"refund policy" not in value, f"the event carries the comment text: {value!r}; the topic is retained and replicated"
        event = json.loads(value)
        assert "comment" not in event, f"the event has a comment field: {event}"
        assert event.get("comment_fingerprint") == want, f"comment_fingerprint must be the SHA-256 hex of the comment ({want}), got {event.get('comment_fingerprint')!r}"
        missing = [f for f in ("feedback_id", "tenant", "request_id", "rating", "model_version", "prompt_version", "route") if f not in event]
        assert not missing, f"the event lacks {missing}: {event}"


def check_acks_all(ctx):
    m = ctx.load("events")
    m.publish_recorded(_row("fb-1"))
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"one row produced {len(ctx.kafka.records(TOPIC))} records"
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 1, "the partition leader failed right after the write and took the event with it: a write acknowledged by the leader alone (acks=1) is not on the followers yet. Produce with acks=all"


def check_outbox(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.publish_recorded(_row("fb-1"))
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"publish_recorded raised when the broker refused the produce: {e!r}; the event goes to the outbox and the vote goes on") from e
    _settle(m)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused one produce and the outbox holds {len(rows)} rows: the refusal arrives in the delivery report, which must write the outbox row"
    assert rows[0].get("feedback_id") == "fb-1" and rows[0].get("rating") == 1, f"the outbox row must be the event, got {rows[0]}"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused produce"
    m.publish_recorded(_row("fb-2", request_id="req-2"))
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(_outbox(ctx)) == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'feedback.recorded';
const COMMENT = 'The answer cited the 2023 refund policy';

const row = (feedbackId = 'fb-1', tenant = 't-acme', requestId = 'req-1', rating = 1) => ({
  feedback_id: feedbackId, tenant, user_id: 'u-1', request_id: requestId, rating, comment: COMMENT,
  model_version: 'support-llm-2026-09', prompt_version: 'triage-v4', route: 'primary',
});

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const outboxRows = ctx => ctx.redis.lrange('outbox:feedback.recorded', 0, -1).map(r => JSON.parse(r));

export async function check_tenant_key(ctx) {
  const m = ctx.load('events');
  const sends: [string, string, string][] = [['fb-1', 't-acme', 'req-1'], ['fb-2', 't-acme', 'req-2'], ['fb-3', 't-other', 'req-1'], ['fb-4', 't-acme', 'req-3']];
  for (const [id, tenant, requestId] of sends) await m.publishRecorded(row(id, tenant, requestId));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 4, \`four rows produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepEqual(keys, ['t-acme', 't-acme', 't-other', 't-acme'], \`records must be keyed by tenant, got \${JSON.stringify(keys)}: keyed by request id, one tenant's events spread over every partition\`);
  assert.equal(new Set(records.filter(r => r.key?.toString() === 't-acme').map(r => r.partition)).size, 1, "one tenant's events must share one partition so the consumer reads them in order");
}

export async function check_comment_fingerprint(ctx) {
  const m = ctx.load('events');
  await m.publishRecorded(row('fb-1'));
  await m.publishRecorded(row('fb-2', 't-acme', 'req-2', -1));
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 2, \`two rows produced \${values.length} records\`);
  const want = createHash('sha256').update(COMMENT).digest('hex');
  for (const value of values) {
    assert(!value.includes('refund policy'), \`the event carries the comment text: \${value}; the topic is retained and replicated\`);
    const event = JSON.parse(value);
    assert(!('comment' in event), \`the event has a comment field: \${value}\`);
    assert.equal(event.comment_fingerprint, want, \`comment_fingerprint must be the SHA-256 hex of the comment (\${want}), got \${JSON.stringify(event.comment_fingerprint)}\`);
    const missing = ['feedback_id', 'tenant', 'request_id', 'rating', 'model_version', 'prompt_version', 'route'].filter(f => !(f in event));
    assert.equal(missing.length, 0, \`the event lacks \${JSON.stringify(missing)}: \${value}\`);
  }
}

export async function check_acks_all(ctx) {
  const m = ctx.load('events');
  await m.publishRecorded(row('fb-1'));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`one row produced \${ctx.kafka.records(TOPIC).length} records\`);
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the partition leader failed right after the write and took the event with it: a write acknowledged by the leader alone (acks 1) is not on the followers yet. Produce with acks -1 (all)');
}

export async function check_outbox(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await m.publishRecorded(row('fb-1'));
  } catch (e) {
    assert.fail(\`publishRecorded rejected when the broker refused the produce: \${e}; the event goes to the outbox and the vote goes on\`);
  }
  await settle();
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused one produce and the outbox holds \${rows.length} rows: the refusal arrives as the rejected send, which must write the outbox row\`);
  assert(rows[0].feedback_id === 'fb-1' && rows[0].rating === 1, \`the outbox row must be the event, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused produce');
  await m.publishRecorded(row('fb-2', 't-acme', 'req-2'));
  await settle();
  assert(ctx.kafka.records(TOPIC).length === 1 && outboxRows(ctx).length === 1, 'a healthy produce after the refusal reaches the topic and adds no outbox row');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"feedback/store"

	"leetbuild/harness"
)

const eventsComment = "The answer cited the 2023 refund policy"

func eventsRow(feedbackID, tenant, requestID string, rating int) store.Feedback {
	return store.Feedback{FeedbackID: feedbackID, Tenant: tenant, UserID: "u-1", RequestID: requestID, Rating: rating, Comment: eventsComment,
		ModelVersion: "support-llm-2026-09", PromptVersion: "triage-v4", Route: "primary"}
}

func eventsPublish(ctx *harness.Ctx, row store.Feedback) {
	ctx.NoError(publishRecorded(context.Background(), row), "publishRecorded(%s) failed", row.FeedbackID)
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, row := range ctx.Redis.LRange("outbox:feedback.recorded", 0, -1) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(row), &e), "the outbox row is JSON: %s", row)
		out = append(out, e)
	}
	return out
}

func CheckTenantKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsRow("fb-1", "t-acme", "req-1", 1))
	eventsPublish(ctx, eventsRow("fb-2", "t-acme", "req-2", 1))
	eventsPublish(ctx, eventsRow("fb-3", "t-other", "req-1", 1))
	eventsPublish(ctx, eventsRow("fb-4", "t-acme", "req-3", 1))
	ctx.Settle()
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 4, "four rows must produce four records on %s; the records", topic)
	keys := ctx.Kafka.Keys(topic)
	ctx.Equal(keys, []string{"t-acme", "t-acme", "t-other", "t-acme"}, "records must be keyed by tenant (keyed by request id, one tenant's events spread over every partition)")
	partitions := map[int]bool{}
	for i, r := range records {
		if keys[i] == "t-acme" {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "one tenant's events must share one partition so the consumer reads them in order; t-acme's partitions")
}

func CheckCommentFingerprint(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsRow("fb-1", "t-acme", "req-1", 1))
	eventsPublish(ctx, eventsRow("fb-2", "t-acme", "req-2", -1))
	ctx.Settle()
	values := ctx.Kafka.Values(topic)
	ctx.Equal(len(values), 2, "two rows must produce two records; the records")
	sum := sha256.Sum256([]byte(eventsComment))
	want := hex.EncodeToString(sum[:])
	for _, value := range values {
		ctx.Assert(!strings.Contains(value, "refund policy"), "the event carries the comment text: %s; the topic is retained and replicated", value)
		var event map[string]any
		ctx.NoError(json.Unmarshal([]byte(value), &event), "the event is JSON: %s", value)
		_, has := event["comment"]
		ctx.Assert(!has, "the event has a comment field: %s", value)
		ctx.Equal(event["comment_fingerprint"], want, "comment_fingerprint must be the SHA-256 hex of the comment")
		for _, f := range []string{"feedback_id", "tenant", "request_id", "rating", "model_version", "prompt_version", "route"} {
			_, ok := event[f]
			ctx.Assert(ok, "the event lacks %s: %s", f, value)
		}
	}
}

func CheckAcksAll(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsRow("fb-1", "t-acme", "req-1", 1))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "one row must produce one record; the records")
	ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "the partition leader failed right after the write and took the event with it: a write acknowledged by the leader alone (RequireOne) is not on the followers yet. Write with RequireAll; the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(topic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("publishRecorded panicked when the broker refused the produce: %v", e)
			}
		}()
		eventsPublish(ctx, eventsRow("fb-1", "t-acme", "req-1", 1))
	}()
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused one produce: the returned error must write the outbox row; outbox rows")
	ctx.Assert(rows[0]["feedback_id"] == "fb-1" && rows[0]["rating"] == float64(1), "the outbox row must be the event, got %v", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(topic)), 0, "nothing reached the topic for the refused produce; records")
	eventsPublish(ctx, eventsRow("fb-2", "t-acme", "req-2", 1))
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(topic)) == 1 && len(eventsOutbox(ctx)) == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <set>
#include <string>
#include <vector>

#include "digest.h"  // sha256_hex, for the expected fingerprint

namespace {

const std::string kComment = "The answer cited the 2023 refund policy";

store::Feedback eventsRow(const std::string& feedback_id, const std::string& tenant, const std::string& request_id, int rating) {
  return store::Feedback{feedback_id, tenant, "u-1", request_id, rating, kComment, "support-llm-2026-09", "triage-v4", "primary"};
}

// Serve the producer's delivery reports, as the service loop does between requests.
void settle(harness::Ctx& ctx) {
  ctx.Settle();
  producer->poll(0);
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& row : ctx.Redis.LRange("outbox:feedback.recorded", 0, -1)) out.push_back(nlohmann::json::parse(row, nullptr, false));
  return out;
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  publish_recorded(eventsRow("fb-1", "t-acme", "req-1", 1));
  publish_recorded(eventsRow("fb-2", "t-acme", "req-2", 1));
  publish_recorded(eventsRow("fb-3", "t-other", "req-1", 1));
  publish_recorded(eventsRow("fb-4", "t-acme", "req-3", 1));
  settle(ctx);
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 4, "four rows must produce four records on %s; the records", kTopic);
  const auto keys = ctx.Kafka.Keys(kTopic);
  ctx.Equal(keys, {"t-acme", "t-acme", "t-other", "t-acme"}, "records must be keyed by tenant (keyed by request id, one tenant's events spread over every partition)");
  std::set<int> partitions;
  for (size_t i = 0; i < records.size(); i++) {
    if (keys[i] == "t-acme") partitions.insert(records[i].Partition);
  }
  ctx.Equal(partitions.size(), 1, "one tenant's events must share one partition so the consumer reads them in order; t-acme's partitions");
}

void CheckCommentFingerprint(harness::Ctx& ctx) {
  publish_recorded(eventsRow("fb-1", "t-acme", "req-1", 1));
  publish_recorded(eventsRow("fb-2", "t-acme", "req-2", -1));
  settle(ctx);
  const auto values = ctx.Kafka.Values(kTopic);
  ctx.Equal(values.size(), 2, "two rows must produce two records; the records");
  const std::string want = sha256_hex(kComment);
  for (const auto& value : values) {
    ctx.Assert(value.find("refund policy") == std::string::npos, "the event carries the comment text: %s; the topic is retained and replicated", value);
    const auto event = nlohmann::json::parse(value, nullptr, false);
    ctx.Assert(event.is_object() && !event.contains("comment"), "the event has a comment field: %s", value);
    ctx.Equal(event.value("comment_fingerprint", ""), want, "comment_fingerprint must be the SHA-256 hex of the comment");
    for (const char* f : {"feedback_id", "tenant", "request_id", "rating", "model_version", "prompt_version", "route"}) {
      ctx.Assert(event.contains(f), "the event lacks %s: %s", f, value);
    }
  }
}

void CheckAcksAll(harness::Ctx& ctx) {
  publish_recorded(eventsRow("fb-1", "t-acme", "req-1", 1));
  settle(ctx);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one row must produce one record; the records");
  ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "the partition leader failed right after the write and took the event with it: a write acknowledged by the leader alone (acks=1) is not on the followers yet. Produce with acks=all; the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  try {
    publish_recorded(eventsRow("fb-1", "t-acme", "req-1", 1));
  } catch (const std::exception& e) {
    ctx.Fatalf("publish_recorded threw when the broker refused the produce: %s; the event goes to the outbox and the vote goes on", e.what());
  }
  settle(ctx);
  const auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused one produce: the delivery report (dr_cb) must write the outbox row; outbox rows");
  ctx.Assert(!rows.empty() && rows[0].is_object() && rows[0].value("feedback_id", "") == "fb-1" && rows[0].value("rating", 0) == 1,
             "the outbox row must be the event, got %v", rows.empty() ? nlohmann::json() : rows[0]);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "nothing reached the topic for the refused produce; records");
  publish_recorded(eventsRow("fb-2", "t-acme", "req-2", 1));
  settle(ctx);
  ctx.Assert(ctx.Kafka.Records(kTopic).size() == 1 && eventsOutbox(ctx).size() == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row");
}
`,
  },
  hints: [
    "Take the broker's partition leader down right after a vote, or have it refuse one produce: the vote is gone from the topic and nothing is in the outbox. Also look at what one event carries.",
    'The key is the request id; the payload copies `comment`; `acks` is `1`, so the leader alone acknowledges; and the `try` around `produce` catches enqueue errors only, while a refusal arrives later in the delivery report.',
    'Produce with `key=row["tenant"]` and `"acks": "all"`, put `hashlib.sha256(comment.encode()).hexdigest()` in `comment_fingerprint` instead of `comment`, and pass an `on_delivery` that calls `store.insert_outbox(event)` when `err` is set.',
  ],
  debrief: `The key decides order: Kafka keeps one partition in order and nothing across partitions, so the tenant is the key when the consumer's state is per tenant. The fingerprint keeps what the consumer needs, a way to see that two comments are the same, without the text, which a retained and replicated topic would keep past any deletion of the row. \`acks=all\` is what makes a leader failover lose nothing that was acknowledged. The outbox is written from the delivery report because that is where a broker's refusal arrives. Production pipelines use a keyed hash (HMAC) so a short comment cannot be guessed back from its fingerprint, enable idempotence where the client supports it, and run the relay that drains the outbox.`,
};
