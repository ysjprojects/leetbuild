import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Calendar events keyed by calendar for sync order',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'store', 'kafka', 'sync'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the event write lands in the
store, a change record lands in the topic, and the sync consumer moves, so the demo looks right. It
compiles, it serves the demo, and it hides five production flaws. Review it like the service owner,
fix it, and prove the fix with the checks below.

Implement the change stream behind the event write:

- Every accepted change publishes **one** \`calendar.event\` record **keyed by the calendar id**.
  Kafka orders within a partition, not within a topic, so the key decides what can be reordered:
  partition by calendar and the changes of one calendar arrive in revision order. The draft keys by
  the first attendee, so a calendar’s revisions scatter across partitions and a consumer can apply
  revision 7 before revision 4.
- The topic comes from a **named constant** holding \`calendar.event\`; the draft inlines the
  string at the produce call and again at the subscription.
- The payload carries \`{event_id, revision, kind}\` and nothing else: never the event body or its
  title and description, never an attendee address. The topic is retained and replicated, so
  content written there outlives the event, the RSVP, and every delete path the service has.
- The event store **commit happens before the produce**. Publish first and a rollback still leaves
  the change in the stream: every consumer applies a revision the store never accepted.
- The producer is **idempotent with \`acks=all\`** (the stack’s equivalent: \`enable.idempotence\`
  plus required acks \`all\`). When the broker rejects the produce, the same payload is written to
  an \`outbox\` row that a relay republishes. The draft is fire-and-forget, so a rejected produce
  is a silently lost change.
- The \`calendar-sync\` **consumer applies each change to the store and only then commits the
  offset**. Commit first and a crash between the two loses the apply forever, because the offset
  already moved past the record.

**Failure mode the checks target.** An attendee key breaks the ordering the sync consumer depends
on; a payload with the body and the addresses is a leak with the retention of the topic; publishing
before the commit makes the stream claim revisions the store rolled back; and a fire-and-forget
producer with a commit-first consumer loses changes on two different paths. The key is the quiet
one: with four hundred attendees the per-attendee fan-out looks like a feature until the sync
consumer applies a stale revision last.`,
  sequence: {
    participants: ['Calendar API', 'Postgres', 'calendar.event', 'Sync consumer'],
    messages: [
      {from: 'Calendar API', to: 'Postgres', label: 'write event · revision = 5', kind: 'sync'},
      {from: 'Postgres', to: 'Calendar API', label: 'commit ok · revision 5 durable', kind: 'reply'},
      {
        from: 'Calendar API',
        to: 'calendar.event',
        label: 'produce · key = calendar id · {event_id, revision, kind}',
        kind: 'sync',
      },
      {from: 'calendar.event', to: 'Calendar API', label: 'ack acks=all · else outbox row', kind: 'reply'},
      {from: 'calendar.event', to: 'Sync consumer', label: 'consume · group calendar-sync', kind: 'async'},
      {from: 'Sync consumer', to: 'Postgres', label: 'apply change · revision 5 once', kind: 'sync'},
      {from: 'Sync consumer', to: 'calendar.event', label: 'commit offset after the apply', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'calendar-key',
      title: 'Keyed by the calendar id, topic from a constant',
      detail:
        'The produce call uses the calendar id as the message key, so the changes of one calendar share a partition and stay in revision order, and the topic comes from a named `calendar.event` constant. The draft keys by the first attendee and inlines the topic string.',
      match: {
        python: {all: [/key=\w*calendar_id/, /CALENDAR_EVENT_TOPIC\s*=\s*["']calendar\.event["']/]},
        typescript: {all: [/key:\s*calendarId/, /CALENDAR_EVENT_TOPIC\s*=\s*['"]calendar\.event['"]/]},
        go: {all: [/Key:\s*\[\]byte\(calendarID\)/, /calendarEventTopic\s*=\s*"calendar\.event"/]},
        scala: {
          all: [/ProducerRecord\(CalendarEventTopic,\s*calendarId/, /CalendarEventTopic\s*=\s*"calendar\.event"/],
        },
        cpp: {
          all: [
            /kCalendarEventTopic\s*=\s*"calendar\.event"/,
            /produce\(\s*kCalendarEventTopic\s*,[\s\S]{0,300}?calendar_id\.(c_str|data)\(\)\s*,\s*calendar_id\.(size|length)\(\)/,
          ],
        },
      },
    },
    {
      id: 'ids-only-payload',
      title: 'Payload is event id, revision and kind only',
      detail:
        'The record carries `event_id`, `revision` and `kind` and nothing else: no event body, no title or description, no attendee address. The draft serializes the whole event, so retained content outlives the event and every RSVP.',
      match: {
        python: {
          all: [/event_id/, /revision/, /kind/],
          none: [/body/i, /email/i, /attendee/i, /title/i, /description/i],
        },
        typescript: {
          all: [/event_id/, /revision/, /kind/],
          none: [/["']body["']|\bbody\s*:/, /email/i, /attendee/i, /title/i, /description/i],
        },
        go: {
          all: [/event_id/, /revision/, /kind/],
          none: [/"body"/, /[Ee]mail/, /[Aa]ttendee/, /[Tt]itle/, /[Dd]escription/],
        },
        scala: {
          all: [/event_id/, /revision/, /kind/],
          none: [/"body"/, /[Ee]mail/, /[Aa]ttendee/, /[Tt]itle/, /[Dd]escription/],
        },
        cpp: {
          all: [/"event_id"/, /"revision"/, /"kind"/],
          none: [/"body"/, /[Ee]mail/, /[Aa]ttendee/, /[Tt]itle/, /[Dd]escription/],
        },
      },
    },
    {
      id: 'commit-then-publish',
      title: 'Store commit happens before the produce',
      detail:
        'The order is the store commit and only then the produce, so the stream never carries a revision the store rolled back. The draft publishes first and commits after, which turns one failed transaction into a change every consumer already applied.',
      match: {
        python: {order: [/\.commit\(/, /produce\(/]},
        typescript: {order: [/\.commit\(/, /producer\.send\(/]},
        go: {order: [/\.Commit\(/, /WriteMessages\(/]},
        scala: {order: [/\.commit\(/, /producer\.send\(/]},
        cpp: {order: [/\.commit\(/, /produce\(/]},
      },
    },
    {
      id: 'idempotent-outbox',
      title: 'Idempotent producer, acks=all, outbox on failure',
      detail:
        'The producer is configured for idempotence with `acks=all`, and a rejected produce writes the same payload to an `outbox` row a relay republishes. The draft is fire-and-forget: the default acknowledgement level, no retry, and a lost change when the broker rejects the produce.',
      match: {
        python: {
          all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/, /insert_outbox\(/],
        },
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/, /insertOutbox\(/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/, /InsertOutbox\(/]},
        scala: {
          all: [
            /"enable\.idempotence"\s*,\s*"true"|ENABLE_IDEMPOTENCE_CONFIG\s*,\s*"true"/,
            /"acks"\s*,\s*"all"|ACKS_CONFIG\s*,\s*"all"/,
            /insertOutbox\(/,
          ],
        },
        cpp: {all: [/"enable\.idempotence"\s*,\s*"true"/, /set\("acks",\s*"all"/, /insertOutbox\(/]},
      },
    },
    {
      id: 'consumer-order',
      title: 'Sync consumer applies before committing offsets',
      detail:
        'The consumer reads `calendar.event` in a named group and applies each change to the store before committing the offset; committing first makes a crash between the two lose the apply forever. The draft commits the offset first, then applies.',
      match: {
        python: {all: [/group\.id/, /CALENDAR_EVENT_TOPIC/], order: [/store\.apply_change\(/, /consumer\.commit\(/]},
        typescript: {
          all: [/groupId/, /CALENDAR_EVENT_TOPIC/],
          order: [/store\.applyChange\(/, /consumer\.commitOffsets\(/],
        },
        go: {all: [/GroupID/, /calendarEventTopic/], order: [/store\.ApplyChange\(/, /reader\.CommitMessages\(/]},
        scala: {
          all: [/GROUP_ID_CONFIG|group\.id/, /CalendarEventTopic/],
          order: [/conn\.applyChange\(/, /consumer\.commitSync\(/],
        },
        cpp: {all: [/group\.id/, /kCalendarEventTopic/], order: [/store\.applyChange\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("calendard")

producer = Producer({"bootstrap.servers": "kafka:9092"})


class EventWrite(BaseModel):
    calendar_id: str
    event_id: str
    revision: int
    kind: str
    event: dict


class CalendarStore:
    def commit(self, change: EventWrite) -> None:
        """INSERT the event row and its revision, then commit."""
        raise NotImplementedError

    def apply_change(self, change: dict) -> None:
        """Apply a change from the stream to the sync-side calendar."""
        raise NotImplementedError


store = CalendarStore()


@app.post("/v1/events")
def create_event(change: EventWrite, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: key by the calendar id instead of the first attendee, publish only event_id, revision
    # and kind (never the body or the attendee addresses), commit the store before the produce,
    # configure the idempotent producer with acks=all plus an outbox fallback, and make the consumer
    # apply each change before it commits the offset.
    attendees = change.event["attendee_emails"]
    logger.info("change tenant=%s calendar=%s title=%r", tenant, change.calendar_id, change.event["title"])
    payload = {
        "event_id": change.event_id,
        "revision": change.revision,
        "kind": change.kind,
        "title": change.event["title"],
        "body": change.event["body"],
        "attendees": attendees,
    }
    producer.produce("calendar.event", key=attendees[0], value=json.dumps(payload))
    producer.flush()
    store.commit(change)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "sync"})
    consumer.subscribe(["calendar.event"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        store.apply_change(json.loads(msg.value()))
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("calendard")

CALENDAR_EVENT_TOPIC = "calendar.event"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class EventWrite(BaseModel):
    calendar_id: str
    event_id: str
    revision: int
    kind: str
    event: dict


class CalendarStore:
    def commit(self, change: EventWrite) -> None:
        """INSERT the event row and its revision, then commit."""
        raise NotImplementedError

    def apply_change(self, change: dict) -> None:
        """Apply a change from the stream to the sync-side calendar."""
        raise NotImplementedError

    def insert_outbox(self, calendar_id: str, event: dict) -> None:
        """One row per undelivered change; a relay republishes it."""
        raise NotImplementedError


store = CalendarStore()


@app.post("/v1/events")
def create_event(change: EventWrite, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    store.commit(change)
    calendar_id = change.calendar_id
    event = {"event_id": change.event_id, "revision": change.revision, "kind": change.kind}
    try:
        producer.produce(CALENDAR_EVENT_TOPIC, key=calendar_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(calendar_id, event)
    logger.info("change published tenant=%s calendar=%s revision=%d", tenant, calendar_id, change.revision)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "calendar-sync", "enable.auto.commit": False}
    )
    consumer.subscribe([CALENDAR_EVENT_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        change = json.loads(msg.value())
        store.apply_change(change)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/**
 * calendar.event: a model-generated draft that keys by attendee and publishes before the commit,
 * so one calendar's revisions scatter across partitions and a rollback still reaches the stream.
 */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'calendard', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface EventChange {
  calendar_id: string;
  event_id: string;
  revision: number;
  kind: string;
  event: {title: string; body: string; attendee_emails: string[]};
}

app.post('/v1/events', async (request, reply) => {
  // TODO: key by the calendar id instead of the first attendee, publish only event_id, revision
  // and kind (never the body or the attendee addresses), commit the store before the produce,
  // configure the idempotent producer with acks=all plus an outbox fallback, and make the consumer
  // apply each change before it commits the offset.
  const change = request.body as EventChange;
  if (typeof change.calendar_id !== 'string' || change.calendar_id === '')
    return reply.code(422).send({error: 'calendar_id is required'});
  const event = {
    event_id: change.event_id,
    revision: change.revision,
    kind: change.kind,
    title: change.event.title,
    body: change.event.body,
    attendees: change.event.attendee_emails,
  };
  request.log.info({calendar_id: change.calendar_id, title: change.event.title}, 'change published');
  await producer.send({
    topic: 'calendar.event',
    messages: [{key: change.event.attendee_emails[0], value: JSON.stringify(event)}],
  });
  await store.commit(change);
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'sync'});
  await consumer.connect();
  await consumer.subscribe({topic: 'calendar.event'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const change = JSON.parse(message.value?.toString() ?? '{}') as EventChange;
      await store.applyChange(change);
    },
  });
}
`,
      solution: `/**
 * calendar.event: one record per change, keyed by the calendar id. KafkaJS hashes the key to pick
 * a partition, so every change of one calendar lands on the same partition in produce order. The
 * payload carries ids and the revision only; the body and the addresses stay in the store, which
 * owns their delete semantics. The produce runs after the commit, so a rollback cannot leave a
 * change the stream already delivered.
 */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'calendard', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const CALENDAR_EVENT_TOPIC = 'calendar.event';

interface EventChange {
  calendar_id: string;
  event_id: string;
  revision: number;
  kind: string;
}

export async function commitAndPublish(change: EventChange): Promise<void> {
  await store.commit(change);
  const calendarId = change.calendar_id;
  const event = {event_id: change.event_id, revision: change.revision, kind: change.kind};
  try {
    await producer.send({
      topic: CALENDAR_EVENT_TOPIC,
      acks: -1,
      messages: [{key: calendarId, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(calendarId, event);
  }
}

app.post('/v1/events', async (request, reply) => {
  const change = request.body as EventChange;
  if (typeof change.calendar_id !== 'string' || change.calendar_id === '')
    return reply.code(422).send({error: 'calendar_id is required'});
  await commitAndPublish(change);
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'calendar-sync'});
  await consumer.connect();
  await consumer.subscribe({topic: CALENDAR_EVENT_TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const change = JSON.parse(message.value?.toString() ?? '{}') as EventChange;
      await store.applyChange(change);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/segmentio/kafka-go"
)

var changeWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "calendar.event"}

type EventChange struct {
	CalendarID string   \`json:"calendar_id"\`
	EventID    string   \`json:"event_id"\`
	Revision   int64    \`json:"revision"\`
	Kind       string   \`json:"kind"\`
	Title      string   \`json:"title"\`
	Body       string   \`json:"body"\`
	Attendees  []string \`json:"attendee_emails"\`
}

type CalendarStore struct{}

func (s *CalendarStore) Commit(ctx context.Context, change EventChange) error {
	return nil
}

func (s *CalendarStore) ApplyChange(ctx context.Context, change EventChange) error {
	return nil
}

var store = &CalendarStore{}

func createEvent(rw http.ResponseWriter, r *http.Request) {
	change := EventChange{}
	_ = json.NewDecoder(r.Body).Decode(&change)
	// TODO: key by the calendar id instead of the first attendee, publish only event_id, revision
	// and kind (never the body or the attendee addresses), commit the store before the produce,
	// configure acks=all with a hash balancer plus an outbox fallback, and make the consumer apply
	// each change before it commits the offset.
	payload, _ := json.Marshal(change)
	_ = changeWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(change.Attendees[0]), Value: payload})
	_ = store.Commit(r.Context(), change)
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "calendar.event",
		GroupID: "sync",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		change := EventChange{}
		_ = json.Unmarshal(msg.Value, &change)
		_ = store.ApplyChange(ctx, change)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
const (
	calendarEventTopic = "calendar.event"
	syncGroupID        = "calendar-sync"
)

var changeWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        calendarEventTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type EventChange struct {
	CalendarID string \`json:"calendar_id"\`
	EventID    string \`json:"event_id"\`
	Revision   int64  \`json:"revision"\`
	Kind       string \`json:"kind"\`
}

type CalendarStore struct{}

func (s *CalendarStore) Commit(ctx context.Context, change EventChange) error {
	return nil
}

func (s *CalendarStore) ApplyChange(ctx context.Context, change EventChange) error {
	return nil
}

func (s *CalendarStore) InsertOutbox(ctx context.Context, event EventChange) error {
	return nil
}

var store = &CalendarStore{}

func createEvent(rw http.ResponseWriter, r *http.Request) {
	change := EventChange{}
	_ = json.NewDecoder(r.Body).Decode(&change)
	if err := store.Commit(r.Context(), change); err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"event_id": change.EventID,
		"revision": change.Revision,
		"kind":     change.Kind,
	})
	calendarID := change.CalendarID
	err := changeWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(calendarID), Value: payload})
	if err != nil {
		_ = store.InsertOutbox(r.Context(), change)
	}
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   calendarEventTopic,
		GroupID: syncGroupID,
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		change := EventChange{}
		_ = json.Unmarshal(msg.Value, &change)
		if err := store.ApplyChange(ctx, change); err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class EventChange(
    calendar_id: String,
    event_id: String,
    revision: Long,
    kind: String,
    title: String,
    body: String,
    attendee_emails: List[String]
)

trait CalendarStore {
  def commit(change: EventChange): Unit
  def applyChange(event: JsObject): Unit
}

object CalendarEventApi {
  implicit val system: ActorSystem = ActorSystem("calendard")
  implicit val changeFormat: RootJsonFormat[EventChange] = jsonFormat7(EventChange)

  val conn: CalendarStore = CalendarStore.open()
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props
  })

  val route: Route =
    path("v1" / "events") {
      post {
        entity(as[EventChange]) { change =>
          // TODO: key by the calendar id instead of the first attendee, publish only event_id,
          // revision and kind (never the body or the attendee addresses), commit the store before
          // the produce, configure enable.idempotence with acks=all plus an outbox fallback, and
          // make the consumer apply each change before it commits the offset.
          val payload = s"""{"event_id":"\${change.event_id}","revision":\${change.revision},"kind":"\${change.kind}","title":"\${change.title}","body":"\${change.body}"}"""
          producer.send(new ProducerRecord("calendar.event", change.attendee_emails.head, payload))
          conn.commit(change)
          complete(StatusCodes.Accepted, """{"accepted":true}""")
        }
      }
    }

  def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "sync")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("calendar.event"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        conn.applyChange(record.value().parseJson.asJsObject)
      }
    }
  }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(route)
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class EventChange(calendar_id: String, event_id: String, revision: Long, kind: String)

trait CalendarStore {
  def commit(change: EventChange): Unit
  def applyChange(event: JsObject): Unit
  def insertOutbox(calendarId: String, payload: String): Unit
}

object CalendarEventApi {
  implicit val system: ActorSystem = ActorSystem("calendard")
  implicit val changeFormat: RootJsonFormat[EventChange] = jsonFormat4(EventChange)

  val CalendarEventTopic = "calendar.event"
  val SyncGroupId = "calendar-sync"

  val conn: CalendarStore = CalendarStore.open()
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  def commitAndPublish(change: EventChange): Unit = {
    conn.commit(change)
    val calendarId = change.calendar_id
    val payload =
      s"""{"event_id":"\${change.event_id}","revision":\${change.revision},"kind":"\${change.kind}"}"""
    try {
      producer.send(new ProducerRecord(CalendarEventTopic, calendarId, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        conn.insertOutbox(calendarId, payload)
    }
  }

  val route: Route =
    path("v1" / "events") {
      post {
        entity(as[EventChange]) { change =>
          commitAndPublish(change)
          complete(StatusCodes.Accepted, """{"accepted":true}""")
        }
      }
    }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, SyncGroupId)
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(CalendarEventTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        conn.applyChange(record.value().parseJson.asJsObject)
        consumer.commitSync()
      }
    }
  }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(route)
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

struct CalendarStore {
  void commit(const std::string& calendarId, const std::string& eventId, long revision);
  void applyChange(const json& change);
};

CalendarStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: key by the calendar id instead of the first attendee, publish only event_id, revision and
// kind (never the body or the attendee addresses), commit the store before the produce, configure
// enable.idempotence with acks=all plus an outbox fallback, and make the consumer apply each change
// before it commits the offset.
void commitAndPublish(const std::string& calendar_id, const json& event) {
  const json record = {{"event_id", event["event_id"]},
                       {"revision", event["revision"]},
                       {"kind", event["kind"]},
                       {"title", event["title"]},
                       {"body", event["body"]},
                       {"attendees", event["attendee_emails"]}};
  const auto payload = record.dump();
  const std::string attendee = event["attendee_emails"][0].get<std::string>();
  producer->produce("calendar.event", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), attendee.data(), attendee.size(), 0, nullptr);
  producer->flush(2000);
  store.commit(calendar_id, event["event_id"].get<std::string>(), event["revision"].get<long>());
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"calendar.event"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync();
    const json change = json::parse(static_cast<const char*>(msg->payload()),
                                    static_cast<const char*>(msg->payload()) + msg->len());
    store.applyChange(change);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kCalendarEventTopic = "calendar.event";

struct CalendarStore {
  void commit(const std::string& calendarId, const std::string& eventId, long revision);
  void applyChange(const json& change);
  void insertOutbox(const std::string& calendarId, const json& event);
};

CalendarStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

void commitAndPublish(const std::string& calendar_id, const std::string& event_id, long revision,
                      const std::string& kind) {
  store.commit(calendar_id, event_id, revision);
  const json event = {{"event_id", event_id}, {"revision", revision}, {"kind", kind}};
  const auto payload = event.dump();
  const auto err = producer->produce(kCalendarEventTopic, RdKafka::Topic::PARTITION_UA,
                                     RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                                     payload.size(), calendar_id.data(), calendar_id.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(calendar_id, event);
  }
  producer->flush(2000);
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kCalendarEventTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json change = json::parse(static_cast<const char*>(msg->payload()),
                                    static_cast<const char*>(msg->payload()) + msg->len());
    store.applyChange(change);
    consumer->commitSync();
  }
}
`,
    },
  },
  hints: [
    'The message key is the partition key: `key=calendar_id` (or `Key: []byte(calendarID)`, `key: calendarId`, `ProducerRecord(CalendarEventTopic, calendarId, …)`, the key bytes in `producer->produce`). Keyed by an attendee, one calendar’s changes land in different partitions and revision order is no longer guaranteed.',
    'Ids only, never content: build the record from `{event_id, revision, kind}`. The topic is retained and replicated, so an event body or an attendee address written there outlives the event, the RSVP and every delete path the service has.',
    'Commit, then publish: `store.commit(change)` before `producer.produce(...)`; make the producer idempotent with `acks=all` and write an `outbox` row when the broker rejects the produce; in the consumer, `applyChange` before `commitSync` so a crash replays the record instead of losing the apply.',
  ],
  debrief: `The interviewer is checking the four contracts a generated Kafka snippet gets wrong, plus the topic constant that keeps producer and consumer in sync. First, the message key is an ordering contract: partition by calendar and one calendar’s changes arrive in revision order; key by attendee and a four-hundred-person event fans its revisions across partitions, so the sync consumer applies a stale revision last. Second, the payload is a retention contract: the topic keeps and replicates whatever you write into it, so the record carries ids, the revision and the change kind — never the body or the addresses, which have their own delete semantics in the store. Third, publish-after-commit is what makes the stream honest: produce first and a rollback leaves a change consumers apply even though the store never accepted it, which is why real systems write an outbox row inside the transaction and let a relay publish it. Fourth, exactly-once *looking* code is not exactly-once: idempotence plus acks=all on the producer, one key per partition, and apply-before-commit on the consumer, or a crash in either place loses work silently. Real platforms add schema-registry validation, per-calendar partition budgets, and dead-letter topics for changes that can never be applied.`,
};
