import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'comment.event keyed by thread, produced after the commit',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter is the event half of the write path. \`create_comment(tenant,
comment)\` produces a \`comment.event\` record with \`record_event\`, then commits the comment with
\`threads.commit_comment\` (step 2, provided); \`delete_comment(tenant, comment_id)\` produces, then
calls \`store.soft_delete\`. \`record_event\` sends \`{type, tenant, comment_id, thread_id, author_id,
text}\` keyed by the author with \`acks=1\`, and waits for the delivery report. It serves the demo
and hides four flaws.

**Failure mode the checks target.** One thread's events land on several partitions and a read model
applies them out of order; a consumer hears of a comment the store does not hold yet, or of a
delete at the old revision; every comment's text is copied into a retained topic; a lost
acknowledgement writes an event twice and a leader failover loses one.

- Key every record by \`thread_id\`.
- Commit first (\`commit_comment\`, \`soft_delete\`), then produce from the committed row; a failed
  delivery still reaches the caller (the commit stays).
- The payload of every event, created or deleted, is
  \`{type: "comment.<kind>", tenant, comment_id, thread_id, parent_id, revision}\`, no text.
- An idempotent producer with \`acks=all\`: \`enable.idempotence\` for confluent-kafka (Python and
  Go) and librdkafka, kafkajs \`idempotent: true\` with \`acks: -1\`.`,
  sequence: {
    participants: ['Comments API', 'Redis', 'comment.event', 'Read model'],
    messages: [
      {from: 'Comments API', to: 'Redis', label: 'commit_comment / soft_delete: committed', kind: 'sync'},
      {
        from: 'Comments API',
        to: 'comment.event',
        label: 'produce key = thread_id · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'comment.event', to: 'Comments API', label: 'delivery report', kind: 'reply'},
      {
        from: 'comment.event',
        to: 'Read model',
        label: '{type, comment_id, parent_id, revision} in thread order',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'thread-key',
      title: 'Keyed by thread id',
      detail:
        'Each record’s key is the comment’s `thread_id`, so one thread’s events share a partition and arrive in order; the starter keys by the author, which scatters a thread over partitions.',
      match: {
        python: {all: [/key\s*=\s*comment\[["']thread_id["']\]/], none: [/key\s*=\s*comment\[["']author_id["']\]/]},
        typescript: {all: [/key:\s*comment\.thread_id/], none: [/key:\s*comment\.author_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*c\.ThreadID\s*\)/], none: [/Key:\s*\[\]byte\(\s*c\.AuthorID\s*\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(\s*Topic,\s*comment\.threadId/],
          none: [/Topic,\s*comment\.authorId/],
        },
        cpp: {all: [/c\.thread_id\.c_str\(\),\s*c\.thread_id\.(size|length)\(\)/], none: [/c\.author_id\.c_str\(\)/]},
      },
    },
    {
      id: 'after-commit',
      title: 'Produces only what has been committed',
      detail:
        '`create_comment` commits with `commit_comment` and `delete_comment` with `soft_delete` before producing, and the event is built from the committed row (a delete carries the revision the delete wrote). When the broker rejects the event, the comment is already committed (or deleted) and the failure reaches the caller. The starter produces first.',
      match: {
        python: {
          order: [
            /def create_comment/,
            /threads\.commit_comment\(/,
            /record_event\(/,
            /def delete_comment/,
            /store\.soft_delete\(/,
            /record_event\(/,
          ],
        },
        typescript: {
          order: [
            /function createComment/,
            /commitComment\(/,
            /recordEvent\(/,
            /function deleteComment/,
            /softDelete\(/,
            /recordEvent\(/,
          ],
        },
        go: {
          order: [
            /func createComment/,
            /threads\.CommitComment\(/,
            /recordEvent\(/,
            /func deleteComment/,
            /store\.SoftDelete\(/,
            /recordEvent\(/,
          ],
        },
        scala: {
          order: [
            /def createComment/,
            /Threads\.commitComment\(/,
            /recordEvent\(/,
            /def deleteComment/,
            /Store\.softDelete\(/,
            /recordEvent\(/,
          ],
        },
        cpp: {
          order: [
            /json createComment/,
            /threads::commitComment\(/,
            /recordEvent\(/,
            /deleteComment\(/,
            /store::softDelete\(/,
            /recordEvent\(/,
          ],
        },
      },
    },
    {
      id: 'payload',
      title: 'Ids and revision, no text',
      detail:
        'The payload of a created and of a deleted event is `{type, tenant, comment_id, thread_id, parent_id, revision}`: what a read model needs to fetch the comment and drop a stale update. The starter ships the author and the text into a retained, replicated topic and leaves the parent and the revision out.',
      match: {
        python: {
          all: [/["']parent_id["']\s*:/, /["']revision["']\s*:/],
          none: [/["']text["']\s*:/, /["']author_id["']\s*:/],
        },
        typescript: {all: [/parent_id:/, /revision:/], none: [/\btext:\s*comment\./, /author_id:\s*comment\./]},
        go: {all: [/"parent_id":/, /"revision":/], none: [/"text":/, /"author_id":/]},
        scala: {all: [/"parent_id"\s*->/, /"revision"\s*->/], none: [/"text"\s*->/, /"author_id"\s*->/]},
        cpp: {all: [/\{"parent_id",/, /\{"revision",/], none: [/\{"text",/, /\{"author_id",/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'An idempotent producer with acks=all',
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
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from comments import store, threads  # store.get, soft_delete; threads.commit_comment

TOPIC = "comment.event"
ACK_TIMEOUT_S = 2

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def record_event(kind: str, tenant: str, comment: dict) -> dict:
    """Produce one comment.event record about the comment and wait for its delivery report; returns the payload."""
    payload = {
        "type": f"comment.{kind}",
        "tenant": tenant,
        "comment_id": comment["id"],
        "thread_id": comment["thread_id"],
        "author_id": comment["author_id"],
        "text": comment["text"],
    }
    report = {}
    producer.produce(TOPIC, key=comment["author_id"], value=json.dumps(payload), on_delivery=lambda err, msg: report.update(error=err))
    producer.flush(ACK_TIMEOUT_S)
    if "error" not in report or report["error"] is not None:
        raise KafkaException(report.get("error"))
    return payload


def create_comment(tenant: str, comment: dict) -> dict:
    """Commit a new comment and announce it; returns the event."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    event = record_event("created", tenant, comment)
    threads.commit_comment(tenant, comment)
    return event


def delete_comment(tenant: str, comment_id: str) -> dict | None:
    """Soft-delete the comment and announce it; returns the event, or None when there is no such comment."""
    comment = store.get(tenant, comment_id)
    if comment is None:
        return None
    event = record_event("deleted", tenant, comment)
    store.soft_delete(tenant, comment_id)
    return event
`,
      solution: `import json

from confluent_kafka import KafkaException, Producer

from comments import store, threads  # store.get, soft_delete; threads.commit_comment

TOPIC = "comment.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def record_event(kind: str, tenant: str, comment: dict) -> dict:
    """Produce one comment.event record about the comment and wait for its delivery report; returns the payload."""
    payload = {
        "type": f"comment.{kind}",
        "tenant": tenant,
        "comment_id": comment["id"],
        "thread_id": comment["thread_id"],
        "parent_id": comment["parent_id"],
        "revision": comment["revision"],  # lets a read model drop an update older than what it holds
    }
    report = {}
    # The thread is the key: one thread's events share a partition, in order.
    producer.produce(TOPIC, key=comment["thread_id"], value=json.dumps(payload), on_delivery=lambda err, msg: report.update(error=err))
    producer.flush(ACK_TIMEOUT_S)
    if "error" not in report or report["error"] is not None:
        raise KafkaException(report.get("error"))
    return payload


def create_comment(tenant: str, comment: dict) -> dict:
    """Commit a new comment and announce it; returns the event."""
    threads.commit_comment(tenant, comment)  # durable first: an event may lag the store, never lead it
    return record_event("created", tenant, comment)


def delete_comment(tenant: str, comment_id: str) -> dict | None:
    """Soft-delete the comment and announce it; returns the event, or None when there is no such comment."""
    deleted = store.soft_delete(tenant, comment_id)
    if deleted is None:
        return None
    return record_event("deleted", tenant, deleted)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Comment, get, softDelete} from 'comments/store';
import {commitComment} from 'comments/threads';

export const TOPIC = 'comment.event';

const kafka = new Kafka({clientId: 'commentsd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Produce one comment.event record about the comment and wait for the broker; resolves the payload. */
export async function recordEvent(kind: string, tenant: string, comment: Comment): Promise<Record<string, unknown>> {
  const payload = {
    type: \`comment.\${kind}\`,
    tenant,
    comment_id: comment.id,
    thread_id: comment.thread_id,
    author_id: comment.author_id,
    text: comment.text,
  };
  await producer.send({topic: TOPIC, messages: [{key: comment.author_id, value: JSON.stringify(payload)}], acks: 1});
  return payload;
}

/** Commit a new comment and announce it; resolves the event. */
export async function createComment(tenant: string, comment: Comment): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const event = await recordEvent('created', tenant, comment);
  await commitComment(tenant, comment);
  return event;
}

/** Soft-delete the comment and announce it; resolves the event, or null when there is no such comment. */
export async function deleteComment(tenant: string, commentId: string): Promise<Record<string, unknown> | null> {
  const comment = await get(tenant, commentId);
  if (comment === null) return null;
  const event = await recordEvent('deleted', tenant, comment);
  await softDelete(tenant, commentId);
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Comment, get, softDelete} from 'comments/store';
import {commitComment} from 'comments/threads';

export const TOPIC = 'comment.event';

const kafka = new Kafka({clientId: 'commentsd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Produce one comment.event record about the comment and wait for the broker; resolves the payload. */
export async function recordEvent(kind: string, tenant: string, comment: Comment): Promise<Record<string, unknown>> {
  const payload = {
    type: \`comment.\${kind}\`,
    tenant,
    comment_id: comment.id,
    thread_id: comment.thread_id,
    parent_id: comment.parent_id,
    revision: comment.revision, // lets a read model drop an update older than what it holds
  };
  // The thread is the key: one thread's events share a partition, in order. acks -1: every in-sync replica.
  await producer.send({topic: TOPIC, messages: [{key: comment.thread_id, value: JSON.stringify(payload)}], acks: -1});
  return payload;
}

/** Commit a new comment and announce it; resolves the event. */
export async function createComment(tenant: string, comment: Comment): Promise<Record<string, unknown>> {
  await commitComment(tenant, comment); // durable first: an event may lag the store, never lead it
  return recordEvent('created', tenant, comment);
}

/** Soft-delete the comment and announce it; resolves the event, or null when there is no such comment. */
export async function deleteComment(tenant: string, commentId: string): Promise<Record<string, unknown> | null> {
  const deleted = await softDelete(tenant, commentId);
  if (deleted === null) return null;
  return recordEvent('deleted', tenant, deleted);
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"comments/store"   // store.Comment, Get, SoftDelete
	"comments/threads" // threads.CommitComment
)

const (
	topic      = "comment.event"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// recordEvent produces one comment.event record about the comment and waits for its delivery
// report; it returns the payload.
func recordEvent(ctx context.Context, kind, tenant string, c store.Comment) (map[string]any, error) {
	payload := map[string]any{
		"type":       "comment." + kind,
		"tenant":     tenant,
		"comment_id": c.ID,
		"thread_id":  c.ThreadID,
		"author_id":  c.AuthorID,
		"text":       c.Text,
	}
	value, _ := json.Marshal(payload)
	t := topic
	deliveries := make(chan kafka.Event, 1)
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(c.AuthorID), Value: value}
	if err := producer.Produce(msg, deliveries); err != nil {
		return nil, err
	}
	select {
	case e := <-deliveries:
		if err := e.(*kafka.Message).TopicPartition.Error; err != nil {
			return nil, err
		}
	case <-time.After(ackTimeout):
		return nil, fmt.Errorf("no delivery report for %s within %v", c.ID, ackTimeout)
	}
	return payload, nil
}

// createComment commits a new comment and announces it; it returns the event.
func createComment(ctx context.Context, tenant string, c store.Comment) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	event, err := recordEvent(ctx, "created", tenant, c)
	if err != nil {
		return nil, err
	}
	if _, err := threads.CommitComment(ctx, tenant, c); err != nil {
		return nil, err
	}
	return event, nil
}

// deleteComment soft-deletes the comment and announces it; it returns the event, or nil when there
// is no such comment.
func deleteComment(ctx context.Context, tenant, commentID string) (map[string]any, error) {
	c := store.Get(ctx, tenant, commentID)
	if c == nil {
		return nil, nil
	}
	event, err := recordEvent(ctx, "deleted", tenant, *c)
	if err != nil {
		return nil, err
	}
	store.SoftDelete(ctx, tenant, commentID)
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"comments/store"   // store.Comment, Get, SoftDelete
	"comments/threads" // threads.CommitComment
)

const (
	topic      = "comment.event"
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

// recordEvent produces one comment.event record about the comment and waits for its delivery
// report; it returns the payload.
func recordEvent(ctx context.Context, kind, tenant string, c store.Comment) (map[string]any, error) {
	payload := map[string]any{
		"type":       "comment." + kind,
		"tenant":     tenant,
		"comment_id": c.ID,
		"thread_id":  c.ThreadID,
		"parent_id":  c.ParentID,
		"revision":   c.Revision, // lets a read model drop an update older than what it holds
	}
	value, _ := json.Marshal(payload)
	t := topic
	deliveries := make(chan kafka.Event, 1)
	// The thread is the key: one thread's events share a partition, in order.
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(c.ThreadID), Value: value}
	if err := producer.Produce(msg, deliveries); err != nil {
		return nil, err
	}
	select {
	case e := <-deliveries:
		if err := e.(*kafka.Message).TopicPartition.Error; err != nil {
			return nil, err
		}
	case <-time.After(ackTimeout):
		return nil, fmt.Errorf("no delivery report for %s within %v", c.ID, ackTimeout)
	}
	return payload, nil
}

// createComment commits a new comment and announces it; it returns the event.
func createComment(ctx context.Context, tenant string, c store.Comment) (map[string]any, error) {
	// Durable first: an event may lag the store, never lead it.
	if _, err := threads.CommitComment(ctx, tenant, c); err != nil {
		return nil, err
	}
	return recordEvent(ctx, "created", tenant, c)
}

// deleteComment soft-deletes the comment and announces it; it returns the event, or nil when there
// is no such comment.
func deleteComment(ctx context.Context, tenant, commentID string) (map[string]any, error) {
	deleted := store.SoftDelete(ctx, tenant, commentID)
	if deleted == nil {
		return nil, nil
	}
	return recordEvent(ctx, "deleted", tenant, *deleted)
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import comments.{Store, Threads} // Store.get, softDelete; Threads.commitComment

object Events {
  val Topic = "comment.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Produce one comment.event record about the comment and wait for the broker; returns the payload. */
  def recordEvent(kind: String, tenant: String, comment: Store.Comment): JsObject = {
    val payload = JsObject(
      "type" -> JsString(s"comment.$kind"),
      "tenant" -> JsString(tenant),
      "comment_id" -> JsString(comment.id),
      "thread_id" -> JsString(comment.threadId),
      "author_id" -> JsString(comment.authorId),
      "text" -> JsString(comment.text))
    producer.send(new ProducerRecord[String, String](Topic, comment.authorId, payload.compactPrint)).get(AckTimeoutMs, TimeUnit.MILLISECONDS)
    payload
  }

  /** Commit a new comment and announce it; returns the event. */
  def createComment(tenant: String, comment: Store.Comment): JsObject = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val event = recordEvent("created", tenant, comment)
    Threads.commitComment(tenant, comment)
    event
  }

  /** Soft-delete the comment and announce it; returns the event, if there is such a comment. */
  def deleteComment(tenant: String, commentId: String): Option[JsObject] =
    Store.get(tenant, commentId).map { comment =>
      val event = recordEvent("deleted", tenant, comment)
      Store.softDelete(tenant, commentId)
      event
    }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import comments.{Store, Threads} // Store.get, softDelete; Threads.commitComment

object Events {
  val Topic = "comment.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Produce one comment.event record about the comment and wait for the broker; returns the payload. */
  def recordEvent(kind: String, tenant: String, comment: Store.Comment): JsObject = {
    val payload = JsObject(
      "type" -> JsString(s"comment.$kind"),
      "tenant" -> JsString(tenant),
      "comment_id" -> JsString(comment.id),
      "thread_id" -> JsString(comment.threadId),
      "parent_id" -> JsString(comment.parentId),
      "revision" -> JsNumber(comment.revision)) // lets a read model drop an update older than what it holds
    // The thread is the key: one thread's events share a partition, in order.
    producer.send(new ProducerRecord[String, String](Topic, comment.threadId, payload.compactPrint)).get(AckTimeoutMs, TimeUnit.MILLISECONDS)
    payload
  }

  /** Commit a new comment and announce it; returns the event. */
  def createComment(tenant: String, comment: Store.Comment): JsObject = {
    Threads.commitComment(tenant, comment) // durable first: an event may lag the store, never lead it
    recordEvent("created", tenant, comment)
  }

  /** Soft-delete the comment and announce it; returns the event, if there is such a comment. */
  def deleteComment(tenant: String, commentId: String): Option[JsObject] =
    Store.softDelete(tenant, commentId).map(deleted => recordEvent("deleted", tenant, deleted))
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>

#include "comments/store.h"    // store::Comment, get, softDelete
#include "comments/threads.h"  // threads::commitComment

using json = nlohmann::json;

const std::string kTopic = "comment.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: recordEvent produces one record and waits for it.
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
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Produce one comment.event record about the comment and wait for its delivery report; returns the payload.
json recordEvent(const std::string& kind, const std::string& tenant, const store::Comment& c) {
  const json payload = {{"type", "comment." + kind}, {"tenant", tenant}, {"comment_id", c.id},
                        {"thread_id", c.thread_id}, {"author_id", c.author_id}, {"text", c.text}};
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), c.author_id.c_str(), c.author_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) throw std::runtime_error("comment.event not delivered: " + RdKafka::err2str(err));
  return payload;
}

// Commit a new comment and announce it; returns the event.
json createComment(const std::string& tenant, const store::Comment& c) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json event = recordEvent("created", tenant, c);
  threads::commitComment(tenant, c);
  return event;
}

// Soft-delete the comment and announce it; returns the event, or none when there is no such comment.
std::optional<json> deleteComment(const std::string& tenant, const std::string& comment_id) {
  const auto c = store::get(tenant, comment_id);
  if (!c) return std::nullopt;
  const json event = recordEvent("deleted", tenant, *c);
  store::softDelete(tenant, comment_id);
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>

#include "comments/store.h"    // store::Comment, get, softDelete
#include "comments/threads.h"  // threads::commitComment

using json = nlohmann::json;

const std::string kTopic = "comment.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: recordEvent produces one record and waits for it.
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

// Produce one comment.event record about the comment and wait for its delivery report; returns the payload.
json recordEvent(const std::string& kind, const std::string& tenant, const store::Comment& c) {
  // revision lets a read model drop an update older than what it holds.
  const json payload = {{"type", "comment." + kind}, {"tenant", tenant}, {"comment_id", c.id},
                        {"thread_id", c.thread_id}, {"parent_id", c.parent_id}, {"revision", c.revision}};
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  // The thread is the key: one thread's events share a partition, in order.
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), c.thread_id.c_str(), c.thread_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) throw std::runtime_error("comment.event not delivered: " + RdKafka::err2str(err));
  return payload;
}

// Commit a new comment and announce it; returns the event.
json createComment(const std::string& tenant, const store::Comment& c) {
  threads::commitComment(tenant, c);  // durable first: an event may lag the store, never lead it
  return recordEvent("created", tenant, c);
}

// Soft-delete the comment and announce it; returns the event, or none when there is no such comment.
std::optional<json> deleteComment(const std::string& tenant, const std::string& comment_id) {
  const auto deleted = store::softDelete(tenant, comment_id);
  if (!deleted) return std::nullopt;
  return recordEvent("deleted", tenant, *deleted);
}
`,
    },
  },
  harness: {
    python: `import json

from comments import store

TOPIC = "comment.event"
INDEX = "thread:acme:t-1:comments"
TEXT = "The butler did it"


def _comment(thread_id="t-1", author="u-1", parent_id="", text=TEXT):
    return store.new_comment(thread_id, parent_id, author, text, text)


def _payloads(ctx):
    out = []
    for record in ctx.kafka.records(TOPIC):
        try:
            out.append(json.loads(record.value))
        except Exception as exc:
            raise AssertionError(f"a record's value is not JSON: {record.value!r} ({exc})")
    return out


def check_thread_key(ctx):
    m = ctx.load("events")
    m.create_comment("acme", _comment("t-1", "u-1"))
    m.create_comment("acme", _comment("t-2", "u-1"))
    m.create_comment("acme", _comment("t-1", "u-2"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three comments produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"t-1", b"t-2", b"t-1"], f"the records are keyed {keys}, expected the thread ids t-1, t-2, t-1: keyed by anything else, one thread's events scatter across partitions"
    assert records[0].partition == records[2].partition, "both t-1 events must land on one partition, or a read model sees the thread out of order"


def check_after_commit(ctx):
    m = ctx.load("events")
    # The instant the comment is committed, what is already on the topic.
    at_commit = ctx.redis_after(INDEX, lambda: len(ctx.kafka.records(TOPIC)))
    comment = _comment()
    m.create_comment("acme", comment)
    assert at_commit.fired, f"create_comment never committed the comment (nothing wrote {INDEX})"
    assert at_commit.result == 0, f"when the comment was committed the topic already held {at_commit.result} record(s): a consumer could look up a comment the store does not have. Commit first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the commit"
    deleted = m.delete_comment("acme", comment["id"])
    assert store.get("acme", comment["id"])["deleted"] is True, "delete_comment must soft-delete the comment"
    assert deleted is not None and deleted.get("revision") == 2, f"the deleted event must carry the revision the delete committed (2), got {deleted}: an event produced before the write describes the row as it was"
    assert m.delete_comment("acme", "c-404") is None, "deleting a comment that does not exist must answer None"
    assert len(ctx.kafka.records(TOPIC)) == 2, f"the topic holds {len(ctx.kafka.records(TOPIC))} records, expected the created and the deleted events"
    # The broker rejects the next event: what the store holds then shows which came first.
    ctx.kafka.fail_next(TOPIC)
    unsent = _comment()
    try:
        m.create_comment("acme", unsent)
        raised = False
    except Exception:
        raised = True
    assert store.get("acme", unsent["id"]) is not None, "the broker rejected the created event and the comment was never committed: commit first, then produce"
    assert raised, "the broker rejected the created event and create_comment returned as if it had been delivered: a failed delivery must reach the caller"
    ctx.kafka.fail_next(TOPIC)
    try:
        m.delete_comment("acme", unsent["id"])
        raised = False
    except Exception:
        raised = True
    assert store.get("acme", unsent["id"])["deleted"] is True, "the broker rejected the deleted event and the comment is not deleted: the event was produced before soft_delete. Commit first: an event may lag the store, never lead it"
    assert raised, "the broker rejected the deleted event and delete_comment returned as if it had been delivered: a failed delivery must reach the caller"


def check_payload(ctx):
    m = ctx.load("events")
    root = _comment()
    m.create_comment("acme", root)
    reply = _comment(parent_id=root["id"], text="Not the butler")
    m.create_comment("acme", reply)
    payload = _payloads(ctx)[1]
    raw = json.dumps(payload)
    assert "butler" not in raw and "text" not in payload, f"the event carries the comment's text: {payload}. The topic is retained and replicated; carry ids, and let consumers read the text from the store"
    expected = {"type": "comment.created", "tenant": "acme", "comment_id": reply["id"], "thread_id": "t-1", "parent_id": root["id"], "revision": 1}
    assert payload == expected, f"the event is {payload}, expected {expected}"
    m.delete_comment("acme", reply["id"])
    events = _payloads(ctx)
    assert len(events) == 3, f"deleting {reply['id']} left {len(events)} events on {TOPIC}, expected a third, the deleted event"
    gone = events[2]
    expected = {"type": "comment.deleted", "tenant": "acme", "comment_id": reply["id"], "thread_id": "t-1", "parent_id": root["id"], "revision": 2}
    assert gone == expected, f"the deleted event is {gone}, expected {expected}: every event carries the same fields, from the committed row"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.create_comment("acme", _comment())
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.create_comment("acme", _comment())
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"
`,
    typescript: `const TOPIC = 'comment.event';
const INDEX = 'thread:acme:t-1:comments';
const TEXT = 'The butler did it';

function events(ctx) {
  return {m: ctx.load('events'), store: ctx.load('/support/comments/store.ts')};
}

const comment = (store, threadId = 't-1', author = 'u-1', parentId = '', text = TEXT) => store.newComment(threadId, parentId, author, text, text);

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function payloads(ctx) {
  return (ctx.kafka.values(TOPIC) as string[]).map(value => {
    try {
      return JSON.parse(value);
    } catch (e) {
      assert.fail(\`a record's value is not JSON: \${value} (\${e})\`);
    }
  });
}

export async function check_thread_key(ctx) {
  const {m, store} = events(ctx);
  await m.createComment('acme', await comment(store, 't-1', 'u-1'));
  await m.createComment('acme', await comment(store, 't-2', 'u-1'));
  await m.createComment('acme', await comment(store, 't-1', 'u-2'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three comments produced \${records.length} records on \${TOPIC}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepStrictEqual(keys, ['t-1', 't-2', 't-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the thread ids t-1, t-2, t-1: keyed by anything else, one thread's events scatter across partitions\`);
  assert.equal(records[0].partition, records[2].partition, 'both t-1 events must land on one partition, or a read model sees the thread out of order');
}

export async function check_after_commit(ctx) {
  const {m, store} = events(ctx);
  // The instant the comment is committed, what is already on the topic.
  const atCommit = ctx.redisAfter(INDEX, () => ctx.kafka.records(TOPIC).length);
  const c = await comment(store);
  await m.createComment('acme', c);
  await settle();
  assert(atCommit.fired, \`createComment never committed the comment (nothing wrote \${INDEX})\`);
  assert.equal(atCommit.result, 0, \`when the comment was committed the topic already held \${atCommit.result} record(s): a consumer could look up a comment the store does not have. Commit first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the commit');
  const deleted = await m.deleteComment('acme', c.id);
  assert.equal((await store.get('acme', c.id)).deleted, true, 'deleteComment must soft-delete the comment');
  assert(deleted !== null && deleted.revision === 2, \`the deleted event must carry the revision the delete committed (2), got \${JSON.stringify(deleted)}: an event produced before the write describes the row as it was\`);
  assert.equal(await m.deleteComment('acme', 'c-404'), null, 'deleting a comment that does not exist must resolve null');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'the topic must hold the created and the deleted events');
  // The broker rejects the next event: what the store holds then shows which came first.
  ctx.kafka.failNext(TOPIC);
  const unsent = await comment(store);
  let raised = false;
  try {
    await m.createComment('acme', unsent);
  } catch {
    raised = true;
  }
  assert((await store.get('acme', unsent.id)) !== null, 'the broker rejected the created event and the comment was never committed: commit first, then produce');
  assert(raised, 'the broker rejected the created event and createComment resolved as if it had been delivered: a failed delivery must reach the caller');
  ctx.kafka.failNext(TOPIC);
  raised = false;
  try {
    await m.deleteComment('acme', unsent.id);
  } catch {
    raised = true;
  }
  assert.equal((await store.get('acme', unsent.id)).deleted, true, 'the broker rejected the deleted event and the comment is not deleted: the event was produced before softDelete. Commit first: an event may lag the store, never lead it');
  assert(raised, 'the broker rejected the deleted event and deleteComment resolved as if it had been delivered: a failed delivery must reach the caller');
}

export async function check_payload(ctx) {
  const {m, store} = events(ctx);
  const root = await comment(store);
  await m.createComment('acme', root);
  const reply = await comment(store, 't-1', 'u-1', root.id, 'Not the butler');
  await m.createComment('acme', reply);
  await settle();
  const payload = payloads(ctx)[1];
  const raw = JSON.stringify(payload);
  assert(!raw.includes('butler') && !('text' in payload), \`the event carries the comment's text: \${raw}. The topic is retained and replicated; carry ids, and let consumers read the text from the store\`);
  const expected = {type: 'comment.created', tenant: 'acme', comment_id: reply.id, thread_id: 't-1', parent_id: root.id, revision: 1};
  assert.deepStrictEqual(payload, expected, \`the event is \${raw}, expected \${JSON.stringify(expected)}\`);
  await m.deleteComment('acme', reply.id);
  await settle();
  const all = payloads(ctx);
  assert.equal(all.length, 3, \`deleting \${reply.id} left \${all.length} events on \${TOPIC}, expected a third, the deleted event\`);
  const gone = {type: 'comment.deleted', tenant: 'acme', comment_id: reply.id, thread_id: 't-1', parent_id: root.id, revision: 2};
  assert.deepStrictEqual(all[2], gone, \`the deleted event is \${JSON.stringify(all[2])}, expected \${JSON.stringify(gone)}: every event carries the same fields, from the committed row\`);
}

export async function check_acks_idempotent(ctx) {
  const {m, store} = events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.createComment('acme', await comment(store));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.createComment('acme', await comment(store));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"comments/store"

	"leetbuild/harness"
)

const (
	hTopic     = "comment.event"
	hEventIdx  = "thread:acme:t-1:comments"
	hEventText = "The butler did it"
)

var hBg = context.Background()

func hEventComment(ctx *harness.Ctx, threadID, author, parentID, text string) store.Comment {
	c, err := store.NewComment(hBg, threadID, parentID, author, text, text)
	ctx.NoError(err, "store.NewComment failed")
	return c
}

func hCreate(ctx *harness.Ctx, c store.Comment) map[string]any {
	event, err := createComment(hBg, "acme", c)
	ctx.NoError(err, "createComment(%s) failed", c.ID)
	return event
}

func hPayloadAt(ctx *harness.Ctx, i int) (map[string]any, string) {
	values := ctx.Kafka.Values(hTopic)
	ctx.Assert(len(values) > i, "the topic holds %d records, expected at least %d", len(values), i+1)
	var p map[string]any
	ctx.Assert(json.Unmarshal([]byte(values[i]), &p) == nil, "a record's value is not JSON: %s", values[i])
	return p, values[i]
}

// hIsEvent reports whether p is exactly {type, tenant: acme, comment_id, thread_id: t-1, parent_id, revision}.
func hIsEvent(p map[string]any, kind, commentID, parentID string, revision int) bool {
	return len(p) == 6 && p["type"] == "comment."+kind && p["tenant"] == "acme" && p["comment_id"] == commentID && p["thread_id"] == "t-1" && p["parent_id"] == parentID && p["revision"] == float64(revision)
}

func CheckThreadKey(ctx *harness.Ctx) {
	hCreate(ctx, hEventComment(ctx, "t-1", "u-1", "", hEventText))
	hCreate(ctx, hEventComment(ctx, "t-2", "u-1", "", hEventText))
	hCreate(ctx, hEventComment(ctx, "t-1", "u-2", "", hEventText))
	ctx.Settle()
	records := ctx.Kafka.Records(hTopic)
	ctx.Equal(len(records), 3, "three comments must produce three records on %s; the records", hTopic)
	ctx.Equal(ctx.Kafka.Keys(hTopic), []string{"t-1", "t-2", "t-1"}, "the records must be keyed by the thread ids (keyed by anything else, one thread's events scatter across partitions)")
	ctx.Equal(records[0].Partition, records[2].Partition, "both t-1 events must land on one partition, or a read model sees the thread out of order; the partitions")
}

func CheckAfterCommit(ctx *harness.Ctx) {
	// The instant the comment is committed, what is already on the topic.
	atCommit := ctx.Redis.After(hEventIdx, func() any { return len(ctx.Kafka.Records(hTopic)) })
	c := hEventComment(ctx, "t-1", "u-1", "", hEventText)
	hCreate(ctx, c)
	ctx.Settle()
	ctx.Assert(atCommit.Fired, "createComment never committed the comment (nothing wrote %s)", hEventIdx)
	ctx.Equal(atCommit.Result, 0, "when the comment was committed the topic already held records: a consumer could look up a comment the store does not have. Commit first, then produce; the records at commit time")
	ctx.Equal(len(ctx.Kafka.Records(hTopic)), 1, "the event must still be produced after the commit; the records")
	deleted, err := deleteComment(hBg, "acme", c.ID)
	ctx.NoError(err, "deleteComment(%s) failed", c.ID)
	ctx.Assert(store.Get(hBg, "acme", c.ID).Deleted, "deleteComment must soft-delete the comment")
	ctx.Assert(deleted != nil && fmt.Sprint(deleted["revision"]) == "2", "the deleted event must carry the revision the delete committed (2), got %v: an event produced before the write describes the row as it was", deleted)
	none, err := deleteComment(hBg, "acme", "c-404")
	ctx.Assert(err == nil && none == nil, "deleting a comment that does not exist must return nil, nil; got %v, %v", none, err)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(hTopic)), 2, "the topic must hold the created and the deleted events; the records")
	// The broker rejects the next event: what the store holds then shows which came first.
	ctx.Kafka.FailNext(hTopic, 1)
	unsent := hEventComment(ctx, "t-1", "u-1", "", hEventText)
	_, err = createComment(hBg, "acme", unsent)
	ctx.Assert(store.Get(hBg, "acme", unsent.ID) != nil, "the broker rejected the created event and the comment was never committed: commit first, then produce")
	ctx.Assert(err != nil, "the broker rejected the created event and createComment returned as if it had been delivered: a failed delivery must reach the caller")
	ctx.Kafka.FailNext(hTopic, 1)
	_, err = deleteComment(hBg, "acme", unsent.ID)
	ctx.Assert(store.Get(hBg, "acme", unsent.ID).Deleted, "the broker rejected the deleted event and the comment is not deleted: the event was produced before store.SoftDelete. Commit first: an event may lag the store, never lead it")
	ctx.Assert(err != nil, "the broker rejected the deleted event and deleteComment returned as if it had been delivered: a failed delivery must reach the caller")
}

func CheckPayload(ctx *harness.Ctx) {
	root := hEventComment(ctx, "t-1", "u-1", "", hEventText)
	hCreate(ctx, root)
	reply := hEventComment(ctx, "t-1", "u-1", root.ID, "Not the butler")
	hCreate(ctx, reply)
	ctx.Settle()
	p, raw := hPayloadAt(ctx, 1)
	_, hasText := p["text"]
	ctx.Assert(!strings.Contains(raw, "butler") && !hasText, "the event carries the comment's text: %s. The topic is retained and replicated; carry ids, and let consumers read the text from the store", raw)
	ctx.Assert(hIsEvent(p, "created", reply.ID, root.ID, 1), "the event is %s, expected {type: comment.created, tenant: acme, comment_id: %s, thread_id: t-1, parent_id: %s, revision: 1}", raw, reply.ID, root.ID)
	_, err := deleteComment(hBg, "acme", reply.ID)
	ctx.NoError(err, "deleteComment(%s) failed", reply.ID)
	ctx.Settle()
	gone, raw := hPayloadAt(ctx, 2)
	ctx.Assert(hIsEvent(gone, "deleted", reply.ID, root.ID, 2), "the deleted event is %s, expected {type: comment.deleted, tenant: acme, comment_id: %s, thread_id: t-1, parent_id: %s, revision: 2}: every event carries the same fields, from the committed row", raw, reply.ID, root.ID)
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(hTopic, 1) // the broker wrote it, the acknowledgement never arrived
	hCreate(ctx, hEventComment(ctx, "t-1", "u-1", "", hEventText))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(hTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	hCreate(ctx, hEventComment(ctx, "t-1", "u-1", "", hEventText))
	ctx.Settle()
	ctx.Kafka.Failover(hTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(hTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>

#include "comments/store.h"

namespace {

const std::string hTopic = "comment.event";
const std::string hEventIndex = "thread:acme:t-1:comments";
const std::string hEventText = "The butler did it";

store::Comment hEventComment(const std::string& thread_id = "t-1", const std::string& author = "u-1", const std::string& parent_id = "",
                             const std::string& text = hEventText) {
  return store::newComment(thread_id, parent_id, author, text, text);
}

nlohmann::json hCreate(harness::Ctx& ctx, const store::Comment& c) {
  try {
    return createComment("acme", c);
  } catch (const std::exception& e) {
    ctx.Fatalf("createComment(%s) threw %s: %s", c.id, harness::CurrentExceptionType(), e.what());
  }
}

}  // namespace

void CheckThreadKey(harness::Ctx& ctx) {
  hCreate(ctx, hEventComment("t-1", "u-1"));
  hCreate(ctx, hEventComment("t-2", "u-1"));
  hCreate(ctx, hEventComment("t-1", "u-2"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(hTopic);
  ctx.Equal(records.size(), 3, "three comments must produce three records on %s; the records", hTopic);
  ctx.Equal(ctx.Kafka.Keys(hTopic), {"t-1", "t-2", "t-1"}, "the records must be keyed by the thread ids (keyed by anything else, one thread's events scatter across partitions)");
  ctx.Equal(records[0].Partition, records[2].Partition, "both t-1 events must land on one partition, or a read model sees the thread out of order; the partitions");
}

void CheckAfterCommit(harness::Ctx& ctx) {
  // The instant the comment is committed, what is already on the topic.
  bool fired = false;
  size_t atCommit = 999;
  ctx.Redis.After(hEventIndex, [&] {
    fired = true;
    atCommit = ctx.Kafka.Records(hTopic).size();
  });
  const store::Comment c = hEventComment();
  hCreate(ctx, c);
  ctx.Settle();
  ctx.Assert(fired, "createComment never committed the comment (nothing wrote %s)", hEventIndex);
  ctx.Equal(atCommit, 0, "when the comment was committed the topic already held records: a consumer could look up a comment the store does not have. Commit first, then produce; the records at commit time");
  ctx.Equal(ctx.Kafka.Records(hTopic).size(), 1, "the event must still be produced after the commit; the records");
  const auto deleted = deleteComment("acme", c.id);
  ctx.Assert(store::get("acme", c.id)->deleted, "deleteComment must soft-delete the comment");
  ctx.Assert(deleted && deleted->value("revision", 0) == 2, "the deleted event must carry the revision the delete committed (2), got %s: an event produced before the write describes the row as it was",
             deleted ? deleted->dump() : "nothing");
  ctx.Assert(!deleteComment("acme", "c-404"), "deleting a comment that does not exist must return nothing");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(hTopic).size(), 2, "the topic must hold the created and the deleted events; the records");
  // The broker rejects the next event: what the store holds then shows which came first.
  ctx.Kafka.FailNext(hTopic, 1);
  const store::Comment unsent = hEventComment();
  bool threw = false;
  try {
    createComment("acme", unsent);
  } catch (const std::exception&) {
    threw = true;
  }
  ctx.Assert(store::get("acme", unsent.id).has_value(), "the broker rejected the created event and the comment was never committed: commit first, then produce");
  ctx.Assert(threw, "the broker rejected the created event and createComment returned as if it had been delivered: a failed delivery must reach the caller");
  ctx.Kafka.FailNext(hTopic, 1);
  threw = false;
  try {
    deleteComment("acme", unsent.id);
  } catch (const std::exception&) {
    threw = true;
  }
  ctx.Assert(store::get("acme", unsent.id)->deleted, "the broker rejected the deleted event and the comment is not deleted: the event was produced before store::softDelete. Commit first: an event may lag the store, never lead it");
  ctx.Assert(threw, "the broker rejected the deleted event and deleteComment returned as if it had been delivered: a failed delivery must reach the caller");
}

void CheckPayload(harness::Ctx& ctx) {
  const store::Comment root = hEventComment();
  hCreate(ctx, root);
  const store::Comment reply = hEventComment("t-1", "u-1", root.id, "Not the butler");
  hCreate(ctx, reply);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(hTopic);
  ctx.Equal(values.size(), 2, "two comments, the records");
  const std::string raw = values[1];
  const auto payload = nlohmann::json::parse(raw, nullptr, false);
  ctx.Assert(payload.is_object(), "a record's value is not JSON: %s", raw);
  ctx.Assert(raw.find("butler") == std::string::npos && !payload.contains("text"), "the event carries the comment's text: %s. The topic is retained and replicated; carry ids, and let consumers read the text from the store", raw);
  const nlohmann::json expected = {{"type", "comment.created"}, {"tenant", "acme"}, {"comment_id", reply.id}, {"thread_id", "t-1"}, {"parent_id", root.id}, {"revision", 1}};
  ctx.Assert(payload == expected, "the event is %s, expected %s", raw, expected.dump());
  try {
    deleteComment("acme", reply.id);
  } catch (const std::exception& e) {
    ctx.Fatalf("deleteComment(%s) threw %s: %s", reply.id, harness::CurrentExceptionType(), e.what());
  }
  ctx.Settle();
  const auto all = ctx.Kafka.Values(hTopic);
  ctx.Equal(all.size(), 3, "deleting %s must add the deleted event; the records", reply.id);
  const auto gone = nlohmann::json::parse(all[2], nullptr, false);
  const nlohmann::json deleted = {{"type", "comment.deleted"}, {"tenant", "acme"}, {"comment_id", reply.id}, {"thread_id", "t-1"}, {"parent_id", root.id}, {"revision", 2}};
  ctx.Assert(gone == deleted, "the deleted event is %s, expected %s: every event carries the same fields, from the committed row", all[2], deleted.dump());
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(hTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  hCreate(ctx, hEventComment());
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(hTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  hCreate(ctx, hEventComment());
  ctx.Settle();
  ctx.Kafka.Failover(hTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(hTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}
`,
  },
  hints: [
    'Post two comments in one thread from two authors and watch the partitions: the thread is split. Consume the topic and you can read every comment’s text without asking the store.',
    'The record key is the author, so the partitioner spreads a thread around. The event goes out before `commit_comment` or `soft_delete`, from the row as it was, and the payload is built with `text` in it.',
    'Key by `comment["thread_id"]`; commit first and build the delete event from the row `soft_delete` returns; send `parent_id` and `revision` instead of `author_id` and `text`; set `enable.idempotence` with `acks=all`.',
  ],
  debrief: `An event is a statement about state that already exists, which is why the commit comes first and why a delete event is built from the row the delete wrote: its revision is what lets a read model drop a stale or repeated update. The key is the thread because order only matters within a thread, and Kafka orders only within a partition. The payload carries ids because the topic outlives every rule the store has about who may read a comment and when it is erased. The idempotent producer with \`acks=all\` makes a retry land once and survive a failover. Production services write the event into an outbox in the same transaction as the comment and let a relay produce it, so a broker outage delays events without losing them.`,
};
