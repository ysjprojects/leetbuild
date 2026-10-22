import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Ticket events keyed by ticket for timeline order',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'worker', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the recorder answers **202**, a
record lands on \`ticket.event\` and the demo shows the timeline filling up. Four production contracts
are broken. It keys the record by the **agent id** instead of the **ticket id**, so one ticket's
events scatter across partitions and the order they arrive in is gone; it copies the **note body**
and the **requester's email** into the payload "so the timeline widget fetches nothing"; it lets the
produce be acknowledged **before the ticket store commits**, so the topic can announce a change the
database never stored; and the producer is a bare one with no idempotence.

\`POST /v1/tickets/{ticket_id}/events\` records a state, assignment or note change on a ticket and
announces it on \`ticket.event\`, which the event worker folds into the timeline the ticket page
reads. Implement the publisher:

- every state, assignment and note event is produced to **\`ticket.event\`** with the **ticket id**
  as the message key, so one ticket's timeline stays in order inside one partition.
- the payload carries the event **type**, the **actor id** and the **actor role**, and the state
  transition as **\`from\` / \`to\`**, plus ids such as \`note_id\` — fields a consumer can build a
  timeline from.
- **no \`note_body\` and no \`requester_email\`**, and no other requester identity beyond ids, may
  reach the topic: it is retained and replicated for days, so a note written there outlives every
  delete the ticket store performs.
- the ticket store **commits before** the produce: a rolled-back write must not be announced, and a
  failed commit must not produce anything.
- the producer is **idempotent with \`acks=all\`**, so a retried produce cannot duplicate a timeline
  entry.
- a committed change answers **202**.

**Failure mode the checks target.** An agent key scatters one ticket's timeline across partitions, so
a consumer can order two tickets but never one; the note body and the requester's address on the
topic are a data leak with the topic's retention; publishing before the commit announces state a
crash can roll back; and a default producer duplicates entries when a produce is retried.`,
  sequence: {
    participants: ['Ticket API', 'Ticket store', 'ticket.event', 'Event worker'],
    messages: [
      {from: 'Ticket API', to: 'Ticket store', label: 'commitTicket(ticket_id, mutation) · commit', kind: 'sync'},
      {from: 'Ticket store', to: 'Ticket API', label: 'committed · prior state', kind: 'reply'},
      {from: 'Ticket API', to: 'ticket.event', label: 'produce · key = ticket id · acks = all', kind: 'sync'},
      {from: 'ticket.event', to: 'Ticket API', label: 'ack', kind: 'reply'},
      {
        from: 'ticket.event',
        to: 'Event worker',
        label: 'consume · group timeline · {type, actor, from, to}',
        kind: 'async',
      },
      {
        from: 'Event worker',
        to: 'Ticket store',
        label: 'appendTimeline(ticket_id, entry) · ids, never the note body',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The message key is the partition key: `key=ticket_id` (`key: ticketId`, `Key: []byte(ticketID)`, `ProducerRecord(topic, ticketId, …)`). Keyed by the agent, one ticket’s events land in different partitions, and the timeline a consumer rebuilds is no longer the order things happened in.',
    'Order the write and the produce: `store.commit_ticket(...)` (or `commitTicket`, `CommitTicket`) returns before the produce, so a rolled-back write is never announced. The payload is a contract, not a copy of the request: project it onto ids, the actor role and the `from`/`to` transition — the topic is retained and replicated, so a note body written there outlives every delete the ticket store performs.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence` with `acks=all` (KafkaJS `idempotent: true` plus `acks: -1`, kafka-go `RequiredAcks: kafka.RequireAll` with a `&kafka.Hash{}` balancer). It needs the same message key on every retry, which is the ticket key again.',
  ],
  checks: [
    {
      id: 'ticket-key',
      title: 'Produced to ticket.event keyed by the ticket id',
      detail:
        'The record goes to `ticket.event` with the **ticket id** as its key, so one ticket’s timeline stays ordered in one partition. The draft keys by the agent id, so one ticket’s events scatter across partitions and their order is gone.',
      match: {
        python: {all: [/ticket\.event/, /produce\([^)]*key\s*=\s*ticket_id/]},
        typescript: {all: [/ticket\.event/, /key:\s*ticketId\b/]},
        go: {all: [/ticket\.event/, /Key:\s*\[\]byte\(ticketID\)/]},
        scala: {all: [/ticket\.event/, /ProducerRecord\([^)]*ticketId/]},
        cpp: {all: [/ticket\.event/, /(ticket\.id|ticketId)\.data\(\)/]},
      },
    },
    {
      id: 'no-body',
      title: 'The payload carries no note body and no requester identity',
      detail:
        'The payload is ids, the actor role and the transition only: no `note_body` and no `requester_email` reaches a topic that is retained and replicated for days. The draft ships the note text and the requester’s address “so the timeline widget fetches nothing”.',
      match: {
        python: {none: [/[Nn]ote_?[Bb]ody/, /[Rr]equester_?[Ee]mail/, /["']body["']/]},
        typescript: {none: [/[Nn]ote_?[Bb]ody/, /[Rr]equester_?[Ee]mail/, /["']body["']/]},
        go: {none: [/[Nn]ote_?[Bb]ody/, /[Rr]equester_?[Ee]mail/, /["']body["']/]},
        scala: {none: [/[Nn]ote_?[Bb]ody/, /[Rr]equester_?[Ee]mail/, /["']body["']/]},
        cpp: {none: [/[Nn]ote_?[Bb]ody/, /[Rr]equester_?[Ee]mail/, /["']body["']/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'The ticket store commits before the produce',
      detail:
        'The committed ticket change comes first (`store.commit_ticket` / `commitTicket` / `CommitTicket`), and only then the record is produced. The draft produces, flushes and *then* commits, so a rolled-back write has already been announced to every consumer.',
      match: {
        python: {order: [/store\.commit_ticket\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.commitTicket\(/, /producer\.send\(/]},
        go: {order: [/store\.CommitTicket\(/, /ticketWriter\.WriteMessages\(/]},
        scala: {order: [/store\.commitTicket\(/, /producer\.send\(/]},
        cpp: {order: [/store\.commitTicket\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'durable-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` plus `acks`, KafkaJS `idempotent: true` with `acks: -1`, kafka-go `RequiredAcks: kafka.RequireAll` with a hashed balancer), so a retry of a produce cannot duplicate a timeline entry. The draft runs a default producer and takes whatever the broker does.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/props\.put\("enable\.idempotence",\s*"true"\)/, /props\.put\("acks",\s*"all"\)/]},
        cpp: {all: [/set\("enable\.idempotence",\s*"true"/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'actor-role',
      title: 'The payload carries the actor role and the transition',
      detail:
        'The event body names the **actor id**, the **actor role**, and the state transition as `from` / `to`, so a consumer can render the timeline without asking the ticket store. The draft sends ids only and never says who acted in what role.',
      match: {
        python: {all: [/\bactor_role\b/, /["']from["']/, /["']to["']/]},
        typescript: {all: [/\bactor_role\b/, /\bfrom\b\s*:/, /\bto\b\s*:/]},
        go: {all: [/actor_role/, /"from"/, /"to"/]},
        scala: {all: [/actor_role/, /"from"/, /"to"/]},
        cpp: {all: [/actor_role/, /"from"/, /"to"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

producer = Producer({"bootstrap.servers": "kafka:9092"})


class TicketStore:
    """The ticket store: commit_ticket writes the ticket row and commits the transaction."""

    def commit_ticket(self, ticket_id: str, mutation: dict) -> str:
        raise NotImplementedError

    def append_timeline(self, ticket_id: str, event: dict) -> None:
        raise NotImplementedError


store = TicketStore()


class TicketEvent(BaseModel):
    type: str
    note_body: str | None = None
    requester_email: str | None = None


@app.post("/v1/tickets/{ticket_id}/events", status_code=202)
def record_event(
    ticket_id: str,
    event: TicketEvent,
    actor_id: str = Header(alias="X-Actor-Id"),
) -> dict:
    # TODO: key the record by the ticket id instead of the agent, keep the note body and the
    # requester's address off the topic, configure the producer with enable.idempotence and
    # acks=all, and commit the ticket write before the produce is acknowledged.
    payload = {
        "id": f"{ticket_id}:{event.type}",
        "ticket_id": ticket_id,
        "type": event.type,
        "actor_id": actor_id,
        "note_body": event.note_body,
        "requester_email": event.requester_email,
    }
    producer.produce("ticket.event", key=actor_id, value=json.dumps(payload))
    producer.flush(2.0)
    store.commit_ticket(ticket_id, payload)
    return {"accepted": True}


def consume() -> None:
    """The event worker folds ticket events into the timeline the ticket page reads."""
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "timeline", "enable.auto.commit": False}
    )
    consumer.subscribe(["ticket.event"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        store.append_timeline(event["ticket_id"], event)
        consumer.commit(msg)
`,
      solution: `import json

from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

TICKET_EVENT_TOPIC = "ticket.event"
# The topic is retained and replicated: the payload contract is ids and the transition, nothing a
# customer typed.
ALLOWED_EVENT_FIELDS = ("id", "ticket_id", "type", "actor_id", "actor_role", "from", "to", "note_id")

# Idempotence plus acks=all: a retried produce of the same record is a no-op, and the broker
# acknowledges only once every in-sync replica holds it.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class TicketStore:
    """The ticket store: commit_ticket writes the ticket row and commits the transaction."""

    def commit_ticket(self, ticket_id: str, mutation: dict) -> str:
        """Returns the state the ticket was in before the transition."""
        raise NotImplementedError

    def append_timeline(self, ticket_id: str, event: dict) -> None:
        raise NotImplementedError


store = TicketStore()


class TicketEvent(BaseModel):
    type: str
    state_to: str | None = None
    note_id: str | None = None


def event_payload(
    ticket_id: str, event: TicketEvent, actor_id: str, actor_role: str, previous: str
) -> dict:
    """Only the allow-listed fields leave the process, whatever the request model grows later."""
    fields = {
        "id": f"{ticket_id}:{event.type}",
        "ticket_id": ticket_id,
        "type": event.type,
        "actor_id": actor_id,
        "actor_role": actor_role,
        "from": previous,
        "to": event.state_to,
        "note_id": event.note_id,
    }
    return {field: fields[field] for field in ALLOWED_EVENT_FIELDS if fields[field] is not None}


@app.post("/v1/tickets/{ticket_id}/events", status_code=202)
def record_event(
    ticket_id: str,
    event: TicketEvent,
    actor_id: str = Header(alias="X-Actor-Id"),
    actor_role: str = Header(alias="X-Actor-Role"),
) -> dict:
    # The ticket write is committed first: only a state the store holds may be announced.
    previous = store.commit_ticket(ticket_id, event.model_dump())
    payload = event_payload(ticket_id, event, actor_id, actor_role, previous)
    producer.produce(TICKET_EVENT_TOPIC, key=ticket_id, value=json.dumps(payload))
    producer.flush(2.0)
    return {"accepted": True}


def consume() -> None:
    """The event worker folds ticket events into the timeline the ticket page reads."""
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "timeline", "enable.auto.commit": False}
    )
    consumer.subscribe([TICKET_EVENT_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        store.append_timeline(event["ticket_id"], event)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** ticket.event: a model-generated draft that keys by the agent and acks before the commit. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'tickets', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface TicketEvent {
  type: string;
  noteBody?: string;
  requesterEmail?: string;
}

app.post('/v1/tickets/:id/events', async (request, reply) => {
  // TODO: key the record by the ticket id instead of the agent, keep the note body and the
  // requester's address out of the payload, set \`idempotent: true\` and \`acks: -1\` on the
  // producer, and commit the ticket write before the produce is acknowledged.
  const ticketId = (request.params as {id: string}).id;
  const actorId = request.headers['x-actor-id'] as string;
  const event = request.body as TicketEvent;
  const payload = {
    id: ticketId + ':' + event.type,
    ticket_id: ticketId,
    type: event.type,
    actor_id: actorId,
    noteBody: event.noteBody,
    requesterEmail: event.requesterEmail,
  };
  await producer.send({
    topic: 'ticket.event',
    messages: [{key: actorId, value: JSON.stringify(payload)}],
  });
  await store.commitTicket(ticketId, event);
  return reply.code(202).send({accepted: true});
});
`,
      solution: `/** ticket.event: one event per committed ticket change, keyed by the ticket id. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'tickets', brokers: ['kafka:9092']});
// Idempotence plus acks=-1: a retried produce of the same record is a no-op, and the broker
// acknowledges only once every in-sync replica holds it.
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const TICKET_EVENT_TOPIC = 'ticket.event';
// The topic is retained and replicated: the payload contract is ids and the transition, nothing the
// customer typed.
const ALLOWED_EVENT_FIELDS = [
  'id',
  'ticket_id',
  'type',
  'actor_id',
  'actor_role',
  'from',
  'to',
  'note_id',
] as const;

interface TicketEvent {
  type: string;
  state_to?: string;
  note_id?: string;
}

function eventPayload(
  ticketId: string,
  event: TicketEvent,
  actorId: string,
  actorRole: string,
  previous: string,
): Record<string, string> {
  const fields: Record<string, string | undefined> = {
    id: ticketId + ':' + event.type,
    ticket_id: ticketId,
    type: event.type,
    actor_id: actorId,
    actor_role: actorRole,
    from: previous,
    to: event.state_to,
    note_id: event.note_id,
  };
  const payload: Record<string, string> = {};
  for (const field of ALLOWED_EVENT_FIELDS) {
    const value = fields[field];
    if (value !== undefined) payload[field] = value;
  }
  return payload;
}

app.post('/v1/tickets/:id/events', async (request, reply) => {
  const ticketId = (request.params as {id: string}).id;
  const actorId = request.headers['x-actor-id'] as string;
  const actorRole = request.headers['x-actor-role'] as string;
  const event = request.body as TicketEvent;
  // The ticket write is committed first: only a state the store holds may be announced.
  const previous = await store.commitTicket(ticketId, event);
  await producer.send({
    topic: TICKET_EVENT_TOPIC,
    acks: -1,
    messages: [
      {key: ticketId, value: JSON.stringify(eventPayload(ticketId, event, actorId, actorRole, previous))},
    ],
  });
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'timeline'});
  await consumer.connect();
  await consumer.subscribe({topic: TICKET_EVENT_TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as Record<string, string>;
      await store.appendTimeline(event['ticket_id'], event);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
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

// ticket.event: a model-generated draft that keys by the agent and acks before the commit.
var ticketWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "ticket.event"}

// TicketStore is the ticket table; CommitTicket writes the row and commits the transaction.
type TicketStore struct{}

func (s *TicketStore) CommitTicket(ctx context.Context, ticketID string, mutation map[string]any) (string, error) {
	return "", nil
}

func (s *TicketStore) AppendTimeline(ctx context.Context, ticketID string, event map[string]any) error {
	return nil
}

var store = &TicketStore{}

type ticketEvent struct {
	Type           string \`json:"type"\`
	NoteBody       string \`json:"note_body"\`
	RequesterEmail string \`json:"requester_email"\`
}

func recordEvent(rw http.ResponseWriter, r *http.Request) {
	// TODO: key the record by ticket_id instead of the agent, keep the note body and the requester's
	// address out of the payload, configure RequiredAcks: kafka.RequireAll with a &kafka.Hash{}
	// balancer, and commit the ticket write before the writer acknowledges the record.
	ticketID := r.PathValue("ticket_id")
	actorID := r.Header.Get("X-Actor-Id")
	event := ticketEvent{}
	_ = json.NewDecoder(r.Body).Decode(&event)
	payload, _ := json.Marshal(map[string]any{
		"id":              ticketID + ":" + event.Type,
		"ticket_id":       ticketID,
		"type":            event.Type,
		"actor_id":        actorID,
		"note_body":       event.NoteBody,
		"requester_email": event.RequesterEmail,
	})
	_ = ticketWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(actorID), Value: payload})
	_, _ = store.CommitTicket(r.Context(), ticketID, map[string]any{"type": event.Type})
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "ticket.event",
		GroupID: "timeline",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event map[string]any
		_ = json.Unmarshal(msg.Value, &event)
		ticketID, _ := event["ticket_id"].(string)
		_ = store.AppendTimeline(ctx, ticketID, event)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"

	"github.com/segmentio/kafka-go"
)

// ticket.event: one event per committed ticket change, keyed by the ticket id.
const ticketEventTopic = "ticket.event"

// allowedEventFields is the complete payload contract: ids, the actor's role and the transition.
var allowedEventFields = []string{"id", "ticket_id", "type", "actor_id", "actor_role", "from", "to", "note_id"}

// RequiredAcks=RequireAll with a hashed balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and a retried record with
// the same key lands on the same partition instead of duplicating across them.
var ticketWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        ticketEventTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

// TicketStore is the ticket table; CommitTicket writes the row and commits the transaction.
type TicketStore struct{}

// CommitTicket returns the state the ticket was in before the transition.
func (s *TicketStore) CommitTicket(ctx context.Context, ticketID string, mutation map[string]any) (string, error) {
	return "", nil
}

func (s *TicketStore) AppendTimeline(ctx context.Context, ticketID string, event map[string]any) error {
	return nil
}

var store = &TicketStore{}

type ticketEvent struct {
	Type    string \`json:"type"\`
	StateTo string \`json:"state_to"\`
	NoteID  string \`json:"note_id"\`
}

// eventPayload projects the event onto the allow-list, so a field added to the request model one
// day cannot leak onto a topic that is retained and replicated for days.
func eventPayload(ticketID string, event ticketEvent, actorID string, actorRole string, previous string) ([]byte, error) {
	fields := map[string]any{
		"id":         ticketID + ":" + event.Type,
		"ticket_id":  ticketID,
		"type":       event.Type,
		"actor_id":   actorID,
		"actor_role": actorRole,
		"from":       previous,
		"to":         event.StateTo,
		"note_id":    event.NoteID,
	}
	payload := map[string]any{}
	for field, value := range fields {
		if value == "" {
			continue
		}
		if !slices.Contains(allowedEventFields, field) {
			return nil, fmt.Errorf("field %q is not allowed on %s", field, ticketEventTopic)
		}
		payload[field] = value
	}
	return json.Marshal(payload)
}

func recordEvent(rw http.ResponseWriter, r *http.Request) {
	ticketID := r.PathValue("ticket_id")
	actorID := r.Header.Get("X-Actor-Id")
	actorRole := r.Header.Get("X-Actor-Role")
	event := ticketEvent{}
	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	// The ticket write is committed first: only a state the store holds may be announced.
	previous, err := store.CommitTicket(r.Context(), ticketID, map[string]any{"type": event.Type})
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	payload, err := eventPayload(ticketID, event, actorID, actorRole, previous)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := ticketWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(ticketID), Value: payload}); err != nil {
		http.Error(rw, err.Error(), http.StatusBadGateway)
		return
	}
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   ticketEventTopic,
		GroupID: "timeline",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event map[string]any
		_ = json.Unmarshal(msg.Value, &event)
		ticketID, _ := event["ticket_id"].(string)
		_ = store.AppendTimeline(ctx, ticketID, event)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

// ticket.event: a model-generated draft that keys by the agent and acks before the commit.
object Events {
  private val producer = new KafkaProducer[String, String](new Properties())

  // TicketStore is the ticket table; commitTicket writes the row and commits the transaction.
  object store {
    def commitTicket(ticketId: String, event: JsObject): String = ""
  }

  val route: Route =
    path("v1" / "tickets" / Segment / "events") { ticketId =>
      post {
        headerValueByName("X-Actor-Id") { actorId =>
          entity(as[String]) { bodyText =>
            // TODO: key the record by ticketId instead of the agent, keep the note body and the
            // requester's address out of the payload, configure the producer with
            // enable.idempotence and acks=all, and commit the ticket write before the send is
            // acknowledged.
            val event = bodyText.parseJson.asJsObject
            val payload = JsObject(
              "id" -> JsString(ticketId + ":" + event("type").convertTo[String]),
              "ticket_id" -> JsString(ticketId),
              "type" -> event("type"),
              "actor_id" -> JsString(actorId),
              "noteBody" -> event.fields.getOrElse("noteBody", JsString("")),
              "requesterEmail" -> event.fields.getOrElse("requesterEmail", JsString("")),
            ).compactPrint
            producer.send(new ProducerRecord("ticket.event", actorId, payload))
            store.commitTicket(ticketId, event)
            complete(StatusCodes.Accepted)
          }
        }
      }
    }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

// ticket.event: one event per committed ticket change, keyed by the ticket id.
object Events {
  private val TicketEventTopic = "ticket.event"

  // The topic is retained and replicated: the payload contract is ids and the transition, nothing a
  // customer typed.
  private val AllowedEventFields =
    List("id", "ticket_id", "type", "actor_id", "actor_role", "from", "to", "note_id")

  // Idempotence plus acks=all: a retried produce of the same record is a no-op, and the broker
  // acknowledges only once every in-sync replica holds it.
  private val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  // TicketStore is the ticket table; commitTicket writes the row and commits the transaction.
  object store {
    def commitTicket(ticketId: String, event: JsObject): String = ""
    def appendTimeline(ticketId: String, event: Map[String, JsValue]): Unit = ()
  }

  // Only the allow-listed fields leave the process, whatever the request body grows later.
  private def eventPayload(
      ticketId: String,
      event: JsObject,
      actorId: String,
      actorRole: String,
      previous: String,
  ): String = {
    val fields = JsObject(
      "id" -> JsString(ticketId + ":" + event("type").convertTo[String]),
      "ticket_id" -> JsString(ticketId),
      "type" -> event("type"),
      "actor_id" -> JsString(actorId),
      "actor_role" -> JsString(actorRole),
      "from" -> JsString(previous),
      "to" -> event.fields.getOrElse("state_to", JsString("")),
    )
    val leaked = fields.fields.keySet -- AllowedEventFields
    require(leaked.isEmpty, s"fields not allowed on $TicketEventTopic: $leaked")
    fields.compactPrint
  }

  val route: Route =
    path("v1" / "tickets" / Segment / "events") { ticketId =>
      post {
        headerValueByName("X-Actor-Id") { actorId =>
          headerValueByName("X-Actor-Role") { actorRole =>
            entity(as[String]) { bodyText =>
              val event = bodyText.parseJson.asJsObject
              // The ticket write is committed first: only a state the store holds may be announced.
              val previous = store.commitTicket(ticketId, event)
              producer.send(new ProducerRecord(TicketEventTopic, ticketId, eventPayload(ticketId, event, actorId, actorRole, previous)))
              complete(StatusCodes.Accepted)
            }
          }
        }
      }
    }

  private def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "timeline")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(TicketEventTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject
        store.appendTimeline(event.fields("ticket_id").convertTo[String], event.fields)
        consumer.commitSync()
      }
    }
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

// ticket.event: a model-generated draft that keys by the agent and acks before the commit.
struct Ticket {
  std::string id;
};

struct TicketStore {
  // commitTicket writes the ticket row and commits the transaction.
  std::string commitTicket(const std::string& ticketId, const json& event);
};

TicketStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: key the record by ticket.id instead of the agent, keep the note body and the requester's
// address out of the payload, set enable.idempotence and acks=all on the producer, and commit the
// ticket write before the produce is acknowledged.
void recordEvent(const Ticket& ticket, const json& event, const std::string& actorId) {
  const json fields = {
      {"id", ticket.id + ":" + event["type"].get<std::string>()},
      {"ticket_id", ticket.id},
      {"type", event["type"]},
      {"actor_id", actorId},
      {"note_body", event.value("note_body", "")},
      {"requester_email", event.value("requester_email", "")},
  };
  const auto payload = fields.dump();
  producer->produce(
      "ticket.event",
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      actorId.data(),
      actorId.size(),
      0,
      nullptr);
  producer->flush(2000);
  store.commitTicket(ticket.id, event);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

// ticket.event: one event per committed ticket change, keyed by the ticket id.
const std::string kTicketEventTopic = "ticket.event";

// The topic is retained and replicated: the payload contract is ids and the transition, nothing the
// customer typed.
const std::vector<std::string> kAllowedEventFields = {
    "id", "ticket_id", "type", "actor_id", "actor_role", "from", "to", "note_id"};

struct Ticket {
  std::string id;
};

struct TicketStore {
  // commitTicket writes the ticket row and commits the transaction; it returns the prior state.
  std::string commitTicket(const std::string& ticketId, const json& event);
  void appendTimeline(const std::string& ticketId, const json& event);
};

TicketStore store;

// Idempotence plus acks=all: a retried produce of the same record is a no-op, and the broker
// acknowledges only once every in-sync replica holds it.
std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// Projects the event onto the allow-list, so a field added to the event one day cannot leak onto a
// topic that is retained and replicated for days.
std::string eventPayload(
    const std::string& ticketId,
    const json& event,
    const std::string& actorId,
    const std::string& actorRole,
    const std::string& previous) {
  const json fields = {
      {"id", ticketId + ":" + event["type"].get<std::string>()},
      {"ticket_id", ticketId},
      {"type", event["type"]},
      {"actor_id", actorId},
      {"actor_role", actorRole},
      {"from", previous},
      {"to", event.value("state_to", "")},
  };
  for (const auto& [field, value] : fields.items()) {
    if (std::find(kAllowedEventFields.begin(), kAllowedEventFields.end(), field) == kAllowedEventFields.end()) {
      throw std::invalid_argument("field not allowed on " + kTicketEventTopic + ": " + field);
    }
  }
  return fields.dump();
}

// POST /v1/tickets/{id}/events: commit the ticket change, then announce it.
void recordEvent(const Ticket& ticket, const json& event, const std::string& actorId, const std::string& actorRole) {
  // The ticket write is committed first: only a state the store holds may be announced.
  const std::string previous = store.commitTicket(ticket.id, event);
  const auto payload = eventPayload(ticket.id, event, actorId, actorRole, previous);
  const auto err = producer->produce(
      kTicketEventTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      ticket.id.data(),
      ticket.id.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    throw std::runtime_error(RdKafka::err2str(err));
  }
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "timeline", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTicketEventTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(
        static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    store.appendTimeline(event["ticket_id"].get<std::string>(), event);
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking whether the event stream is a contract or a copy of the request. The key is the first contract: a Kafka key chooses the partition, so keying by the ticket id keeps one ticket's open → pending → resolved sequence in one partition and in order, while keying by the agent puts two tickets' events in the same partition and one ticket's events in several — the timeline a consumer rebuilds is then not the order things happened in. The payload is the second: the topic is replicated and retained for days, so a note body or a requester's address written there outlives every delete the ticket store performs, and the "the widget fetches nothing" argument optimises a read that a consumer can answer from ids. The third contract is ordering between the two systems: a produce is durable and immediate, a database commit can still roll back, so publishing first announces a change that may never exist — commit, then produce, and let a failed commit reach the caller instead of the topic. Idempotence with acks=all is the producer-side half: without it a retry after a timeout duplicates a timeline entry a consumer counts. The role and transition fields are what make the topic self-sufficient for the timeline. Real platforms add a schema registry so producers and consumers agree on the payload, an outbox row when the broker is unreachable so a committed change is not lost, and consumer-side dedupe on the event id for the at-least-once handoff the broker still gives.`,
};
