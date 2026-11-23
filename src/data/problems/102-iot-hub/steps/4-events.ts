import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Command transitions keyed by device for the fleet audit',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['hub', 'kafka', 'audit', 'outbox'],
  task: `## Task

**Starting point.** The starter is \`publish_transition(command, outcome)\`, called whenever a command
moves (\`accepted\`, \`queued\`, \`delivered\`, \`expired\`, \`failed\`): it produces a JSON event with the
command's id, device, action, params, outcome and time to \`iot.command\`, keyed by the command id,
from a producer with \`acks=1\`, and returns \`True\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** One lock's transitions land on different partitions and the
fleet audit reads \`delivered\` before \`accepted\`; the unlock PIN sits in a retained, replicated
topic; a lost acknowledgement writes a transition twice and a leader failover loses one; and a
broker that refuses the record or does not answer drops the transition with nobody told.

- The record key is the **device id**.
- The payload is \`{command_id, device_id, action, outcome, at_ms}\`: no \`params\`.
- The producer is **idempotent** with **\`acks=all\`** (kafka-go has no idempotent producer, so the
  Go stack uses confluent-kafka-go).
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` = 2 s; when it fails or does not come, insert
  an outbox row (\`outbox.insert(topic, key, payload)\`) and return \`False\`.`,
  sequence: {
    participants: ['iothub', 'iot.command', 'Outbox', 'Fleet audit'],
    messages: [
      {from: 'iothub', to: 'iot.command', label: 'produce key = device id · idempotent · acks=all', kind: 'sync'},
      {from: 'iot.command', to: 'iothub', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'iothub', to: 'Outbox', label: 'no report / error → insert(topic, key, payload) · False', kind: 'async'},
      {from: 'iot.command', to: 'Fleet audit', label: 'consume one device in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'device-key',
      title: 'Keys iot.command by the device id',
      detail:
        "Transitions of lock-7, lock-9, lock-7 carry those keys and lock-7's two records share a partition; the starter keys by command id, which spreads one device over every partition.",
      match: {
        python: {
          all: [/producer\.produce\([^)\n]*key\s*=\s*command\[["']device_id["']\]/],
          none: [/key\s*=\s*command\[["']command_id["']\]/],
        },
        typescript: {all: [/key:\s*command\.device_id/], none: [/key:\s*command\.command_id/]},
        go: {all: [/Key:\s*\[\]byte\(command\.DeviceID\)/], none: [/Key:\s*\[\]byte\(command\.CommandID\)/]},
        cpp: {
          all: [/command\.device_id\.c_str\(\)\s*,\s*command\.device_id\.(size|length)\(\)/],
          none: [/command\.command_id\.c_str\(\)/],
        },
      },
    },
    {
      id: 'ids-and-outcomes',
      title: 'Carries ids and the outcome, never the params',
      detail:
        "The event is exactly `{command_id, device_id, action, outcome, at_ms}`, with `at_ms` the transition's time in milliseconds; the starter copies the command's `params` (an unlock PIN) into a topic every consumer group can read for as long as it is retained.",
      match: {
        python: {all: [/["']outcome["']/], none: [/def event_payload(?:(?!\ndef )[\s\S])*?params/]},
        typescript: {all: [/outcome/], none: [/function eventPayload(?:(?!\nexport |\nfunction )[\s\S])*?params/]},
        go: {all: [/"outcome"/], none: [/func eventPayload(?:(?!\n\})[\s\S])*?Params/]},
        cpp: {all: [/"outcome"/], none: [/json eventPayload(?:(?!\n\})[\s\S])*?params/]},
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
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'An acknowledged transition returns true and writes no row. A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the device key and the event payload (never the params), and the call returns false; the starter fires and forgets.',
      match: {
        python: {all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/outbox\.insert\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        cpp: {all: [/outbox::insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

from confluent_kafka import Producer

from iothub import outbox  # insert(topic, key, payload)

TOPIC = "iot.command"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(command: dict, outcome: str) -> dict:
    return {
        "command_id": command["command_id"],
        "device_id": command["device_id"],
        "action": command["action"],
        "params": command["params"],
        "outcome": outcome,
        "at_ms": int(time.time() * 1000),
    }


def publish_transition(command: dict, outcome: str) -> bool:
    """Tell the fleet audit what happened to a command; True once the broker has the event."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = event_payload(command, outcome)
    producer.produce(TOPIC, key=command["command_id"], value=json.dumps(payload))
    producer.poll(0)
    return True
`,
      solution: `import json
import time

from confluent_kafka import Producer

from iothub import outbox  # insert(topic, key, payload)

TOPIC = "iot.command"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def event_payload(command: dict, outcome: str) -> dict:
    # Ids and the outcome; the parameters (a PIN, a setpoint) stay in the command store.
    return {
        "command_id": command["command_id"],
        "device_id": command["device_id"],
        "action": command["action"],
        "outcome": outcome,
        "at_ms": int(time.time() * 1000),
    }


def publish_transition(command: dict, outcome: str) -> bool:
    """Tell the fleet audit what happened to a command; True once the broker has the event."""
    payload = event_payload(command, outcome)
    report = {}

    def on_delivery(err, msg):
        report["error"] = err

    # One device's transitions share a key, so the audit reads them in the order they happened.
    producer.produce(TOPIC, key=command["device_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or report.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the audit is late, not wrong.
        outbox.insert(TOPIC, command["device_id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import type {Command} from 'iothub/commands';
import * as outbox from 'iothub/outbox'; // outbox.insert(topic, key, payload)

export const TOPIC = 'iot.command';

const kafka = new Kafka({clientId: 'iothub', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export function eventPayload(command: Command, outcome: string) {
  return {
    command_id: command.command_id,
    device_id: command.device_id,
    action: command.action,
    params: command.params,
    outcome,
    at_ms: Date.now(),
  };
}

/** Tell the fleet audit what happened to a command; true once the broker has the event. */
export async function publishTransition(command: Command, outcome: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = eventPayload(command, outcome);
  void producer.send({topic: TOPIC, messages: [{key: command.command_id, value: JSON.stringify(payload)}], acks: 1});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import type {Command} from 'iothub/commands';
import * as outbox from 'iothub/outbox'; // outbox.insert(topic, key, payload)

export const TOPIC = 'iot.command';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'iothub', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Ids and the outcome; the parameters (a PIN, a setpoint) stay in the command store. */
export function eventPayload(command: Command, outcome: string) {
  return {
    command_id: command.command_id,
    device_id: command.device_id,
    action: command.action,
    outcome,
    at_ms: Date.now(),
  };
}

/** Tell the fleet audit what happened to a command; true once the broker has the event. */
export async function publishTransition(command: Command, outcome: string): Promise<boolean> {
  const payload = eventPayload(command, outcome);
  try {
    // One device's transitions share a key, so the audit reads them in the order they happened.
    await producer.send({
      topic: TOPIC,
      messages: [{key: command.device_id, value: JSON.stringify(payload)}],
      acks: -1, // every in-sync replica has the record before the broker answers
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the audit is late, not wrong.
    await outbox.insert(TOPIC, command.device_id, payload);
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
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"iothub/commands" // commands.Command
)

const topic = "iot.command"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func eventPayload(command *commands.Command, outcome string) map[string]any {
	return map[string]any{
		"command_id": command.CommandID,
		"device_id":  command.DeviceID,
		"action":     command.Action,
		"params":     command.Params,
		"outcome":    outcome,
		"at_ms":      time.Now().UnixMilli(),
	}
}

// publishTransition tells the fleet audit what happened to a command; true once the broker has the event.
func publishTransition(ctx context.Context, command *commands.Command, outcome string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(eventPayload(command, outcome))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(command.CommandID), Value: value}
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

	"iothub/commands" // commands.Command
	"iothub/outbox"   // outbox.Insert(ctx, topic, key, payload)
)

const (
	topic      = "iot.command"
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

// eventPayload is ids and the outcome; the parameters (a PIN, a setpoint) stay in the command store.
func eventPayload(command *commands.Command, outcome string) map[string]any {
	return map[string]any{
		"command_id": command.CommandID,
		"device_id":  command.DeviceID,
		"action":     command.Action,
		"outcome":    outcome,
		"at_ms":      time.Now().UnixMilli(),
	}
}

// publishTransition tells the fleet audit what happened to a command; true once the broker has the event.
func publishTransition(ctx context.Context, command *commands.Command, outcome string) (bool, error) {
	payload := eventPayload(command, outcome)
	value, _ := json.Marshal(payload)
	t := topic
	// One device's transitions share a key, so the audit reads them in the order they happened.
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(command.DeviceID), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so the audit is late, not wrong.
		return false, outbox.Insert(ctx, topic, command.DeviceID, payload)
	}
	return true, nil
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>

#include "iothub/commands.h"  // commands::Command
#include "iothub/outbox.h"    // outbox::insert(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "iot.command";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

json eventPayload(const commands::Command& command, const std::string& outcome) {
  return json{{"command_id", command.command_id}, {"device_id", command.device_id}, {"action", command.action},
              {"params", command.params},         {"outcome", outcome},              {"at_ms", nowMs()}};
}

// Tell the fleet audit what happened to a command; true once the broker has the event.
bool publishTransition(const commands::Command& command, const std::string& outcome) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string value = eventPayload(command, outcome).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), command.command_id.c_str(), command.command_id.size(), 0, nullptr);
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>

#include "iothub/commands.h"  // commands::Command
#include "iothub/outbox.h"    // outbox::insert(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "iot.command";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishTransition produces one record and waits for it.
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

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Ids and the outcome; the command's parameters (a PIN, a setpoint) stay in the command store.
json eventPayload(const commands::Command& command, const std::string& outcome) {
  return json{{"command_id", command.command_id}, {"device_id", command.device_id}, {"action", command.action},
              {"outcome", outcome},               {"at_ms", nowMs()}};
}

// Tell the fleet audit what happened to a command; true once the broker has the event.
bool publishTransition(const commands::Command& command, const std::string& outcome) {
  const json payload = eventPayload(command, outcome);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  // One device's transitions share a key, so the audit reads them in the order they happened.
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), command.device_id.c_str(), command.device_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the audit is late, not wrong.
    outbox::insert(kTopic, command.device_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "iot.command"


def _command(n, device="lock-7"):
    return {
        "command_id": f"cmd-{n}",
        "device_id": device,
        "action": "unlock",
        "params": {"pin": "4711"},
        "state": "pending_ack",
        "expires_at_ms": 0,
        "ack_required": True,
    }


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_device_key(ctx):
    m = ctx.load("events")
    m.publish_transition(_command(1, "lock-7"), "accepted")
    m.publish_transition(_command(2, "lock-9"), "accepted")
    m.publish_transition(_command(1, "lock-7"), "delivered")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three transitions produced {len(records)} records on iot.command (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"lock-7", b"lock-9", b"lock-7"], f"the records are keyed {keys}, expected the device ids lock-7, lock-9, lock-7"
    assert records[0].partition == records[2].partition, "lock-7's accepted and delivered landed on two partitions: the fleet audit can read delivered before accepted"


def check_ids_and_outcomes(ctx):
    m = ctx.load("events")
    now_ms = int(ctx.clock.time() * 1000)
    m.publish_transition(_command(1), "accepted")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one transition produced {len(records)} records"
    raw = records[0].value.decode()
    value = json.loads(raw)
    assert (value.get("command_id"), value.get("device_id"), value.get("action"), value.get("outcome")) == ("cmd-1", "lock-7", "unlock", "accepted"), f"the event is {raw}, expected command_id, device_id, action and outcome"
    assert "params" not in value and "4711" not in raw, f"the event carries the command's params ({raw}): the unlock PIN now sits in a retained, replicated topic every consumer group can read"
    assert set(value) == {"command_id", "device_id", "action", "outcome", "at_ms"}, f"the event carries the fields {sorted(value)}, expected exactly command_id, device_id, action, outcome and at_ms: the event names what it keeps, it does not copy the command and drop what looks secret"
    assert isinstance(value["at_ms"], int) and abs(value["at_ms"] - now_ms) <= 1000, f"the event's at_ms is {value['at_ms']!r}, expected the time of the transition in milliseconds ({now_ms})"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_transition(_command(1), "accepted")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the transition twice. Enable idempotence"
    m.publish_transition(_command(1), "delivered")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the transition the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ok = m.publish_transition(_command(0), "accepted")
    assert ok is True and _outbox(ctx) == [], f"a transition the broker acknowledged returned {ok!r} and left the outbox rows {_outbox(ctx)}, expected True and no row"
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_transition(_command(1), "accepted")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the transition vanishes from the fleet audit"
    payload = rows[0].get("payload", {})
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "lock-7" and payload.get("command_id") == "cmd-1" and payload.get("outcome") == "accepted", f"the outbox row is {rows[0]}, expected the topic, the key lock-7 and the event payload"
    assert "params" not in payload and "4711" not in json.dumps(payload), f"the outbox row carries the command's params ({payload}): the row holds the event the topic would have received, never the PIN"
    assert ok is False, f"publish_transition returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_transition(_command(2), "accepted")
    waited = ctx.clock.time() - before
    assert waited <= 2.5, f"publish_transition waited {waited:.1f} s for a broker that does not answer: wait for the report at most ACK_TIMEOUT_S = 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("command_id") == "cmd-2", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_transition returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'iot.command';

const command = (n: number, device = 'lock-7') => ({
  command_id: \`cmd-\${n}\`,
  device_id: device,
  action: 'unlock',
  params: {pin: '4711'},
  state: 'pending_ack',
  expires_at_ms: 0,
  ack_required: true,
});

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_device_key(ctx) {
  const m = ctx.load('events');
  await m.publishTransition(command(1, 'lock-7'), 'accepted');
  await m.publishTransition(command(2, 'lock-9'), 'accepted');
  await m.publishTransition(command(1, 'lock-7'), 'delivered');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three transitions produced \${records.length} records on iot.command\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['lock-7', 'lock-9', 'lock-7'], \`the records are keyed \${JSON.stringify(keys)}, expected the device ids lock-7, lock-9, lock-7\`);
  assert.equal(records[0].partition, records[2].partition, "lock-7's accepted and delivered landed on two partitions: the fleet audit can read delivered before accepted");
}

export async function check_ids_and_outcomes(ctx) {
  const m = ctx.load('events');
  const nowMs = ctx.clock.now();
  await m.publishTransition(command(1), 'accepted');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one transition produced \${values.length} records\`);
  const value = JSON.parse(values[0]);
  assert(value.command_id === 'cmd-1' && value.device_id === 'lock-7' && value.action === 'unlock' && value.outcome === 'accepted', \`the event is \${values[0]}, expected command_id, device_id, action and outcome\`);
  assert(!('params' in value) && !values[0].includes('4711'), \`the event carries the command's params (\${values[0]}): the unlock PIN now sits in a retained, replicated topic every consumer group can read\`);
  const fields = Object.keys(value).sort();
  assert.deepEqual(fields, ['action', 'at_ms', 'command_id', 'device_id', 'outcome'], \`the event carries the fields \${JSON.stringify(fields)}, expected exactly command_id, device_id, action, outcome and at_ms: the event names what it keeps, it does not copy the command and drop what looks secret\`);
  assert(Number.isInteger(value.at_ms) && Math.abs(value.at_ms - nowMs) <= 1000, \`the event's at_ms is \${JSON.stringify(value.at_ms)}, expected the time of the transition in milliseconds (\${nowMs})\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishTransition(command(1), 'accepted');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the transition twice. Enable idempotence\`);
  await m.publishTransition(command(1), 'delivered');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the transition the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  let ok = await m.publishTransition(command(0), 'accepted');
  await settle();
  let rows = outboxRows(ctx);
  assert(ok === true && rows.length === 0, \`a transition the broker acknowledged resolved \${JSON.stringify(ok)} and left the outbox rows \${JSON.stringify(rows)}, expected true and no row\`);
  ctx.kafka.failNext(TOPIC, 1);
  ok = await m.publishTransition(command(1), 'accepted');
  await settle();
  rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the transition vanishes from the fleet audit\`);
  const payload = rows[0].payload ?? {};
  assert(rows[0].topic === TOPIC && rows[0].key === 'lock-7' && payload.command_id === 'cmd-1' && payload.outcome === 'accepted', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key lock-7 and the event payload\`);
  assert(!('params' in payload) && !JSON.stringify(payload).includes('4711'), \`the outbox row carries the command's params (\${JSON.stringify(payload)}): the row holds the event the topic would have received, never the PIN\`);
  assert.equal(ok, false, \`publishTransition resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishTransition(command(2), 'accepted');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 2.5, \`publishTransition waited \${waited.toFixed(1)} s for a broker that does not answer: wait for the report at most ACK_TIMEOUT_MS = 2000, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.command_id === 'cmd-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishTransition resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"iothub/commands"

	"leetbuild/harness"
)

const kHEventsTopic = "iot.command"

func hEventsCommand(n int, device string) *commands.Command {
	return &commands.Command{
		CommandID: fmt.Sprintf("cmd-%d", n), DeviceID: device, Action: "unlock", Params: map[string]string{"pin": "4711"},
		State: "pending_ack", AckRequired: true,
	}
}

func hEventsPublish(ctx *harness.Ctx, c *commands.Command, outcome string) bool {
	ok, err := publishTransition(context.Background(), c, outcome)
	ctx.NoError(err, "publishTransition")
	return ok
}

type HEventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func hEventsOutbox(ctx *harness.Ctx) []HEventsRow {
	var rows []HEventsRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row HEventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckDeviceKey(ctx *harness.Ctx) {
	hEventsPublish(ctx, hEventsCommand(1, "lock-7"), "accepted")
	hEventsPublish(ctx, hEventsCommand(2, "lock-9"), "accepted")
	hEventsPublish(ctx, hEventsCommand(1, "lock-7"), "delivered")
	ctx.Settle()
	records := ctx.Kafka.Records(kHEventsTopic)
	ctx.Equal(len(records), 3, "three transitions must produce three records on iot.command; the records")
	ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), []string{"lock-7", "lock-9", "lock-7"}, "the records must be keyed by the device ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "lock-7's accepted and delivered must share a partition, or the fleet audit can read delivered before accepted; the partitions")
}

func CheckIdsAndOutcomes(ctx *harness.Ctx) {
	nowMs := ctx.Clock.Now()
	hEventsPublish(ctx, hEventsCommand(1, "lock-7"), "accepted")
	ctx.Settle()
	values := ctx.Kafka.Values(kHEventsTopic)
	ctx.Equal(len(values), 1, "one transition must produce one record; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the event must be JSON")
	ctx.Assert(value["command_id"] == "cmd-1" && value["device_id"] == "lock-7" && value["action"] == "unlock" && value["outcome"] == "accepted", "the event is %s, expected command_id, device_id, action and outcome", values[0])
	_, hasParams := value["params"]
	ctx.Assert(!hasParams && !strings.Contains(values[0], "4711"), "the event carries the command's params (%s): the unlock PIN now sits in a retained, replicated topic every consumer group can read", values[0])
	exact := len(value) == 5
	for _, field := range []string{"command_id", "device_id", "action", "outcome", "at_ms"} {
		_, has := value[field]
		exact = exact && has
	}
	ctx.Assert(exact, "the event is %s, expected exactly command_id, device_id, action, outcome and at_ms: the event names what it keeps, it does not copy the command and drop what looks secret", values[0])
	at, isNumber := value["at_ms"].(float64)
	ctx.Assert(isNumber && float64(int64(at)) == at && at-float64(nowMs) <= 1000 && float64(nowMs)-at <= 1000, "the event's at_ms is %v, expected the time of the transition in milliseconds (%d)", value["at_ms"], nowMs)
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(kHEventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	hEventsPublish(ctx, hEventsCommand(1, "lock-7"), "accepted")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the transition twice (enable.idempotence); the records")
	hEventsPublish(ctx, hEventsCommand(1, "lock-7"), "delivered")
	ctx.Settle()
	ctx.Kafka.Failover(kHEventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 2, "a leader failover must not lose a transition (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ok := hEventsPublish(ctx, hEventsCommand(0, "lock-7"), "accepted")
	ctx.Settle()
	rows := hEventsOutbox(ctx)
	ctx.Assert(ok && len(rows) == 0, "a transition the broker acknowledged returned %v and left the outbox rows %v, expected true and no row", ok, rows)
	ctx.Kafka.FailNext(kHEventsTopic, 1)
	ok = hEventsPublish(ctx, hEventsCommand(1, "lock-7"), "accepted")
	ctx.Settle()
	rows = hEventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the transition vanishes from the fleet audit; the rows")
	ctx.Assert(rows[0].Topic == kHEventsTopic && rows[0].Key == "lock-7" && rows[0].Payload["command_id"] == "cmd-1" && rows[0].Payload["outcome"] == "accepted", "the outbox row is %v, expected the topic, the key lock-7 and the event payload", rows[0])
	_, rowParams := rows[0].Payload["params"]
	rowText, _ := json.Marshal(rows[0].Payload)
	ctx.Assert(!rowParams && !strings.Contains(string(rowText), "4711"), "the outbox row carries the command's params (%s): the row holds the event the topic would have received, never the PIN", rowText)
	ctx.Equal(ok, false, "publishTransition's result after a failed delivery")
	ctx.Kafka.Stall(kHEventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = hEventsPublish(ctx, hEventsCommand(2, "lock-7"), "accepted")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 2.5, "publishTransition waited %.1f s for a broker that does not answer: wait for the report at most ackTimeout = 2 s, then write the outbox row", waited)
	rows = hEventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["command_id"] == "cmd-2", "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishTransition's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cstdlib>
#include <string>
#include <vector>

#include "iothub/commands.h"

namespace {

const std::string kHEventsTopic = "iot.command";

commands::Command hEventsCommand(int n, const std::string& device = "lock-7") {
  commands::Command c;
  c.command_id = "cmd-" + std::to_string(n);
  c.device_id = device;
  c.action = "unlock";
  c.params = {{"pin", "4711"}};
  c.state = "pending_ack";
  c.ack_required = true;
  return c;
}

std::vector<nlohmann::json> hEventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string hEventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckDeviceKey(harness::Ctx& ctx) {
  publishTransition(hEventsCommand(1, "lock-7"), "accepted");
  publishTransition(hEventsCommand(2, "lock-9"), "accepted");
  publishTransition(hEventsCommand(1, "lock-7"), "delivered");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kHEventsTopic);
  ctx.Equal(records.size(), 3, "three transitions must produce three records on iot.command; the records");
  ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), {"lock-7", "lock-9", "lock-7"}, "the records must be keyed by the device ids");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "lock-7's accepted and delivered must share a partition, or the fleet audit can read delivered before accepted; the partitions");
}

void CheckIdsAndOutcomes(harness::Ctx& ctx) {
  const int64_t now_ms = ctx.Clock.Now();
  publishTransition(hEventsCommand(1), "accepted");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kHEventsTopic);
  ctx.Equal(values.size(), 1, "one transition must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(hEventsField(value, "command_id") == "cmd-1" && hEventsField(value, "device_id") == "lock-7" && hEventsField(value, "action") == "unlock" &&
                 hEventsField(value, "outcome") == "accepted",
             "the event is %s, expected command_id, device_id, action and outcome", values[0]);
  ctx.Assert(!(value.is_object() && value.contains("params")) && values[0].find("4711") == std::string::npos,
             "the event carries the command's params (%s): the unlock PIN now sits in a retained, replicated topic every consumer group can read", values[0]);
  bool exact = value.is_object() && value.size() == 5;
  for (const char* field : {"command_id", "device_id", "action", "outcome", "at_ms"}) exact = exact && value.contains(field);
  ctx.Assert(exact, "the event is %s, expected exactly command_id, device_id, action, outcome and at_ms: the event names what it keeps, it does not copy the command and drop what looks secret",
             values[0]);
  const bool at_ok = value.is_object() && value.contains("at_ms") && value["at_ms"].is_number_integer() &&
                     std::llabs(value["at_ms"].get<long long>() - static_cast<long long>(now_ms)) <= 1000;
  ctx.Assert(at_ok, "the event is %s, expected at_ms to be the time of the transition in milliseconds (%d)", values[0], now_ms);
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kHEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishTransition(hEventsCommand(1), "accepted");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the transition twice (enable.idempotence); the records");
  publishTransition(hEventsCommand(1), "delivered");
  ctx.Settle();
  ctx.Kafka.Failover(kHEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 2, "a leader failover must not lose a transition (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  bool ok = publishTransition(hEventsCommand(0), "accepted");
  ctx.Settle();
  auto rows = hEventsOutbox(ctx);
  ctx.Assert(ok && rows.empty(), "a transition the broker acknowledged returned %v and left %d outbox rows, expected true and no row", ok, rows.size());
  ctx.Kafka.FailNext(kHEventsTopic, 1);
  ok = publishTransition(hEventsCommand(1), "accepted");
  ctx.Settle();
  rows = hEventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the transition vanishes from the fleet audit; the rows");
  ctx.Assert(hEventsField(rows[0], "topic") == kHEventsTopic && hEventsField(rows[0], "key") == "lock-7" && rows[0].contains("payload") &&
                 hEventsField(rows[0]["payload"], "command_id") == "cmd-1" && hEventsField(rows[0]["payload"], "outcome") == "accepted",
             "the outbox row is %s, expected the topic, the key lock-7 and the event payload", rows[0].dump());
  ctx.Assert(!(rows[0]["payload"].is_object() && rows[0]["payload"].contains("params")) && rows[0]["payload"].dump().find("4711") == std::string::npos,
             "the outbox row carries the command's params (%s): the row holds the event the topic would have received, never the PIN", rows[0]["payload"].dump());
  ctx.Equal(ok, false, "publishTransition's result after a failed delivery");
  ctx.Kafka.Stall(kHEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishTransition(hEventsCommand(2), "accepted");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 2.5, "publishTransition waited %.1f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = hEventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && hEventsField(rows[1]["payload"], "command_id") == "cmd-2",
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishTransition's result without a delivery report");
}
`,
  },
  hints: [
    "Publish `accepted` and then `delivered` for one lock: the two records carry different keys and can land on different partitions. Read one record's value: the PIN is in it.",
    'The key is the command id, which spreads one device over every partition; the payload copies `params` whole; `acks=1` without idempotence lets a retry duplicate and a failover lose; nothing reads the delivery report, so the call answers `True` whatever the broker did.',
    '`key=command["device_id"]`; drop `params` from `event_payload`; `enable.idempotence: True` with `acks: all`; produce with `on_delivery`, `flush(ACK_TIMEOUT_S)`, and on an error or a record still in flight `outbox.insert(TOPIC, device_id, payload)` and return `False`.',
  ],
  debrief: `The key is an ordering contract: Kafka keeps order within a partition and the audit needs one device's history in order, so the device id is the key and the command id is a field. The topic outlives the request and every consumer group can read it, which is why the event carries ids and the outcome while the parameters stay in the command store. Idempotence and \`acks=all\` cover what a retry and a failover do to the log; the delivery report is what makes \`True\` mean something, and the outbox turns an outage into a delay. Production pipelines write the outbox row in the same transaction as the state change and let a relay publish it, so no transition depends on the broker being up at that moment.`,
};
