import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Usage events keyed by account for analytics',
  concept: 'kafka',
  file: 'events',
  focus: ['kafka', 'api', 'store', 'redis'],
  task: `## Task

**Starting point.** The starter is the rollup publisher for \`usage.rollup\`: \`publish_rollup\` builds
an event with the account, the gateway, the query string and the units, produces it keyed by the
gateway, and then calls \`apply_usage\` to commit the counters. It compiles, serves the demo and
hides four flaws.

**Failure mode the checks target.** Keying by the gateway scatters one account's events across
partitions, so a rollup consumer sees them out of order; the query string in the value puts user
data into a topic that outlives the request; and producing before the counters commit means a
crash between the two leaves an event for usage the meter has no record of, so the analytics total
cannot tie out against billing.

- Events are **keyed by account**, so one account's usage stream stays in one partition and arrives
  in order.
- The event carries the **account, the period, the units and the cap state** and nothing else.
  Request payloads and endpoint arguments (query strings, paths) are user data and do not belong in
  a retained, replicated topic.
- The event is published **after** the counters commit: \`apply_usage\` first, \`produce\` second.
- The topic is \`usage.rollup\` and the producer waits for all in-sync replicas.`,
  sequence: {
    participants: ['Metering worker', 'Redis counters', 'usage.rollup'],
    messages: [
      {from: 'Metering worker', to: 'Redis counters', label: 'apply_usage(account, period, units)', kind: 'sync'},
      {from: 'Redis counters', to: 'Metering worker', label: '{total, cap, over}', kind: 'reply'},
      {
        from: 'Metering worker',
        to: 'usage.rollup',
        label: 'produce key=account · {period, units, cap_state}',
        kind: 'async',
      },
      {from: 'usage.rollup', to: 'Metering worker', label: 'ack', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'key-account',
      title: 'Keys the event by account',
      detail:
        'The produced message is keyed by the account so one account’s usage stays in one partition and in order. The starter keys by the gateway, which scatters the stream.',
      match: {
        python: {all: [/key=account/], none: [/key=gateway/]},
        typescript: {all: [/key: account/], none: [/key: gateway/]},
        go: {all: [/Key:\s*\[\]byte\(account\)/], none: [/Key:\s*\[\]byte\(gateway\)/]},
        scala: {all: [/key\s*=\s*account|Topic, account/], none: [/key\s*=\s*gateway|Topic, gateway/]},
        cpp: {all: [/key\s*=\s*account/], none: [/key\s*=\s*gateway/]},
      },
    },
    {
      id: 'no-content',
      title: 'Keeps request content out of the event',
      detail:
        'The event carries the period, the units and the cap state only — no query strings, no paths, no payloads. The starter publishes the query string for "product analytics".',
      match: {
        python: {all: [/cap_state/], none: [/query/]},
        typescript: {all: [/capState/], none: [/query/]},
        go: {all: [/CapState/], none: [/[Qq]uery/]},
        scala: {all: [/capState/], none: [/[Qq]uery/]},
        cpp: {all: [/cap_state/, /CapState|cap_state/], none: [/[Qq]uery/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Publishes only after the counters commit',
      detail:
        'The rollup is produced after `apply_usage` has committed the counters. The starter produces first and counts second, so an event can describe usage the meter never recorded.',
      match: {
        python: {order: [/apply_usage\(/, /producer\.produce\(/]},
        typescript: {order: [/applyUsage\(/, /producer\.send\(/]},
        go: {order: [/ApplyUsage\(/, /WriteMessages\(/]},
        scala: {order: [/applyUsage\(/, /\.send\(/]},
        cpp: {order: [/applyUsage\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'topic',
      title: 'Publishes to usage.rollup',
      detail: 'The event topic is `usage.rollup`.',
      match: {
        python: {all: [/usage\.rollup/]},
        typescript: {all: [/usage\.rollup/]},
        go: {all: [/usage\.rollup/]},
        scala: {all: [/usage\.rollup/]},
        cpp: {all: [/usage\.rollup/]},
      },
    },
    {
      id: 'event-fields',
      title: 'Carries period, units and cap state',
      detail:
        'The event names the period, the units and the cap state so a rollup can be computed without re-reading the meter. The starter’s event has neither the period nor the cap state.',
      match: {
        python: {all: [/period/, /units/, /cap_state/]},
        typescript: {all: [/period/, /units/, /capState/]},
        go: {all: [/Period/, /Units/, /CapState/]},
        scala: {all: [/period/, /units/, /capState/]},
        cpp: {all: [/period/, /units/, /cap_state/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from state import apply_usage

logger = logging.getLogger("metering")

TOPIC = "usage.rollup"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_rollup(
    account: str, period: str, units: int, route: str, gateway: str, query_string: str
) -> None:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    event = {"account": account, "gateway": gateway, "query": query_string, "units": units}
    producer.produce(TOPIC, key=gateway, value=json.dumps(event).encode("utf-8"))
    producer.poll(0)
    apply_usage(account, period, route, units, gateway)
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from state import apply_usage

logger = logging.getLogger("metering")

TOPIC = "usage.rollup"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def publish_rollup(account: str, period: str, units: int, route: str, gateway: str) -> None:
    total = apply_usage(account, period, route, units, gateway)
    event = {
        "account": account,
        "period": period,
        "units": units,
        "cap_state": "over" if total["over"] else "under",
    }
    producer.produce(TOPIC, key=account, value=json.dumps(event).encode("utf-8"))
    producer.poll(0)
`,
    },
    typescript: {
      starter: `/** usage.rollup. */
import {Kafka} from 'kafkajs';

import {applyUsage} from './state';

const kafka = new Kafka({clientId: 'metering', brokers: ['kafka:9092']});
const producer = kafka.producer();

const TOPIC = 'usage.rollup';

export async function publishRollup(
  account: string,
  period: string,
  units: number,
  route: string,
  gateway: string,
  queryString: string,
): Promise<void> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const event = {account, gateway, query: queryString, units};
  await producer.send({topic: TOPIC, messages: [{key: gateway, value: JSON.stringify(event)}]});
  await applyUsage(account, period, route, units, gateway);
}
`,
      solution: `/** usage.rollup: one event per account, published after the counters commit. */
import {Kafka} from 'kafkajs';

import {applyUsage} from './state';

const kafka = new Kafka({clientId: 'metering', brokers: ['kafka:9092']});
const producer = kafka.producer({acks: -1, idempotent: true});

const TOPIC = 'usage.rollup';

export interface RollupEvent {
  account: string;
  period: string;
  units: number;
  capState: string;
}

export async function publishRollup(
  account: string,
  period: string,
  units: number,
  route: string,
  gateway: string,
): Promise<void> {
  const result = await applyUsage(account, period, route, units, gateway);
  const event: RollupEvent = {
    account: account,
    period: period,
    units: units,
    capState: result.over ? 'over' : 'under',
  };
  await producer.send({topic: TOPIC, messages: [{key: account, value: JSON.stringify(event)}]});
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	kafka "github.com/segmentio/kafka-go"
)

const topic = "usage.rollup"

var producer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	BatchTimeout: 10 * time.Millisecond,
}

func PublishRollup(ctx context.Context, account, period string, units int, route, gateway, queryString string) error {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	event := map[string]any{"account": account, "gateway": gateway, "query": queryString, "units": units}
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := producer.WriteMessages(ctx, kafka.Message{Key: []byte(gateway), Value: value}); err != nil {
		return err
	}
	_, err = ApplyUsage(ctx, account, period, route, units, gateway)
	return err
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	kafka "github.com/segmentio/kafka-go"
)

const topic = "usage.rollup"

var producer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 10 * time.Millisecond,
}

type RollupEvent struct {
	Account  string \`json:"account"\`
	Period   string \`json:"period"\`
	Units    int    \`json:"units"\`
	CapState string \`json:"cap_state"\`
}

func PublishRollup(ctx context.Context, account, period string, units int, route, gateway string) error {
	result, err := ApplyUsage(ctx, account, period, route, units, gateway)
	if err != nil {
		return err
	}
	capState := "under"
	if over, ok := result["over"].(int64); ok && over == 1 {
		capState = "over"
	}
	event := RollupEvent{Account: account, Period: period, Units: units, CapState: capState}
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return producer.WriteMessages(ctx, kafka.Message{Key: []byte(account), Value: value})
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

object Events {
  val Topic = "usage.rollup"

  val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")

  val producer = new KafkaProducer[String, String](props)

  def publishRollup(account: String, period: String, units: Int, route: String, gateway: String, queryString: String): Unit = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val payload = s"""{"account":"$account","gateway":"$gateway","query":"$queryString","units":$units}"""
    producer.send(new ProducerRecord[String, String](Topic, gateway, payload))
    MeteringState.applyUsage(account, period, route, units, gateway)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

object Events {
  val Topic = "usage.rollup"

  val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")

  val producer = new KafkaProducer[String, String](props)

  def publishRollup(account: String, period: String, units: Int, route: String, gateway: String): Unit = {
    val result = MeteringState.applyUsage(account, period, route, units, gateway)
    val capState = if (result("over") == true) "over" else "under"
    val payload =
      s"""{"account":"$account","period":"$period","units":$units,"cap_state":"$capState"}"""
    producer.send(new ProducerRecord[String, String](Topic, account, payload))
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <string>

const std::string kTopic = "usage.rollup";

void publishRollup(RdKafka::Producer* producer, const std::string& account, const std::string& period,
                   int units, const std::string& route, const std::string& gateway,
                   const std::string& queryString) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string key = gateway;
  const std::string payload = "{\\"account\\":\\"" + account + "\\",\\"query\\":\\"" + queryString +
                              "\\",\\"units\\":" + std::to_string(units) + "}";
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), key.data(), key.size(), 0, nullptr);
  applyUsage(account, period, route, units, gateway);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <string>

const std::string kTopic = "usage.rollup";

void publishRollup(RdKafka::Producer* producer, const std::string& account, const std::string& period,
                   int units, const std::string& route, const std::string& gateway) {
  const auto result = applyUsage(account, period, route, units, gateway);
  const std::string cap_state = "under";
  const std::string key = account;
  const std::string payload = "{\\"account\\":\\"" + account + "\\",\\"period\\":\\"" + period +
                              "\\",\\"units\\":" + std::to_string(units) + ",\\"cap_state\\":\\"" + cap_state + "\\"}";
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), key.data(), key.size(), 0, nullptr);
}
`,
    },
  },
  hints: [
    'An account served by two gateways shows a rollup that jumps backwards, a customer’s search terms turn up in the analytics topic, and after a worker crash analytics reports units billing has no row for.',
    'Look at the produce call: its key is `gateway`, its value includes `query_string` and lacks `period` and `cap_state`, and it runs before `apply_usage`, so the event exists before the counters do.',
    'Call `apply_usage` first and read the cap state from its result; then produce with `key=account` and a value of account, `period`, `units` and `cap_state`, dropping the query string and the gateway.',
  ],
  debrief: `The key is the account because Kafka orders within a partition and nowhere else; the partition
is chosen from the key, so the key has to be the thing whose order matters. The value is ids and
counters only, because retention and replication make the topic the longest-lived copy of anything
written to it, and a query string is user data with no reason to live that long. Producing after
\`apply_usage\` makes the event a description of state that exists, which is the only kind a rollup
consumer can reconcile. Production publishers usually version the event shape through a schema
registry and fall back to an outbox row when the broker rejects the produce, so the counters and the
event cannot drift apart under a broker outage either.`,
};
