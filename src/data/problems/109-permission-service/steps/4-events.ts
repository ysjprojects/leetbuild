import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Permission events keyed by subject for revocation replay',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'outbox', 'projector', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it assigns a role, publishes a
\`permission.event\` on the happy path and answers \`200\`. It compiles, it serves the demo, and it
hides four production flaws — a role-ordered stream, a publish that races the grant, no outbox, and a
payload with no version. Review it like the service owner, fix it, and prove the fix with the checks
below.

Every grant change — \`granted\`, \`revoked\` and \`scope_changed\` alike — produces **exactly one**
\`permission.event\` record on the \`permission.event\` topic.

- The message **key is the subject id** (\`user:ada\`) for every kind of change, so that one
  subject's history stays on one partition and in order: a consumer can replay that subject's
  grants and revocations in the order they happened. Never key by the role.
- The payload carries \`type\`, \`subject\`, \`role_id\`, \`scope\` and \`grant_version\` — the
  version the grant was committed at. A record without the version cannot be folded back into the
  cache, which is the whole reason the stream exists.
- The event row is inserted into \`permission_outbox\` **in the same transaction as the grant**,
  through \`store.commitAssignment(...)\`: the grant and its event land together or not at all.
- A **relay** publishes pending outbox rows only **after** that transaction has committed, and
  calls \`store.markSent(rowId)\` only **after** the broker acknowledges the produce. A broker
  rejection leaves the row pending for the next pass instead of dropping the event; the assignment
  is already committed, so a broker outage is still \`200\` with the event queued — never a 5xx,
  never a lost event.
- A **projector** consumer replays \`permission.event\` into the \`grant_version\` counter
  (\`rebuildVersion\`), which is how the permission cache is rebuilt from the log after a Redis loss.
- Log the subject, role id and version — ids only, never the whole permission set.

**Failure mode the checks target.** Keying by the role scatters one subject's history across
partitions, so no consumer can reconstruct that subject in order and a revocation can be replayed
before the grant it revokes. Publishing before the commit announces a grant that can still roll back,
so the topic and the store disagree about whether the grant exists. With no outbox, one broker
rejection loses the event forever and a revocation never reaches the cache. And a payload with no
version leaves the log unable to explain the counter — and the cache — it was supposed to rebuild.`,
  sequence: {
    participants: ['Permission Service', 'Outbox', 'permission.event', 'Event projector', 'Redis'],
    messages: [
      {
        from: 'Permission Service',
        to: 'Outbox',
        label: 'INSERT permission_outbox · one row per grant change · same tx as the grant',
        kind: 'sync',
      },
      {
        from: 'Permission Service',
        to: 'Permission Service',
        label: 'COMMIT · grant + outbox row land together',
        kind: 'sync',
      },
      {
        from: 'Outbox',
        to: 'permission.event',
        label: 'relay · produce key = subject · type/subject/role_id/scope/grant_version',
        kind: 'async',
      },
      {from: 'permission.event', to: 'Outbox', label: 'ack', kind: 'reply'},
      {from: 'Outbox', to: 'Outbox', label: 'markSent(row) · a rejection stays pending', kind: 'sync'},
      {from: 'permission.event', to: 'Event projector', label: 'consume · group permission-projector', kind: 'async'},
      {from: 'Event projector', to: 'Redis', label: 'rebuildVersion · SET grant_version = max(seen)', kind: 'sync'},
      {from: 'Redis', to: 'Event projector', label: 'counter', kind: 'reply'},
      {from: 'Event projector', to: 'permission.event', label: 'commit offset after the fold', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key, so it is an ordering contract: `key=subject` (`Key: []byte(subject)`, `key: subject`, `ProducerRecord(topic, subject, …)`). Keyed by the role, one subject’s granted, revoked and scope-changed records land on different partitions and their relative order stops meaning anything — a replay can undo a grant after it was made.',
    'The outbox is the durability half of the produce, not a retry helper: the event row is written into `permission_outbox` in the same transaction as the grant, a relay publishes pending rows once that transaction has committed, and only the broker’s acknowledgement may mark a row sent. A rejection mid-relay leaves the row pending, so a broker outage queues the event instead of dropping it — and the caller’s assignment is already durable, so it must not become a 5xx.',
    'Two facts make the stream replayable. The publish has to be a consequence of the commit — commit, then produce, never the reverse, because a rolled-back grant that was already announced cannot be un-announced. And every record carries `grant_version`, so a projector consuming `permission.event` can fold the log back into the version counter and rebuild the cache from the topic after Redis is lost.',
  ],
  checks: [
    {
      id: 'subject-key',
      title: 'Keys every event by subject id',
      detail:
        'Granted, revoked and scope-changed events all use the subject id as the message key, so one subject’s history stays on one partition and in order. The draft keys by role, scattering a subject’s events across partitions.',
      match: {
        python: {all: [/producer\.produce\(/, /key=subject\b/]},
        typescript: {all: [/producer\.send\(/, /key:\s*subject\b/]},
        go: {all: [/WriteMessages\(/, /Key:\s*\[\]byte\(subject\)/]},
        scala: {all: [/producer\.send\(/, /ProducerRecord[\s\S]{0,160}?subject\b/]},
        cpp: {all: [/producer->produce\(/, /std::string key = subject/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes the event to an outbox inside the grant transaction',
      detail:
        'The event row goes into `permission_outbox` in the same transaction as the grant, and a relay publishes pending rows. The draft has no outbox, so a broker rejection drops the event.',
      match: {
        python: {all: [/permission_outbox/, /def relay\(/]},
        typescript: {all: [/permission_outbox/, /relayOutbox\(/]},
        go: {all: [/permission_outbox/, /func relay\(/]},
        scala: {all: [/permission_outbox/, /def relay\(/]},
        cpp: {all: [/permission_outbox/, /relayOutbox\(/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Publishes after the commit and marks sent after the ack',
      detail:
        'Rows are published only after the grant transaction commits, and marked sent only after the broker acknowledges; publishing before the commit can announce a grant that then rolls back. The draft publishes first.',
      match: {
        python: {order: [/store\.commit_assignment\(/, /producer\.produce\(/, /store\.mark_sent\(/]},
        typescript: {order: [/store\.commitAssignment\(/, /producer\.send\(/, /store\.markSent\(/]},
        go: {order: [/store\.CommitAssignment\(/, /WriteMessages\(/, /store\.MarkSent\(/]},
        scala: {order: [/store\.commitAssignment\(/, /producer\.send\(/, /store\.markSent\(/]},
        cpp: {order: [/store\.commitAssignment\(/, /producer->produce\(/, /store\.markSent\(/]},
      },
    },
    {
      id: 'event-fields',
      title: 'Carries the role ids, scopes and grant version',
      detail:
        'Each event carries the type, subject, `role_id`, scope and `grant_version`, which is what makes the stream replayable into the version counter. The draft’s payload has no version, so the stream cannot be folded back into the cache.',
      match: {
        python: {all: [/grant_version/, /role_id/]},
        typescript: {all: [/grant_version/, /role_id/]},
        go: {all: [/grant_version/, /role_id/]},
        scala: {all: [/grant_version/, /role_id/]},
        cpp: {all: [/grant_version/, /role_id/]},
      },
    },
    {
      id: 'rebuild-version',
      title: 'Rebuilds the cache version from the event stream',
      detail:
        'A projector folds `permission.event` back into the `grant_version` counter, so the cache can be rebuilt from the log after a Redis loss. The draft has no such path.',
      match: {
        python: {all: [/def rebuild_version\(/, /permission\.event/]},
        typescript: {all: [/rebuildVersion\(/, /permission\.event/]},
        go: {all: [/rebuildVersion\(/, /permission\.event/]},
        scala: {all: [/rebuildVersion\(/, /permission\.event/]},
        cpp: {all: [/rebuildVersion\(/, /permission\.event/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("permission")

producer = Producer({"bootstrap.servers": "kafka:9092"})


class Assignment(BaseModel):
    subject: str
    role: str
    scope: str


class GrantStore:
    def save(self, subject: str, role: str, scope: str) -> None:
        """Persist one assignment row."""
        raise NotImplementedError


store = GrantStore()


@app.post("/v1/roles/assignments")
def assign(body: Assignment, assigner: str = Header(alias="X-Assigner-Id")) -> dict:
    # TODO: this draft keys the event by the role instead of the subject, publishes before the
    # grant row is stored, has no outbox for a broker rejection, and its payload carries no
    # version, so the stream cannot be folded back into the cache. Review all four.
    logger.info("assign assigner=%s subject=%s role=%s scope=%s", assigner, body.subject, body.role, body.scope)
    event = {"type": "granted", "subject": body.subject, "role": body.role, "scope": body.scope}
    producer.produce("permission.event", key=body.role, value=json.dumps(event))
    producer.flush()
    store.save(body.subject, body.role, body.scope)
    return {"subject": body.subject, "role": body.role}


def consume_events() -> None:
    """Follow the stream and keep the cache warm."""
    from confluent_kafka import Consumer

    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "permission-projector"})
    consumer.subscribe(["permission.event"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        logger.info("event type=%s subject=%s", event["type"], event["subject"])
        consumer.commit(msg)
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("permission")

TOPIC = "permission.event"
OUTBOX_TABLE = "permission_outbox"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Assignment(BaseModel):
    subject: str
    role_id: str
    scope: str


class OutboxRow:
    id: int
    subject: str
    payload: str


class GrantStore:
    def commit_assignment(self, subject: str, role_id: str, scope: str, event: dict) -> None:
        """INSERT the grant row and its permission_outbox row in one transaction."""
        raise NotImplementedError

    def pending(self, limit: int) -> list[OutboxRow]:
        """Unsent permission_outbox rows, oldest first."""
        raise NotImplementedError

    def mark_sent(self, row_id: int) -> None:
        """Stamp the outbox row as published, after the broker ack."""
        raise NotImplementedError


store = GrantStore()


@app.post("/v1/roles/assignments")
def assign(body: Assignment, assigner: str = Header(alias="X-Assigner-Id")) -> dict:
    grant_version = r.incr("grant_version")
    event = {
        "type": "granted",
        "subject": body.subject,
        "role_id": body.role_id,
        "scope": body.scope,
        "grant_version": grant_version,
    }
    # The grant row and its outbox row commit together: there is no event without a grant.
    store.commit_assignment(body.subject, body.role_id, body.scope, event)
    logger.info(
        "assign assigner=%s subject=%s role_id=%s scope=%s grant_version=%d",
        assigner,
        body.subject,
        body.role_id,
        body.scope,
        grant_version,
    )
    return {"subject": body.subject, "grant_version": grant_version}


def relay(limit: int = 100) -> None:
    """Publish committed outbox rows, keyed by subject, and mark each sent only after the ack."""
    for row in store.pending(limit):
        subject = row.subject
        try:
            producer.produce(TOPIC, key=subject, value=row.payload)
            producer.flush(2.0)
        except KafkaException:
            logger.warning("produce rejected row=%s subject=%s", row.id, subject)
            continue  # the row stays pending: the next relay pass retries it
        store.mark_sent(row.id)


def rebuild_version() -> None:
    """Projector: fold permission.event back into the grant_version counter."""
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "permission-projector",
            "enable.auto.commit": False,
        }
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        r.set("grant_version", event["grant_version"])
        logger.info("rebuilt subject=%s grant_version=%d", event["subject"], event["grant_version"])
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** POST /v1/roles/assignments: a model-generated draft that tells Kafka before it stores the grant. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'permission-service', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface Assignment {
  subject: string;
  role: string;
  scope: string;
}

interface GrantStore {
  save(assignment: Assignment): Promise<void>;
}

const store = {} as GrantStore;

app.post('/v1/roles/assignments', async (request, reply) => {
  // TODO: the event is keyed by the role instead of the subject, it is published before the grant
  // row is stored, there is no outbox for a rejected produce and the payload carries no version,
  // so the stream cannot be folded back into the cache. Review all four.
  const body = request.body as Assignment;
  request.log.info({subject: body.subject, role: body.role, scope: body.scope}, 'assign');
  const event = {type: 'granted', subject: body.subject, role: body.role, scope: body.scope};
  await producer.send({
    topic: 'permission.event',
    messages: [{key: body.role, value: JSON.stringify(event)}],
  });
  await store.save(body);
  return reply.code(200).send({subject: body.subject, role: body.role});
});

/** Follows the stream so the projector stays roughly current. */
export async function consumeEvents(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'permission-projector'});
  await consumer.connect();
  await consumer.subscribe({topic: 'permission.event'});
  await consumer.run({
    eachMessage: async ({message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {type: string; subject: string};
      app.log.info({type: event.type, subject: event.subject}, 'permission.event');
    },
  });
}
`,
      solution: `/** Permission events: one outbox row per grant change, published per subject after the commit. */
import Fastify from 'fastify';
import {Kafka, type EachMessagePayload} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'permission-service', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const redis = new Redis('redis://redis:6379');

export const TOPIC = 'permission.event';
export const OUTBOX_TABLE = 'permission_outbox';

interface PermissionEvent {
  type: string;
  subject: string;
  role_id: string;
  scope: string;
  grant_version: number;
}

interface Assignment {
  subject: string;
  role_id: string;
  scope: string;
}

interface OutboxRow {
  id: number;
  subject: string;
  payload: string;
}

interface GrantStore {
  /** INSERT the grant row and its permission_outbox row in one transaction. */
  commitAssignment(subject: string, roleId: string, scope: string, event: PermissionEvent): Promise<void>;
  /** Unsent permission_outbox rows, oldest first. */
  pending(limit: number): Promise<OutboxRow[]>;
  /** Stamp the outbox row as published, after the broker ack. */
  markSent(rowId: number): Promise<void>;
}

const store = {} as GrantStore;

app.post('/v1/roles/assignments', async (request, reply) => {
  const assigner = request.headers['x-assigner-id'] as string;
  const body = request.body as Assignment;
  const grant_version = Number(await redis.incr('grant_version'));
  const event: PermissionEvent = {
    type: 'granted',
    subject: body.subject,
    role_id: body.role_id,
    scope: body.scope,
    grant_version,
  };
  // The grant row and its outbox row commit together: there is no event without a grant.
  await store.commitAssignment(body.subject, body.role_id, body.scope, event);
  request.log.info({assigner, subject: body.subject, role_id: body.role_id, grant_version}, 'assign');
  return reply.code(200).send({subject: body.subject, grant_version});
});

export async function relayOutbox(limit = 100): Promise<void> {
  for (const row of await store.pending(limit)) {
    const subject = row.subject;
    try {
      await producer.send({
        topic: TOPIC,
        acks: -1,
        messages: [{key: subject, value: row.payload}],
      });
    } catch (error) {
      // Rejected by the broker: the row stays pending and the next relay pass retries it.
      app.log.warn({row: row.id, subject, error}, 'produce rejected');
      continue;
    }
    await store.markSent(row.id);
  }
}

export async function rebuildVersion(): Promise<number> {
  const consumer = kafka.consumer({groupId: 'permission-projector'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  let version = 0;
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}: EachMessagePayload) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as PermissionEvent;
      version = Math.max(version, event.grant_version);
      await redis.set('grant_version', String(version));
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
  return version;
}

void app.listen({port: 8080, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/segmentio/kafka-go"
)

const eventTopic = "permission.event"

var eventWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: eventTopic}

type Assignment struct {
	Subject string \`json:"subject"\`
	Role    string \`json:"role"\`
	Scope   string \`json:"scope"\`
}

func saveAssignment(ctx context.Context, body Assignment) error {
	_ = ctx
	return nil
}

// TODO: the draft keys the event by the role instead of the subject, writes the event before the
// grant row is stored, has no outbox for a broker rejection and its payload carries no version,
// so the stream cannot be folded back into the cache. Review all four.
func assign(rw http.ResponseWriter, r *http.Request) {
	body := Assignment{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	event := map[string]any{
		"type":    "granted",
		"subject": body.Subject,
		"role":    body.Role,
		"scope":   body.Scope,
	}
	payload, _ := json.Marshal(event)
	if err := eventWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.Role), Value: payload}); err != nil {
		log.Printf("event rejected subject=%s", body.Subject)
	}
	if err := saveAssignment(r.Context(), body); err != nil {
		http.Error(rw, "save failed", http.StatusInternalServerError)
		return
	}
	rw.WriteHeader(http.StatusOK)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	eventTopic  = "permission.event"
	outboxTable = "permission_outbox"
)

var (
	eventWriter = &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Topic:        eventTopic,
		RequiredAcks: kafka.RequireAll,
		Balancer:     &kafka.Hash{},
	}
	rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

type PermissionEvent struct {
	Type         string \`json:"type"\`
	Subject      string \`json:"subject"\`
	RoleID       string \`json:"role_id"\`
	Scope        string \`json:"scope"\`
	GrantVersion int64  \`json:"grant_version"\`
}

type OutboxRow struct {
	ID      int64
	Subject string
	Payload []byte
}

type GrantStore struct{}

// CommitAssignment writes the grant row and its permission_outbox row in one transaction.
func (s *GrantStore) CommitAssignment(ctx context.Context, event PermissionEvent) error {
	return nil
}

// Pending returns unsent permission_outbox rows, oldest first.
func (s *GrantStore) Pending(ctx context.Context, limit int) ([]OutboxRow, error) {
	return nil, nil
}

// MarkSent stamps the outbox row as published, after the broker ack.
func (s *GrantStore) MarkSent(ctx context.Context, rowID int64) error {
	return nil
}

var store = &GrantStore{}

func assign(rw http.ResponseWriter, r *http.Request) {
	body := PermissionEvent{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	body.Type = "granted"
	version, err := rdb.Incr(r.Context(), "grant_version").Result()
	if err != nil {
		http.Error(rw, "version unavailable", http.StatusServiceUnavailable)
		return
	}
	body.GrantVersion = version
	// The grant row and its outbox row commit together: there is no event without a grant.
	if err := store.CommitAssignment(r.Context(), body); err != nil {
		http.Error(rw, "commit failed", http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(rw).Encode(map[string]any{"subject": body.Subject, "grant_version": version})
}

func relay(ctx context.Context) {
	rows, err := store.Pending(ctx, 100)
	if err != nil {
		log.Printf("outbox unavailable: %v", err)
		return
	}
	for _, row := range rows {
		subject := row.Subject
		if err := eventWriter.WriteMessages(ctx, kafka.Message{Key: []byte(subject), Value: row.Payload}); err != nil {
			log.Printf("produce rejected row=%d subject=%s; left pending", row.ID, subject)
			continue
		}
		if err := store.MarkSent(ctx, row.ID); err != nil {
			log.Printf("mark sent failed row=%d", row.ID)
		}
	}
}

func rebuildVersion(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   eventTopic,
		GroupID: "permission-projector",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		event := PermissionEvent{}
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		if err := rdb.Set(ctx, "grant_version", event.GrantVersion, 0).Err(); err != nil {
			return err
		}
		log.Printf("rebuilt subject=%s grant_version=%d", event.Subject, event.GrantVersion)
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object PermissionEvents {
  private val log = Logger.getLogger("permission")
  val producer = new KafkaProducer[String, String](new Properties())

  // TODO: key the event by the role instead of the subject, publish it only after the grant row is
  // stored, add an outbox for a broker rejection and carry a version in the payload so the stream
  // can be folded back into the cache. Review all four.
  def assign(assigner: String, subjectId: String, roleId: String, scope: String): Unit = {
    log.info(s"assign assigner=$assigner subj=$subjectId role=$roleId scope=$scope")
    val payload = Map("type" -> "granted", "subj" -> subjectId, "role" -> roleId, "scope" -> scope).toJson.compactPrint
    val ack = producer.send(new ProducerRecord("permission.event", roleId, payload))
    ack.get()
    GrantStore.save(subjectId, roleId, scope)
  }

  /** Follows the stream so the projector stays roughly current. */
  def followStream(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "permission-projector")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("permission.event"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        log.info(s"event type=\${event("type").convertTo[String]} scope=\${event("scope").convertTo[String]}")
        consumer.commitSync()
      }
    }
  }
}

object GrantStore {
  def save(subjectId: String, roleId: String, scope: String): Unit = ()
}
`,
      solution: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

case class OutboxRow(id: Long, subject: String, payload: String)

trait GrantStore {
  /** INSERT the grant row and its permission_outbox row in one transaction. */
  def commitAssignment(subject: String, payload: String): Unit
  /** Unsent permission_outbox rows, oldest first. */
  def pending(limit: Int): Seq[OutboxRow]
  /** Stamp the outbox row as published, after the broker ack. */
  def markSent(rowId: Long): Unit
}

object PermissionEvents {
  private val log = Logger.getLogger("permission")
  val topic = "permission.event"
  val outboxTable = "permission_outbox"

  val store: GrantStore = ???

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def assign(assigner: String, subject: String, roleId: String, scope: String): Unit = {
    val grantVersion = jedis.incr("grant_version")
    val payload = Map(
      "type" -> "granted",
      "subject" -> subject,
      "role_id" -> roleId,
      "scope" -> scope,
      "grant_version" -> grantVersion.toString
    ).toJson.compactPrint
    // The grant row and its outbox row commit together: there is no event without a grant.
    store.commitAssignment(subject, payload)
    log.info(s"assign assigner=$assigner subject=$subject role_id=$roleId grant_version=$grantVersion")
  }

  def relay(limit: Int = 100): Unit = {
    store.pending(limit).foreach { row =>
      val subject = row.subject
      try {
        val ack = producer.send(new ProducerRecord[String, String](topic, subject, row.payload))
        ack.get()
        store.markSent(row.id)
      } catch {
        case _: org.apache.kafka.common.KafkaException =>
          () // rejected by the broker: the row stays pending and the next pass retries it
      }
    }
  }

  def rebuildVersion(): Long = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "permission-projector")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(topic))
    var version = 0L
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        version = math.max(version, event("grant_version").convertTo[String].toLong)
        jedis.set("grant_version", version.toString)
        consumer.commitSync()
      }
    }
    version
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kPermissionTopic = "permission.event";

std::unique_ptr<RdKafka::Producer> producer;

// TODO: key the event by the role instead of the subject, produce it only after the grant row is
// stored, add an outbox for a broker rejection and carry a version in the payload so the stream
// can be folded back into the cache. Review all four.
void assign(const std::string& subject, const std::string& roleId, const std::string& scope) {
  const json event = {{"type", "granted"}, {"subject", subject}, {"role", roleId}, {"scope", scope}};
  const auto payload = event.dump();
  producer->produce(
      kPermissionTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      roleId.data(),
      roleId.size(),
      0,
      nullptr);
  producer->flush(2000);
  std::cerr << "assigned subject=" << subject << " role=" << roleId << "\\n";
  saveAssignment(subject, roleId, scope);
}

void saveAssignment(const std::string& subject, const std::string& roleId, const std::string& scope) {
  std::cerr << "saved subject=" << subject << " role=" << roleId << " scope=" << scope << "\\n";
}

// Follows the stream so the projector stays roughly current.
void consumeEvents(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kPermissionTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()),
                                   static_cast<const char*>(msg->payload()) + msg->len());
    std::cerr << "event type=" << event["type"].get<std::string>() << "\\n";
    consumer->commitSync();
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kPermissionTopic = "permission.event";
const std::string kOutboxTable = "permission_outbox";

struct OutboxRow {
  long id;
  std::string subject;
  std::string payload;
};

struct GrantStore {
  // The grant row and its permission_outbox row commit together: no event without a grant.
  void commitAssignment(const std::string& subject, const json& event);
  std::vector<OutboxRow> pending(int limit);
  // MarkSent stamps the row as published, after the broker ack.
  void markSent(long rowId);
};

GrantStore store;

std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");
std::unique_ptr<RdKafka::Producer> producer;

void assign(const std::string& subject, const std::string& roleId, const std::string& scope) {
  const auto grantVersion = redis->incr("grant_version");
  const json event = {
      {"type", "granted"},
      {"subject", subject},
      {"role_id", roleId},
      {"scope", scope},
      {"grant_version", grantVersion},
  };
  store.commitAssignment(subject, event);
}

void relayOutbox() {
  for (const auto& row : store.pending(100)) {
    const std::string subject = row.subject;
    const std::string key = subject;
    const auto err = producer->produce(
        kPermissionTopic,
        RdKafka::Topic::PARTITION_UA,
        RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(row.payload.data()),
        row.payload.size(),
        key.data(),
        key.size(),
        0,
        nullptr);
    producer->flush(2000);
    if (err != RdKafka::ERR_NO_ERROR) continue; // rejected: the row stays pending for the next pass
    store.markSent(row.id);
  }
}

long rebuildVersion() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "permission-projector", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kPermissionTopic});
  long version = 0;
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(
        static_cast<const char*>(msg->payload()),
        static_cast<const char*>(msg->payload()) + msg->len());
    version = std::max(version, event["grant_version"].get<long>());
    redis->set("grant_version", std::to_string(version));
    consumer->commitSync();
  }
  return version;
}
`,
    },
  },
  debrief: `The interviewer is checking whether you can review an event-publishing path whose failure modes are all ordering and durability rather than syntax. The draft is convincing because the demo shows a well-shaped record arriving; nothing in it survives a broker rejection, a rollback or a Redis flush. Four contracts are under review. The key is an ordering contract: partition by subject, and every change to that subject’s authority replays in the order it happened, so a revocation can never be applied before the grant it revokes. The outbox is the atomicity contract: the event row commits with the grant, so the topic and the store can never disagree about whether a grant exists. Publish-after-commit and mark-sent-after-ack are the same contract pointed at the broker — announce only what is durable, and never forget what was not delivered. And \`grant_version\` in the payload is what makes the stream an authority instead of a notification: a projector can rebuild the counter, and therefore the cache, from the log alone. Real platforms add a schema registry with compatibility rules, relay lag metrics, per-partition ordering guarantees and a compacted subject-state topic.`,
};
