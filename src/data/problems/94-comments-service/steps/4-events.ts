import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Comment events keyed by thread for read models',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it serialises the comment,
produces one event to \`comment.event\` and lets read models rebuild themselves. It compiles, the
analytics pipeline fills up, and it hides three production flaws. Review it like the service owner,
fix it, and prove the fix with the checks below.

Publish comment lifecycle events to the topic \`comment.event\`.

- Every event is **keyed by the thread id** (\`key: comment.thread_id\` /
  \`Key: []byte(comment.ThreadID)\` / \`ProducerRecord(Topic, comment.thread_id, payload)\`). The key
  is the ordering contract: one thread's events must land on one partition so a read model never
  applies an edit before the create it edits.
- Events are published **after the change commits** at the durable store. Write the comment (or the
  edit, or the tombstone) first, then produce: an event for a change that does not exist yet is an
  event a consumer cannot act on.
- The payload carries identity and revision only — \`id\`, \`parent_id\`, \`revision\`,
  \`event_type\` — declared as one explicit field list (\`EVENT_FIELDS\`) so a future field cannot
  be added by accident. **Never the body**: a topic is retained and replicated, and a body in it
  turns every consumer into another copy of your tenant's content.
- All three lifecycle events are published by explicit functions:
  \`publish_created\`, \`publish_edited\`, \`publish_deleted\`, each writing its own
  \`event_type\` (\`created\` / \`edited\` / \`deleted\`) after its own durable write.
- Edits carry the new **revision**, so a consumer can drop an out-of-order or duplicate edit
  instead of overwriting newer text with older text.

**Failure mode the checks target.** The draft gets the key, the moment and the payload wrong at
once. Keying by the **author** scatters one thread's events across partitions, so a thread's stream
arrives interleaved with every other thread that author touches and a read model can apply an edit
before the comment it edits exists. It **produces before the insert**, so a crash between the two
leaves the topic advertising a comment the store never wrote. And it **ships the body** in the event
"so read models avoid a fetch" — the fetch is exactly what a read model should do, because the body
is the one field that must not be copied into a retained, replicated, long-lived log.`,
  sequence: {
    participants: ['Comments API', 'comment.event', 'Read model'],
    messages: [
      {from: 'Comments API', to: 'Comments API', label: 'insert / update / soft-delete commits first', kind: 'sync'},
      {
        from: 'Comments API',
        to: 'comment.event',
        label: 'produce key = thread_id · {id, parent_id, revision, event_type}',
        kind: 'async',
      },
      {from: 'comment.event', to: 'Read model', label: 'one partition per thread, in order', kind: 'async'},
      {from: 'Read model', to: 'Read model', label: 'drop revisions older than the row', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'topic-key',
      title: 'Publishes to comment.event keyed by thread',
      detail:
        'The message key is the thread id, so every event of one thread lands on one partition and a thread’s stream stays ordered. The draft keys by the author, which interleaves threads.',
      match: {
        python: {all: [/TOPIC = "comment\.event"/, /key=comment\["thread_id"\]/]},
        typescript: {all: [/TOPIC = 'comment\.event'/, /key: comment\.thread_id/]},
        go: {all: [/commentEventTopic = "comment\.event"/, /Key: \[\]byte\(comment\.ThreadID\)/]},
        scala: {all: [/val Topic = "comment\.event"/, /ProducerRecord\(Topic, comment\.thread_id, payload\)/]},
        cpp: {all: [/kCommentEventTopic = "comment\.event"/, /comment\.threadId\.data\(\)/]},
      },
    },
    {
      id: 'after-commit',
      title: 'Publishes only after the change commits',
      detail:
        'The durable write happens before the produce in every publisher. The draft produces first, so a crash in between advertises a comment the store never wrote.',
      match: {
        python: {order: [/store\.insert\(/, /producer\.send\(/]},
        typescript: {order: [/store\.insert\(/, /producer\.send\(/]},
        go: {order: [/store\.Insert\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/store\.insert\(/, /producer\.send\(/]},
        cpp: {order: [/store\.insert\(/, /produce\(eventValue/]},
      },
    },
    {
      id: 'payload-shape',
      title: 'Carries comment id, parent id and revision',
      detail:
        'The event is built from one explicit field list (`EVENT_FIELDS`) and carries `id`, `parent_id`, `revision` and `event_type` — ids the read model can fetch with and a revision it can compare.',
      match: {
        python: {all: [/EVENT_FIELDS/, /"parent_id": comment\[/, /"revision": comment\[/]},
        typescript: {all: [/EVENT_FIELDS/, /parent_id: comment\.parentId/, /revision: comment\.revision/]},
        go: {all: [/eventFields/, /"parent_id":\s+comment\.ParentID/, /"revision":\s+comment\.Revision/]},
        scala: {all: [/EventFields/, /"parent_id" -> comment\.parentId/, /"revision" -> comment\.revision/]},
        cpp: {all: [/kEventFields/, /"parent_id", comment\.parentId/, /"revision", comment\.revision/]},
      },
    },
    {
      id: 'no-body',
      title: 'Never puts the body in the event',
      detail:
        'No payload field carries comment text. The draft ships the body into a retained, replicated topic, so every consumer holds a copy of tenant content.',
      match: {
        python: {all: [/EVENT_FIELDS/], none: [/["']body["']/]},
        typescript: {all: [/EVENT_FIELDS/], none: [/\bbody\b/]},
        go: {all: [/eventFields/], none: [/json:"body"|"body"/]},
        scala: {all: [/EventFields/], none: [/"body"/]},
        cpp: {all: [/kEventFields/], none: [/"body"/]},
      },
    },
    {
      id: 'event-types',
      title: 'Publishes created, edited and deleted',
      detail:
        'Three explicit publishers — `publish_created`, `publish_edited`, `publish_deleted` — each with its own `event_type`, so a delete is a tombstone event rather than silence.',
      match: {
        python: {all: [/def publish_created\(/, /def publish_edited\(/, /def publish_deleted\(/]},
        typescript: {all: [/export async function publishCreated\(/, /publishEdited\(/, /publishDeleted\(/]},
        go: {all: [/func publishCreated\(/, /func publishEdited\(/, /func publishDeleted\(/]},
        scala: {all: [/def publishCreated\(/, /def publishEdited\(/, /def publishDeleted\(/]},
        cpp: {all: [/publishCreated\(/, /publishEdited\(/, /publishDeleted\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from kafka import KafkaProducer

producer = KafkaProducer(bootstrap_servers="kafka:9092")


class CommentStore:
    def insert(self, comment: dict) -> None:
        """Persist the comment."""
        raise NotImplementedError


store = CommentStore()


def publish(comment: dict) -> None:
    # TODO: this draft keys by the author, publishes before the comment commits, and ships the body
    # so read models avoid a fetch. Review all three.
    payload = json.dumps(
        {"id": comment["id"], "author_id": comment["author_id"], "body": comment["body"]}
    ).encode()
    producer.send(TOPIC, key=comment["author_id"].encode(), value=payload)
    producer.flush()
    store.insert(comment)


TOPIC = "comment.event"
`,
      solution: `import json

from kafka import KafkaProducer

producer = KafkaProducer(bootstrap_servers="kafka:9092", acks="all")

TOPIC = "comment.event"
EVENT_FIELDS = ("id", "parent_id", "revision", "event_type")


class CommentStore:
    def insert(self, comment: dict) -> None:
        """Persist the comment."""
        raise NotImplementedError

    def update(self, comment: dict) -> None:
        """Persist a new revision of the comment."""
        raise NotImplementedError

    def soft_delete(self, comment: dict) -> None:
        """Mark the comment deleted without losing its identity."""
        raise NotImplementedError


store = CommentStore()


def event_value(comment: dict, event_type: str) -> bytes:
    """Identity and revision only: a consumer fetches the text from the store, it never travels."""
    payload = {
        "id": comment["id"],
        "parent_id": comment["parent_id"],
        "revision": comment["revision"],
        "event_type": event_type,
    }
    if tuple(payload) != EVENT_FIELDS:
        raise ValueError("comment.event payload drifted")
    return json.dumps(payload).encode()


def publish_created(comment: dict) -> None:
    """Commit first, then publish keyed by the thread, so a thread's stream stays ordered."""
    store.insert(comment)
    producer.send(TOPIC, key=comment["thread_id"].encode(), value=event_value(comment, "created"))
    producer.flush()


def publish_edited(comment: dict) -> None:
    store.update(comment)
    producer.send(TOPIC, key=comment["thread_id"].encode(), value=event_value(comment, "edited"))
    producer.flush()


def publish_deleted(comment: dict) -> None:
    store.soft_delete(comment)
    producer.send(TOPIC, key=comment["thread_id"].encode(), value=event_value(comment, "deleted"))
    producer.flush()
`,
    },
    typescript: {
      starter: `/** comment.event: a model-generated draft that keys by author and publishes too early. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'comments-service', brokers: ['kafka:9092']});
export const producer = kafka.producer();

interface Comment {
  id: string;
  thread_id: string;
  author_id: string;
  parentId: string | null;
  revision: number;
  text: string;
}

export async function publish(comment: Comment): Promise<void> {
  // TODO: this draft keys by the author, publishes before the comment commits, and ships the body
  // so read models avoid a fetch. Review all three.
  await producer.send({
    topic: 'comment.event',
    messages: [{key: comment.author_id, value: JSON.stringify({id: comment.id, body: comment.text})}],
  });
  await store.insert(comment);
}
`,
      solution: `/** comment.event: one event per lifecycle change, keyed by thread, after the commit. */
import {Kafka} from 'kafkajs';

import {store} from './store';

const kafka = new Kafka({clientId: 'comments-service', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});

const TOPIC = 'comment.event';
const EVENT_FIELDS = ['id', 'parent_id', 'revision', 'event_type'] as const;

interface Comment {
  id: string;
  thread_id: string;
  author_id: string;
  parentId: string | null;
  revision: number;
}

/** Identity and revision only: a consumer fetches the text from the store, it never travels. */
function eventValue(comment: Comment, eventType: string): string {
  const payload: Record<string, unknown> = {
    id: comment.id,
    parent_id: comment.parentId,
    revision: comment.revision,
    event_type: eventType,
  };
  if (Object.keys(payload).join() !== EVENT_FIELDS.join()) throw new Error('comment.event payload drifted');
  return JSON.stringify(payload);
}

/** Commit first, then publish keyed by the thread, so a thread's stream stays ordered. */
export async function publishCreated(comment: Comment): Promise<void> {
  await store.insert(comment);
  await producer.send({
    topic: TOPIC,
    acks: -1,
    messages: [{key: comment.thread_id, value: eventValue(comment, 'created')}],
  });
}

export async function publishEdited(comment: Comment): Promise<void> {
  await store.update(comment);
  await producer.send({
    topic: TOPIC,
    acks: -1,
    messages: [{key: comment.thread_id, value: eventValue(comment, 'edited')}],
  });
}

export async function publishDeleted(comment: Comment): Promise<void> {
  await store.softDelete(comment);
  await producer.send({
    topic: TOPIC,
    acks: -1,
    messages: [{key: comment.thread_id, value: eventValue(comment, 'deleted')}],
  });
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

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "comment.event"}

type Comment struct {
	ID       string
	ThreadID string
	AuthorID string
	ParentID string
	Revision int
	Text     string
}

type CommentStore struct{}

func (s *CommentStore) Insert(ctx context.Context, comment *Comment) error { return nil }

var store = &CommentStore{}

// TODO: this draft keys by the author, publishes before the comment commits, and ships the text so
// read models avoid a fetch. Review all three.
func publish(ctx context.Context, comment *Comment) error {
	payload, _ := json.Marshal(map[string]any{"id": comment.ID, "body": comment.Text})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(comment.AuthorID), Value: payload}); err != nil {
		return err
	}
	return store.Insert(ctx, comment)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const commentEventTopic = "comment.event"

var (
	writer      = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: commentEventTopic, RequiredAcks: kafka.RequireAll}
	eventFields = [...]string{"id", "parent_id", "revision", "event_type"}
)

type Comment struct {
	ID       string
	ThreadID string
	AuthorID string
	ParentID string
	Revision int
}

type CommentStore struct{}

func (s *CommentStore) Insert(ctx context.Context, comment *Comment) error     { return nil }
func (s *CommentStore) Update(ctx context.Context, comment *Comment) error     { return nil }
func (s *CommentStore) SoftDelete(ctx context.Context, comment *Comment) error { return nil }

var store = &CommentStore{}

// eventValue builds the event from one explicit field list: identity and revision, never the text.
func eventValue(comment *Comment, eventType string) []byte {
	payload := map[string]any{
		"id":         comment.ID,
		"parent_id":  comment.ParentID,
		"revision":   comment.Revision,
		"event_type": eventType,
	}
	out, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	if len(payload) != len(eventFields) {
		panic("comment.event payload drifted")
	}
	return out
}

// publishCreated commits first, then publishes keyed by the thread, so one thread stays ordered.
func publishCreated(ctx context.Context, comment *Comment) error {
	if err := store.Insert(ctx, comment); err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(comment.ThreadID), Value: eventValue(comment, "created")})
}

func publishEdited(ctx context.Context, comment *Comment) error {
	if err := store.Update(ctx, comment); err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(comment.ThreadID), Value: eventValue(comment, "edited")})
}

func publishDeleted(ctx context.Context, comment *Comment) error {
	if err := store.SoftDelete(ctx, comment); err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(comment.ThreadID), Value: eventValue(comment, "deleted")})
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object CommentEvents {
  val producer = new KafkaProducer[String, String](new Properties())
  val store = CommentStore.open()

  // TODO: this draft keys by the author, publishes before the comment commits, and ships the text
  // so read models avoid a fetch. Review all three.
  def publish(comment: Comment): Unit = {
    val payload = Map("id" -> comment.id, "body" -> comment.text).toJson.compactPrint
    producer.send(new ProducerRecord("comment.event", comment.authorId, payload))
    store.insert(comment)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object CommentEvents {
  val Topic = "comment.event"
  val EventFields = List("id", "parent_id", "revision", "event_type")

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val store = CommentStore.open()

  /** Identity and revision only: a consumer fetches the text from the store, it never travels. */
  def eventValue(comment: Comment, eventType: String): String = {
    val payload = Map(
      "id" -> comment.id,
      "parent_id" -> comment.parentId,
      "revision" -> comment.revision,
      "event_type" -> eventType
    )
    require(payload.keys.toList.sorted == EventFields.sorted, "comment.event payload drifted")
    payload.toJson.compactPrint
  }

  /** Commit first, then publish keyed by the thread, so one thread stays ordered. */
  def publishCreated(comment: Comment): Unit = {
    store.insert(comment)
    val payload = eventValue(comment, "created")
    producer.send(new ProducerRecord(Topic, comment.thread_id, payload))
  }

  def publishEdited(comment: Comment): Unit = {
    store.update(comment)
    val payload = eventValue(comment, "edited")
    producer.send(new ProducerRecord(Topic, comment.thread_id, payload))
  }

  def publishDeleted(comment: Comment): Unit = {
    store.softDelete(comment)
    val payload = eventValue(comment, "deleted")
    producer.send(new ProducerRecord(Topic, comment.thread_id, payload))
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

using json = nlohmann::json;

struct CommentStore {
  void insert(const Comment& comment);
};

struct Comment {
  std::string id;
  std::string threadId;
  std::string authorId;
  std::string text;
};

CommentStore store;
std::unique_ptr<RdKafka::Producer> producer;

// TODO: this draft keys by the author, publishes before the comment commits, and ships the text so
// read models avoid a fetch. Review all three.
void publish(const Comment& comment) {
  const json event = {{"id", comment.id}, {"body", comment.text}};
  const auto payload = event.dump();
  producer->produce(
      "comment.event",
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      comment.authorId.data(),
      comment.authorId.size(),
      0,
      nullptr);
  store.insert(comment);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kCommentEventTopic = "comment.event";
const std::vector<std::string> kEventFields = {"id", "parent_id", "revision", "event_type"};

struct Comment {
  std::string id;
  std::string threadId;
  std::string authorId;
  std::string parentId;
  int revision = 1;
};

struct CommentStore {
  void insert(const Comment& comment);
  void update(const Comment& comment);
  void softDelete(const Comment& comment);
};

CommentStore store;
std::unique_ptr<RdKafka::Producer> producer;

// eventValue builds the event from one explicit field list: identity and revision, never the text.
static std::string eventValue(const Comment& comment, const std::string& eventType) {
  const json payload = {
      {"id", comment.id},
      {"parent_id", comment.parentId},
      {"revision", comment.revision},
      {"event_type", eventType},
  };
  return payload.dump();
}

static void produce(const std::string& payload, const Comment& comment) {
  producer->produce(
      kCommentEventTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      comment.threadId.data(),
      comment.threadId.size(),
      0,
      nullptr);
  producer->flush(2000);
}

// publishCreated commits first, then publishes keyed by the thread, so one thread stays ordered.
void publishCreated(const Comment& comment) {
  store.insert(comment);
  produce(eventValue(comment, "created"), comment);
}

void publishEdited(const Comment& comment) {
  store.update(comment);
  produce(eventValue(comment, "edited"), comment);
}

void publishDeleted(const Comment& comment) {
  store.softDelete(comment);
  produce(eventValue(comment, "deleted"), comment);
}
`,
    },
  },
  hints: [
    'The key is a routing decision, not metadata: Kafka maps the key to a partition, so `key = thread_id` puts one thread’s stream on one partition and in order. Keying by the author mixes every thread that author writes in and a read model can apply an edit before the create it edits.',
    'Order the statements, not just the calls: write to the store, then `producer.send(...)`. An event published first is a promise about a row that a crash can take away, and a consumer will fail on a comment that does not exist.',
    'Build the payload from one explicit list of fields (`EVENT_FIELDS`) — `id`, `parent_id`, `revision`, `event_type` — and add an assertion that the keys still match. The body has no place in a retained, replicated topic: consumers fetch by id when they need the text, which keeps content in the store that owns its retention.',
  ],
  debrief: `The interviewer is asking what an event stream is for. It is not a copy of the database: it is the ordered log of what happened, so consumers can rebuild derived views. Three properties follow. The key decides order — by thread, because a thread is the unit whose order matters. The publish moment decides truth — after the commit, because a consumer that follows a failed write will ask for a comment that does not exist. And the payload decides exposure — ids and revisions only, because a topic is retained, replicated and read by teams who never needed your tenant’s text. The revision field is what makes the stream idempotent in practice: a consumer comparing revisions can drop duplicates and out-of-order edits instead of trusting arrival order. Real platforms add a schema registry, an outbox row so a produce failure is retried rather than lost, and a tombstone retention policy for delete events.`,
};
