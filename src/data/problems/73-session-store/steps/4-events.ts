import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Session events: keyed by user, hashed tokens, committed first',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'redis', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter opens a session and announces it: \`open_session(user_id,
device_class, token)\` mints an id, produces \`{type: "session.created", session_id, user_id,
device_class, token}\` to \`session.event\` keyed by the session id with a producer at \`acks=1\`,
does not wait for the delivery report, then writes the session with \`store.put_session\` and
answers \`{session_id, published: true}\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** One user's events land on two partitions and the audit consumer
applies them out of order. The topic, retained and replicated, holds live tokens. A consumer reads
about a session the store does not have yet. A lost acknowledgement writes the event twice, a
failover loses it, and a broker that refuses it or never answers loses it for good.

- The record key is the **user id**.
- The payload carries \`token_hash\` (\`store.token_hash\`), never the token.
- \`store.put_session\` first, then the produce.
- The producer is idempotent with \`acks=all\` (Go uses confluent-kafka-go: kafka-go has no
  idempotent producer).
- Wait for the delivery report at most 2 s; on a failure or no report, \`store.outbox_add(topic,
  key, payload)\` and answer \`published: false\`.`,
  sequence: {
    participants: ['Session API', 'Session store', 'session.event', 'Outbox'],
    messages: [
      {from: 'Session API', to: 'Session store', label: 'put_session(id, user, device, token)', kind: 'sync'},
      {from: 'Session API', to: 'session.event', label: 'produce key = user_id · token_hash · acks=all', kind: 'sync'},
      {from: 'session.event', to: 'Session API', label: 'delivery report within 2 s → published', kind: 'reply'},
      {from: 'session.event', to: 'Session API', label: 'error / no report', kind: 'reply'},
      {from: 'Session API', to: 'Outbox', label: 'outbox_add(topic, key, payload) → published: false', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'user-key',
      title: 'Keys session.event by the user id',
      detail:
        "Events for u-1, u-2, u-1 carry those keys and the two u-1 events share a partition. The starter keys by the session id, which changes at every login, so one user's history spreads over every partition.",
      match: {
        python: {all: [/key\s*=\s*user_id/], none: [/key\s*=\s*session_id/]},
        typescript: {all: [/key:\s*userId\b/], none: [/key:\s*sessionId\b/]},
        go: {all: [/Key:\s*\[\]byte\(userID\)/], none: [/Key:\s*\[\]byte\(sessionID\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*userId/], none: [/Topic,\s*sessionId/]},
        cpp: {all: [/user_id\.c_str\(\),\s*user_id\.size\(\)/], none: [/session_id\.c_str\(\)/]},
      },
    },
    {
      id: 'hashed-token',
      title: 'The event carries a token hash, never the token',
      detail:
        'The record value carries `token_hash` (the SHA-256 the store keeps) with the session id, user id and device class, and the token itself appears nowhere in it. The starter publishes the token.',
      match: {
        python: {all: [/token_hash/], none: [/["']token["']\s*:/]},
        typescript: {all: [/token_hash/], none: [/[{,]\s*token\s*[,}]/]},
        go: {all: [/"token_hash"/], none: [/"token":\s*token/]},
        scala: {all: [/"token_hash"/], none: [/"token"\s*->/]},
        cpp: {all: [/"token_hash"/], none: [/\{"token",\s*token\}/]},
      },
    },
    {
      id: 'record-first',
      title: 'Commits the session before producing its event',
      detail:
        "When the session enters the user's set the topic is still empty: the event follows the commit. The starter produces first.",
      match: {
        python: {order: [/store\.put_session\(/, /producer\.produce\(/]},
        typescript: {order: [/\bputSession\(/, /producer\.send\(/]},
        go: {order: [/store\.PutSession\(/, /producer\.Produce\(/]},
        scala: {order: [/Store\.putSession\(/, /producer\.send\(/]},
        cpp: {order: [/store::putSession\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'An idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the payload, and the call answers `published: false`. The starter fires and forgets.',
      match: {
        python: {all: [/store\.outbox_add\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/\boutboxAdd\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.OutboxAdd\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.outboxAdd\(/, /\.get\(\s*[^\n]*TimeUnit/, /Failure|catch|isFailure/]},
        cpp: {all: [/store::outboxAdd\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from sessions import store  # new_session_id, put_session, token_hash, outbox_add

TOPIC = "session.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(session_id: str, user_id: str, device_class: str, token: str) -> dict:
    return {"type": "session.created", "session_id": session_id, "user_id": user_id, "device_class": device_class, "token": token}


def open_session(user_id: str, device_class: str, token: str) -> dict:
    """Open a session for a completed login and announce it on session.event."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    session_id = store.new_session_id()
    payload = event_payload(session_id, user_id, device_class, token)
    producer.produce(TOPIC, key=session_id, value=json.dumps(payload))
    producer.poll(0)
    store.put_session(session_id, user_id, device_class, token)
    return {"session_id": session_id, "published": True}
`,
      solution: `import json

from confluent_kafka import Producer

from sessions import store  # new_session_id, put_session, token_hash, outbox_add

TOPIC = "session.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def event_payload(session_id: str, user_id: str, device_class: str, token: str) -> dict:
    """What a consumer needs to correlate the session; the hash, never the credential."""
    return {
        "type": "session.created",
        "session_id": session_id,
        "user_id": user_id,
        "device_class": device_class,
        "token_hash": store.token_hash(token),
    }


def open_session(user_id: str, device_class: str, token: str) -> dict:
    """Open a session for a completed login, then announce it on session.event."""
    session_id = store.new_session_id()
    # The session exists before anyone hears about it.
    store.put_session(session_id, user_id, device_class, token)
    payload = event_payload(session_id, user_id, device_class, token)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    # One user's events share a partition, so the audit trail reads them in order.
    producer.produce(TOPIC, key=user_id, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the audit trail is late, not wrong.
        store.outbox_add(TOPIC, user_id, payload)
        return {"session_id": session_id, "published": False}
    return {"session_id": session_id, "published": True}
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {newSessionId, outboxAdd, putSession, tokenHash} from 'sessions/store';

export const TOPIC = 'session.event';

const kafka = new Kafka({clientId: 'sessiond', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export function eventPayload(sessionId: string, userId: string, deviceClass: string, token: string) {
  return {type: 'session.created', session_id: sessionId, user_id: userId, device_class: deviceClass, token};
}

/** Open a session for a completed login and announce it on session.event. */
export async function openSession(userId: string, deviceClass: string, token: string): Promise<{session_id: string; published: boolean}> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const sessionId = newSessionId();
  const payload = eventPayload(sessionId, userId, deviceClass, token);
  void producer.send({topic: TOPIC, messages: [{key: sessionId, value: JSON.stringify(payload)}], acks: 1});
  await putSession(sessionId, userId, deviceClass, token);
  return {session_id: sessionId, published: true};
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {newSessionId, outboxAdd, putSession, tokenHash} from 'sessions/store';

export const TOPIC = 'session.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'sessiond', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What a consumer needs to correlate the session; the hash, never the credential. */
export function eventPayload(sessionId: string, userId: string, deviceClass: string, token: string) {
  return {type: 'session.created', session_id: sessionId, user_id: userId, device_class: deviceClass, token_hash: tokenHash(token)};
}

/** Open a session for a completed login, then announce it on session.event. */
export async function openSession(userId: string, deviceClass: string, token: string): Promise<{session_id: string; published: boolean}> {
  const sessionId = newSessionId();
  // The session exists before anyone hears about it.
  await putSession(sessionId, userId, deviceClass, token);
  const payload = eventPayload(sessionId, userId, deviceClass, token);
  try {
    // One user's events share a partition, so the audit trail reads them in order; acks: -1 (all).
    await producer.send({topic: TOPIC, messages: [{key: userId, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return {session_id: sessionId, published: true};
  } catch {
    // The broker did not take it: the relay publishes the row later, so the audit trail is late, not wrong.
    await outboxAdd(TOPIC, userId, payload);
    return {session_id: sessionId, published: false};
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

	"sessions/store" // store.NewSessionID, PutSession, TokenHash, OutboxAdd
)

const topic = "session.event"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func eventPayload(sessionID, userID, deviceClass, token string) map[string]any {
	return map[string]any{"type": "session.created", "session_id": sessionID, "user_id": userID, "device_class": deviceClass, "token": token}
}

// openSession opens a session for a completed login and announces it on session.event: the new id, and whether the event went out.
func openSession(ctx context.Context, userID, deviceClass, token string) (string, bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	sessionID := store.NewSessionID()
	value, _ := json.Marshal(eventPayload(sessionID, userID, deviceClass, token))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(sessionID), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return "", false, err
	}
	if err := store.PutSession(ctx, sessionID, userID, deviceClass, token); err != nil {
		return "", false, err
	}
	return sessionID, true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"sessions/store" // store.NewSessionID, PutSession, TokenHash, OutboxAdd
)

const (
	topic      = "session.event"
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

// eventPayload is what a consumer needs to correlate the session; the hash, never the credential.
func eventPayload(sessionID, userID, deviceClass, token string) map[string]any {
	return map[string]any{"type": "session.created", "session_id": sessionID, "user_id": userID, "device_class": deviceClass, "token_hash": store.TokenHash(token)}
}

// openSession opens a session for a completed login, then announces it on session.event: the new id, and whether the event went out.
func openSession(ctx context.Context, userID, deviceClass, token string) (string, bool, error) {
	sessionID := store.NewSessionID()
	// The session exists before anyone hears about it.
	if err := store.PutSession(ctx, sessionID, userID, deviceClass, token); err != nil {
		return "", false, err
	}
	payload := eventPayload(sessionID, userID, deviceClass, token)
	value, _ := json.Marshal(payload)
	t := topic
	// One user's events share a partition, so the audit trail reads them in order.
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(userID), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so the audit trail is late, not wrong.
		if err := store.OutboxAdd(ctx, topic, userID, payload); err != nil {
			return sessionID, false, err
		}
		return sessionID, false, nil
	}
	return sessionID, true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import sessions.Store // Store.newSessionId, putSession, tokenHash, outboxAdd

object SessionEvents {
  final case class Opened(sessionId: String, published: Boolean)

  val Topic = "session.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventPayload(sessionId: String, userId: String, deviceClass: String, token: String): JsObject =
    JsObject("type" -> JsString("session.created"), "session_id" -> JsString(sessionId), "user_id" -> JsString(userId),
      "device_class" -> JsString(deviceClass), "token" -> JsString(token))

  /** Open a session for a completed login and announce it on session.event. */
  def openSession(userId: String, deviceClass: String, token: String): Opened = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val sessionId = Store.newSessionId()
    val payload = eventPayload(sessionId, userId, deviceClass, token)
    producer.send(new ProducerRecord[String, String](Topic, sessionId, payload.compactPrint))
    Store.putSession(sessionId, userId, deviceClass, token)
    Opened(sessionId, published = true)
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import sessions.Store // Store.newSessionId, putSession, tokenHash, outboxAdd

object SessionEvents {
  final case class Opened(sessionId: String, published: Boolean)

  val Topic = "session.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What a consumer needs to correlate the session; the hash, never the credential. */
  def eventPayload(sessionId: String, userId: String, deviceClass: String, token: String): JsObject =
    JsObject("type" -> JsString("session.created"), "session_id" -> JsString(sessionId), "user_id" -> JsString(userId),
      "device_class" -> JsString(deviceClass), "token_hash" -> JsString(Store.tokenHash(token)))

  /** Open a session for a completed login, then announce it on session.event. */
  def openSession(userId: String, deviceClass: String, token: String): Opened = {
    val sessionId = Store.newSessionId()
    // The session exists before anyone hears about it.
    Store.putSession(sessionId, userId, deviceClass, token)
    val payload = eventPayload(sessionId, userId, deviceClass, token)
    // One user's events share a partition, so the audit trail reads them in order.
    val record = new ProducerRecord[String, String](Topic, userId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the audit trail is late, not wrong.
      Store.outboxAdd(Topic, userId, payload)
    }
    Opened(sessionId, published = acked.isSuccess)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "sessions/store.h"  // store::newSessionId, putSession, tokenHash, outboxAdd

using json = nlohmann::json;

const std::string kTopic = "session.event";

struct Opened {
  std::string session_id;
  bool published = false;
};

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventPayload(const std::string& session_id, const std::string& user_id, const std::string& device_class, const std::string& token) {
  return json{{"type", "session.created"}, {"session_id", session_id}, {"user_id", user_id}, {"device_class", device_class}, {"token", token}};
}

// Open a session for a completed login and announce it on session.event.
Opened openSession(const std::string& user_id, const std::string& device_class, const std::string& token) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string session_id = store::newSessionId();
  const std::string value = eventPayload(session_id, user_id, device_class, token).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    session_id.c_str(), session_id.size(), 0, nullptr);
  producer->poll(0);
  store::putSession(session_id, user_id, device_class, token);
  return Opened{session_id, true};
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "sessions/store.h"  // store::newSessionId, putSession, tokenHash, outboxAdd

using json = nlohmann::json;

const std::string kTopic = "session.event";
constexpr int kAckTimeoutMs = 2000;

struct Opened {
  std::string session_id;
  bool published = false;
};

// The delivery report of the record in flight: openSession produces one record and waits for it.
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

// What a consumer needs to correlate the session; the hash, never the credential.
json eventPayload(const std::string& session_id, const std::string& user_id, const std::string& device_class, const std::string& token) {
  return json{{"type", "session.created"}, {"session_id", session_id}, {"user_id", user_id}, {"device_class", device_class}, {"token_hash", store::tokenHash(token)}};
}

// Open a session for a completed login, then announce it on session.event.
Opened openSession(const std::string& user_id, const std::string& device_class, const std::string& token) {
  const std::string session_id = store::newSessionId();
  // The session exists before anyone hears about it.
  store::putSession(session_id, user_id, device_class, token);
  const json payload = eventPayload(session_id, user_id, device_class, token);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  // One user's events share a partition, so the audit trail reads them in order.
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), user_id.c_str(), user_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the audit trail is late, not wrong.
    store::outboxAdd(kTopic, user_id, payload);
    return Opened{session_id, false};
  }
  return Opened{session_id, true};
}
`,
    },
  },
  harness: {
    python: `import json

from sessions import store

TOPIC = "session.event"


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_user_key(ctx):
    m = ctx.load("events")
    m.open_session("u-1", "mobile", "tok-1")
    m.open_session("u-2", "desktop", "tok-2")
    m.open_session("u-1", "desktop", "tok-3")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three open_session calls produced {len(records)} records on session.event (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"u-1", b"u-2", b"u-1"], f"the records are keyed {keys}, expected the user ids u-1, u-2, u-1"
    assert records[0].partition == records[2].partition, "both u-1 events must land on one partition, or the audit trail reads one user's sessions out of order"


def check_hashed_token(ctx):
    m = ctx.load("events")
    opened = m.open_session("u-1", "mobile", "tok-secret-1")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one open_session produced {len(records)} records"
    raw = records[0].value
    assert b"tok-secret-1" not in raw, f"the event carries the token itself: {raw.decode()}. A retained, replicated topic holding tokens is a credential store"
    value = json.loads(raw)
    assert value.get("token_hash") == store.token_hash("tok-secret-1"), f"the payload's token_hash is {value.get('token_hash')!r}, expected store.token_hash of the token"
    assert value.get("session_id") == opened["session_id"] and value.get("user_id") == "u-1" and value.get("device_class") == "mobile", f"the payload is {value}, expected the session id, user id and device class"


def check_record_first(ctx):
    m = ctx.load("events")
    probe = ctx.redis_after("user:u-1:sessions", lambda: len(ctx.kafka.records(TOPIC)))
    opened = m.open_session("u-1", "mobile", "tok-1")
    assert probe.fired, "open_session never committed the session (nothing entered user:u-1:sessions)"
    assert probe.result == 0, f"when the session was committed the topic already held {probe.result} record(s): a consumer could read about a session the store does not have. Commit first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the commit"
    assert store.read_session(opened["session_id"]) is not None, "the session must be in the store"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.open_session("u-1", "mobile", "tok-1")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.open_session("u-1", "mobile", "tok-2")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    opened = m.open_session("u-1", "mobile", "tok-1")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the session is missing from the audit trail for good"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "u-1" and rows[0].get("payload", {}).get("session_id") == opened["session_id"], f"the outbox row is {rows[0]}, expected the topic, the key u-1 and the payload"
    assert opened.get("published") is False, f"open_session answered {opened} after a failed delivery, expected published: False"
    assert store.read_session(opened["session_id"]) is not None, "the session must stay committed when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    stalled = m.open_session("u-1", "mobile", "tok-2")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"open_session waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("session_id") == stalled["session_id"], f"no delivery report within the window and the outbox holds {rows}"
    assert stalled.get("published") is False, f"open_session answered {stalled} without a delivery report, expected published: False"
`,
    typescript: `const TOPIC = 'session.event';

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const setup = ctx => ({m: ctx.load('events'), store: ctx.load('/support/sessions/store.ts')});

export async function check_user_key(ctx) {
  const {m} = setup(ctx);
  await m.openSession('u-1', 'mobile', 'tok-1');
  await m.openSession('u-2', 'desktop', 'tok-2');
  await m.openSession('u-1', 'desktop', 'tok-3');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three openSession calls produced \${records.length} records on session.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['u-1', 'u-2', 'u-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the user ids u-1, u-2, u-1\`);
  assert.equal(records[0].partition, records[2].partition, "both u-1 events must land on one partition, or the audit trail reads one user's sessions out of order");
}

export async function check_hashed_token(ctx) {
  const {m, store} = setup(ctx);
  const opened = await m.openSession('u-1', 'mobile', 'tok-secret-1');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one openSession produced \${values.length} records\`);
  assert(!values[0].includes('tok-secret-1'), \`the event carries the token itself: \${values[0]}. A retained, replicated topic holding tokens is a credential store\`);
  const value = JSON.parse(values[0]);
  assert.equal(value.token_hash, store.tokenHash('tok-secret-1'), \`the payload's token_hash is \${JSON.stringify(value.token_hash)}, expected tokenHash of the token\`);
  assert(value.session_id === opened.session_id && value.user_id === 'u-1' && value.device_class === 'mobile', \`the payload is \${values[0]}, expected the session id, user id and device class\`);
}

export async function check_record_first(ctx) {
  const {m, store} = setup(ctx);
  const probe = ctx.redisAfter('user:u-1:sessions', () => ctx.kafka.records(TOPIC).length);
  const opened = await m.openSession('u-1', 'mobile', 'tok-1');
  await settle();
  assert(probe.fired, 'openSession never committed the session (nothing entered user:u-1:sessions)');
  assert.equal(probe.result, 0, \`when the session was committed the topic already held \${probe.result} record(s): a consumer could read about a session the store does not have. Commit first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the commit');
  assert((await store.readSession(opened.session_id)) !== null, 'the session must be in the store');
}

export async function check_idempotent_producer(ctx) {
  const {m} = setup(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.openSession('u-1', 'mobile', 'tok-1');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.openSession('u-1', 'mobile', 'tok-2');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox(ctx) {
  const {m, store} = setup(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  const opened = await m.openSession('u-1', 'mobile', 'tok-1');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the session is missing from the audit trail for good\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'u-1' && rows[0].payload?.session_id === opened.session_id, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key u-1 and the payload\`);
  assert.equal(opened.published, false, \`openSession answered \${JSON.stringify(opened)} after a failed delivery, expected published: false\`);
  assert((await store.readSession(opened.session_id)) !== null, 'the session must stay committed when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  const stalled = await m.openSession('u-1', 'mobile', 'tok-2');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`openSession waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.session_id === stalled.session_id, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(stalled.published, false, \`openSession answered \${JSON.stringify(stalled)} without a delivery report, expected published: false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"leetbuild/harness"

	"sessions/store"
)

const eventsTopic = "session.event"

var bg = context.Background()

func open(ctx *harness.Ctx, userID, deviceClass, token string) (string, bool) {
	sessionID, published, err := openSession(bg, userID, deviceClass, token)
	ctx.NoError(err, "openSession")
	return sessionID, published
}

type outboxRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func outbox(ctx *harness.Ctx) []outboxRow {
	var rows []outboxRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row outboxRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckUserKey(ctx *harness.Ctx) {
	open(ctx, "u-1", "mobile", "tok-1")
	open(ctx, "u-2", "desktop", "tok-2")
	open(ctx, "u-1", "desktop", "tok-3")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three openSession calls must produce three records on session.event; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"u-1", "u-2", "u-1"}, "the records must be keyed by the user ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both u-1 events must land on one partition, or the audit trail reads one user's sessions out of order; the partitions")
}

func CheckHashedToken(ctx *harness.Ctx) {
	sessionID, _ := open(ctx, "u-1", "mobile", "tok-secret-1")
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one openSession must produce one record; the records")
	ctx.Assert(!strings.Contains(values[0], "tok-secret-1"), "the event carries the token itself: %s. A retained, replicated topic holding tokens is a credential store", values[0])
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	ctx.Equal(value["token_hash"], store.TokenHash("tok-secret-1"), "the payload's token_hash (store.TokenHash of the token)")
	ctx.Assert(value["session_id"] == sessionID && value["user_id"] == "u-1" && value["device_class"] == "mobile", "the payload is %s, expected the session id, user id and device class", values[0])
}

func CheckRecordFirst(ctx *harness.Ctx) {
	probe := ctx.Redis.After("user:u-1:sessions", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	sessionID, _ := open(ctx, "u-1", "mobile", "tok-1")
	ctx.Settle()
	ctx.Assert(probe.Fired, "openSession never committed the session (nothing entered user:u-1:sessions)")
	ctx.Equal(probe.Result, 0, "when the session was committed the topic already held records: a consumer could read about a session the store does not have. Commit first, then produce; the records at commit time")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the commit; the records")
	ctx.Assert(store.ReadSession(bg, sessionID) != nil, "the session must be in the store")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	open(ctx, "u-1", "mobile", "tok-1")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	open(ctx, "u-1", "mobile", "tok-2")
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	sessionID, published := open(ctx, "u-1", "mobile", "tok-1")
	ctx.Settle()
	rows := outbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the session is missing from the audit trail for good; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "u-1" && rows[0].Payload["session_id"] == sessionID, "the outbox row is %v, expected the topic, the key u-1 and the payload", rows[0])
	ctx.Equal(published, false, "openSession's published after a failed delivery")
	ctx.Assert(store.ReadSession(bg, sessionID) != nil, "the session must stay committed when only the produce failed")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	stalledID, published := open(ctx, "u-1", "mobile", "tok-2")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "openSession waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = outbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["session_id"] == stalledID, "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(published, false, "openSession's published without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "sessions/store.h"

namespace {

const std::string kEventsTopic = "session.event";

std::vector<nlohmann::json> outboxRows(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckUserKey(harness::Ctx& ctx) {
  openSession("u-1", "mobile", "tok-1");
  openSession("u-2", "desktop", "tok-2");
  openSession("u-1", "desktop", "tok-3");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three openSession calls must produce three records on session.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"u-1", "u-2", "u-1"}, "the records must be keyed by the user ids");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "both u-1 events must land on one partition, or the audit trail reads one user's sessions out of order; the partitions");
}

void CheckHashedToken(harness::Ctx& ctx) {
  const Opened opened = openSession("u-1", "mobile", "tok-secret-1");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one openSession must produce one record; the records");
  ctx.Assert(values[0].find("tok-secret-1") == std::string::npos,
             "the event carries the token itself: %s. A retained, replicated topic holding tokens is a credential store", values[0]);
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Equal(field(value, "token_hash"), store::tokenHash("tok-secret-1"), "the payload's token_hash (store::tokenHash of the token)");
  ctx.Assert(field(value, "session_id") == opened.session_id && field(value, "user_id") == "u-1" && field(value, "device_class") == "mobile",
             "the payload is %s, expected the session id, user id and device class", values[0]);
}

void CheckRecordFirst(harness::Ctx& ctx) {
  size_t atCommit = 999;
  bool fired = false;
  ctx.Redis.After("user:u-1:sessions", [&] {
    fired = true;
    atCommit = ctx.Kafka.Records(kEventsTopic).size();
  });
  const Opened opened = openSession("u-1", "mobile", "tok-1");
  ctx.Settle();
  ctx.Assert(fired, "openSession never committed the session (nothing entered user:u-1:sessions)");
  ctx.Equal(atCommit, 0,
            "when the session was committed the topic already held records: a consumer could read about a session the store does not have. "
            "Commit first, then produce; the records at commit time");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "the event must still be produced after the commit; the records");
  ctx.Assert(store::readSession(opened.session_id).has_value(), "the session must be in the store");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  openSession("u-1", "mobile", "tok-1");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  openSession("u-1", "mobile", "tok-2");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  const Opened opened = openSession("u-1", "mobile", "tok-1");
  ctx.Settle();
  auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the session is missing from the audit trail for good; the rows");
  ctx.Assert(field(rows[0], "topic") == kEventsTopic && field(rows[0], "key") == "u-1" && rows[0].contains("payload") &&
                 field(rows[0]["payload"], "session_id") == opened.session_id,
             "the outbox row is %s, expected the topic, the key u-1 and the payload", rows[0].dump());
  ctx.Equal(opened.published, false, "openSession's published after a failed delivery");
  ctx.Assert(store::readSession(opened.session_id).has_value(), "the session must stay committed when only the produce failed");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  const Opened stalled = openSession("u-1", "mobile", "tok-2");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "openSession waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && field(rows[1]["payload"], "session_id") == stalled.session_id,
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(stalled.published, false, "openSession's published without a delivery report");
}
`,
  },
  hints: [
    "Open two sessions for one user and one for another: the user's two events sit on different partitions. Read the topic: every token is there in clear. Fail the broker once: the event is gone and the call still says published.",
    'The key is the session id, new at every login; the payload copies `token`; the produce runs before `put_session`; nobody reads the delivery report, so failure looks like success; `acks=1` without idempotence duplicates on retry and loses on failover.',
    'Key by `user_id`, put `token_hash` in the payload, call `put_session` first, set `enable.idempotence` and `acks=all`, produce with an `on_delivery` callback, `flush(2)`, and on an error or an unflushed record call `outbox_add` and answer `published: False`.',
  ],
  debrief: `The key decides what stays ordered: Kafka orders per partition, and a user's session history (login, rotation, logout) only makes sense in order, so the key is the user id rather than a session id that changes at every rotation. A hash is enough for every consumer that correlates sessions, and a token in a retained, replicated topic outlives any revocation. Committing first makes the event a statement about something that exists; waiting for the delivery report gives \`published\` a meaning, and the outbox turns a broker outage into a delay. Production systems write the outbox row in the same transaction as the session and let a relay do every produce, and they key the hash with a server-side secret (HMAC), so a leaked topic cannot be checked against guessed tokens.`,
};
