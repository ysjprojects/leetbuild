import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Lifecycle events keyed by user, without contact data',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter produces the \`identity.event\` stream the rest of the platform
consumes: \`record_event(kind, user_id, reason)\` loads the account and produces one record with the
kind as \`type\`, the reason, and the account's email and name, keyed by the email;
\`change_status(user_id, expected, status, reason)\` records the event, then commits the change with
\`accounts.transition\` and answers the event, or \`None\` when the account was not in \`expected\`.
Verify an account and an event shows up; it hides five flaws.

**Failure mode the checks target.** An account that changes its address splits its history across
partitions; any typo becomes an event type; the address and the name sit in a retained topic;
consumers hear about changes that never committed; and a lost acknowledgement writes the event twice.

- The record key is the **user id**.
- \`type\` comes from \`EVENT_TYPES\` (\`created\` → \`identity.created\`, \`verified\` →
  \`identity.verified\`, \`suspended\` → \`identity.suspended\`); another kind is refused, unproduced.
- The payload is \`{type, user_id, reason}\`: no email, phone or name.
- \`change_status\` commits through \`accounts.transition\` first and produces only when it moved.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent: true\` with \`acks: -1\`; the Go
  step uses confluent-kafka-go, since kafka-go has no idempotent producer).`,
  sequence: {
    participants: ['identityd', 'accounts store', 'identity.event', 'Consumers'],
    messages: [
      {from: 'identityd', to: 'accounts store', label: 'transition(u-1, unverified → verified)', kind: 'sync'},
      {from: 'accounts store', to: 'identityd', label: 'moved', kind: 'reply'},
      {
        from: 'identityd',
        to: 'identity.event',
        label: 'produce · key u-1 · {type, user_id, reason} · acks all',
        kind: 'sync',
      },
      {from: 'identity.event', to: 'identityd', label: 'delivery report (once, idempotent on retry)', kind: 'reply'},
      {from: 'identity.event', to: 'Consumers', label: 'one partition per user, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'user-key',
      title: 'Keyed by user id',
      detail:
        "The record key is the user id (`key=user_id`, `key: userId`, `[]byte(userID)`, `ProducerRecord(topic, userId, …)`), so one account's events stay on one partition in order; the starter keys by the email, which the account can change.",
      match: {
        python: {all: [/key=user_id/, /identity\.event/], none: [/key=account/]},
        typescript: {all: [/key:\s*userId\b/, /identity\.event/], none: [/key:\s*account/]},
        go: {all: [/Key:\s*\[\]byte\(userID\)/, /identity\.event/], none: [/Key:\s*\[\]byte\(account/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(EventTopic,\s*userId/, /identity\.event/],
          none: [/EventTopic,\s*account/],
        },
        cpp: {
          all: [/user_id\.c_str\(\),\s*user_id\.(size|length)\(\)/, /identity\.event/],
          none: [/account->email\.c_str\(\)/],
        },
      },
    },
    {
      id: 'event-types',
      title: 'Event types come from one closed map',
      detail:
        '`EVENT_TYPES` maps `created`, `verified` and `suspended` to `identity.created`, `identity.verified` and `identity.suspended`, and an unknown kind is refused before anything is produced; the starter forwards whatever kind it was given.',
      match: {
        python: {
          all: [
            /EVENT_TYPES\s*=/,
            /identity\.created/,
            /identity\.verified/,
            /identity\.suspended/,
            /EVENT_TYPES\[kind\]/,
          ],
        },
        typescript: {
          all: [
            /EVENT_TYPES\s*[:=]/,
            /identity\.created/,
            /identity\.verified/,
            /identity\.suspended/,
            /EVENT_TYPES\[kind\]/,
          ],
        },
        go: {
          all: [
            /eventTypes\s*=/,
            /identity\.created/,
            /identity\.verified/,
            /identity\.suspended/,
            /eventTypes\[kind\]/,
          ],
        },
        scala: {
          all: [
            /EventTypes\s*[:=]/,
            /identity\.created/,
            /identity\.verified/,
            /identity\.suspended/,
            /EventTypes\.get\(kind\)|EventTypes\(kind\)/,
          ],
        },
        cpp: {
          all: [
            /kEventTypes\s*=/,
            /identity\.created/,
            /identity\.verified/,
            /identity\.suspended/,
            /kEventTypes\.find\(kind\)/,
          ],
        },
      },
    },
    {
      id: 'no-contact-pii',
      title: 'The payload carries no contact data',
      detail:
        'The payload is `type`, `user_id` and `reason`; the event function reads no account and writes no email, phone or name, because the topic is replicated and retained longer than any deletion request the account can make.',
      match: {
        python: {
          all: [/["']reason["']/],
          none: [/def record_event(?:(?!\ndef )[\s\S])*?(["'](email|phone|name)["']|get_account)/],
        },
        typescript: {
          all: [/reason/],
          none: [/function recordEvent(?:(?!\nexport )[\s\S])*?(\b(email|phone|name)\b|getAccount)/],
        },
        go: {
          all: [/"reason"/],
          none: [/func recordEvent(?:(?!\n\})[\s\S])*?(\.Email|\.Phone|\.Name|"email"|"name"|GetAccount)/],
        },
        scala: {
          all: [/"reason"/],
          none: [
            /def recordEvent(?:(?!\n {2}def |\n {2}\/\*\*)[\s\S])*?(\.email|\.phone|\.name|"email"|"name"|getAccount)/,
          ],
        },
        cpp: {all: [/"reason"/], none: [/json recordEvent(?:(?!\n\})[\s\S])*?(email|phone|->name|"name"|getAccount)/]},
      },
    },
    {
      id: 'commit-before-produce',
      title: 'Commits the status change before producing',
      detail:
        '`change_status` calls `accounts.transition` first and produces the event only when it moved the account, so consumers never hear about a change that did not commit; the starter produces first.',
      match: {
        python: {order: [/def change_status\(/, /accounts\.transition\(/, /record_event\(/]},
        typescript: {order: [/function changeStatus\(/, /transition\(/, /recordEvent\(/]},
        go: {order: [/func changeStatus\(/, /accounts\.Transition\(/, /recordEvent\(/]},
        scala: {order: [/def changeStatus\(/, /Accounts\.transition\(/, /recordEvent\(/]},
        cpp: {order: [/std::optional<json> changeStatus\(/, /accounts::transition\(/, /recordEvent\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer sets `enable.idempotence` with `acks=all` (kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the record once and a leader failover loses nothing; the starter runs with `acks=1`.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from identityd import accounts  # get_account, transition

EVENT_TOPIC = "identity.event"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("identity event not delivered: %s", err)


def record_event(kind: str, user_id: str, reason: str) -> dict:
    """One record on identity.event for a lifecycle change of the account."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    account = accounts.get_account(user_id) or {}
    payload = {
        "type": kind,
        "user_id": user_id,
        "reason": reason,
        "email": account.get("email"),  # the welcome mailer reads the address from the event
        "name": account.get("name"),
    }
    producer.produce(EVENT_TOPIC, key=account.get("email", user_id), value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload


def change_status(user_id: str, expected: str, status: str, reason: str) -> dict | None:
    """Move the account from expected to status and announce it; None when the account was not in expected."""
    event = record_event(status, user_id, reason)
    if not accounts.transition(user_id, expected, status):
        return None
    return event
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from identityd import accounts  # get_account, transition

EVENT_TOPIC = "identity.event"
EVENT_TYPES = {"created": "identity.created", "verified": "identity.verified", "suspended": "identity.suspended"}
log = logging.getLogger("events")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("identity event not delivered: %s", err)


def record_event(kind: str, user_id: str, reason: str) -> dict:
    """One record on identity.event for a lifecycle change of the account."""
    # The topic outlives every deletion request: it carries the id and a reason code, nothing to contact.
    payload = {"type": EVENT_TYPES[kind], "user_id": user_id, "reason": reason}
    producer.produce(EVENT_TOPIC, key=user_id, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload


def change_status(user_id: str, expected: str, status: str, reason: str) -> dict | None:
    """Move the account from expected to status and announce it; None when the account was not in expected."""
    # The change commits first: an event may lag the state, it may never precede it.
    if not accounts.transition(user_id, expected, status):
        return None
    return record_event(status, user_id, reason)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {getAccount, transition} from 'identityd/accounts';

export const EVENT_TOPIC = 'identity.event';

const kafka = new Kafka({clientId: 'identityd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One record on identity.event for a lifecycle change of the account. */
export async function recordEvent(kind: string, userId: string, reason: string): Promise<Record<string, unknown>> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const account = await getAccount(userId);
  // The welcome mailer reads the address from the event.
  const payload = {type: kind, user_id: userId, reason, email: account?.email, name: account?.name};
  await producer.send({topic: EVENT_TOPIC, messages: [{key: account?.email ?? userId, value: JSON.stringify(payload)}], acks: 1});
  return payload;
}

/** Move the account from expected to status and announce it; null when the account was not in expected. */
export async function changeStatus(userId: string, expected: string, status: string, reason: string): Promise<Record<string, unknown> | null> {
  const event = await recordEvent(status, userId, reason);
  if (!(await transition(userId, expected, status))) return null;
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {getAccount, transition} from 'identityd/accounts';

export const EVENT_TOPIC = 'identity.event';
export const EVENT_TYPES: Record<string, string> = {created: 'identity.created', verified: 'identity.verified', suspended: 'identity.suspended'};

const kafka = new Kafka({clientId: 'identityd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the record once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One record on identity.event for a lifecycle change of the account. */
export async function recordEvent(kind: string, userId: string, reason: string): Promise<Record<string, unknown>> {
  const type = EVENT_TYPES[kind];
  if (type === undefined) throw new Error(\`unknown event kind \${kind}\`);
  // The topic outlives every deletion request: it carries the id and a reason code, nothing to contact.
  const payload = {type, user_id: userId, reason};
  await producer.send({topic: EVENT_TOPIC, messages: [{key: userId, value: JSON.stringify(payload)}], acks: -1});
  return payload;
}

/** Move the account from expected to status and announce it; null when the account was not in expected. */
export async function changeStatus(userId: string, expected: string, status: string, reason: string): Promise<Record<string, unknown> | null> {
  // The change commits first: an event may lag the state, it may never precede it.
  if (!(await transition(userId, expected, status))) return null;
  return recordEvent(status, userId, reason);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"identityd/accounts" // accounts.GetAccount, Transition
)

const (
	eventTopic = "identity.event"
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

// recordEvent produces one record on identity.event for a lifecycle change of the account.
func recordEvent(ctx context.Context, kind, userID, reason string) (map[string]any, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	account, err := accounts.GetAccount(ctx, userID)
	if err != nil || account == nil {
		return nil, fmt.Errorf("no account %s: %v", userID, err)
	}
	// The welcome mailer reads the address from the event.
	payload := map[string]any{"type": kind, "user_id": userID, "reason": reason, "email": account.Email, "name": account.Name}
	value, _ := json.Marshal(payload)
	topic := eventTopic
	deliveries := make(chan kafka.Event, 1)
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(account.Email), Value: value}
	if err := producer.Produce(msg, deliveries); err != nil {
		return nil, err
	}
	select {
	case e := <-deliveries:
		if err := e.(*kafka.Message).TopicPartition.Error; err != nil {
			return nil, err
		}
	case <-time.After(ackTimeout):
		return nil, errors.New("no delivery report for the identity event")
	}
	return payload, nil
}

// changeStatus moves the account from expected to status and announces it; nil when the account was not in expected.
func changeStatus(ctx context.Context, userID, expected, status, reason string) (map[string]any, error) {
	event, err := recordEvent(ctx, status, userID, reason)
	if err != nil {
		return nil, err
	}
	moved, err := accounts.Transition(ctx, userID, expected, status)
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
	"errors"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"identityd/accounts" // accounts.GetAccount, Transition
)

const (
	eventTopic = "identity.event"
	ackTimeout = 2 * time.Second
)

var eventTypes = map[string]string{"created": "identity.created", "verified": "identity.verified", "suspended": "identity.suspended"}

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"enable.idempotence": true,  // a retry after a lost acknowledgement writes the record once
		"acks":               "all", // on every in-sync replica before the broker answers
	})
	if err != nil {
		panic(err)
	}
	return p
}

// recordEvent produces one record on identity.event for a lifecycle change of the account.
func recordEvent(ctx context.Context, kind, userID, reason string) (map[string]any, error) {
	eventType, known := eventTypes[kind]
	if !known {
		return nil, fmt.Errorf("unknown event kind %q", kind)
	}
	// The topic outlives every deletion request: it carries the id and a reason code, nothing to contact.
	payload := map[string]any{"type": eventType, "user_id": userID, "reason": reason}
	value, _ := json.Marshal(payload)
	topic := eventTopic
	deliveries := make(chan kafka.Event, 1)
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(userID), Value: value}
	if err := producer.Produce(msg, deliveries); err != nil {
		return nil, err
	}
	select {
	case e := <-deliveries:
		if err := e.(*kafka.Message).TopicPartition.Error; err != nil {
			return nil, err
		}
	case <-time.After(ackTimeout):
		return nil, errors.New("no delivery report for the identity event")
	}
	return payload, nil
}

// changeStatus moves the account from expected to status and announces it; nil when the account was not in expected.
func changeStatus(ctx context.Context, userID, expected, status, reason string) (map[string]any, error) {
	// The change commits first: an event may lag the state, it may never precede it.
	moved, err := accounts.Transition(ctx, userID, expected, status)
	if err != nil || !moved {
		return nil, err
	}
	return recordEvent(ctx, status, userID, reason)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import identityd.Accounts // Accounts.getAccount, transition

object Events {
  val EventTopic = "identity.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"identity event not delivered: \${exception.getMessage}")
  }

  /** One record on identity.event for a lifecycle change of the account. */
  def recordEvent(kind: String, userId: String, reason: String): JsObject = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val account = Accounts.getAccount(userId).getOrElse(throw new NoSuchElementException(s"no account $userId"))
    val payload = JsObject(
      "type" -> JsString(kind),
      "user_id" -> JsString(userId),
      "reason" -> JsString(reason),
      "email" -> JsString(account.email), // the welcome mailer reads the address from the event
      "name" -> JsString(account.name))
    producer.send(new ProducerRecord[String, String](EventTopic, account.email, payload.compactPrint), onDelivery).get()
    payload
  }

  /** Move the account from expected to status and announce it; None when the account was not in expected. */
  def changeStatus(userId: String, expected: String, status: String, reason: String): Option[JsObject] = {
    val event = recordEvent(status, userId, reason)
    if (Accounts.transition(userId, expected, status)) Some(event) else None
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import identityd.Accounts // Accounts.getAccount, transition

object Events {
  val EventTopic = "identity.event"
  val EventTypes: Map[String, String] = Map("created" -> "identity.created", "verified" -> "identity.verified", "suspended" -> "identity.suspended")

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"identity event not delivered: \${exception.getMessage}")
  }

  /** One record on identity.event for a lifecycle change of the account. */
  def recordEvent(kind: String, userId: String, reason: String): JsObject = {
    val eventType = EventTypes.get(kind).getOrElse(throw new IllegalArgumentException(s"unknown event kind $kind"))
    // The topic outlives every deletion request: it carries the id and a reason code, nothing to contact.
    val payload = JsObject("type" -> JsString(eventType), "user_id" -> JsString(userId), "reason" -> JsString(reason))
    producer.send(new ProducerRecord[String, String](EventTopic, userId, payload.compactPrint), onDelivery).get()
    payload
  }

  /** Move the account from expected to status and announce it; None when the account was not in expected. */
  def changeStatus(userId: String, expected: String, status: String, reason: String): Option[JsObject] =
    // The change commits first: an event may lag the state, it may never precede it.
    if (!Accounts.transition(userId, expected, status)) None
    else Some(recordEvent(status, userId, reason))
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

#include "identityd/accounts.h"  // accounts::getAccount, transition

using json = nlohmann::json;

const std::string kEventTopic = "identity.event";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "identity event not delivered: " << message.errstr() << "\\n";
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

// One record on identity.event for a lifecycle change of the account.
json recordEvent(const std::string& kind, const std::string& user_id, const std::string& reason) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const auto account = accounts::getAccount(user_id);
  if (!account) throw std::out_of_range("no account " + user_id);
  // The welcome mailer reads the address from the event.
  const json payload = {{"type", kind}, {"user_id", user_id}, {"reason", reason}, {"email", account->email}, {"name", account->name}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), account->email.c_str(), account->email.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}

// Move the account from expected to status and announce it; none when the account was not in expected.
std::optional<json> changeStatus(const std::string& user_id, const std::string& expected, const std::string& status,
                                 const std::string& reason) {
  const json event = recordEvent(status, user_id, reason);
  if (!accounts::transition(user_id, expected, status)) return std::nullopt;
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>

#include "identityd/accounts.h"  // accounts::getAccount, transition

using json = nlohmann::json;

const std::string kEventTopic = "identity.event";
const std::map<std::string, std::string> kEventTypes = {
    {"created", "identity.created"}, {"verified", "identity.verified"}, {"suspended", "identity.suspended"}};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "identity event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One record on identity.event for a lifecycle change of the account.
json recordEvent(const std::string& kind, const std::string& user_id, const std::string& reason) {
  const auto type = kEventTypes.find(kind);
  if (type == kEventTypes.end()) throw std::invalid_argument("unknown event kind " + kind);
  // The topic outlives every deletion request: it carries the id and a reason code, nothing to contact.
  const json payload = {{"type", type->second}, {"user_id", user_id}, {"reason", reason}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), user_id.c_str(), user_id.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}

// Move the account from expected to status and announce it; none when the account was not in expected.
std::optional<json> changeStatus(const std::string& user_id, const std::string& expected, const std::string& status,
                                 const std::string& reason) {
  // The change commits first: an event may lag the state, it may never precede it.
  if (!accounts::transition(user_id, expected, status)) return std::nullopt;
  return recordEvent(status, user_id, reason);
}
`,
    },
  },
  harness: {
    python: `import json

from identityd import accounts

TOPIC = "identity.event"


def _events(ctx):
    accounts.create_account("u-1", "ada@example.com", "+442079460958", "Ada Lovelace")
    return ctx.load("events")


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def _change(m, expected, status, reason):
    event = m.change_status("u-1", expected, status, reason)
    assert event is not None, f"change_status(u-1, {expected} → {status}) must commit and answer the event"
    return event


def check_user_key(ctx):
    m = _events(ctx)
    m.record_event("created", "u-1", "signup")
    _change(m, "unverified", "verified", "email_confirmed")
    _change(m, "verified", "suspended", "chargeback")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three events produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"u-1"] * 3, f"records must be keyed by the user id, got {keys}: keyed by the address, an account that changes it splits its history across partitions"
    partitions = {r.partition for r in records}
    assert len(partitions) == 1, f"u-1's events landed on partitions {sorted(partitions)}: one account's history must stay on one partition, in order"


def check_event_types(ctx):
    m = _events(ctx)
    m.record_event("created", "u-1", "signup")
    _change(m, "unverified", "verified", "email_confirmed")
    _change(m, "verified", "suspended", "chargeback")
    types = [_payload(r).get("type") for r in ctx.kafka.records(TOPIC)]
    assert types == ["identity.created", "identity.verified", "identity.suspended"], f"the three events carry types {types}, expected identity.created, identity.verified, identity.suspended"
    try:
        m.record_event("verifed", "u-1", "typo")
    except Exception:
        pass
    else:
        raise AssertionError("an unknown kind (verifed) must be refused, not forwarded as an event type")
    assert len(ctx.kafka.records(TOPIC)) == 3, "the refused kind still produced a record"


def check_no_contact_pii(ctx):
    m = _events(ctx)
    _change(m, "unverified", "verified", "email_confirmed")
    record = ctx.kafka.records(TOPIC)[0]
    payload = _payload(record)
    for name in ("email", "phone", "name"):
        assert name not in payload, f"the event carries the account's {name}: {payload}. The topic is retained and replicated; carry the user id and a reason code"
    text = record.value.decode() if isinstance(record.value, bytes) else str(record.value)
    for value in ("ada@example.com", "Ada Lovelace", "+442079460958"):
        assert value not in text, f"the event carries {value!r} under another name: {text}"
    assert payload == {"type": "identity.verified", "user_id": "u-1", "reason": "email_confirmed"}, f"the payload is {payload}, expected type, user_id and reason"


def check_commit_before_produce(ctx):
    m = _events(ctx)
    # The moment the status change commits, what is already on the topic.
    at_commit = ctx.redis_after("account:u-1", lambda: len(ctx.kafka.records(TOPIC)))
    _change(m, "unverified", "verified", "email_confirmed")
    assert at_commit.fired, "change_status never touched account:u-1"
    assert at_commit.result == 0, f"when the change committed the topic already held {at_commit.result} record(s): consumers heard about a change before it existed. Commit, then produce"
    assert accounts.get_account("u-1")["status"] == "verified", "the change did not commit"
    before = len(ctx.kafka.records(TOPIC))
    stale = m.change_status("u-1", "unverified", "suspended", "chargeback")
    assert stale is None, "a change whose expected status is stale must not commit and must answer None"
    assert len(ctx.kafka.records(TOPIC)) == before, "a change that did not commit produced an event anyway"


def check_idempotent_producer(ctx):
    m = _events(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    _change(m, "unverified", "verified", "email_confirmed")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one change whose acknowledgement was lost left {len(records)} records on the topic: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    _change(m, "verified", "suspended", "chargeback")
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the second event and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'identity.event';

async function events(ctx) {
  const accounts = ctx.load('/support/identityd/accounts.ts');
  await accounts.createAccount('u-1', 'ada@example.com', '+442079460958', 'Ada Lovelace');
  return {m: ctx.load('events'), accounts};
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

async function change(m, expected: string, status: string, reason: string) {
  const event = await m.changeStatus('u-1', expected, status, reason);
  assert(event !== null, \`changeStatus(u-1, \${expected} → \${status}) must commit and answer the event\`);
  return event;
}

export async function check_user_key(ctx) {
  const {m} = await events(ctx);
  await m.recordEvent('created', 'u-1', 'signup');
  await change(m, 'unverified', 'verified', 'email_confirmed');
  await change(m, 'verified', 'suspended', 'chargeback');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three events produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['u-1', 'u-1', 'u-1'], \`records must be keyed by the user id, got \${JSON.stringify(keys)}: keyed by the address, an account that changes it splits its history across partitions\`);
  const partitions = [...new Set(records.map(r => r.partition))];
  assert.equal(partitions.length, 1, \`u-1's events landed on partitions \${JSON.stringify(partitions)}: one account's history must stay on one partition, in order\`);
}

export async function check_event_types(ctx) {
  const {m} = await events(ctx);
  await m.recordEvent('created', 'u-1', 'signup');
  await change(m, 'unverified', 'verified', 'email_confirmed');
  await change(m, 'verified', 'suspended', 'chargeback');
  const types = ctx.kafka.records(TOPIC).map(r => payload(r).type);
  assert.deepStrictEqual(types, ['identity.created', 'identity.verified', 'identity.suspended'], \`the three events carry types \${JSON.stringify(types)}, expected identity.created, identity.verified, identity.suspended\`);
  await assert.rejects(m.recordEvent('verifed', 'u-1', 'typo'), 'an unknown kind (verifed) must be refused, not forwarded as an event type');
  assert.equal(ctx.kafka.records(TOPIC).length, 3, 'the refused kind still produced a record');
}

export async function check_no_contact_pii(ctx) {
  const {m} = await events(ctx);
  await change(m, 'unverified', 'verified', 'email_confirmed');
  const record = ctx.kafka.records(TOPIC)[0];
  const p = payload(record);
  for (const name of ['email', 'phone', 'name']) {
    assert(!(name in p), \`the event carries the account's \${name}: \${JSON.stringify(p)}. The topic is retained and replicated; carry the user id and a reason code\`);
  }
  const text = record.value.toString();
  for (const value of ['ada@example.com', 'Ada Lovelace', '+442079460958']) assert(!text.includes(value), \`the event carries \${value} under another name: \${text}\`);
  assert.deepStrictEqual(p, {type: 'identity.verified', user_id: 'u-1', reason: 'email_confirmed'}, \`the payload is \${text}, expected type, user_id and reason\`);
}

export async function check_commit_before_produce(ctx) {
  const {m, accounts} = await events(ctx);
  // The moment the status change commits, what is already on the topic.
  const atCommit = ctx.redisAfter('account:u-1', () => ctx.kafka.records(TOPIC).length);
  await change(m, 'unverified', 'verified', 'email_confirmed');
  assert(atCommit.fired, 'changeStatus never touched account:u-1');
  assert.equal(atCommit.result, 0, \`when the change committed the topic already held \${atCommit.result} record(s): consumers heard about a change before it existed. Commit, then produce\`);
  assert.equal((await accounts.getAccount('u-1')).status, 'verified', 'the change did not commit');
  const before = ctx.kafka.records(TOPIC).length;
  assert.equal(await m.changeStatus('u-1', 'unverified', 'suspended', 'chargeback'), null, 'a change whose expected status is stale must not commit and must answer null');
  assert.equal(ctx.kafka.records(TOPIC).length, before, 'a change that did not commit produced an event anyway');
}

export async function check_idempotent_producer(ctx) {
  const {m} = await events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await change(m, 'unverified', 'verified', 'email_confirmed');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one change whose acknowledgement was lost left \${records.length} records on the topic: the producer's retry wrote the event twice. Make the producer idempotent (acks all)\`);
  await change(m, 'verified', 'suspended', 'chargeback');
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the second event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"identityd/accounts"

	"leetbuild/harness"
)

const topic = "identity.event"

var eventsBg = context.Background()

func setupEvents(ctx *harness.Ctx) {
	_, err := accounts.CreateAccount(eventsBg, "u-1", "ada@example.com", "+442079460958", "Ada Lovelace")
	ctx.NoError(err, "CreateAccount(u-1) failed")
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func mustChange(ctx *harness.Ctx, expected, status, reason string) map[string]any {
	event, err := changeStatus(eventsBg, "u-1", expected, status, reason)
	ctx.NoError(err, "changeStatus(u-1, %s → %s) failed", expected, status)
	ctx.Assert(event != nil, "changeStatus(u-1, %s → %s) must commit and answer the event", expected, status)
	return event
}

func mustRecord(ctx *harness.Ctx, kind, reason string) {
	_, err := recordEvent(eventsBg, kind, "u-1", reason)
	ctx.NoError(err, "recordEvent(%q) failed", kind)
}

func CheckUserKey(ctx *harness.Ctx) {
	setupEvents(ctx)
	mustRecord(ctx, "created", "signup")
	mustChange(ctx, "unverified", "verified", "email_confirmed")
	mustChange(ctx, "verified", "suspended", "chargeback")
	ctx.Settle()
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 3, "three events must produce three records on %s; the records", topic)
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"u-1", "u-1", "u-1"}, "records must be keyed by the user id (keyed by the address, an account that changes it splits its history across partitions)")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "u-1's events landed on partitions %d, %d, %d: one account's history must stay on one partition, in order", records[0].Partition, records[1].Partition, records[2].Partition)
}

func CheckEventTypes(ctx *harness.Ctx) {
	setupEvents(ctx)
	mustRecord(ctx, "created", "signup")
	mustChange(ctx, "unverified", "verified", "email_confirmed")
	mustChange(ctx, "verified", "suspended", "chargeback")
	ctx.Settle()
	var types []string
	for _, r := range ctx.Kafka.Records(topic) {
		t, _ := payloadOf(ctx, r.Value)["type"].(string)
		types = append(types, t)
	}
	ctx.Equal(types, []string{"identity.created", "identity.verified", "identity.suspended"}, "the three events' types")
	_, err := recordEvent(eventsBg, "verifed", "u-1", "typo")
	ctx.Assert(err != nil, "an unknown kind (verifed) must be refused, not forwarded as an event type")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 3, "the refused kind must not produce a record; the records")
}

func CheckNoContactPii(ctx *harness.Ctx) {
	setupEvents(ctx)
	mustChange(ctx, "unverified", "verified", "email_confirmed")
	ctx.Settle()
	record := ctx.Kafka.Records(topic)[0]
	p := payloadOf(ctx, record.Value)
	for _, name := range []string{"email", "phone", "name"} {
		_, present := p[name]
		ctx.Assert(!present, "the event carries the account's %s: %v. The topic is retained and replicated; carry the user id and a reason code", name, p)
	}
	text := string(record.Value)
	for _, value := range []string{"ada@example.com", "Ada Lovelace", "+442079460958"} {
		ctx.Assert(!strings.Contains(text, value), "the event carries %q under another name: %s", value, text)
	}
	ctx.Equal(p, map[string]any{"type": "identity.verified", "user_id": "u-1", "reason": "email_confirmed"}, "the payload")
}

func CheckCommitBeforeProduce(ctx *harness.Ctx) {
	setupEvents(ctx)
	// The moment the status change commits, what is already on the topic.
	atCommit := ctx.Redis.After("account:u-1", func() any { return len(ctx.Kafka.Records(topic)) })
	mustChange(ctx, "unverified", "verified", "email_confirmed")
	ctx.Settle()
	ctx.Assert(atCommit.Fired, "changeStatus never touched account:u-1")
	ctx.Equal(atCommit.Result, 0, "when the change committed the topic already held records: consumers heard about a change before it existed. Commit, then produce; records at the commit")
	a, err := accounts.GetAccount(eventsBg, "u-1")
	ctx.NoError(err, "GetAccount failed")
	ctx.Equal(a.Status, "verified", "the change must commit; the status")
	before := len(ctx.Kafka.Records(topic))
	stale, err := changeStatus(eventsBg, "u-1", "unverified", "suspended", "chargeback")
	ctx.NoError(err, "a stale change must not fail")
	ctx.Assert(stale == nil, "a change whose expected status is stale must not commit and must answer nil, got %v", stale)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), before, "a change that did not commit must not produce an event; the records")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	setupEvents(ctx)
	ctx.Kafka.LoseAcks(topic, 1)
	mustChange(ctx, "unverified", "verified", "email_confirmed")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	mustChange(ctx, "verified", "suspended", "chargeback")
	ctx.Settle()
	lost := ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

#include "identityd/accounts.h"

using json = nlohmann::json;

namespace {

const std::string kTopic = "identity.event";

void setupEvents() { accounts::createAccount("u-1", "ada@example.com", "+442079460958", "Ada Lovelace"); }

json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  try {
    return json::parse(record.Value.value_or(""));
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", record.Value.value_or(""), e.what());
  }
}

json mustChange(harness::Ctx& ctx, const std::string& expected, const std::string& status, const std::string& reason) {
  std::optional<json> event;
  try {
    event = changeStatus("u-1", expected, status, reason);
  } catch (const std::exception& e) {
    ctx.Fatalf("changeStatus(u-1, %s → %s) threw %s: %s", expected, status, harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(event.has_value(), "changeStatus(u-1, %s → %s) must commit and answer the event", expected, status);
  return *event;
}

}  // namespace

void CheckUserKey(harness::Ctx& ctx) {
  setupEvents();
  recordEvent("created", "u-1", "signup");
  mustChange(ctx, "unverified", "verified", "email_confirmed");
  mustChange(ctx, "verified", "suspended", "chargeback");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three events must produce three records on %s; the records", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"u-1", "u-1", "u-1"}, "records must be keyed by the user id (keyed by the address, an account that changes it splits its history across partitions)");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
             "u-1's events landed on partitions %d, %d, %d: one account's history must stay on one partition, in order",
             records[0].Partition, records[1].Partition, records[2].Partition);
}

void CheckEventTypes(harness::Ctx& ctx) {
  setupEvents();
  recordEvent("created", "u-1", "signup");
  mustChange(ctx, "unverified", "verified", "email_confirmed");
  mustChange(ctx, "verified", "suspended", "chargeback");
  std::vector<std::string> types;
  for (const auto& r : ctx.Kafka.Records(kTopic)) types.push_back(payloadOf(ctx, r).value("type", ""));
  ctx.Equal(types, {"identity.created", "identity.verified", "identity.suspended"}, "the three events' types");
  bool refused = false;
  try {
    recordEvent("verifed", "u-1", "typo");
  } catch (const std::exception&) {
    refused = true;
  }
  ctx.Assert(refused, "an unknown kind (verifed) must be refused, not forwarded as an event type");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 3, "the refused kind must not produce a record; the records");
}

void CheckNoContactPii(harness::Ctx& ctx) {
  setupEvents();
  mustChange(ctx, "unverified", "verified", "email_confirmed");
  const auto record = ctx.Kafka.Records(kTopic)[0];
  const json p = payloadOf(ctx, record);
  for (const std::string name : {"email", "phone", "name"}) {
    ctx.Assert(!p.contains(name), "the event carries the account's %s: %s. The topic is retained and replicated; carry the user id and a reason code", name, p.dump());
  }
  const std::string text = record.Value.value_or("");
  for (const std::string value : {"ada@example.com", "Ada Lovelace", "+442079460958"}) {
    ctx.Assert(text.find(value) == std::string::npos, "the event carries %q under another name: %s", value, text);
  }
  ctx.Equal(p, json{{"type", "identity.verified"}, {"user_id", "u-1"}, {"reason", "email_confirmed"}}, "the payload");
}

void CheckCommitBeforeProduce(harness::Ctx& ctx) {
  setupEvents();
  // The moment the status change commits, what is already on the topic.
  int atCommit = -1;
  ctx.Redis.After("account:u-1", [&] { atCommit = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  mustChange(ctx, "unverified", "verified", "email_confirmed");
  ctx.Assert(atCommit >= 0, "changeStatus never touched account:u-1");
  ctx.Equal(atCommit, 0, "when the change committed the topic already held records: consumers heard about a change before it existed. Commit, then produce; records at the commit");
  ctx.Equal(accounts::getAccount("u-1")->status, "verified", "the change must commit; the status");
  const size_t before = ctx.Kafka.Records(kTopic).size();
  const auto stale = changeStatus("u-1", "unverified", "suspended", "chargeback");
  ctx.Assert(!stale, "a change whose expected status is stale must not commit and must answer nothing");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), before, "a change that did not commit must not produce an event; the records");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  setupEvents();
  ctx.Kafka.LoseAcks(kTopic, 1);
  mustChange(ctx, "unverified", "verified", "email_confirmed");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1,
            "one change whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records on the topic");
  mustChange(ctx, "verified", "suspended", "chargeback");
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    "Change an account's email between two events and watch the partitions; read a record and the address is in it; make a status change fail and its event is on the topic anyway.",
    'The key is the email and the payload copies the account row. `change_status` produces before `accounts.transition`, so a stale change is announced, and `acks=1` lets one broker answer for all.',
    'Key by `user_id`, set `type` from `EVENT_TYPES[kind]`, send `{type, user_id, reason}` only, call `accounts.transition` first and produce only when it moved, and configure `enable.idempotence` with `acks=all`.',
  ],
  debrief: `An event is a statement about state that already exists, which is why the transition commits before the record is produced and why a stale change produces nothing. The key is the user id because order matters per account and the id is the one handle that never changes. The payload carries an id and a reason code because the topic is replicated and retained, so an address written there survives the account's deletion request; consumers that need the address look it up and get told when it is gone. Idempotence with acks=all makes a retry after a lost acknowledgement write once on every replica. Production services write the event into an outbox in the same transaction as the account and relay it, so a broker outage delays it without losing it.`,
};
