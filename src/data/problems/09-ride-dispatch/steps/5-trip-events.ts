import type {Step} from '@/lib/types';

// ---- 5. Trip events through Kafka into a state-machine consumer --------------------------------
export const tripEventsStep: Step = {
  id: 'trip-events',
  title: 'Trip events: keyed producer, state-machine consumer',
  concept: 'kafka',
  file: 'trip_events',
  focus: ['dispatcher', 'kafka'],
  task: `## Task

Everything that happens to a ride — \`requested\`, \`matched\`, \`started\`, \`completed\`, \`cancelled\` —
is an event on the **\`trip-events\`** topic, and the ride's status is whatever the consumer group
**\`trip-state\`** has applied so far. The transition table is provided: \`can_transition(current, event)\`
says whether \`event\` may follow the ride's current state (\`requested\` is the only event an unseen ride
accepts). \`rides.get\` / \`rides.set_status\` are provided.

- The producer uses **\`acks=all\`** and the **idempotent producer**: a lost or duplicated \`completed\`
  is a billing bug. \`publish_event(ride_id, event)\` produces to \`trip-events\` **keyed by \`ride_id\`**,
  so one ride's events land on one partition, in order.
- The consumer disables auto-commit and, per record: look up the ride's current status; if the
  transition is **illegal** (a \`started\` after \`completed\`, a duplicate \`matched\`), log it, **commit**,
  and move on — the record is not going to become legal by being read again. If it is legal,
  \`set_status\`, **then** commit.

:::widget kafka-partitions {"partitions": 8}

> Keying by ride id is what makes the state machine possible: with \`matched\` and \`started\` on different
> partitions, two consumers could apply them in either order.

:::widget delivery-semantics {}`,
  sequence: {
    participants: ['dispatcher', 'Kafka', 'trip-state', 'ride store'],
    messages: [
      {
        from: 'dispatcher',
        to: 'Kafka',
        label: 'produce trip-events key=r-42 {event: matched} · acks=all',
        kind: 'sync',
      },
      {from: 'Kafka', to: 'dispatcher', label: 'ack (all in-sync replicas)', kind: 'reply'},
      {from: 'Kafka', to: 'trip-state', label: 'poll → record (partition 3, offset 518)', kind: 'reply'},
      {
        from: 'trip-state',
        to: 'ride store',
        label: 'get r-42 → requested · can_transition(requested, matched) ✓',
        kind: 'sync',
      },
      {from: 'trip-state', to: 'ride store', label: 'set_status r-42 matched', kind: 'sync'},
      {from: 'trip-state', to: 'Kafka', label: 'commit offset 519 (partition 3)', kind: 'sync'},
      {
        from: 'Kafka',
        to: 'trip-state',
        label: 'record r-99 {event: started} but r-99 is completed → log, commit',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Two configurations, two jobs: the producer gets `acks=all` + idempotence, the consumer gets `group.id=trip-state` + auto-commit off. Neither helps the other.',
    'The consumer loop has three exits per record: illegal → log + commit + continue; legal → set_status + commit; a failure in set_status → do not commit (the record is redelivered). Write them in that order.',
    'Skipping an illegal transition and still committing is deliberate: the event is wrong, not the consumer, and re-reading it forever would block every later event on that partition.',
  ],
  checks: [
    {
      id: 'durable-producer',
      title: 'Producer waits for all in-sync replicas and is idempotent',
      detail:
        '`acks=all` means a leader failover cannot lose an acknowledged event; the idempotent producer means its own retries cannot duplicate one. (kafka-go has no idempotent mode: `RequireAll` is what it can promise.)',
      match: {
        python: {all: [/"acks"\s*:\s*"all"/, /"enable\.idempotence"\s*:\s*True/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"acks"\s*,\s*"all"/, /"enable\.idempotence"\s*,\s*"true"/]},
        cpp: {all: [/"acks"\s*,\s*"all"/, /"enable\.idempotence"\s*,\s*"true"/]},
      },
    },
    {
      id: 'keyed-by-ride',
      title: 'Produces to trip-events keyed by ride_id',
      detail: 'The record key is the ride id, so every event of one ride shares a partition and keeps its order.',
      match: {
        python: {all: [/producer\.produce\(\s*(?:TOPIC|"trip-events")\s*,[^\n]*\bkey\s*=\s*ride_id\b/]},
        typescript: {all: [/\.send\(\s*\{[^\n]*topic:\s*(?:TOPIC|['"]trip-events['"])[\s\S]{0,200}?\bkey:\s*rideId\b/]},
        go: {all: [/writer\.WriteMessages\(/, /Key:\s*\[\]byte\(\s*rideID\s*\)/]},
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*(?:Topic|"trip-events")\s*,\s*rideId\s*,/]},
        cpp: {
          all: [
            /producer->produce\(\s*(?:kTopic|"trip-events")[\s\S]{0,300}?ride_id\.(?:c_str|data)\(\)\s*,\s*ride_id\.(?:size|length)\(\)/,
          ],
        },
      },
    },
    {
      id: 'manual-commit',
      title: 'Disables auto-commit',
      detail:
        'Offsets are committed explicitly, after the status write — not on a timer that cannot know whether the write happened.',
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/]},
        typescript: {all: [/autoCommit:\s*false/]},
        go: {all: [/reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"enable\.auto\.commit"\s*,\s*"false"/]},
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/]},
      },
    },
    {
      id: 'illegal-skipped',
      title: 'Logs and skips illegal transitions',
      detail:
        'Ask `can_transition(current, event)` for every record; when it says no, log the record and do not write the status.',
      match: {
        python: {all: [/(?<!def )\bcan_transition\(/, /log\.\w+\(/]},
        typescript: {all: [/(?<!function )\bcanTransition\(/, /console\.\w+\(/]},
        go: {all: [/(?<!func )\bcanTransition\(/, /log\.Printf\(/]},
        scala: {all: [/(?<!def )\bcanTransition\(/, /println\(/]},
        cpp: {all: [/\bcan_transition\(\s*(?!const\b)\w/, /std::cerr/]},
      },
    },
    {
      id: 'set-then-commit',
      title: 'Commits after the status write',
      detail:
        'Commit the offset only once `set_status` ran: at-least-once, never at-most-once. A crash in between replays an event the state machine will now reject as a duplicate.',
      match: {
        python: {order: [/rides\.set_status\(/, /consumer\.commit\(/]},
        typescript: {order: [/rides\.setStatus\(/, /\.commitOffsets\(/]},
        go: {order: [/(?<!func )\bsetStatus\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/(?<!def )\bsetStatus\(/, /consumer\.commitSync\(/]},
        cpp: {order: [/\bset_status\(\s*(?!const\b)\w/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

from confluent_kafka import Consumer, Producer

from ride_store import rides  # provided: rides.get(ride_id) -> dict | None; rides.set_status(ride_id, status)

TOPIC = "trip-events"
log = logging.getLogger("trip-events")

# event → the states it may follow; None is the state of a ride nobody has seen yet
TRANSITIONS = {
    "requested": {None},
    "matched": {"requested"},
    "started": {"matched"},
    "completed": {"started"},
    "cancelled": {"requested", "matched"},
}


def can_transition(current: str | None, event: str) -> bool:
    return current in TRANSITIONS.get(event, set())


producer = Producer({"bootstrap.servers": "kafka:9092"})  # TODO: acks=all and the idempotent producer


def publish_event(ride_id: str, event: str) -> None:
    value = json.dumps({"ride_id": ride_id, "event": event, "ts": time.time()})
    # TODO: produce to TOPIC keyed by ride_id; poll(0) to serve delivery callbacks
    raise NotImplementedError


consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "trip-state",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe([TOPIC])


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        event = json.loads(msg.value())
        ride_id, kind = event["ride_id"], event["event"]
        # TODO: current = status of rides.get(ride_id) (None when unknown); not can_transition → log, commit, continue
        # TODO: rides.set_status(ride_id, kind), then commit this message
        raise NotImplementedError
`,
      solution: `import json
import logging
import time

from confluent_kafka import Consumer, Producer

from ride_store import rides  # provided: rides.get(ride_id) -> dict | None; rides.set_status(ride_id, status)

TOPIC = "trip-events"
log = logging.getLogger("trip-events")

# event → the states it may follow; None is the state of a ride nobody has seen yet
TRANSITIONS = {
    "requested": {None},
    "matched": {"requested"},
    "started": {"matched"},
    "completed": {"started"},
    "cancelled": {"requested", "matched"},
}


def can_transition(current: str | None, event: str) -> bool:
    return current in TRANSITIONS.get(event, set())


producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def publish_event(ride_id: str, event: str) -> None:
    value = json.dumps({"ride_id": ride_id, "event": event, "ts": time.time()})
    producer.produce(TOPIC, key=ride_id, value=value)
    producer.poll(0)


consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "trip-state",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC])


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        event = json.loads(msg.value())
        ride_id, kind = event["ride_id"], event["event"]
        ride = rides.get(ride_id)
        current = ride["status"] if ride else None
        if not can_transition(current, kind):
            log.warning("ride %s: illegal %s → %s at offset %d; skipping", ride_id, current, kind, msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        rides.set_status(ride_id, kind)
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {type EachMessagePayload, Kafka} from 'kafkajs';

import {rides} from 'ride_store'; // provided: rides.get(rideId) -> Ride | null; rides.setStatus(rideId, status)

export const TOPIC = 'trip-events';

// event → the states it may follow; null is the state of a ride nobody has seen yet
const TRANSITIONS: Record<string, (string | null)[]> = {
  requested: [null],
  matched: ['requested'],
  started: ['matched'],
  completed: ['started'],
  cancelled: ['requested', 'matched'],
};

export function canTransition(current: string | null, event: string): boolean {
  return (TRANSITIONS[event] ?? []).includes(current);
}

const kafka = new Kafka({clientId: 'dispatcher', brokers: ['kafka:9092']});
const producer = kafka.producer(); // TODO: the idempotent producer (acks all)
let connected: Promise<void> | null = null;

export async function publishEvent(rideId: string, event: string): Promise<void> {
  connected ??= producer.connect();
  await connected;
  const value = JSON.stringify({ride_id: rideId, event, ts: Date.now() / 1000});
  // TODO: send to TOPIC with acks: -1, keyed by rideId
  throw new Error(\`not implemented: \${value}\`);
}

const consumer = kafka.consumer({groupId: 'trip-state'});

async function handle({topic, partition, message}: EachMessagePayload): Promise<void> {
  const event = JSON.parse(message.value?.toString() ?? '{}') as {ride_id: string; event: string};
  const rideId = event.ride_id;
  const kind = event.event;
  // TODO: current = status of rides.get(rideId) (null when unknown); not canTransition → log, commit, return
  // TODO: rides.setStatus(rideId, kind), then commitOffsets this message (offset + 1) on topic/partition
  throw new Error(\`not implemented: \${rideId} \${kind} \${topic}/\${partition}\`);
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({eachMessage: handle}); // TODO: disable auto-commit
}
`,
      solution: `import {type EachMessagePayload, Kafka} from 'kafkajs';

import {rides} from 'ride_store'; // provided: rides.get(rideId) -> Ride | null; rides.setStatus(rideId, status)

export const TOPIC = 'trip-events';

// event → the states it may follow; null is the state of a ride nobody has seen yet
const TRANSITIONS: Record<string, (string | null)[]> = {
  requested: [null],
  matched: ['requested'],
  started: ['matched'],
  completed: ['started'],
  cancelled: ['requested', 'matched'],
};

export function canTransition(current: string | null, event: string): boolean {
  return (TRANSITIONS[event] ?? []).includes(current);
}

const kafka = new Kafka({clientId: 'dispatcher', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
let connected: Promise<void> | null = null;

export async function publishEvent(rideId: string, event: string): Promise<void> {
  connected ??= producer.connect();
  await connected;
  const value = JSON.stringify({ride_id: rideId, event, ts: Date.now() / 1000});
  await producer.send({topic: TOPIC, acks: -1, messages: [{key: rideId, value}]});
}

const consumer = kafka.consumer({groupId: 'trip-state'});

async function handle({topic, partition, message}: EachMessagePayload): Promise<void> {
  const event = JSON.parse(message.value?.toString() ?? '{}') as {ride_id: string; event: string};
  const rideId = event.ride_id;
  const kind = event.event;
  const current = rides.get(rideId)?.status ?? null;
  if (!canTransition(current, kind)) {
    console.warn(\`ride \${rideId}: illegal \${current} → \${kind} at offset \${message.offset}; skipping\`);
    await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    return;
  }
  rides.setStatus(rideId, kind);
  await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({autoCommit: false, eachMessage: handle});
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

const topic = "trip-events"

// Provided (ride_store.go): getStatus is "" for a ride nobody has seen yet.
func getStatus(ctx context.Context, rideID string) string   { panic("not implemented") }
func setStatus(ctx context.Context, rideID, status string) { panic("not implemented") }

// transitions maps an event to the states it may follow; "" is the state of an unseen ride.
var transitions = map[string][]string{
	"requested": {""},
	"matched":   {"requested"},
	"started":   {"matched"},
	"completed": {"started"},
	"cancelled": {"requested", "matched"},
}

func canTransition(current, event string) bool {
	for _, from := range transitions[event] {
		if from == current {
			return true
		}
	}
	return false
}

type tripEvent struct {
	RideID string  \`json:"ride_id"\`
	Event  string  \`json:"event"\`
	Ts     float64 \`json:"ts"\`
}

// TODO: RequiredAcks all (kafka-go has no idempotent mode); Balancer Hash so equal keys share a partition
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic}

func publishEvent(ctx context.Context, rideID, event string) error {
	value, _ := json.Marshal(tripEvent{RideID: rideID, Event: event, Ts: float64(time.Now().UnixMilli()) / 1000})
	// TODO: WriteMessages one kafka.Message keyed by rideID
	_ = value
	return nil
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "trip-state",
	Topic:   topic,
})

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: parse; !canTransition(getStatus(...), event) → log, CommitMessages, continue
		// TODO: setStatus, then CommitMessages
		log.Println("not implemented")
		return nil
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

const topic = "trip-events"

// Provided (ride_store.go): getStatus is "" for a ride nobody has seen yet.
func getStatus(ctx context.Context, rideID string) string   { panic("not implemented") }
func setStatus(ctx context.Context, rideID, status string) { panic("not implemented") }

// transitions maps an event to the states it may follow; "" is the state of an unseen ride.
var transitions = map[string][]string{
	"requested": {""},
	"matched":   {"requested"},
	"started":   {"matched"},
	"completed": {"started"},
	"cancelled": {"requested", "matched"},
}

func canTransition(current, event string) bool {
	for _, from := range transitions[event] {
		if from == current {
			return true
		}
	}
	return false
}

type tripEvent struct {
	RideID string  \`json:"ride_id"\`
	Event  string  \`json:"event"\`
	Ts     float64 \`json:"ts"\`
}

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

func publishEvent(ctx context.Context, rideID, event string) error {
	value, _ := json.Marshal(tripEvent{RideID: rideID, Event: event, Ts: float64(time.Now().UnixMilli()) / 1000})
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(rideID), Value: value})
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "trip-state",
	Topic:   topic,
})

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var ev tripEvent
		if err := json.Unmarshal(msg.Value, &ev); err != nil || ev.RideID == "" {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		current := getStatus(ctx, ev.RideID)
		if !canTransition(current, ev.Event) {
			log.Printf("ride %s: illegal %q → %q at offset %d; skipping", ev.RideID, current, ev.Event, msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		setStatus(ctx, ev.RideID, ev.Event)
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.jdk.CollectionConverters._

object TripEvents {
  val Topic = "trip-events"

  /** Provided (RideStore): getStatus is None for a ride nobody has seen yet. */
  def getStatus(rideId: String): Option[String] = ???
  def setStatus(rideId: String, status: String): Unit = ???

  /** Event → the states it may follow; None is the state of an unseen ride. */
  val Transitions: Map[String, Set[Option[String]]] = Map(
    "requested" -> Set(None),
    "matched" -> Set(Some("requested")),
    "started" -> Set(Some("matched")),
    "completed" -> Set(Some("started")),
    "cancelled" -> Set(Some("requested"), Some("matched")),
  )

  def canTransition(current: Option[String], event: String): Boolean =
    Transitions.getOrElse(event, Set.empty).contains(current)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  // TODO: acks=all and the idempotent producer
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  def publishEvent(rideId: String, event: String): Unit = {
    val value = s"""{"ride_id":"$rideId","event":"$event","ts":\${System.currentTimeMillis() / 1000.0}}"""
    // TODO: send a ProducerRecord(Topic, rideId, value) — the key keeps one ride's events on one partition
  }

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", "trip-state")
  consumerProps.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  private val EventField = """"event"\\s*:\\s*"([^"]+)"""".r

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val rideId = record.key()
        val event = EventField.findFirstMatchIn(record.value()).map(_.group(1)).getOrElse("")
        // TODO: !canTransition(getStatus(rideId), event) → log and skip (the batch commit below still covers it)
        // TODO: setStatus(rideId, event)
      }
      // TODO: commitSync after every record of the batch is applied
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.jdk.CollectionConverters._

object TripEvents {
  val Topic = "trip-events"

  /** Provided (RideStore): getStatus is None for a ride nobody has seen yet. */
  def getStatus(rideId: String): Option[String] = ???
  def setStatus(rideId: String, status: String): Unit = ???

  /** Event → the states it may follow; None is the state of an unseen ride. */
  val Transitions: Map[String, Set[Option[String]]] = Map(
    "requested" -> Set(None),
    "matched" -> Set(Some("requested")),
    "started" -> Set(Some("matched")),
    "completed" -> Set(Some("started")),
    "cancelled" -> Set(Some("requested"), Some("matched")),
  )

  def canTransition(current: Option[String], event: String): Boolean =
    Transitions.getOrElse(event, Set.empty).contains(current)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  def publishEvent(rideId: String, event: String): Unit = {
    val value = s"""{"ride_id":"$rideId","event":"$event","ts":\${System.currentTimeMillis() / 1000.0}}"""
    producer.send(new ProducerRecord[String, String](Topic, rideId, value))
  }

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", "trip-state")
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  private val EventField = """"event"\\s*:\\s*"([^"]+)"""".r

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val rideId = record.key()
        val event = EventField.findFirstMatchIn(record.value()).map(_.group(1)).getOrElse("")
        val current = getStatus(rideId)
        if (!canTransition(current, event))
          System.err.println(s"ride $rideId: illegal \${current.getOrElse("<new>")} → $event at offset \${record.offset()}; skipping")
        else setStatus(rideId, event)
      }
      consumer.commitSync() // after every record of the batch has been applied or skipped
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <map>
#include <memory>
#include <regex>
#include <set>
#include <string>

#include "ride_store.h"  // std::string get_status(const std::string& ride_id) — "" when unseen; void set_status(const std::string& ride_id, const std::string& status)

const std::string kTopic = "trip-events";

// Event → the states it may follow; "" is the state of an unseen ride.
const std::map<std::string, std::set<std::string>> kTransitions = {
    {"requested", {""}},        {"matched", {"requested"}},
    {"started", {"matched"}},   {"completed", {"started"}},
    {"cancelled", {"requested", "matched"}},
};

bool can_transition(const std::string& current, const std::string& event) {
  const auto it = kTransitions.find(event);
  return it != kTransitions.end() && it->second.count(current) > 0;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // TODO: acks=all and enable.idempotence=true
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "trip-state", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();
const std::regex kEventField(R"("event"\\s*:\\s*"([^"]+)")");

void publish_event(const std::string& ride_id, const std::string& event) {
  const std::string value = "{\\"ride_id\\":\\"" + ride_id + "\\",\\"event\\":\\"" + event + "\\"}";
  // TODO: produce to kTopic keyed by ride_id (RK_MSG_COPY); poll(0) to serve delivery callbacks
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string ride_id = msg->key() ? *msg->key() : "";
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    std::smatch m;
    const std::string event = std::regex_search(value, m, kEventField) ? m[1].str() : "";
    // TODO: !can_transition(get_status(ride_id), event) → log, commitSync, continue
    // TODO: set_status(ride_id, event), then commitSync this message
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <map>
#include <memory>
#include <regex>
#include <set>
#include <string>

#include "ride_store.h"  // std::string get_status(const std::string& ride_id) — "" when unseen; void set_status(const std::string& ride_id, const std::string& status)

const std::string kTopic = "trip-events";

// Event → the states it may follow; "" is the state of an unseen ride.
const std::map<std::string, std::set<std::string>> kTransitions = {
    {"requested", {""}},        {"matched", {"requested"}},
    {"started", {"matched"}},   {"completed", {"started"}},
    {"cancelled", {"requested", "matched"}},
};

bool can_transition(const std::string& current, const std::string& event) {
  const auto it = kTransitions.find(event);
  return it != kTransitions.end() && it->second.count(current) > 0;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "trip-state", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();
const std::regex kEventField(R"("event"\\s*:\\s*"([^"]+)")");

void publish_event(const std::string& ride_id, const std::string& event) {
  const std::string value = "{\\"ride_id\\":\\"" + ride_id + "\\",\\"event\\":\\"" + event + "\\"}";
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(value.data()), value.size(), ride_id.c_str(), ride_id.size(), 0, nullptr);
  producer->poll(0);  // serve delivery callbacks; returns immediately
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string ride_id = msg->key() ? *msg->key() : "";
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    std::smatch m;
    const std::string event = std::regex_search(value, m, kEventField) ? m[1].str() : "";
    const std::string current = get_status(ride_id);
    if (!can_transition(current, event)) {
      std::cerr << "ride " << ride_id << ": illegal " << current << " -> " << event << " at offset " << msg->offset()
                << "; skipping\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    set_status(ride_id, event);
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json
import logging


def _seed(ctx, *events):
    for ride_id, event in events:
        ctx.kafka.seed("trip-events", key=ride_id, value=json.dumps({"ride_id": ride_id, "event": event, "ts": 0}))


def _consumer(ctx):
    m = ctx.load("trip_events")
    import ride_store  # the provided store the learner's module just imported

    records = []
    handler = logging.Handler()
    handler.emit = records.append
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.INFO)
    return m, ride_store.rides, records


def _truthy(value):
    return value is True or str(value).lower() == "true"


def check_durable_producer(ctx):
    m, store, records = _consumer(ctx)
    conf = m.producer.conf
    assert str(conf.get("acks", "")).lower() in ("all", "-1"), f"the producer's acks is {conf.get('acks')!r}, expected all"
    assert _truthy(conf.get("enable.idempotence")), f"enable.idempotence is {conf.get('enable.idempotence')!r}, expected True"
    m.publish_event("r-42", "requested")
    assert len(ctx.kafka.records("trip-events")) == 1, "publish_event must produce one record"


def check_keyed_by_ride(ctx):
    m, store, records = _consumer(ctx)
    m.publish_event("r-42", "requested")
    m.publish_event("r-42", "matched")
    m.publish_event("r-7", "requested")
    produced = ctx.kafka.records("trip-events")
    assert len(produced) == 3, f"expected three records on trip-events, found {len(produced)}"
    keys = [r.key for r in produced]
    assert keys == [b"r-42", b"r-42", b"r-7"], f"records must be keyed by ride_id, got {keys}"
    assert produced[0].partition == produced[1].partition, "one ride's events must share a partition"
    first = json.loads(produced[0].value)
    assert first.get("ride_id") == "r-42" and first.get("event") == "requested", f"the value must be JSON with ride_id and event: {first}"


def check_manual_commit(ctx):
    _seed(ctx, ("r-42", "requested"), ("r-42", "matched"))
    m, store, records = _consumer(ctx)
    assert ctx.kafka.consumers[-1].auto_commit is False, "enable.auto.commit must be False"
    ctx.drain(m.run)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, not after the write"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened"
    assert ctx.kafka.lag("trip-state", "trip-events") == 0, "every applied record must be committed"
    assert store.get("r-42")["status"] == "matched", f"after requested, matched the ride must be matched, got {store.get('r-42')}"


def check_illegal_skipped(ctx):
    _seed(ctx, ("r-42", "requested"), ("r-42", "matched"), ("r-42", "matched"), ("r-42", "completed"), ("r-42", "started"), ("r-99", "started"))
    m, store, records = _consumer(ctx)
    ctx.drain(m.run)
    ride = store.get("r-42")
    assert ride is not None and ride.get("status") == "started", f"r-42 should be started (requested → matched → started; the duplicate matched and the early completed are illegal), got {ride}"
    assert store.get("r-99") is None, "started on a ride nobody has seen is illegal and must not create r-99"
    assert ctx.kafka.lag("trip-state", "trip-events") == 0, "illegal events must be committed too, or the partition replays them forever"
    logged = [r for r in records if r.levelno >= logging.INFO]
    assert len(logged) >= 3, f"three illegal transitions were skipped but only {len(logged)} log records were emitted"


def check_set_then_commit(ctx):
    _seed(ctx, ("r-42", "requested"))
    m, store, records = _consumer(ctx)
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(store.get("r-42")))
    ctx.drain(m.run)
    assert at_commit, "the offset was never committed"
    assert at_commit[0] is not None and at_commit[0].get("status") == "requested", f"the commit must come after set_status: at commit time r-42 was {at_commit[0]}"
    # A failing status write must not be committed: the record has to be redelivered.
    _seed(ctx, ("r-7", "requested"))
    real_set_status = store.set_status

    def failing_set_status(ride_id, status):
        if ride_id == "r-7":
            raise RuntimeError("ride store unavailable")
        real_set_status(ride_id, status)

    store.set_status = failing_set_status
    try:
        ctx.drain(m.run)
    except Exception:
        pass
    assert store.get("r-7") is None
    assert ctx.kafka.lag("trip-state", "trip-events") == 1, "set_status failed for r-7 but its offset was committed: the event is lost (at-most-once)"
`,
    typescript: `import {rides} from 'ride_store';

function seed(ctx, events: [string, string][]) {
  for (const [rideId, event] of events) {
    ctx.kafka.seed('trip-events', {key: rideId, value: JSON.stringify({ride_id: rideId, event, ts: 0})});
  }
}

/** The learner's module plus the provided store it imported; the learner's console output is collected. */
function consumer(ctx) {
  const m = ctx.load('trip_events');
  const logged: string[] = [];
  const real = {log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.warn = console.error = console.debug = capture;
  return {m, store: rides, logged, restore: () => Object.assign(console, real)};
}

export async function check_durable_producer(ctx) {
  const {m, restore} = consumer(ctx);
  try {
    // The broker writes the record but its acknowledgement is lost: a non-idempotent producer's retry writes it again.
    ctx.kafka.loseAcks('trip-events');
    await m.publishEvent('r-42', 'requested');
    let n = ctx.kafka.records('trip-events').length;
    assert(n >= 1, 'publishEvent must produce one record');
    assert.equal(n, 1, \`a lost ack made the producer write the event \${n} times: the idempotent producer makes its own retries write once\`);
    // A leader failover right after the ack: a record acknowledged by the leader alone (acks 0 or 1) is gone.
    await m.publishEvent('r-42', 'matched');
    ctx.kafka.failover('trip-events');
    n = ctx.kafka.records('trip-events').length;
    assert.equal(n, 2, \`a leader failover lost an acknowledged event (\${n} of 2 remain): wait for all in-sync replicas (acks: -1)\`);
  } finally {
    restore();
  }
}

export async function check_keyed_by_ride(ctx) {
  const {m, restore} = consumer(ctx);
  try {
    await m.publishEvent('r-42', 'requested');
    await m.publishEvent('r-42', 'matched');
    await m.publishEvent('r-7', 'requested');
    const produced = ctx.kafka.records('trip-events');
    assert.equal(produced.length, 3, \`expected three records on trip-events, found \${produced.length}\`);
    const keys = ctx.kafka.keys('trip-events');
    assert.deepEqual(keys, ['r-42', 'r-42', 'r-7'], \`records must be keyed by ride_id, got \${JSON.stringify(keys)}\`);
    assert.equal(produced[0].partition, produced[1].partition, "one ride's events must share a partition");
    const first = JSON.parse(String(produced[0].value));
    assert(first.ride_id === 'r-42' && first.event === 'requested', \`the value must be JSON with ride_id and event: \${JSON.stringify(first)}\`);
  } finally {
    restore();
  }
}

export async function check_manual_commit(ctx) {
  seed(ctx, [['r-42', 'requested'], ['r-42', 'matched']]);
  const {m, store, restore} = consumer(ctx);
  try {
    await ctx.drain(m.run());
    const consumers = ctx.kafka.consumers;
    assert(consumers.length > 0, 'no consumer joined the trip-state group');
    assert.equal(consumers[consumers.length - 1].autoCommit, false, 'autoCommit must be false: offsets are committed explicitly, after the status write');
    assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, not after the write');
    assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened');
    assert.equal(ctx.kafka.lag('trip-state', 'trip-events'), 0, 'every applied record must be committed');
    assert.equal(store.get('r-42')?.status, 'matched', \`after requested, matched the ride must be matched, got \${JSON.stringify(store.get('r-42'))}\`);
  } finally {
    restore();
  }
}

export async function check_illegal_skipped(ctx) {
  seed(ctx, [['r-42', 'requested'], ['r-42', 'matched'], ['r-42', 'matched'], ['r-42', 'completed'], ['r-42', 'started'], ['r-99', 'started']]);
  const {m, store, logged, restore} = consumer(ctx);
  try {
    await ctx.drain(m.run());
    const ride = store.get('r-42');
    assert(ride !== null && ride.status === 'started', \`r-42 should be started (requested → matched → started; the duplicate matched and the early completed are illegal), got \${JSON.stringify(ride)}\`);
    assert.equal(store.get('r-99'), null, 'started on a ride nobody has seen is illegal and must not create r-99');
    assert.equal(ctx.kafka.lag('trip-state', 'trip-events'), 0, 'illegal events must be committed too, or the partition replays them forever');
    assert(logged.length >= 3, \`three illegal transitions were skipped but only \${logged.length} log lines were emitted\`);
  } finally {
    restore();
  }
}

export async function check_set_then_commit(ctx) {
  seed(ctx, [['r-42', 'requested']]);
  const {m, store, restore} = consumer(ctx);
  try {
    const atCommit: unknown[] = [];
    ctx.kafka.onCommit(() => atCommit.push(store.get('r-42')));
    await ctx.drain(m.run());
    assert(atCommit.length > 0, 'the offset was never committed');
    const first = atCommit[0] as {status?: string} | null;
    assert(first !== null && first.status === 'requested', \`the commit must come after setStatus: at commit time r-42 was \${JSON.stringify(first)}\`);
    // A failing status write must not be committed: the record has to be redelivered.
    seed(ctx, [['r-7', 'requested']]);
    const realSetStatus = store.setStatus.bind(store);
    store.setStatus = (rideId: string, status: string) => {
      if (rideId === 'r-7') throw new Error('ride store unavailable');
      realSetStatus(rideId, status);
    };
    try {
      await ctx.drain(m.run());
    } catch {
      // the consumer loop surfaces the store's error; what matters is what was committed
    }
    assert.equal(store.get('r-7'), null);
    assert.equal(ctx.kafka.lag('trip-state', 'trip-events'), 1, 'setStatus failed for r-7 but its offset was committed: the event is lost (at-most-once)');
  } finally {
    restore();
  }
}
`,
  },
  debrief: `The topic is the ride's history and the consumer group is the projection of it: because one ride's events share a partition, the state machine sees them in the order they happened, and because the commit follows the write, a crash replays an event instead of losing it — and the transition table turns that replay into a harmless no-op. Skipping an illegal event *and committing* is the part people get wrong: refusing to commit would block the partition forever on one bad record. Real systems send skipped records to a dead-letter topic, version the event schema, and derive several projections (billing, analytics, the rider's live screen) from the same log.`,
};
