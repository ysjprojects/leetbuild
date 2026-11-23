import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Ticket events keyed by ticket, produced after the commit',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'store', 'kafka'],
  task: `## Task

**Starting point.** The starter announces state changes on \`ticket.event\`:
\`publish_transition(ticket_id, from_state, to_state, actor_id, actor_role)\` reads the ticket, produces
\`{type: "ticket.transition", ticket_id, requester_id, subject, actor_id, state}\` keyed by the actor
with a delivery callback, then calls \`store.transition\` and answers the event, or \`None\` when the
ticket was no longer in \`from_state\`. Move a ticket and an event shows up; it hides 5 flaws.

**Failure mode the checks target.** One ticket's events land on several partitions and its timeline
is read out of order, the customer's subject sits in a retained, replicated topic, a transition the
store refused is announced anyway, a consumer cannot tell who moved the ticket from where, and a lost
acknowledgement writes the event twice.

- The record key is the **ticket id**.
- The payload is \`type\`, \`ticket_id\`, \`requester_id\`, \`actor_id\`, \`actor_role\`, \`from\` and \`to\`:
  ids and the transition, no text the customer wrote.
- \`store.transition\` commits first; only a transition that moved produces a record.
- The producer is idempotent with \`acks=all\` (\`enable.idempotence\`; kafkajs \`idempotent: true\` with
  \`acks: -1\`; Go uses confluent-kafka-go here, whose librdkafka producer has the same settings).`,
  sequence: {
    participants: ['Ticket API', 'Ticket store', 'ticket.event', 'Timeline consumer'],
    messages: [
      {from: 'Ticket API', to: 'Ticket store', label: 'transition(T-1, open, pending)', kind: 'sync'},
      {from: 'Ticket store', to: 'Ticket API', label: 'moved · or not (no event)', kind: 'reply'},
      {
        from: 'Ticket API',
        to: 'ticket.event',
        label: 'produce · key T-1 · {actor_role, from, to} · acks=all',
        kind: 'sync',
      },
      {from: 'ticket.event', to: 'Ticket API', label: 'delivery report (once, idempotent on retry)', kind: 'reply'},
      {from: 'ticket.event', to: 'Timeline consumer', label: 'one partition per ticket, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'ticket-key',
      title: 'Keyed by ticket id',
      detail:
        'The record key is the ticket id, so one ticket’s events land on one partition and a consumer reads them in order; the starter keys by the actor, so a ticket moved by two people spreads over partitions.',
      match: {
        python: {all: [/produce\([^\n]*key\s*=\s*ticket_id/], none: [/key\s*=\s*actor_id/]},
        typescript: {all: [/key:\s*ticketId\b/], none: [/key:\s*actorId\b/]},
        go: {all: [/Key:\s*\[\]byte\(ticketID\)/], none: [/Key:\s*\[\]byte\(actorID\)/]},
        cpp: {all: [/ticket_id\.c_str\(\),\s*ticket_id\.size\(\)/], none: [/actor_id\.c_str\(\)/]},
      },
    },
    {
      id: 'no-customer-text',
      title: 'Carries ids, never the customer’s words',
      detail:
        'The payload carries ids and the transition; the subject the customer wrote, or any part of it, stays in the ticket store, out of a topic every consumer can read and that outlives any deletion in the store. The starter copies `subject` in.',
      match: {
        python: {none: [/["']subject["']/]},
        typescript: {none: [/\bsubject\b/]},
        go: {none: [/"subject"/]},
        cpp: {none: [/"subject"/]},
      },
    },
    {
      id: 'event-fields',
      title: 'Names the actor’s role and the transition',
      detail:
        'The payload carries `requester_id`, `actor_role`, `from` and `to`, so a consumer renders "agent A-7 moved it from open to pending" from the event alone; the starter sends the new state only.',
      match: {
        python: {all: [/["']actor_role["']\s*:/, /["']from["']\s*:/, /["']to["']\s*:/]},
        typescript: {all: [/\bactor_role:/, /\bfrom:/, /\bto:/]},
        go: {all: [/"actor_role":/, /"from":/, /"to":/]},
        cpp: {all: [/\{"actor_role",/, /\{"from",/, /\{"to",/]},
      },
    },
    {
      id: 'commit-before-produce',
      title: 'Commits the transition before producing',
      detail:
        '`store.transition` runs first and the record is produced only when it moved the ticket, so no consumer hears about a state the store refused, even when another agent moves the ticket between a read and the commit; the starter produces, then commits.',
      match: {
        python: {order: [/store\.transition\(/, /producer\.produce\(/]},
        typescript: {order: [/await transition\(/, /producer\.send\(/]},
        go: {order: [/store\.Transition\(/, /producer\.Produce\(/]},
        cpp: {order: [/store::transition\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'durable-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer sets `enable.idempotence` and `acks=all` (kafkajs `idempotent: true`, `acks: -1`), so a retry after a lost acknowledgement writes the event once and a leader failover loses nothing; the starter runs with `acks=1`.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from tickets import store  # get_ticket, transition

TOPIC = "ticket.event"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("ticket event not delivered: %s", err)


def publish_transition(ticket_id: str, from_state: str, to_state: str, actor_id: str, actor_role: str) -> dict | None:
    """Move the ticket and tell ticket.event; None when the ticket was not in from_state."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    ticket = store.get_ticket(ticket_id)
    event = {
        "type": "ticket.transition",
        "ticket_id": ticket_id,
        "requester_id": ticket["requester_id"],
        "subject": ticket["subject"],
        "actor_id": actor_id,
        "state": to_state,
    }
    producer.produce(TOPIC, key=actor_id, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    if not store.transition(ticket_id, from_state, to_state):
        return None
    return event
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from tickets import store  # get_ticket, transition

TOPIC = "ticket.event"
log = logging.getLogger("events")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("ticket event not delivered: %s", err)


def publish_transition(ticket_id: str, from_state: str, to_state: str, actor_id: str, actor_role: str) -> dict | None:
    """Move the ticket and tell ticket.event; None when the ticket was not in from_state."""
    # The store commits first: an event may lag the state, never precede it.
    if not store.transition(ticket_id, from_state, to_state):
        return None
    ticket = store.get_ticket(ticket_id)
    event = {
        "type": "ticket.transition",
        "ticket_id": ticket_id,
        "requester_id": ticket["requester_id"],
        "actor_id": actor_id,
        "actor_role": actor_role,
        "from": from_state,
        "to": to_state,
    }
    producer.produce(TOPIC, key=ticket_id, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(2.0)
    return event
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {getTicket, transition} from 'tickets/store';

export const TOPIC = 'ticket.event';

const kafka = new Kafka({clientId: 'ticketd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Move the ticket and tell ticket.event; null when the ticket was not in fromState. */
export async function publishTransition(
  ticketId: string,
  fromState: string,
  toState: string,
  actorId: string,
  actorRole: string,
): Promise<Record<string, unknown> | null> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const ticket = await getTicket(ticketId);
  if (ticket === null) return null;
  const event = {
    type: 'ticket.transition',
    ticket_id: ticketId,
    requester_id: ticket.requester_id,
    subject: ticket.subject,
    actor_id: actorId,
    state: toState,
  };
  await producer.send({topic: TOPIC, messages: [{key: actorId, value: JSON.stringify(event)}], acks: 1});
  if (!(await transition(ticketId, fromState, toState))) return null;
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {getTicket, transition} from 'tickets/store';

export const TOPIC = 'ticket.event';

const kafka = new Kafka({clientId: 'ticketd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the event once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Move the ticket and tell ticket.event; null when the ticket was not in fromState. */
export async function publishTransition(
  ticketId: string,
  fromState: string,
  toState: string,
  actorId: string,
  actorRole: string,
): Promise<Record<string, unknown> | null> {
  // The store commits first: an event may lag the state, never precede it.
  if (!(await transition(ticketId, fromState, toState))) return null;
  const ticket = await getTicket(ticketId);
  if (ticket === null) return null;
  const event = {
    type: 'ticket.transition',
    ticket_id: ticketId,
    requester_id: ticket.requester_id,
    actor_id: actorId,
    actor_role: actorRole,
    from: fromState,
    to: toState,
  };
  await producer.send({topic: TOPIC, messages: [{key: ticketId, value: JSON.stringify(event)}], acks: -1});
  return event;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"tickets/store" // store.GetTicket, Transition
)

const (
	topic      = "ticket.event"
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

// publishTransition moves the ticket and tells ticket.event; nil when the ticket was not in fromState.
func publishTransition(ctx context.Context, ticketID, fromState, toState, actorID, actorRole string) (map[string]any, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	ticket := store.GetTicket(ctx, ticketID)
	if ticket == nil {
		return nil, fmt.Errorf("unknown ticket %s", ticketID)
	}
	event := map[string]any{
		"type":         "ticket.transition",
		"ticket_id":    ticketID,
		"requester_id": ticket.RequesterID,
		"subject":      ticket.Subject,
		"actor_id":     actorID,
		"state":        toState,
	}
	value, _ := json.Marshal(event)
	t := topic
	deliveries := make(chan kafka.Event, 1)
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(actorID), Value: value}
	if err := producer.Produce(msg, deliveries); err != nil {
		return nil, err
	}
	select {
	case e := <-deliveries:
		if err := e.(*kafka.Message).TopicPartition.Error; err != nil {
			log.Printf("ticket event not delivered: %v", err)
		}
	case <-time.After(ackTimeout):
		log.Printf("ticket event for %s not acknowledged within %v", ticketID, ackTimeout)
	}
	moved, err := store.Transition(ctx, ticketID, fromState, toState)
	if err != nil || !moved {
		return nil, err
	}
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"tickets/store" // store.GetTicket, Transition
)

const (
	topic      = "ticket.event"
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

// publishTransition moves the ticket and tells ticket.event; nil when the ticket was not in fromState.
func publishTransition(ctx context.Context, ticketID, fromState, toState, actorID, actorRole string) (map[string]any, error) {
	// The store commits first: an event may lag the state, never precede it.
	moved, err := store.Transition(ctx, ticketID, fromState, toState)
	if err != nil || !moved {
		return nil, err
	}
	ticket := store.GetTicket(ctx, ticketID)
	event := map[string]any{
		"type":         "ticket.transition",
		"ticket_id":    ticketID,
		"requester_id": ticket.RequesterID,
		"actor_id":     actorID,
		"actor_role":   actorRole,
		"from":         fromState,
		"to":           toState,
	}
	value, _ := json.Marshal(event)
	t := topic
	deliveries := make(chan kafka.Event, 1)
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(ticketID), Value: value}
	if err := producer.Produce(msg, deliveries); err != nil {
		return nil, err
	}
	select {
	case e := <-deliveries:
		if err := e.(*kafka.Message).TopicPartition.Error; err != nil {
			log.Printf("ticket event not delivered: %v", err)
		}
	case <-time.After(ackTimeout):
		log.Printf("ticket event for %s not acknowledged within %v", ticketID, ackTimeout)
	}
	return event, nil
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>

#include "tickets/store.h"  // store::getTicket, transition

using json = nlohmann::json;

const std::string kTopic = "ticket.event";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "ticket event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Move the ticket and tell ticket.event; none when the ticket was not in from_state.
std::optional<json> publishTransition(const std::string& ticket_id, const std::string& from_state, const std::string& to_state,
                                      const std::string& actor_id, const std::string& actor_role) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto ticket = store::getTicket(ticket_id);
  if (!ticket) throw std::out_of_range("unknown ticket " + ticket_id);
  const json event = {{"type", "ticket.transition"}, {"ticket_id", ticket_id}, {"requester_id", ticket->requester_id},
                      {"subject", ticket->subject},  {"actor_id", actor_id},   {"state", to_state}};
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), actor_id.c_str(), actor_id.size(), 0, nullptr);
  producer->flush(2000);
  if (!store::transition(ticket_id, from_state, to_state)) return std::nullopt;
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "tickets/store.h"  // store::getTicket, transition

using json = nlohmann::json;

const std::string kTopic = "ticket.event";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "ticket event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Move the ticket and tell ticket.event; none when the ticket was not in from_state.
std::optional<json> publishTransition(const std::string& ticket_id, const std::string& from_state, const std::string& to_state,
                                      const std::string& actor_id, const std::string& actor_role) {
  // The store commits first: an event may lag the state, never precede it.
  if (!store::transition(ticket_id, from_state, to_state)) return std::nullopt;
  const auto ticket = store::getTicket(ticket_id);
  const json event = {{"type", "ticket.transition"}, {"ticket_id", ticket_id}, {"requester_id", ticket->requester_id},
                      {"actor_id", actor_id},        {"actor_role", actor_role}, {"from", from_state},
                      {"to", to_state}};
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), ticket_id.c_str(), ticket_id.size(), 0, nullptr);
  producer->flush(2000);
  return event;
}
`,
    },
  },
  harness: {
    python: `import json

from tickets import store

TOPIC = "ticket.event"
SUBJECT = "Invoice 4471 charged twice"


def _events(ctx):
    m = ctx.load("events")
    return m, store.create_ticket("R-1", SUBJECT)["id"]


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def _publish(m, t, from_state, to_state, actor="A-7", role="agent"):
    event = m.publish_transition(t, from_state, to_state, actor, role)
    assert event is not None, f"moving {t} from {from_state} to {to_state} must commit and answer the event"
    return event


def check_ticket_key(ctx):
    m, t = _events(ctx)
    _publish(m, t, "open", "pending", "A-7", "agent")
    _publish(m, t, "pending", "open", "R-1", "requester")
    _publish(m, t, "open", "resolved", "A-9", "agent")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three transitions produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [t.encode()] * 3, f"records must be keyed by the ticket id, got {keys}: keyed by the actor, one ticket's events land on several partitions and its timeline is read out of order"
    partitions = {r.partition for r in records}
    assert len(partitions) == 1, f"{t}'s events landed on partitions {sorted(partitions)}: one ticket's history must stay on one partition"


def check_no_customer_text(ctx):
    m, t = _events(ctx)
    _publish(m, t, "open", "pending")
    records = ctx.kafka.records(TOPIC)
    assert records, f"the transition produced nothing on {TOPIC}"
    text = records[0].value.decode() if isinstance(records[0].value, bytes) else str(records[0].value)
    for words in (SUBJECT, "4471", "charged"):
        assert words not in text, f"the event carries the ticket's subject ({words!r}): {text}. {TOPIC} is retained and replicated; carry ids and the transition"
    assert "subject" not in _payload(records[0]), f"the event has a subject field: {text}"


def check_event_fields(ctx):
    m, t = _events(ctx)
    _publish(m, t, "open", "pending", "R-1", "requester")
    payload = _payload(ctx.kafka.records(TOPIC)[0])
    expected = {"type": "ticket.transition", "ticket_id": t, "requester_id": "R-1", "actor_id": "R-1", "actor_role": "requester", "from": "open", "to": "pending"}
    for name, value in expected.items():
        assert payload.get(name) == value, f"the event's {name} is {payload.get(name)!r}, expected {value!r}: a consumer renders the timeline entry from the event alone ({payload})"


def check_commit_before_produce(ctx):
    m, t = _events(ctx)
    stale = m.publish_transition(t, "pending", "resolved", "A-7", "agent")
    assert stale is None, f"{t} is open, so a move from pending must not commit and must answer None, got {stale}"
    records = ctx.kafka.records(TOPIC)
    assert records == [], f"a transition the store refused produced {len(records)} record(s): consumers now believe {t} is resolved while it is open. Commit first, produce after"
    assert store.get_ticket(t)["state"] == "open", f"the refused move changed the ticket: {store.get_ticket(t)}"
    _publish(m, t, "open", "pending")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"a committed transition must produce one record, the topic holds {len(ctx.kafka.records(TOPIC))}"
    assert store.get_ticket(t)["state"] == "pending", f"the store holds {store.get_ticket(t)} after the move"
    # Another agent resolves the next ticket the instant this call first touches it.
    t2 = store.create_ticket("R-1", SUBJECT)["id"]
    rival = ctx.redis_after(f"ticket:{t2}", lambda: ctx.redis.hset(f"ticket:{t2}", "state", "resolved"))
    event = m.publish_transition(t2, "open", "pending", "A-7", "agent")
    assert rival.fired, f"publish_transition never touched ticket:{t2}"
    produced = [r for r in ctx.kafka.records(TOPIC) if _payload(r).get("ticket_id") == t2]
    if event is None:
        assert produced == [], f"another agent resolved {t2} between this call's read and its commit, so the move did not commit, yet it produced {len(produced)} record(s). Produce only after store.transition moved the ticket"
    else:
        assert len(produced) == 1, f"the committed move of {t2} produced {len(produced)} records, expected 1"


def check_durable_producer(ctx):
    m, t = _events(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    _publish(m, t, "open", "pending")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one transition whose acknowledgement was lost left {len(records)} records: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    _publish(m, t, "pending", "resolved")
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the second event and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'ticket.event';
const SUBJECT = 'Invoice 4471 charged twice';

async function events(ctx) {
  const m = ctx.load('events');
  const store = ctx.load('/support/tickets/store.ts');
  const t = (await store.createTicket('R-1', SUBJECT)).id;
  return {m, store, t};
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

async function publish(m, t: string, fromState: string, toState: string, actor = 'A-7', role = 'agent') {
  const event = await m.publishTransition(t, fromState, toState, actor, role);
  assert(event !== null, \`moving \${t} from \${fromState} to \${toState} must commit and answer the event\`);
  return event;
}

export async function check_ticket_key(ctx) {
  const {m, t} = await events(ctx);
  await publish(m, t, 'open', 'pending', 'A-7', 'agent');
  await publish(m, t, 'pending', 'open', 'R-1', 'requester');
  await publish(m, t, 'open', 'resolved', 'A-9', 'agent');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three transitions produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, [t, t, t], \`records must be keyed by the ticket id, got \${JSON.stringify(keys)}: keyed by the actor, one ticket's events land on several partitions and its timeline is read out of order\`);
  const partitions = [...new Set(records.map(r => r.partition))];
  assert.equal(partitions.length, 1, \`\${t}'s events landed on partitions \${JSON.stringify(partitions)}: one ticket's history must stay on one partition\`);
}

export async function check_no_customer_text(ctx) {
  const {m, t} = await events(ctx);
  await publish(m, t, 'open', 'pending');
  const records = ctx.kafka.records(TOPIC);
  assert(records.length > 0, \`the transition produced nothing on \${TOPIC}\`);
  const text = records[0].value.toString();
  for (const words of [SUBJECT, '4471', 'charged']) {
    assert(!text.includes(words), \`the event carries the ticket's subject (\${JSON.stringify(words)}): \${text}. \${TOPIC} is retained and replicated; carry ids and the transition\`);
  }
  assert(!('subject' in payload(records[0])), \`the event has a subject field: \${text}\`);
}

export async function check_event_fields(ctx) {
  const {m, t} = await events(ctx);
  await publish(m, t, 'open', 'pending', 'R-1', 'requester');
  const p = payload(ctx.kafka.records(TOPIC)[0]);
  const expected = {type: 'ticket.transition', ticket_id: t, requester_id: 'R-1', actor_id: 'R-1', actor_role: 'requester', from: 'open', to: 'pending'};
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(p[name], value, \`the event's \${name} is \${JSON.stringify(p[name])}, expected \${JSON.stringify(value)}: a consumer renders the timeline entry from the event alone (\${JSON.stringify(p)})\`);
  }
}

export async function check_commit_before_produce(ctx) {
  const {m, store, t} = await events(ctx);
  const stale = await m.publishTransition(t, 'pending', 'resolved', 'A-7', 'agent');
  assert.equal(stale, null, \`\${t} is open, so a move from pending must not commit and must answer null\`);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 0, \`a transition the store refused produced \${records.length} record(s): consumers now believe \${t} is resolved while it is open. Commit first, produce after\`);
  assert.equal((await store.getTicket(t)).state, 'open', 'the refused move changed the ticket');
  await publish(m, t, 'open', 'pending');
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'a committed transition must produce one record');
  assert.equal((await store.getTicket(t)).state, 'pending', 'the store must hold the committed state');
  // Another agent resolves the next ticket the instant this call first touches it.
  const t2 = (await store.createTicket('R-1', SUBJECT)).id;
  const rival = ctx.redisAfter(\`ticket:\${t2}\`, () => ctx.redis.hset(\`ticket:\${t2}\`, 'state', 'resolved'));
  const event = await m.publishTransition(t2, 'open', 'pending', 'A-7', 'agent');
  assert(rival.fired, \`publishTransition never touched ticket:\${t2}\`);
  const produced = ctx.kafka.records(TOPIC).filter(r => payload(r).ticket_id === t2);
  if (event === null || event === undefined) {
    assert.equal(produced.length, 0, \`another agent resolved \${t2} between this call's read and its commit, so the move did not commit, yet it produced \${produced.length} record(s). Produce only after the store's transition moved the ticket\`);
  } else {
    assert.equal(produced.length, 1, \`the committed move of \${t2} produced \${produced.length} records, expected 1\`);
  }
}

export async function check_durable_producer(ctx) {
  const {m, t} = await events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await publish(m, t, 'open', 'pending');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one transition whose acknowledgement was lost left \${records.length} records: the producer's retry wrote the event twice. Make the producer idempotent (acks -1)\`);
  await publish(m, t, 'pending', 'resolved');
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the second event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"tickets/store"

	"leetbuild/harness"
)

const (
	kHEventsTopic   = "ticket.event"
	kHEventsSubject = "Invoice 4471 charged twice"
)

var hEventsBg = context.Background()

func hEventsTicket() string { return store.CreateTicket(hEventsBg, "R-1", kHEventsSubject).ID }

func hEventsPublish(ctx *harness.Ctx, t, fromState, toState, actor, role string) map[string]any {
	event, err := publishTransition(hEventsBg, t, fromState, toState, actor, role)
	ctx.NoError(err, "moving %s from %s to %s failed", t, fromState, toState)
	ctx.Assert(event != nil, "moving %s from %s to %s must commit and answer the event", t, fromState, toState)
	ctx.Settle()
	return event
}

func hEventsPayload(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func CheckTicketKey(ctx *harness.Ctx) {
	t := hEventsTicket()
	hEventsPublish(ctx, t, "open", "pending", "A-7", "agent")
	hEventsPublish(ctx, t, "pending", "open", "R-1", "requester")
	hEventsPublish(ctx, t, "open", "resolved", "A-9", "agent")
	records := ctx.Kafka.Records(kHEventsTopic)
	ctx.Equal(len(records), 3, "three transitions must produce three records on %s; the records", kHEventsTopic)
	ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), []string{t, t, t}, "records must be keyed by the ticket id (keyed by the actor, one ticket's events land on several partitions and its timeline is read out of order)")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "%s's events landed on partitions %d, %d, %d: one ticket's history must stay on one partition", t, records[0].Partition, records[1].Partition, records[2].Partition)
}

func CheckNoCustomerText(ctx *harness.Ctx) {
	t := hEventsTicket()
	hEventsPublish(ctx, t, "open", "pending", "A-7", "agent")
	records := ctx.Kafka.Records(kHEventsTopic)
	ctx.Assert(len(records) > 0, "the transition produced nothing on %s", kHEventsTopic)
	text := string(records[0].Value)
	for _, words := range []string{kHEventsSubject, "4471", "charged"} {
		ctx.Assert(!strings.Contains(text, words), "the event carries the ticket's subject (%q): %s. %s is retained and replicated; carry ids and the transition", words, text, kHEventsTopic)
	}
	_, has := hEventsPayload(ctx, records[0].Value)["subject"]
	ctx.Assert(!has, "the event has a subject field: %s", text)
}

func CheckEventFields(ctx *harness.Ctx) {
	t := hEventsTicket()
	hEventsPublish(ctx, t, "open", "pending", "R-1", "requester")
	p := hEventsPayload(ctx, ctx.Kafka.Records(kHEventsTopic)[0].Value)
	expected := map[string]string{"type": "ticket.transition", "ticket_id": t, "requester_id": "R-1", "actor_id": "R-1", "actor_role": "requester", "from": "open", "to": "pending"}
	for _, name := range []string{"type", "ticket_id", "requester_id", "actor_id", "actor_role", "from", "to"} {
		ctx.Equal(p[name], expected[name], "a consumer renders the timeline entry from the event alone (%v); the event's %s", p, name)
	}
}

func CheckCommitBeforeProduce(ctx *harness.Ctx) {
	t := hEventsTicket()
	stale, err := publishTransition(hEventsBg, t, "pending", "resolved", "A-7", "agent")
	ctx.NoError(err, "a refused transition must not fail")
	ctx.Settle()
	ctx.Assert(stale == nil, "%s is open, so a move from pending must not commit and must answer nil, got %v", t, stale)
	records := ctx.Kafka.Records(kHEventsTopic)
	ctx.Assert(len(records) == 0, "a transition the store refused produced %d record(s): consumers now believe %s is resolved while it is open. Commit first, produce after", len(records), t)
	ctx.Equal(store.GetTicket(hEventsBg, t).State, "open", "the refused move must leave the ticket; its state")
	hEventsPublish(ctx, t, "open", "pending", "A-7", "agent")
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "a committed transition must produce one record; the records")
	ctx.Equal(store.GetTicket(hEventsBg, t).State, "pending", "the committed state")
	// Another agent resolves the next ticket the instant this call first touches it.
	t2 := hEventsTicket()
	rival := ctx.Redis.After("ticket:"+t2, func() any { return ctx.Redis.Do("HSET", "ticket:"+t2, "state", "resolved") })
	event, err := publishTransition(hEventsBg, t2, "open", "pending", "A-7", "agent")
	ctx.NoError(err, "publishTransition(%s) failed", t2)
	ctx.Settle()
	ctx.Assert(rival.Fired, "publishTransition never touched ticket:%s", t2)
	produced := 0
	for _, r := range ctx.Kafka.Records(kHEventsTopic) {
		if hEventsPayload(ctx, r.Value)["ticket_id"] == t2 {
			produced++
		}
	}
	if event == nil {
		ctx.Assert(produced == 0, "another agent resolved %s between this call's read and its commit, so the move did not commit, yet it produced %d record(s). Produce only after store.Transition moved the ticket", t2, produced)
	} else {
		ctx.Equal(produced, 1, "the committed move of %s; its records", t2)
	}
}

func CheckDurableProducer(ctx *harness.Ctx) {
	t := hEventsTicket()
	ctx.Kafka.LoseAcks(kHEventsTopic, 1)
	hEventsPublish(ctx, t, "open", "pending", "A-7", "agent")
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "one transition whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records")
	hEventsPublish(ctx, t, "pending", "resolved", "A-7", "agent")
	lost := ctx.Kafka.Failover(kHEventsTopic)
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "tickets/store.h"

using json = nlohmann::json;

namespace {

const std::string kHEventsTopic = "ticket.event";
const std::string kHEventsSubject = "Invoice 4471 charged twice";

std::string hEventsTicket() { return store::createTicket("R-1", kHEventsSubject).id; }

json hMustPublish(harness::Ctx& ctx, const std::string& t, const std::string& from_state, const std::string& to_state,
                 const std::string& actor = "A-7", const std::string& role = "agent") {
  std::optional<json> event;
  try {
    event = publishTransition(t, from_state, to_state, actor, role);
  } catch (const std::exception& e) {
    ctx.Fatalf("moving %s from %s to %s threw %s: %s", t, from_state, to_state, harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(event.has_value(), "moving %s from %s to %s must commit and answer the event", t, from_state, to_state);
  return *event;
}

json hPayloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  try {
    return json::parse(record.Value.value_or(""));
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", record.Value.value_or(""), e.what());
  }
}

}  // namespace

void CheckTicketKey(harness::Ctx& ctx) {
  const std::string t = hEventsTicket();
  hMustPublish(ctx, t, "open", "pending", "A-7", "agent");
  hMustPublish(ctx, t, "pending", "open", "R-1", "requester");
  hMustPublish(ctx, t, "open", "resolved", "A-9", "agent");
  const auto records = ctx.Kafka.Records(kHEventsTopic);
  ctx.Equal(records.size(), 3, "three transitions must produce three records on %s; the records", kHEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), {t, t, t}, "records must be keyed by the ticket id (keyed by the actor, one ticket's events land on several partitions and its timeline is read out of order)");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
             "%s's events landed on partitions %d, %d, %d: one ticket's history must stay on one partition", t, records[0].Partition,
             records[1].Partition, records[2].Partition);
}

void CheckNoCustomerText(harness::Ctx& ctx) {
  const std::string t = hEventsTicket();
  hMustPublish(ctx, t, "open", "pending");
  const auto records = ctx.Kafka.Records(kHEventsTopic);
  ctx.Assert(!records.empty(), "the transition produced nothing on %s", kHEventsTopic);
  const std::string text = records[0].Value.value_or("");
  for (const std::string& words : {kHEventsSubject, std::string("4471"), std::string("charged")}) {
    ctx.Assert(text.find(words) == std::string::npos, "the event carries the ticket's subject (%q): %s. %s is retained and replicated; carry ids and the transition", words, text, kHEventsTopic);
  }
  ctx.Assert(!hPayloadOf(ctx, records[0]).contains("subject"), "the event has a subject field: %s", text);
}

void CheckEventFields(harness::Ctx& ctx) {
  const std::string t = hEventsTicket();
  hMustPublish(ctx, t, "open", "pending", "R-1", "requester");
  const json p = hPayloadOf(ctx, ctx.Kafka.Records(kHEventsTopic)[0]);
  const std::vector<std::pair<std::string, std::string>> expected = {
      {"type", "ticket.transition"}, {"ticket_id", t}, {"requester_id", "R-1"}, {"actor_id", "R-1"}, {"actor_role", "requester"}, {"from", "open"}, {"to", "pending"}};
  for (const auto& [name, value] : expected) {
    ctx.Equal(p.value(name, ""), value, "a consumer renders the timeline entry from the event alone (%s); the event's %s", p.dump(), name);
  }
}

void CheckCommitBeforeProduce(harness::Ctx& ctx) {
  const std::string t = hEventsTicket();
  std::optional<json> stale;
  try {
    stale = publishTransition(t, "pending", "resolved", "A-7", "agent");
  } catch (const std::exception& e) {
    ctx.Fatalf("a refused transition threw %s: %s", harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(!stale, "%s is open, so a move from pending must not commit and must answer nothing", t);
  const auto records = ctx.Kafka.Records(kHEventsTopic);
  ctx.Assert(records.empty(), "a transition the store refused produced %d record(s): consumers now believe %s is resolved while it is open. Commit first, produce after", records.size(), t);
  ctx.Equal(store::getTicket(t)->state, "open", "the refused move must leave the ticket; its state");
  hMustPublish(ctx, t, "open", "pending");
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1, "a committed transition must produce one record; the records");
  ctx.Equal(store::getTicket(t)->state, "pending", "the committed state");
  // Another agent resolves the next ticket the instant this call first touches it.
  const std::string t2 = hEventsTicket();
  auto fired = std::make_shared<bool>(false);
  ctx.Redis.After("ticket:" + t2, [&ctx, fired, t2] {
    *fired = true;
    ctx.Redis.Do("HSET", "ticket:" + t2, "state", "resolved");
  });
  std::optional<json> event;
  try {
    event = publishTransition(t2, "open", "pending", "A-7", "agent");
  } catch (const std::exception& e) {
    ctx.Fatalf("publishTransition(%s) threw %s: %s", t2, harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(*fired, "publishTransition never touched ticket:%s", t2);
  size_t produced = 0;
  for (const auto& r : ctx.Kafka.Records(kHEventsTopic)) {
    if (hPayloadOf(ctx, r).value("ticket_id", "") == t2) ++produced;
  }
  if (!event) {
    ctx.Assert(produced == 0, "another agent resolved %s between this call's read and its commit, so the move did not commit, yet it produced %d record(s). Produce only after store::transition moved the ticket", t2, produced);
  } else {
    ctx.Equal(produced, 1, "the committed move of %s; its records", t2);
  }
}

void CheckDurableProducer(harness::Ctx& ctx) {
  const std::string t = hEventsTicket();
  ctx.Kafka.LoseAcks(kHEventsTopic, 1);
  hMustPublish(ctx, t, "open", "pending");
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1, "one transition whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records");
  hMustPublish(ctx, t, "pending", "resolved");
  const int lost = ctx.Kafka.Failover(kHEventsTopic);
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records", lost);
}
`,
  },
  hints: [
    'Move one ticket as two different people and look at the partitions: its events sit on two of them. Move it from a state it is not in: the call answers no, and the topic says it moved anyway.',
    'The key is the actor, so the partition follows the person. The payload is built from the ticket row, subject included, and is produced before `store.transition` decides whether the move happened.',
    'Call `store.transition` first and return when it did not move; produce `{type, ticket_id, requester_id, actor_id, actor_role, from, to}` with `key=ticket_id`; set `enable.idempotence` and `acks=all`.',
  ],
  debrief: `An event is a statement about state that already exists, which is why the transition commits first and a refused move produces nothing. The key is the ticket because order matters per ticket and nowhere else; the payload is ids and the transition because the topic is read by every consumer and kept long after a customer asks for their words to be deleted from the store. Idempotence with acks=all makes a retry after a lost acknowledgement write the record once on every replica. A crash between the commit and the produce still loses the event here; production systems write it into an outbox in the same transaction as the state and let a relay produce it, or read the store's change log instead.`,
};
