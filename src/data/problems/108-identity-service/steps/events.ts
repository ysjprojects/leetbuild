import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'User events keyed by user with minimal PII',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the lifecycle endpoint answers
**202**, a record lands on \`identity.event\` and the demo shows the topic filling up. Three production
contracts are broken. It keys the record by the **email address** instead of the user id, it copies
the **address and the number** into the payload "for downstream dedupe", and it lets the producer
acknowledge the record **before the account write commits**, so the topic can announce a state the
database never stored. On top of that the producer is a bare one with no idempotence, and any
\`kind\` string a caller sends is published as-is.

\`POST /v1/users/{user_id}/events\` records a lifecycle change on an account and announces it to the
consumer that projects profiles. Implement the lifecycle publisher:

- the event is produced to the **\`identity.event\`** topic with the **user id** as the message key,
  so one user's lifecycle stays in order in one partition.
- the payload carries the event **kind** and its **reason code** only: no \`email\`, \`phone\` or
  \`name\` field reaches the topic, which is retained and replicated for days.
- the account write **commits before** the produce: an uncommitted change is never announced, and a
  failed transaction must not produce anything.
- the producer is **idempotent with acks=all**, so a retried produce cannot duplicate a record.
- \`kind\` is validated against the closed lifecycle set **\`created\`**, **\`verified\`**,
  **\`suspended\`**; anything else is rejected with **422** and never published.
- a committed change answers **202**.

**Failure mode the checks target.** Keying by the address puts one account's events in partitions
that stop being ordered the moment the address changes or an alias is used; the address and the
number on the topic are a data leak with the topic's retention; a produce-then-commit window
announces state a crash can roll back; a default producer duplicates records when a produce is
retried; and an open \`kind\` lets typo events into a topic consumers switch on.`,
  sequence: {
    participants: ['Lifecycle API', 'Accounts DB', 'identity.event', 'Profile projector'],
    messages: [
      {from: 'Lifecycle API', to: 'Accounts DB', label: 'UPDATE accounts SET state … · commit', kind: 'sync'},
      {from: 'Accounts DB', to: 'Lifecycle API', label: 'committed', kind: 'reply'},
      {from: 'Lifecycle API', to: 'identity.event', label: 'produce · key = user id · acks = all', kind: 'sync'},
      {from: 'identity.event', to: 'Lifecycle API', label: 'ack', kind: 'reply'},
      {
        from: 'identity.event',
        to: 'Profile projector',
        label: 'consume · {kind, reason} · group profiles',
        kind: 'async',
      },
    ],
  },
  hints: [
    'The message key is the partition key: `key=user_id` (`key: userId`, `Key: []byte(userID)`, `ProducerRecord(topic, user.id, …)`). Keyed by the address, one account’s lifecycle splits across partitions, and an address change would re-key the whole history — the key must be the identity, not a handle of it.',
    'The payload is a contract, not a copy of the request: build it from an allow-list (`ALLOWED_EVENT_FIELDS`) so only the kind and the reason code can travel. The topic is retained and replicated, so an address written there outlives every deletion the accounts table does.',
    'Order the write and the produce: `commit()` the account row first, then publish, and let a failed transaction reach the client instead of the topic. Configure the producer with `enable.idempotence` and `acks=all` (KafkaJS `idempotent: true` plus `acks: -1`, kafka-go `RequiredAcks: kafka.RequireAll` with a `&kafka.Hash{}` balancer), and check the kind against the closed enum before either.',
  ],
  checks: [
    {
      id: 'user-key',
      title: 'Produced to identity.event keyed by the user id',
      detail:
        'The record goes to `identity.event` with the **user id** as its key, so one user’s lifecycle stays ordered in one partition. The draft keys by the email address, so the ordering guarantee follows a handle that can change instead of the identity itself.',
      match: {
        python: {
          all: [
            /IDENTITY_EVENT_TOPIC\s*=\s*['"]identity\.event['"]/,
            /produce\(\s*IDENTITY_EVENT_TOPIC,\s*key\s*=\s*user_id/,
          ],
        },
        typescript: {all: [/IDENTITY_EVENT_TOPIC\s*=\s*['"]identity\.event['"]/, /key:\s*userId\b/]},
        go: {all: [/identityEventTopic\s*=\s*"identity\.event"/, /Key:\s*\[\]byte\(userID\)/]},
        scala: {all: [/IdentityEventTopic\s*=\s*"identity\.event"/, /ProducerRecord\(IdentityEventTopic,\s*userId/]},
        cpp: {all: [/kIdentityEventTopic\s*=\s*"identity\.event"/, /user\.id\.data\(\)/]},
      },
    },
    {
      id: 'no-contact-pii',
      title: 'Payload carries the kind and the reason only',
      detail:
        'The event body is projected through an allow-list (`ALLOWED_EVENT_FIELDS` / `kAllowedEventFields`) that names exactly `kind` and `reason`, and the module never mentions `email`, `phone` or `name`. The draft copies the address and the number into the payload for downstream dedupe — retained and replicated with the topic.',
      match: {
        python: {
          all: [/ALLOWED_EVENT_FIELDS\s*=\s*\(\s*"kind"\s*,\s*"reason"\s*\)/],
          none: [/\bemail\b|\bphone\b|\bname\b/i],
        },
        typescript: {
          all: [/ALLOWED_EVENT_FIELDS\s*=\s*\[\s*'kind'\s*,\s*'reason'\s*\]/],
          none: [/\bemail\b|\bphone\b|\bname\b/i],
        },
        go: {
          all: [/allowedEventFields\s*=\s*\[\]string\{"kind",\s*"reason"\}/],
          none: [/\bemail\b|\bphone\b|\bname\b/i],
        },
        scala: {
          all: [/AllowedEventFields\s*=\s*List\("kind",\s*"reason"\)/],
          none: [/\bemail\b|\bphone\b|\bname\b/i],
        },
        cpp: {
          all: [/kAllowedEventFields\s*=\s*\{"kind",\s*"reason"\}/],
          none: [/\bemail\b|\bphone\b|\bname\b/i],
        },
      },
    },
    {
      id: 'commit-before-publish',
      title: 'The account write commits before the produce',
      detail:
        'The committed account row comes first (`store.commit_state` / `commitState`, `conn.commit()`), and only then the record is produced. The draft produces, flushes and *then* commits the write, so a rolled-back transaction has already been announced to every consumer.',
      match: {
        python: {order: [/store\.commit_state\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.commitState\(/, /producer\.send\(/]},
        go: {order: [/store\.CommitState\(/, /WriteMessages\(/]},
        scala: {order: [/\.commit\(\)/, /producer\.send\(/]},
        cpp: {order: [/store\.commitState\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` plus `acks`, KafkaJS `idempotent: true` with `acks: -1`, kafka-go `RequiredAcks: kafka.RequireAll` with a hashed balancer), so a retry of a produce cannot duplicate a record. The draft runs a default producer and takes whatever the broker does.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/props\.put\("enable\.idempotence",\s*"true"\)/, /props\.put\("acks",\s*"all"\)/]},
        cpp: {all: [/set\("enable\.idempotence",\s*"true"/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'lifecycle-enum',
      title: 'The lifecycle kinds are a closed set',
      detail:
        '`created`, `verified` and `suspended` are the whole vocabulary (`LIFECYCLE_EVENTS` / `kLifecycleEvents`) and `kind` is validated against it before anything is written or produced, so an unknown kind can never be published. The draft publishes whatever string arrives, including typos consumers switch on.',
      match: {
        python: {
          all: [/LIFECYCLE_EVENTS\s*=\s*\(\s*"created"\s*,\s*"verified"\s*,\s*"suspended"\s*\)/, /raise ValueError/],
        },
        typescript: {
          all: [/LIFECYCLE_EVENTS\s*=\s*\[\s*'created'\s*,\s*'verified'\s*,\s*'suspended'\s*\]/, /throw new Error/],
        },
        go: {
          all: [/lifecycleEvents\s*=\s*\[\]string\{"created",\s*"verified",\s*"suspended"\}/, /validateKind\(/],
        },
        scala: {
          all: [/LifecycleEvents\s*=\s*List\("created",\s*"verified",\s*"suspended"\)/, /IllegalArgumentException/],
        },
        cpp: {all: [/kLifecycleEvents\s*=\s*\{"created",\s*"verified",\s*"suspended"\}/, /std::invalid_argument/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

producer = Producer({"bootstrap.servers": "kafka:9092"})


class AccountStore:
    """The accounts table: \`commit_state\` writes the row and commits the transaction."""

    def commit_state(self, user_id: str, state: str) -> None:
        raise NotImplementedError


store = AccountStore()


class LifecycleEvent(BaseModel):
    kind: str
    reason: str
    email: str
    phone: str


@app.post("/v1/users/{user_id}/events", status_code=202)
def record_event(user_id: str, event: LifecycleEvent) -> dict:
    # TODO: key the record by \`user_id\` instead of \`event.email\`, keep the address and the number
    # out of the payload (\`kind\` and \`reason\` only), set enable.idempotence + acks=all on the
    # producer, reject kinds outside created/verified/suspended, and commit the account write
    # before the produce is acknowledged.
    body = {"kind": event.kind, "reason": event.reason, "email": event.email, "phone": event.phone}
    producer.produce("identity.event", key=event.email, value=json.dumps(body))
    producer.flush(2.0)
    store.commit_state(user_id, event.kind)
    return {"accepted": True}
`,
      solution: `import json

from confluent_kafka import Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

IDENTITY_EVENT_TOPIC = "identity.event"
LIFECYCLE_EVENTS = ("created", "verified", "suspended")
# The topic is retained and replicated: the payload contract is exactly these two fields.
ALLOWED_EVENT_FIELDS = ("kind", "reason")

# Idempotence plus acks=all: a retried produce of the same record is a no-op, and the broker
# acknowledges only once every in-sync replica holds it.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class AccountStore:
    """The accounts table: \`commit_state\` writes the row and commits the transaction."""

    def commit_state(self, user_id: str, state: str) -> None:
        raise NotImplementedError


store = AccountStore()


class LifecycleEvent(BaseModel):
    kind: str
    reason: str

    def payload(self) -> dict:
        """Only the allow-listed fields leave the process, whatever the body grows later."""
        body = self.model_dump()
        return {field: body[field] for field in ALLOWED_EVENT_FIELDS}


def assert_lifecycle_event(kind: str) -> None:
    """The topic speaks a closed vocabulary; a typo must never reach a consumer."""
    if kind not in LIFECYCLE_EVENTS:
        raise ValueError(f"unknown lifecycle event: {kind}")


@app.post("/v1/users/{user_id}/events", status_code=202)
def record_event(user_id: str, event: LifecycleEvent) -> dict:
    assert_lifecycle_event(event.kind)
    # The account write is committed first: only a state the database holds may be announced.
    store.commit_state(user_id, event.kind)
    producer.produce(IDENTITY_EVENT_TOPIC, key=user_id, value=json.dumps(event.payload()))
    producer.flush(2.0)
    return {"accepted": True}
`,
    },
    typescript: {
      starter: `/** identity.event: a model-generated draft that keys by the address and acks before the commit. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'identity', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface LifecycleEvent {
  kind: string;
  reason: string;
  email: string;
  phone: string;
}

app.post('/v1/users/:id/events', async (request, reply) => {
  // TODO: key the record by the user id instead of \`event.email\`, keep the address and the number
  // out of the payload (\`kind\` and \`reason\` only), set \`idempotent: true\` and \`acks: -1\` on the
  // producer, reject kinds outside created/verified/suspended, and commit the account write before
  // the produce is acknowledged.
  const userId = (request.params as {id: string}).id;
  const event = request.body as LifecycleEvent;
  const body = {kind: event.kind, reason: event.reason, email: event.email, phone: event.phone};
  await producer.send({
    topic: 'identity.event',
    messages: [{key: event.email, value: JSON.stringify(body)}],
  });
  await store.commitState(userId, event.kind);
  return reply.code(202).send({accepted: true});
});
`,
      solution: `/** identity.event: one lifecycle event per committed account change, keyed by the user id. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'identity', brokers: ['kafka:9092']});
// Idempotence plus acks=-1: a retried produce of the same record is a no-op, and the broker
// acknowledges only once every in-sync replica holds it.
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const IDENTITY_EVENT_TOPIC = 'identity.event';
const LIFECYCLE_EVENTS = ['created', 'verified', 'suspended'] as const;
// The topic is retained and replicated: the payload contract is exactly these two fields.
const ALLOWED_EVENT_FIELDS = ['kind', 'reason'] as const;

interface LifecycleEvent {
  kind: string;
  reason: string;
}

function assertLifecycleEvent(kind: string): void {
  if (!(LIFECYCLE_EVENTS as readonly string[]).includes(kind)) {
    throw new Error(\`unknown lifecycle event: \${kind}\`);
  }
}

function eventPayload(event: LifecycleEvent): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const field of ALLOWED_EVENT_FIELDS) fields[field] = event[field];
  return fields;
}

app.post('/v1/users/:id/events', async (request, reply) => {
  const userId = (request.params as {id: string}).id;
  const event = request.body as LifecycleEvent;
  assertLifecycleEvent(event.kind);
  // The account write is committed first: only a state the database holds may be announced.
  await store.commitState(userId, event.kind);
  await producer.send({
    topic: IDENTITY_EVENT_TOPIC,
    acks: -1,
    messages: [{key: userId, value: JSON.stringify(eventPayload(event))}],
  });
  return reply.code(202).send({accepted: true});
});
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

// identity.event: a model-generated draft that keys by the address and acks before the commit.
var eventWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "identity.event"}

// AccountStore is the accounts table; CommitState writes the row and commits the transaction.
type AccountStore struct{}

func (s *AccountStore) CommitState(ctx context.Context, userID string, state string) error {
	return nil
}

var store = &AccountStore{}

type lifecycleEvent struct {
	Kind   string \`json:"kind"\`
	Reason string \`json:"reason"\`
	Email  string \`json:"email"\`
	Phone  string \`json:"phone"\`
}

func recordEvent(rw http.ResponseWriter, r *http.Request) {
	// TODO: key the record by the user id instead of the address, keep the address and the number
	// out of the payload (kind and reason only), configure RequiredAcks: kafka.RequireAll with a
	// &kafka.Hash{} balancer, reject kinds outside created/verified/suspended, and commit the
	// account write before the writer acknowledges the record.
	userID := r.PathValue("user_id")
	event := lifecycleEvent{}
	_ = json.NewDecoder(r.Body).Decode(&event)
	payload, _ := json.Marshal(map[string]any{
		"kind":   event.Kind,
		"reason": event.Reason,
		"email":  event.Email,
		"phone":  event.Phone,
	})
	_ = eventWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(event.Email), Value: payload})
	_ = store.CommitState(r.Context(), userID, event.Kind)
	rw.WriteHeader(http.StatusAccepted)
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

// identity.event: one lifecycle event per committed account change, keyed by the user id.
const identityEventTopic = "identity.event"

// RequiredAcks=RequireAll with a hashed balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and a retried record with
// the same key lands on the same partition instead of duplicating across them.
var eventWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        identityEventTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var lifecycleEvents = []string{"created", "verified", "suspended"}

// allowedEventFields is the complete payload contract: a lifecycle kind and a reason code.
var allowedEventFields = []string{"kind", "reason"}

// AccountStore is the accounts table; CommitState writes the row and commits the transaction.
type AccountStore struct{}

func (s *AccountStore) CommitState(ctx context.Context, userID string, state string) error {
	return nil
}

var store = &AccountStore{}

type lifecycleEvent struct {
	Kind   string \`json:"kind"\`
	Reason string \`json:"reason"\`
}

func validateKind(kind string) error {
	if !slices.Contains(lifecycleEvents, kind) {
		return fmt.Errorf("unknown lifecycle event %q", kind)
	}
	return nil
}

// eventPayload projects the event onto the allow-list, so a field added to the struct one day
// cannot leak onto a topic that is retained and replicated for days.
func eventPayload(event lifecycleEvent) ([]byte, error) {
	body, err := json.Marshal(map[string]any{"kind": event.Kind, "reason": event.Reason})
	if err != nil {
		return nil, err
	}
	var fields map[string]any
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	for field := range fields {
		if !slices.Contains(allowedEventFields, field) {
			return nil, fmt.Errorf("field %q is not allowed on %s", field, identityEventTopic)
		}
	}
	return body, nil
}

func recordEvent(rw http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("user_id")
	event := lifecycleEvent{}
	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	if err := validateKind(event.Kind); err != nil {
		http.Error(rw, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	// The account write is committed first: only a state the database holds may be announced.
	if err := store.CommitState(r.Context(), userID, event.Kind); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	payload, err := eventPayload(event)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := eventWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(userID), Value: payload}); err != nil {
		http.Error(rw, err.Error(), http.StatusBadGateway)
		return
	}
	rw.WriteHeader(http.StatusAccepted)
}
`,
    },
    scala: {
      starter: `import java.sql.Connection
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

// identity.event: a model-generated draft that keys by the address and acks before the commit.
object Events {
  private val producer = new KafkaProducer[String, String](new Properties())

  val route: Route =
    path("v1" / "users" / Segment / "events") { userId =>
      post {
        entity(as[String]) { bodyText =>
          // TODO: key the record by userId instead of the address, keep the address and the number
          // out of the payload (kind and reason only), configure the producer with
          // enable.idempotence and acks=all, reject kinds outside created/verified/suspended, and
          // commit the account write before the send is acknowledged.
          val body = bodyText.parseJson.asJsObject.fields
          val kind = body("kind").convertTo[String]
          val reason = body("reason").convertTo[String]
          val email = body("email").convertTo[String]
          val payload =
            Map("kind" -> kind, "reason" -> reason, "email" -> email).toJson.compactPrint
          producer.send(new ProducerRecord("identity.event", email, payload))
          val conn: Connection = Accounts.connect()
          val stmt = conn.prepareStatement("UPDATE accounts SET state = ? WHERE id = ?")
          stmt.setString(1, kind)
          stmt.setString(2, userId)
          stmt.executeUpdate()
          conn.commit()
          conn.close()
          complete(StatusCodes.Accepted)
        }
      }
    }
}
`,
      solution: `import java.sql.Connection
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

// identity.event: one lifecycle event per committed account change, keyed by the user id.
object Events {
  private val IdentityEventTopic = "identity.event"

  private val LifecycleEvents = List("created", "verified", "suspended")

  // The topic is retained and replicated: the payload contract is exactly these two fields.
  private val AllowedEventFields = List("kind", "reason")

  // Idempotence plus acks=all: a retried produce of the same record is a no-op, and the broker
  // acknowledges only once every in-sync replica holds it.
  private val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  private def eventPayload(kind: String, reason: String): String = {
    val fields = Map("kind" -> kind, "reason" -> reason)
    val leaked = fields.keySet -- AllowedEventFields
    require(leaked.isEmpty, s"fields not allowed on $IdentityEventTopic: $leaked")
    fields.toJson.compactPrint
  }

  private def assertLifecycleEvent(kind: String): Unit =
    // The topic speaks a closed vocabulary; a typo must never reach a consumer.
    if (!LifecycleEvents.contains(kind)) {
      throw new IllegalArgumentException(s"unknown lifecycle event: $kind")
    }

  val route: Route =
    path("v1" / "users" / Segment / "events") { userId =>
      post {
        entity(as[String]) { bodyText =>
          val body = bodyText.parseJson.asJsObject.fields
          val kind = body("kind").convertTo[String]
          val reason = body("reason").convertTo[String]
          assertLifecycleEvent(kind)
          // The account write is committed first: only a state the database holds may be announced.
          val conn: Connection = Accounts.connect()
          try {
            val stmt = conn.prepareStatement("UPDATE accounts SET state = ? WHERE id = ?")
            stmt.setString(1, kind)
            stmt.setString(2, userId)
            stmt.executeUpdate()
            conn.commit()
          } finally conn.close()
          producer.send(new ProducerRecord(IdentityEventTopic, userId, eventPayload(kind, reason)))
          complete(StatusCodes.Accepted)
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

// identity.event: a model-generated draft that keys by the address and acks before the commit.
struct User {
  std::string id;
  std::string email;
  std::string phone;
};

struct AccountStore {
  // UPDATE accounts SET state = ? WHERE id = ? inside one transaction, then commit.
  void commitState(const std::string& userId, const std::string& state);
};

AccountStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: key the record by user.id instead of user.email, keep the address and the number out of
// the payload (kind and reason only), set enable.idempotence and acks=all on the producer, reject
// kinds outside created/verified/suspended, and commit the account write before the produce is
// acknowledged.
void recordEvent(const User& user, const std::string& kind, const std::string& reason) {
  const json event = {{"kind", kind}, {"reason", reason}, {"email", user.email}, {"phone", user.phone}};
  const auto payload = event.dump();
  producer->produce(
      "identity.event",
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      user.email.data(),
      user.email.size(),
      0,
      nullptr);
  producer->flush(2000);
  store.commitState(user.id, kind);
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

// identity.event: one lifecycle event per committed account change, keyed by the user id.
const std::string kIdentityEventTopic = "identity.event";

const std::vector<std::string> kLifecycleEvents = {"created", "verified", "suspended"};

// The topic is retained and replicated: the payload contract is exactly these two fields.
const std::vector<std::string> kAllowedEventFields = {"kind", "reason"};

struct User {
  std::string id;
};

struct AccountStore {
  // UPDATE accounts SET state = ? WHERE id = ? inside one transaction, then commit.
  void commitState(const std::string& userId, const std::string& state);
};

AccountStore store;

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

void assertLifecycleEvent(const std::string& kind) {
  // The topic speaks a closed vocabulary; a typo must never reach a consumer.
  if (std::find(kLifecycleEvents.begin(), kLifecycleEvents.end(), kind) == kLifecycleEvents.end()) {
    throw std::invalid_argument("unknown lifecycle event: " + kind);
  }
}

// Projects the event onto the allow-list, so a field added to the event one day cannot leak onto a
// topic that is retained and replicated for days.
std::string eventPayload(const json& event) {
  for (const auto& [field, value] : event.items()) {
    if (std::find(kAllowedEventFields.begin(), kAllowedEventFields.end(), field) == kAllowedEventFields.end()) {
      throw std::invalid_argument("field not allowed on " + kIdentityEventTopic + ": " + field);
    }
  }
  return event.dump();
}

// POST /v1/users/{id}/events: commit the account change, then announce it.
void recordEvent(const User& user, const std::string& kind, const std::string& reason) {
  assertLifecycleEvent(kind);
  // The account write is committed first: only a state the database holds may be announced.
  store.commitState(user.id, kind);
  const json event = {{"kind", kind}, {"reason", reason}};
  const auto payload = eventPayload(event);
  const auto err = producer->produce(
      kIdentityEventTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      user.id.data(),
      user.id.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    throw std::runtime_error(RdKafka::err2str(err));
  }
  producer->flush(2000);
}
`,
    },
  },
  debrief: `The interviewer is checking whether the event stream is a contract or a copy of the request. The key is the first contract: a Kafka key chooses the partition, so keying by the user id keeps one account's created → verified → suspended sequence in one partition and in order, while keying by the email address puts the ordering at the mercy of a handle the account can change — and the address at the mercy of the topic's retention. The payload is the second: the topic is replicated and retained for days, so anything written there outlives every delete the accounts table performs. The fix is not "remember not to add the address" but an allow-list the code projects through, so a field added to the request model one day fails at the boundary rather than leaking quietly. The third contract is ordering between the two systems: a produce is durable and immediate, a database commit can still roll back, so publishing first announces a state that may never exist — commit, then produce, and let a failed transaction reach the caller instead of the topic. Idempotence with acks=all is the producer-side half: without it a retry after a timeout can duplicate a lifecycle event a consumer counts. Closing the kind vocabulary keeps consumers' switch statements honest. Real platforms add a schema registry so producers and consumers agree on the payload shape, an outbox row when the broker is unreachable so a committed change is not lost, and a consumer-side dedupe on (user id, kind, version) for the at-least-once handoff the broker still gives.`,
};
