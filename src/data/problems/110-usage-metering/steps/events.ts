import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Usage events keyed by account for analytics',
  concept: 'kafka',
  file: 'events',
  focus: ['kafka', 'api', 'store', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes a rollup event per
report. It compiles, it serves the demo, and it hides three production flaws. Review it like the
service owner, fix it, and prove the fix with the checks below.

Implement the rollup publisher for \`usage.rollup\`.

- Events are **keyed by account**, so one account's usage stream stays in one partition and arrives in
  order. Keying by the gateway scatters an account's events across partitions and lets a rollup be
  computed from events in the wrong order.
- The event carries the **account, the period, the units and the cap state** — and nothing else.
  Request payloads and endpoint arguments (query strings, paths) are user data and must never be
  copied into a retained, replicated topic.
- The event is published **after** the counters commit: \`apply_usage\` first, \`produce\` second. An
  event that describes usage the meter never recorded is worse than no event, because the analytics
  rollup will disagree with billing forever.
- The topic is \`usage.rollup\` and the producer waits for all in-sync replicas.

**Failure mode the checks target.** The draft keys by the gateway, so ordering is lost; it copies the
query string into the event, so user data lands in a topic that outlives the request; and it produces
before the counters commit, so a crash between the two leaves an event for usage that was never
counted — an analytics total that can never tie out against the meter.`,
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
        'The produced message is keyed by the account so one account’s usage stays in one partition and in order. The draft keys by the gateway, which scatters the stream.',
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
        'The event carries the period, the units and the cap state only — no query strings, no paths, no payloads. The draft publishes the query string for "product analytics".',
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
        'The rollup is produced after `apply_usage` has committed the counters. The draft produces first and counts second, so an event can describe usage the meter never recorded.',
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
        'The event names the period, the units and the cap state so a rollup can be computed without re-reading the meter. The draft’s event has neither the period nor the cap state.',
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
    # TODO: this draft keys by the gateway, so an account's usage scatters across partitions and the
    # rollup loses ordering; it publishes the query string for product analytics, copying user data
    # into a retained topic; and it produces before the counters commit, so an event can describe
    # usage the meter never recorded. Review all three.
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
      starter: `/** usage.rollup: a model-generated draft that keys by gateway and copies the query string. */
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
  // TODO: this draft keys by the gateway, so an account's usage scatters across partitions and the
  // rollup loses ordering; it publishes the query string for product analytics, copying user data
  // into a retained topic; and it produces before the counters commit, so an event can describe
  // usage the meter never recorded. Review all three.
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
	// TODO: this draft keys by the gateway, so an account's usage scatters across partitions and the
	// rollup loses ordering; it publishes the query string for product analytics, copying user data
	// into a retained topic; and it produces before the counters commit, so an event can describe
	// usage the meter never recorded. Review all three.
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
    // TODO: this draft keys by the gateway, so an account's usage scatters across partitions and the
    // rollup loses ordering; it publishes the query string for product analytics, copying user data
    // into a retained topic; and it produces before the counters commit, so an event can describe
    // usage the meter never recorded. Review all three.
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
  // TODO: this draft keys by the gateway, so an account's usage scatters across partitions and the
  // rollup loses ordering; it publishes the query string for product analytics, copying user data
  // into a retained topic; and it produces before the counters commit, so an event can describe
  // usage the meter never recorded. Review all three.
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
    'The key decides the partition, and the partition decides the order. Key by the account so a rollup for one account is computed from a single ordered stream; key by the gateway and the same account’s events land wherever the gateway count happens to hash.',
    'The topic is retained and replicated. Anything you put in the value outlives the request, so copy ids and counters — period, units, cap state — never payloads or endpoint arguments. If analytics needs a path, aggregate it before the event.',
    'Produce after the counter commit. `apply_usage` first, `produce` second: an event for usage the meter never recorded can never be reconciled, and the rollup will disagree with billing forever.',
  ],
  debrief: `The interviewer is testing the ordering and content rules of an event pipeline. Three defects, all
quiet: keying by the gateway loses per-account order, so a rollup consumer can compute an average from
events that arrived out of order; the query string in the value puts user data into a topic with
retention and replication, where it outlives the request and the tenant; and producing before the
counters commit means the event and the meter can disagree after a crash. The fix is to key by the
account, to keep the event to ids and counters, and to publish only after the counter commit — the
same outbox discipline as the read path. Real systems add a schema registry so the event shape is
versioned, an outbox row when the broker rejects the produce, and a rollup consumer that commits its
offset only after it has written the aggregate.`,
};
