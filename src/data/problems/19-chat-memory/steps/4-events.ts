import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'session.turn events keyed by conversation, without content, with an outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'worker'],
  task: `## Task

**Starting point.** The starter is what the turn route calls after an append:
\`publish_turn_event(tenant, session_id, turn)\` builds the \`session.turn\` event with \`turn_event\`
(type, tenant, session id, turn id, role, tokens and the turn's content), produces it keyed by the
turn id from a producer with \`acks=1\`, polls once and returns \`True\`. Events show up on the topic;
it hides four flaws.

**Failure mode the checks target.** Two turns of one conversation land on two partitions and the
worker summarizes them out of order; a pasted card number sits in a retained topic long after the
buffer expired; a broker that loses an acknowledgement gets the event twice, and a leader failover
loses it; and a broker that is down drops the event while the caller hears \`True\`.

- The key is the conversation: \`conversation_key(tenant, session_id)\` = \`{tenant}:{session_id}\`.
- The payload is \`{type, tenant, session_id, turn_id, role, tokens}\`: ids and counts, no content.
- The producer is **idempotent** with **\`acks=all\`** (kafkajs: \`idempotent: true\` and \`acks: -1\`;
  Go uses confluent-kafka-go, since kafka-go has no idempotent producer).
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` = 2 s; on a failed delivery or no report,
  \`outbox.insert(TOPIC, key, payload)\` (provided, \`memory.outbox\`) and return \`False\`.`,
  sequence: {
    participants: ['Memory API', 'Kafka session.turn', 'Outbox', 'Memory worker'],
    messages: [
      {
        from: 'Memory API',
        to: 'Kafka session.turn',
        label: 'produce key = t1:s-1 · {turn_id, role, tokens} · idempotent, acks=all',
        kind: 'sync',
      },
      {from: 'Kafka session.turn', to: 'Memory API', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'Kafka session.turn', to: 'Memory API', label: 'failed · no report', kind: 'reply'},
      {from: 'Memory API', to: 'Outbox', label: 'insert(topic, key, payload) → False', kind: 'async'},
      {
        from: 'Kafka session.turn',
        to: 'Memory worker',
        label: 'one conversation, one partition, in order',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'conversation-key',
      title: 'Keys session.turn by the conversation',
      detail:
        'The record key is `conversation_key(tenant, session_id)` (`{tenant}:{session_id}`), so every turn of a conversation lands on one partition and the worker reads them in order; the starter keys by the turn id.',
      match: {
        python: {
          all: [/def conversation_key\(\s*tenant/, /f["']\{tenant\}:\{session_id\}["']/],
          none: [/key\s*=\s*turn\[/],
        },
        typescript: {
          all: [
            /conversationKey\s*=\s*\(\s*tenant|function conversationKey\(\s*tenant/,
            /`\$\{tenant\}:\$\{sessionId\}`/,
          ],
          none: [/key:\s*turn\.turn_id/],
        },
        go: {
          all: [/func conversationKey\(\s*tenant/, /tenant\s*\+\s*":"\s*\+\s*sessionID/],
          none: [/Key:\s*\[\]byte\(turn\.TurnID\)/],
        },
        scala: {all: [/def conversationKey\(\s*tenant/, /s"\$tenant:\$sessionId"/], none: [/\(Topic,\s*turn\.turnId/]},
        cpp: {
          all: [/std::string conversationKey\(\s*const std::string& tenant/, /tenant\s*\+\s*":"\s*\+\s*session_id/],
          none: [/turn\.turn_id\.c_str\(\)/],
        },
      },
    },
    {
      id: 'no-content',
      title: 'Carries ids and token counts, not content',
      detail:
        "The payload is `{type, tenant, session_id, turn_id, role, tokens}`; the turn's text stays in the buffer, which expires, instead of a topic that keeps it for its whole retention.",
      match: {
        python: {all: [/["']tokens["']\s*:\s*turn\[["']tokens["']\]/], none: [/["']content["']\s*:\s*turn\[/]},
        typescript: {all: [/tokens:\s*turn\.tokens/], none: [/turn\.content/]},
        go: {all: [/"tokens":\s*turn\.Tokens/], none: [/turn\.Content/]},
        scala: {all: [/"tokens"\s*->\s*JsNumber\(turn\.tokens\)/], none: [/turn\.content/]},
        cpp: {all: [/\{"tokens",\s*turn\.tokens\}/], none: [/turn\.content/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover; the starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the payload, and the call returns false; the starter returns true before any report arrives.',
      match: {
        python: {all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/outbox\.insert\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insert\(/, /\.get\(\s*[^\n]*TimeUnit/, /Failure|catch/]},
        cpp: {all: [/outbox::insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from memory import outbox  # outbox.insert(topic, key, payload)

TOPIC = "session.turn"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def turn_event(tenant: str, session_id: str, turn: dict) -> dict:
    """What the memory worker needs to act on a turn."""
    return {
        "type": "session.turn",
        "tenant": tenant,
        "session_id": session_id,
        "turn_id": turn["turn_id"],
        "role": turn["role"],
        "tokens": turn["tokens"],
        "content": turn["content"],
    }


def publish_turn_event(tenant: str, session_id: str, turn: dict) -> bool:
    """Tell the memory worker about an appended turn; True once the event is on its way."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = turn_event(tenant, session_id, turn)
    producer.produce(TOPIC, key=turn["turn_id"], value=json.dumps(payload))
    producer.poll(0)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from memory import outbox  # outbox.insert(topic, key, payload)

TOPIC = "session.turn"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def conversation_key(tenant: str, session_id: str) -> str:
    return f"{tenant}:{session_id}"


def turn_event(tenant: str, session_id: str, turn: dict) -> dict:
    """What the memory worker needs to act on a turn: its ids, its role and its size."""
    return {
        "type": "session.turn",
        "tenant": tenant,
        "session_id": session_id,
        "turn_id": turn["turn_id"],
        "role": turn["role"],
        "tokens": turn["tokens"],
    }


def publish_turn_event(tenant: str, session_id: str, turn: dict) -> bool:
    """Tell the memory worker about an appended turn; True once the broker acknowledged the event."""
    key = conversation_key(tenant, session_id)
    payload = turn_event(tenant, session_id, turn)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=key, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so the worker is late, not wrong.
        outbox.insert(TOPIC, key, payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as outbox from 'memory/outbox'; // outbox.insert(topic, key, payload)
import type {Turn} from 'memory/sessions';

export const TOPIC = 'session.turn';

const kafka = new Kafka({clientId: 'memd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** What the memory worker needs to act on a turn. */
export function turnEvent(tenant: string, sessionId: string, turn: Turn) {
  return {
    type: 'session.turn',
    tenant,
    session_id: sessionId,
    turn_id: turn.turn_id,
    role: turn.role,
    tokens: turn.tokens,
    content: turn.content,
  };
}

/** Tell the memory worker about an appended turn; true once the event is on its way. */
export async function publishTurnEvent(tenant: string, sessionId: string, turn: Turn): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = turnEvent(tenant, sessionId, turn);
  void producer.send({topic: TOPIC, messages: [{key: turn.turn_id, value: JSON.stringify(payload)}], acks: 1});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as outbox from 'memory/outbox'; // outbox.insert(topic, key, payload)
import type {Turn} from 'memory/sessions';

export const TOPIC = 'session.turn';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'memd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

export const conversationKey = (tenant: string, sessionId: string): string => \`\${tenant}:\${sessionId}\`;

/** What the memory worker needs to act on a turn: its ids, its role and its size. */
export function turnEvent(tenant: string, sessionId: string, turn: Turn) {
  return {
    type: 'session.turn',
    tenant,
    session_id: sessionId,
    turn_id: turn.turn_id,
    role: turn.role,
    tokens: turn.tokens,
  };
}

/** Tell the memory worker about an appended turn; true once the broker acknowledged the event. */
export async function publishTurnEvent(tenant: string, sessionId: string, turn: Turn): Promise<boolean> {
  const key = conversationKey(tenant, sessionId);
  const payload = turnEvent(tenant, sessionId, turn);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay produces the row later, so the worker is late, not wrong.
    await outbox.insert(TOPIC, key, payload);
    return false;
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

	"memory/sessions" // sessions.Turn
)

const topic = "session.turn"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// turnEvent is what the memory worker needs to act on a turn.
func turnEvent(tenant, sessionID string, turn sessions.Turn) map[string]any {
	return map[string]any{
		"type":       "session.turn",
		"tenant":     tenant,
		"session_id": sessionID,
		"turn_id":    turn.TurnID,
		"role":       turn.Role,
		"tokens":     turn.Tokens,
		"content":    turn.Content,
	}
}

// publishTurnEvent tells the memory worker about an appended turn; true once the event is on its way.
func publishTurnEvent(ctx context.Context, tenant, sessionID string, turn sessions.Turn) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(turnEvent(tenant, sessionID, turn))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(turn.TurnID), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"memory/outbox"   // outbox.Insert(ctx, topic, key, payload)
	"memory/sessions" // sessions.Turn
)

const (
	topic      = "session.turn"
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

func conversationKey(tenant, sessionID string) string {
	return tenant + ":" + sessionID
}

// turnEvent is what the memory worker needs to act on a turn: its ids, its role and its size.
func turnEvent(tenant, sessionID string, turn sessions.Turn) map[string]any {
	return map[string]any{
		"type":       "session.turn",
		"tenant":     tenant,
		"session_id": sessionID,
		"turn_id":    turn.TurnID,
		"role":       turn.Role,
		"tokens":     turn.Tokens,
	}
}

// publishTurnEvent tells the memory worker about an appended turn; true once the broker acknowledged the event.
func publishTurnEvent(ctx context.Context, tenant, sessionID string, turn sessions.Turn) (bool, error) {
	key := conversationKey(tenant, sessionID)
	payload := turnEvent(tenant, sessionID, turn)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(key), Value: value}
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
		// The broker did not take it: the relay produces the row later, so the worker is late, not wrong.
		if err := outbox.Insert(ctx, topic, key, payload); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import memory.{Outbox, Sessions} // Outbox.insert(topic, key, payload); Sessions.Turn

object Events {
  val Topic = "session.turn"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What the memory worker needs to act on a turn. */
  def turnEvent(tenant: String, sessionId: String, turn: Sessions.Turn): JsObject =
    JsObject(
      "type" -> JsString("session.turn"),
      "tenant" -> JsString(tenant),
      "session_id" -> JsString(sessionId),
      "turn_id" -> JsString(turn.turnId),
      "role" -> JsString(turn.role),
      "tokens" -> JsNumber(turn.tokens),
      "content" -> JsString(turn.content)
    )

  /** Tell the memory worker about an appended turn; true once the event is on its way. */
  def publishTurnEvent(tenant: String, sessionId: String, turn: Sessions.Turn): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = turnEvent(tenant, sessionId, turn)
    producer.send(new ProducerRecord[String, String](Topic, turn.turnId, payload.compactPrint))
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import memory.{Outbox, Sessions} // Outbox.insert(topic, key, payload); Sessions.Turn

object Events {
  val Topic = "session.turn"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def conversationKey(tenant: String, sessionId: String): String = s"$tenant:$sessionId"

  /** What the memory worker needs to act on a turn: its ids, its role and its size. */
  def turnEvent(tenant: String, sessionId: String, turn: Sessions.Turn): JsObject =
    JsObject(
      "type" -> JsString("session.turn"),
      "tenant" -> JsString(tenant),
      "session_id" -> JsString(sessionId),
      "turn_id" -> JsString(turn.turnId),
      "role" -> JsString(turn.role),
      "tokens" -> JsNumber(turn.tokens)
    )

  /** Tell the memory worker about an appended turn; true once the broker acknowledged the event. */
  def publishTurnEvent(tenant: String, sessionId: String, turn: Sessions.Turn): Boolean = {
    val key = conversationKey(tenant, sessionId)
    val payload = turnEvent(tenant, sessionId, turn)
    val record = new ProducerRecord[String, String](Topic, key, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay produces the row later, so the worker is late, not wrong.
      Outbox.insert(Topic, key, payload)
    }
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "memory/outbox.h"    // outbox::insert(topic, key, payload)
#include "memory/sessions.h"  // sessions::Turn

using json = nlohmann::json;

const std::string kTopic = "session.turn";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What the memory worker needs to act on a turn.
json turnEvent(const std::string& tenant, const std::string& session_id, const sessions::Turn& turn) {
  return json{{"type", "session.turn"}, {"tenant", tenant},         {"session_id", session_id},
              {"turn_id", turn.turn_id}, {"role", turn.role},       {"tokens", turn.tokens},
              {"content", turn.content}};
}

// Tell the memory worker about an appended turn; true once the event is on its way.
bool publishTurnEvent(const std::string& tenant, const std::string& session_id, const sessions::Turn& turn) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string value = turnEvent(tenant, session_id, turn).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    turn.turn_id.c_str(), turn.turn_id.size(), 0, nullptr);
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "memory/outbox.h"    // outbox::insert(topic, key, payload)
#include "memory/sessions.h"  // sessions::Turn

using json = nlohmann::json;

const std::string kTopic = "session.turn";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishTurnEvent produces one record and waits for it.
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

std::string conversationKey(const std::string& tenant, const std::string& session_id) { return tenant + ":" + session_id; }

// What the memory worker needs to act on a turn: its ids, its role and its size.
json turnEvent(const std::string& tenant, const std::string& session_id, const sessions::Turn& turn) {
  return json{{"type", "session.turn"}, {"tenant", tenant}, {"session_id", session_id},
              {"turn_id", turn.turn_id}, {"role", turn.role}, {"tokens", turn.tokens}};
}

// Tell the memory worker about an appended turn; true once the broker acknowledged the event.
bool publishTurnEvent(const std::string& tenant, const std::string& session_id, const sessions::Turn& turn) {
  const std::string key = conversationKey(tenant, session_id);
  const json payload = turnEvent(tenant, session_id, turn);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), key.c_str(), key.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so the worker is late, not wrong.
    outbox::insert(kTopic, key, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "session.turn"
CARD = "My card is 4111 1111 1111 1111, book the flight."


def _turn(n, content="Ship it on the 14th."):
    return {"turn_id": f"t-{n}", "role": "user", "content": content, "tokens": 9}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_conversation_key(ctx):
    m = ctx.load("events")
    m.publish_turn_event("t1", "s-1", _turn(1))
    m.publish_turn_event("t1", "s-2", _turn(1))
    m.publish_turn_event("t1", "s-1", _turn(2))
    m.publish_turn_event("t2", "s-1", _turn(1))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 4, f"four publish_turn_event calls produced {len(records)} records on session.turn (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"t1:s-1", b"t1:s-2", b"t1:s-1", b"t2:s-1"], f"the records are keyed {keys}, expected the conversation {{tenant}}:{{session_id}}"
    assert records[0].partition == records[2].partition, "both turns of t1:s-1 must land on one partition, or the worker reads a conversation out of order"


def check_no_content(ctx):
    m = ctx.load("events")
    m.publish_turn_event("t1", "s-1", _turn(1, CARD))
    values = ctx.kafka.values(TOPIC)
    assert len(values) == 1, f"one publish_turn_event produced {len(values)} records"
    assert b"4111" not in values[0], f"the event carries the turn's text into a retained topic: {values[0]!r}"
    value = json.loads(values[0])
    want = {"type": "session.turn", "tenant": "t1", "session_id": "s-1", "turn_id": "t-1", "role": "user", "tokens": 9}
    assert value == want, f"the payload is {value}, expected exactly {want}"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_turn_event("t1", "s-1", _turn(1))
    m.publish_turn_event("t1", "s-1", _turn(2))  # serves any report still pending
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after one lost acknowledgement two turns left {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote an event twice. Enable idempotence"
    m.publish_turn_event("t1", "s-1", _turn(3))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 3, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_turn_event("t1", "s-1", _turn(1))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the worker never hears of the turn"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "t1:s-1" and rows[0].get("payload", {}).get("turn_id") == "t-1", f"the outbox row is {rows[0]}, expected the topic, the key t1:s-1 and the payload"
    assert ok is False, f"publish_turn_event returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_turn_event("t1", "s-1", _turn(2))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_turn_event waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("turn_id") == "t-2", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_turn_event returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'session.turn';
const CARD = 'My card is 4111 1111 1111 1111, book the flight.';

const turn = (n: number, content = 'Ship it on the 14th.') => ({turn_id: \`t-\${n}\`, role: 'user', content, tokens: 9});

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_conversation_key(ctx) {
  const m = ctx.load('events');
  await m.publishTurnEvent('t1', 's-1', turn(1));
  await m.publishTurnEvent('t1', 's-2', turn(1));
  await m.publishTurnEvent('t1', 's-1', turn(2));
  await m.publishTurnEvent('t2', 's-1', turn(1));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 4, \`four publishTurnEvent calls produced \${records.length} records on session.turn\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['t1:s-1', 't1:s-2', 't1:s-1', 't2:s-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the conversation {tenant}:{session_id}\`);
  assert.equal(records[0].partition, records[2].partition, 'both turns of t1:s-1 must land on one partition, or the worker reads a conversation out of order');
}

export async function check_no_content(ctx) {
  const m = ctx.load('events');
  await m.publishTurnEvent('t1', 's-1', turn(1, CARD));
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publishTurnEvent produced \${values.length} records\`);
  assert(!values[0].includes('4111'), \`the event carries the turn's text into a retained topic: \${values[0]}\`);
  const want = {type: 'session.turn', tenant: 't1', session_id: 's-1', turn_id: 't-1', role: 'user', tokens: 9};
  assert.deepStrictEqual(JSON.parse(values[0]), want, \`the payload is \${values[0]}, expected exactly \${JSON.stringify(want)}\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishTurnEvent('t1', 's-1', turn(1));
  await m.publishTurnEvent('t1', 's-1', turn(2));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after one lost acknowledgement two turns left \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote an event twice. Enable idempotence\`);
  await m.publishTurnEvent('t1', 's-1', turn(3));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 3, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishTurnEvent('t1', 's-1', turn(1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the worker never hears of the turn\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 't1:s-1' && rows[0].payload?.turn_id === 't-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key t1:s-1 and the payload\`);
  assert.equal(ok, false, \`publishTurnEvent resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishTurnEvent('t1', 's-1', turn(2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishTurnEvent waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.turn_id === 't-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishTurnEvent resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"memory/sessions"

	"leetbuild/harness"
)

const (
	eventsTopic = "session.turn"
	card        = "My card is 4111 1111 1111 1111, book the flight."
)

func eventTurn(n int, content string) sessions.Turn {
	if content == "" {
		content = "Ship it on the 14th."
	}
	return sessions.Turn{TurnID: fmt.Sprintf("t-%d", n), Role: "user", Content: content, Tokens: 9}
}

func mustPublish(ctx *harness.Ctx, tenant, sessionID string, turn sessions.Turn) bool {
	ok, err := publishTurnEvent(context.Background(), tenant, sessionID, turn)
	ctx.NoError(err, "publishTurnEvent(%s, %s, %s)", tenant, sessionID, turn.TurnID)
	return ok
}

type outboxRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func outboxRows(ctx *harness.Ctx) []outboxRow {
	var rows []outboxRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row outboxRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckConversationKey(ctx *harness.Ctx) {
	mustPublish(ctx, "t1", "s-1", eventTurn(1, ""))
	mustPublish(ctx, "t1", "s-2", eventTurn(1, ""))
	mustPublish(ctx, "t1", "s-1", eventTurn(2, ""))
	mustPublish(ctx, "t2", "s-1", eventTurn(1, ""))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 4, "four publishTurnEvent calls must produce four records on session.turn; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"t1:s-1", "t1:s-2", "t1:s-1", "t2:s-1"}, "the records must be keyed by the conversation {tenant}:{session_id}")
	ctx.Equal(records[0].Partition, records[2].Partition, "both turns of t1:s-1 must land on one partition, or the worker reads a conversation out of order; the partitions")
}

func CheckNoContent(ctx *harness.Ctx) {
	mustPublish(ctx, "t1", "s-1", eventTurn(1, card))
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one publishTurnEvent must produce one record; the records")
	ctx.Assert(!strings.Contains(values[0], "4111"), "the event carries the turn's text into a retained topic: %s", values[0])
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	ctx.Equal(value, map[string]any{"type": "session.turn", "tenant": "t1", "session_id": "s-1", "turn_id": "t-1", "role": "user", "tokens": 9}, "the payload")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	mustPublish(ctx, "t1", "s-1", eventTurn(1, ""))
	mustPublish(ctx, "t1", "s-1", eventTurn(2, ""))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "after one lost acknowledgement the producer's retry must not write an event twice (enable.idempotence); the records for two turns")
	mustPublish(ctx, "t1", "s-1", eventTurn(3, ""))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 3, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := mustPublish(ctx, "t1", "s-1", eventTurn(1, ""))
	ctx.Settle()
	rows := outboxRows(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the worker never hears of the turn; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "t1:s-1" && rows[0].Payload["turn_id"] == "t-1", "the outbox row is %v, expected the topic, the key t1:s-1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishTurnEvent's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = mustPublish(ctx, "t1", "s-1", eventTurn(2, ""))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishTurnEvent waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = outboxRows(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["turn_id"] == "t-2", "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishTurnEvent's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "session.turn";
const std::string kCard = "My card is 4111 1111 1111 1111, book the flight.";

sessions::Turn eventTurn(int n, const std::string& content = "Ship it on the 14th.") {
  return sessions::Turn{"t-" + std::to_string(n), "user", content, 9};
}

std::vector<nlohmann::json> outboxRows(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string text(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckConversationKey(harness::Ctx& ctx) {
  publishTurnEvent("t1", "s-1", eventTurn(1));
  publishTurnEvent("t1", "s-2", eventTurn(1));
  publishTurnEvent("t1", "s-1", eventTurn(2));
  publishTurnEvent("t2", "s-1", eventTurn(1));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 4, "four publishTurnEvent calls must produce four records on session.turn; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"t1:s-1", "t1:s-2", "t1:s-1", "t2:s-1"}, "the records must be keyed by the conversation {tenant}:{session_id}");
  ctx.Equal(records[0].Partition, records[2].Partition, "both turns of t1:s-1 must land on one partition, or the worker reads a conversation out of order; the partitions");
}

void CheckNoContent(harness::Ctx& ctx) {
  publishTurnEvent("t1", "s-1", eventTurn(1, kCard));
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one publishTurnEvent must produce one record; the records");
  ctx.Assert(values[0].find("4111") == std::string::npos, "the event carries the turn's text into a retained topic: %s", values[0]);
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  const nlohmann::json want = {{"type", "session.turn"}, {"tenant", "t1"}, {"session_id", "s-1"}, {"turn_id", "t-1"}, {"role", "user"}, {"tokens", 9}};
  ctx.Assert(value == want, "the payload is %s, expected exactly %s", values[0], want.dump());
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishTurnEvent("t1", "s-1", eventTurn(1));
  publishTurnEvent("t1", "s-1", eventTurn(2));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "after one lost acknowledgement the producer's retry must not write an event twice (enable.idempotence); the records for two turns");
  publishTurnEvent("t1", "s-1", eventTurn(3));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 3, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishTurnEvent("t1", "s-1", eventTurn(1));
  ctx.Settle();
  auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the worker never hears of the turn; the rows");
  ctx.Assert(text(rows[0], "topic") == kEventsTopic && text(rows[0], "key") == "t1:s-1" && rows[0].contains("payload") && text(rows[0]["payload"], "turn_id") == "t-1",
             "the outbox row is %s, expected the topic, the key t1:s-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishTurnEvent's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishTurnEvent("t1", "s-1", eventTurn(2));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishTurnEvent waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && text(rows[1]["payload"], "turn_id") == "t-2", "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishTurnEvent's result without a delivery report");
}
`,
  },
  hints: [
    'The worker sees `t-2` of a conversation before `t-1`, the event log holds text users pasted, and after a broker blip one turn arrives twice and another never arrives while the route answered 201.',
    'Kafka orders records per partition and the key picks the partition: the turn id gives each turn its own. `acks=1` without idempotence lets a retry duplicate and a failover lose; `poll(0)` returns before any delivery report.',
    'Key by `f"{tenant}:{session_id}"`, drop `content` from `turn_event`, set `enable.idempotence` with `acks=all`, produce with `on_delivery`, `flush(ACK_TIMEOUT_S)`, and on an error or a record still in flight `outbox.insert(...)` and return `False`.',
  ],
  debrief: `The key is an ordering contract: whatever is in the key is what the worker sees in order, and a conversation is the unit a summarizer reasons about. Leaving the content out is a retention decision as much as a privacy one: the buffer expires in a day, a topic keeps records as long as its retention says, so the event carries ids a consumer can look up while the turn still exists. Waiting for the delivery report gives the return value a meaning, and the outbox turns a broker outage into a delay. Production pipelines write the outbox row in the same transaction as the turn and let a relay do every produce, and they register the payload schema so a field such as \`content\` cannot be added without review.`,
};
