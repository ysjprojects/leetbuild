import type {Step} from '@/lib/types';

export const exposureLogStep: Step = {
  id: 'exposure-log',
  title: 'Exposure events: logged, never awaited',
  concept: 'kafka',
  file: 'exposures',
  focus: ['web', 'kafka', 'monitoring'],
  task: `## Task

Every assignment Stormcrow makes is logged, and the monitoring graphs per variant are drawn from that
stream. Implement \`get_exposed_variant(name, attrs)\`: the variant from step 2's \`get_variant\`, plus one
**exposure event** on the topic \`gate-exposures\` — without making the caller wait for Kafka.

- The record is **keyed by the gate name** (one gate's exposures stay in order on one partition) and its value
  is JSON \`{"feature", "variant", "version", "user_id", "ts"}\` — \`version\` is the snapshot version that made the
  assignment (the graphs are annotated per edit), \`ts\` the current time in seconds.
- **Non-blocking**: hand the record to the producer and return the variant. The request path must not wait for
  an acknowledgement; a broker that is slow or away must not slow a page.
- **Bounded**: at most \`MAX_PENDING\` (1000) exposures may be in flight. Beyond that, drop the event, count it in
  \`dropped\` and log one line — memory is not an unbounded queue for a broker that is not answering.
- \`shutdown()\` flushes what is pending with a **5-second** bound and returns; a stopping server must not hang on
  a dead broker.

:::widget kafka-partitions {}

> Observability must never become the dependency: the gate decision is a pure function; the log of it is
> best-effort by design.`,
  sequence: {
    participants: ['app server', 'exposures', 'Kafka'],
    messages: [
      {from: 'app server', to: 'exposures', label: 'get_exposed_variant("button_color", ana)', kind: 'sync'},
      {from: 'exposures', to: 'exposures', label: 'get_variant → RED_BUTTON (snapshot v7)', kind: 'sync'},
      {
        from: 'exposures',
        to: 'Kafka',
        label: 'produce gate-exposures key=button_color {feature, variant, version: 7, user_id, ts}',
        kind: 'async',
      },
      {from: 'exposures', to: 'app server', label: 'RED_BUTTON — before the broker answers', kind: 'reply'},
      {from: 'Kafka', to: 'exposures', label: 'ack (later; a failure is logged, not raised)', kind: 'async'},
    ],
  },
  hints: [
    'Compute the variant first and read the snapshot version at the same moment; then build the event and hand it to the producer without awaiting the result — attach the completion handler for logging and for freeing the in-flight slot.',
    'Keep an in-flight count (or set): increment before sending, decrement in the completion handler. If it is already at `MAX_PENDING`, increment `dropped`, log once, and still return the variant — the decision is never affected by logging.',
    '`shutdown()` waits for the pending deliveries with a deadline: a flush with a timeout, or a wait on the in-flight promises raced against a 5-second timer; whatever is still unacknowledged is reported as dropped.',
  ],
  checks: [
    {
      id: 'topic-keyed',
      title: 'One exposure per decision on gate-exposures, keyed by gate',
      detail:
        'Each `get_exposed_variant` call produces one record on `gate-exposures` with key = gate name and a JSON value carrying `feature`, the returned `variant`, the snapshot `version`, `user_id` and `ts`.',
      match: {
        python: {
          all: [/gate-exposures/, /producer\.produce\(\s*(TOPIC|"gate-exposures")\s*,[\s\S]{0,200}?key\s*=\s*name/],
        },
        typescript: {all: [/gate-exposures/, /\.send\(\s*\{[\s\S]{0,200}?key:\s*name/]},
        go: {all: [/gate-exposures/, /Key:\s*\[\]byte\(\s*name\s*\)/]},
        scala: {all: [/gate-exposures/, /new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"gate-exposures")\s*,\s*name\s*,/]},
        cpp: {
          all: [
            /gate-exposures/,
            /producer->produce\(\s*(kTopic|"gate-exposures")\s*,[\s\S]{0,400}?name\.c_str\(\)\s*,\s*name\.(size|length)\(\)/,
          ],
        },
      },
    },
    {
      id: 'non-blocking',
      title: 'The caller never waits for the broker',
      detail:
        'With the broker not acknowledging, `get_exposed_variant` returns the right variant without any virtual time passing; the records arrive once the broker is back.',
      match: {
        python: {
          all: [/producer\.poll\(\s*0\s*\)/],
          none: [/def get_exposed_variant(?:(?!\ndef )[\s\S])*?producer\.flush\(/],
        },
        typescript: {all: [/producer\s*\.send\(/], none: [/await\s+producer\s*\.send\(/]},
        go: {
          all: [/select\s*\{[\s\S]{0,300}?default:/],
          none: [/func getExposedVariant(?:(?!\n\})[\s\S])*?WriteMessages\(/],
        },
        scala: {all: [/producer\.send\([\s\S]{0,200}?onDelivery\s*\)/], none: [/\.send\([^\n]*\)\.get\(/]},
        cpp: {all: [/producer->poll\(\s*0\s*\)/], none: [/get_exposed_variant(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
    {
      id: 'bounded',
      title: 'At most MAX_PENDING exposures in flight; the rest are dropped and counted',
      detail:
        'With the broker away, 1200 exposures leave at most 1000 pending; `dropped` counts the rest and one line is logged; after the broker resumes the pending ones are delivered.',
      match: {
        python: {all: [/pending\s*>=\s*MAX_PENDING/, /dropped\s*\+=\s*1/, /pending\s*-=\s*1/]},
        typescript: {all: [/inFlight\.size\s*>=\s*MAX_PENDING/, /dropped\s*(\+=\s*1|\+\+)/, /inFlight\.delete\(/]},
        go: {all: [/make\(\s*chan kafka\.Message\s*,\s*maxPending\s*\)/, /dropped\.Add\(\s*1\s*\)/]},
        scala: {
          all: [/pending\.get\(\)\s*>=\s*MaxPending/, /dropped\.incrementAndGet\(\)/, /pending\.decrementAndGet\(\)/],
        },
        cpp: {
          all: [
            /pending\.load\(\)\s*>=\s*kMaxPending/,
            /\+\+dropped|dropped\+\+|dropped\.fetch_add\(/,
            /--pending|pending--|pending\.fetch_sub\(/,
          ],
        },
      },
    },
    {
      id: 'flush',
      title: 'shutdown() flushes within 5 seconds',
      detail:
        '`shutdown()` delivers the pending exposures when the broker answers, and returns within 5 s of virtual time when it does not.',
      match: {
        python: {all: [/def shutdown\(/, /producer\.flush\(\s*(timeout_s|FLUSH_TIMEOUT_S|5)\s*\)/]},
        typescript: {all: [/function shutdown\(/, /Promise\.race\(/, /Promise\.all\(/]},
        go: {all: [/func shutdown\(/, /context\.WithTimeout\(/, /flushTimeout|5\s*\*\s*time\.Second/]},
        scala: {all: [/def shutdown\(/, /producer\.close\(\s*(FlushTimeout|Duration\.ofSeconds\(\s*5\s*\))\s*\)/]},
        cpp: {all: [/void shutdown\(/, /producer->flush\(\s*(kFlushTimeoutMs|5000)\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Exposure events: every assignment logged to gate-exposures — never awaited, bounded, flushed on shutdown."""
import json
import logging
import time

from confluent_kafka import Producer

import gates
from gates import get_variant

TOPIC = "gate-exposures"
MAX_PENDING = 1000  # exposures handed to the producer and not yet acknowledged: past this, the event is dropped
FLUSH_TIMEOUT_S = 5
log = logging.getLogger("exposures")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 20})
pending = 0  # in flight: handed to the producer, not yet acknowledged
dropped = 0  # exported as gate_exposures_dropped_total


def on_delivery(err, msg) -> None:
    """Runs on poll()/flush(): the slot is free again; a failure is logged, never raised into a request."""
    # TODO: free the slot
    if err is not None:
        log.warning("exposure not delivered: %s", err)


def get_exposed_variant(name: str, attrs: dict) -> str:
    """The decision from step 2 plus one exposure keyed by the gate name; the caller never waits for the broker."""
    global pending, dropped
    variant = get_variant(name, attrs)
    event = {"feature": name, "variant": variant, "version": gates.snapshot.version, "user_id": attrs["user_id"], "ts": time.time()}
    # TODO: poll(0) first so acknowledged exposures free their slots; at the bound → dropped += 1, log once, still return the variant
    # TODO: otherwise take a slot and produce keyed by the gate name with on_delivery; never flush here
    raise NotImplementedError


def shutdown(timeout_s: float = FLUSH_TIMEOUT_S) -> int:
    """Flush what is pending, timeout_s at most; whatever is still unacknowledged is reported as dropped."""
    # TODO
    raise NotImplementedError
`,
      solution: `"""Exposure events: every assignment logged to gate-exposures — never awaited, bounded, flushed on shutdown."""
import json
import logging
import time

from confluent_kafka import Producer

import gates
from gates import get_variant

TOPIC = "gate-exposures"
MAX_PENDING = 1000  # exposures handed to the producer and not yet acknowledged: past this, the event is dropped
FLUSH_TIMEOUT_S = 5
log = logging.getLogger("exposures")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 20})
pending = 0  # in flight: handed to the producer, not yet acknowledged
dropped = 0  # exported as gate_exposures_dropped_total


def on_delivery(err, msg) -> None:
    """Runs on poll()/flush(): the slot is free again; a failure is logged, never raised into a request."""
    global pending
    pending -= 1
    if err is not None:
        log.warning("exposure not delivered: %s", err)


def get_exposed_variant(name: str, attrs: dict) -> str:
    """The decision from step 2 plus one exposure keyed by the gate name; the caller never waits for the broker."""
    global pending, dropped
    variant = get_variant(name, attrs)
    event = {"feature": name, "variant": variant, "version": gates.snapshot.version, "user_id": attrs["user_id"], "ts": time.time()}
    producer.poll(0)  # serve delivery callbacks (slots free up); returns immediately
    if pending >= MAX_PENDING:
        if dropped == 0:
            log.warning("exposures dropped: %d pending, the broker is behind", pending)
        dropped += 1  # the broker is behind: lose one graph point, not the request
        return variant
    pending += 1
    producer.produce(TOPIC, key=name, value=json.dumps(event), on_delivery=on_delivery)
    return variant


def shutdown(timeout_s: float = FLUSH_TIMEOUT_S) -> int:
    """Flush what is pending, timeout_s at most; whatever is still unacknowledged is reported as dropped."""
    global dropped
    left = producer.flush(timeout_s)
    if left:
        dropped += left
        log.warning("shutdown: %d exposures still unacknowledged after %s s", left, timeout_s)
    return left
`,
    },
    typescript: {
      starter: `/** Exposure events: every assignment logged to gate-exposures — never awaited, bounded, flushed on shutdown. */
import {Kafka} from 'kafkajs';
import {setTimeout as sleep} from 'node:timers/promises';

import {getVariant, snapshot, type Attrs} from './gates';

export const TOPIC = 'gate-exposures';
/** Exposures handed to the producer and not yet acknowledged: past this, the event is dropped. */
export const MAX_PENDING = 1000;
export const FLUSH_TIMEOUT_MS = 5000;

const kafka = new Kafka({clientId: 'gates', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export let dropped = 0; // exported as gate_exposures_dropped_total
/** In flight: handed to the producer, not yet acknowledged. */
const inFlight = new Set<Promise<void>>();

/** The decision from step 2 plus one exposure keyed by the gate name; the caller never waits for the broker. */
export function getExposedVariant(name: string, attrs: Attrs): string {
  const variant = getVariant(name, attrs);
  const event = {feature: name, variant, version: snapshot.version, user_id: attrs.user_id, ts: Date.now() / 1000};
  // TODO: at the bound → dropped += 1, warn once, still return the variant
  // TODO: otherwise send to TOPIC keyed by name with acks: 1 — never awaited: log a failed delivery,
  //       keep the promise in inFlight and remove it when the send settles
  throw new Error('not implemented');
}

/** Flush what is pending, FLUSH_TIMEOUT_MS at most; whatever is still unacknowledged is reported as dropped. */
export async function shutdown(): Promise<number> {
  // TODO: race the in-flight sends against a sleep
  throw new Error('not implemented');
}
`,
      solution: `/** Exposure events: every assignment logged to gate-exposures — never awaited, bounded, flushed on shutdown. */
import {Kafka} from 'kafkajs';
import {setTimeout as sleep} from 'node:timers/promises';

import {getVariant, snapshot, type Attrs} from './gates';

export const TOPIC = 'gate-exposures';
/** Exposures handed to the producer and not yet acknowledged: past this, the event is dropped. */
export const MAX_PENDING = 1000;
export const FLUSH_TIMEOUT_MS = 5000;

const kafka = new Kafka({clientId: 'gates', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export let dropped = 0; // exported as gate_exposures_dropped_total
/** In flight: handed to the producer, not yet acknowledged. */
const inFlight = new Set<Promise<void>>();

/** The decision from step 2 plus one exposure keyed by the gate name; the caller never waits for the broker. */
export function getExposedVariant(name: string, attrs: Attrs): string {
  const variant = getVariant(name, attrs);
  const event = {feature: name, variant, version: snapshot.version, user_id: attrs.user_id, ts: Date.now() / 1000};
  if (inFlight.size >= MAX_PENDING) {
    if (dropped === 0) console.warn(\`exposures dropped: \${inFlight.size} pending, the broker is behind\`);
    dropped += 1; // the broker is behind: lose one graph point, not the request
    return variant;
  }
  const send = producer
    .send({topic: TOPIC, messages: [{key: name, value: JSON.stringify(event)}], acks: 1})
    .then(
      () => undefined,
      (err: Error) => console.warn(\`exposure not delivered: \${err.message}\`),
    );
  inFlight.add(send);
  void send.finally(() => inFlight.delete(send)); // the slot is free again
  return variant;
}

/** Flush what is pending, FLUSH_TIMEOUT_MS at most; whatever is still unacknowledged is reported as dropped. */
export async function shutdown(): Promise<number> {
  await Promise.race([Promise.all(inFlight), sleep(FLUSH_TIMEOUT_MS)]);
  const left = inFlight.size;
  if (left > 0) {
    dropped += left;
    console.warn(\`shutdown: \${left} exposures still unacknowledged after \${FLUSH_TIMEOUT_MS} ms\`);
  }
  return left;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	exposuresTopic = "gate-exposures"
	maxPending     = 1000 // exposures queued and not yet written: past this, the event is dropped
	flushTimeout   = 5 * time.Second
)

var exposuresWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        exposuresTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

var (
	queue   chan kafka.Message // TODO: buffered with maxPending — a slow broker fills it, it never grows
	dropped atomic.Int64       // exported as gate_exposures_dropped_total
	pumped  = make(chan struct{})
)

var pumpCtx, stopPump = context.WithCancel(context.Background())

type exposure struct {
	Feature string  \`json:"feature"\`
	Variant string  \`json:"variant"\`
	Version int     \`json:"version"\`
	UserID  string  \`json:"user_id"\`
	Ts      float64 \`json:"ts"\`
}

// getExposedVariant decides as step 2 does and hands one exposure to the pump; it never waits for the broker.
func getExposedVariant(name string, attrs map[string]string) string {
	variant := getVariant(name, attrs)
	value, _ := json.Marshal(exposure{Feature: name, Variant: variant, Version: snapshot.Load().Version, UserID: attrs["user_id"], Ts: float64(time.Now().UnixMilli()) / 1000})
	// TODO: non-blocking send into queue keyed by name; when full, dropped.Add(1) and log once instead of waiting
	_ = value
	panic("not implemented")
}

// pump drains the queue in batches on its own goroutine; started once at boot.
func pump() {
	defer close(pumped)
	batch := make([]kafka.Message, 0, 100)
	for m := range queue {
		batch = append(batch[:0], m)
	drain:
		for len(batch) < cap(batch) {
			select {
			case m, ok := <-queue:
				if !ok {
					break drain // closed by shutdown: write what is in hand
				}
				batch = append(batch, m)
			default:
				break drain
			}
		}
		if err := exposuresWriter.WriteMessages(pumpCtx, batch...); err != nil {
			log.Printf("%d exposures not delivered: %v", len(batch), err)
		}
	}
}

// shutdown lets the pump drain what is queued, flushTimeout at most; what is left is reported as dropped.
func shutdown() {
	// TODO: close the queue, wait for pumped or a flushTimeout context, then stop the pump
	panic("not implemented")
}

func init() { go pump() }
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	exposuresTopic = "gate-exposures"
	maxPending     = 1000 // exposures queued and not yet written: past this, the event is dropped
	flushTimeout   = 5 * time.Second
)

var exposuresWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        exposuresTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

var (
	queue   = make(chan kafka.Message, maxPending) // bounded: a slow broker fills it, it never grows
	dropped atomic.Int64                           // exported as gate_exposures_dropped_total
	pumped  = make(chan struct{})
)

var pumpCtx, stopPump = context.WithCancel(context.Background())

type exposure struct {
	Feature string  \`json:"feature"\`
	Variant string  \`json:"variant"\`
	Version int     \`json:"version"\`
	UserID  string  \`json:"user_id"\`
	Ts      float64 \`json:"ts"\`
}

// getExposedVariant decides as step 2 does and hands one exposure to the pump; it never waits for the broker.
func getExposedVariant(name string, attrs map[string]string) string {
	variant := getVariant(name, attrs)
	value, _ := json.Marshal(exposure{Feature: name, Variant: variant, Version: snapshot.Load().Version, UserID: attrs["user_id"], Ts: float64(time.Now().UnixMilli()) / 1000})
	select {
	case queue <- kafka.Message{Key: []byte(name), Value: value}:
	default:
		// the broker is behind: lose one graph point, not the request
		if dropped.Add(1) == 1 {
			log.Printf("exposures dropped: %d pending, the broker is behind", maxPending)
		}
	}
	return variant
}

// pump drains the queue in batches on its own goroutine; started once at boot.
func pump() {
	defer close(pumped)
	batch := make([]kafka.Message, 0, 100)
	for m := range queue {
		batch = append(batch[:0], m)
	drain:
		for len(batch) < cap(batch) {
			select {
			case m, ok := <-queue:
				if !ok {
					break drain // closed by shutdown: write what is in hand
				}
				batch = append(batch, m)
			default:
				break drain
			}
		}
		if err := exposuresWriter.WriteMessages(pumpCtx, batch...); err != nil {
			log.Printf("%d exposures not delivered: %v", len(batch), err)
		}
	}
}

// shutdown lets the pump drain what is queued, flushTimeout at most; what is left is reported as dropped.
func shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), flushTimeout)
	defer cancel()
	close(queue)
	select {
	case <-pumped:
		_ = exposuresWriter.Close() // everything was written: nothing left to wait for
	case <-ctx.Done():
		// a dead broker: Close would wait out the writer's retries, so the write in hand is abandoned instead
		left := int64(len(queue))
		dropped.Add(left)
		log.Printf("shutdown: %d exposures still unacknowledged after %s", left, flushTimeout)
	}
	stopPump()
}

func init() { go pump() }
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.atomic.{AtomicInteger, AtomicLong}

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer

import Gates.{getVariant, snapshot}

/** Exposure events: every assignment logged to gate-exposures — never awaited, bounded, flushed on shutdown. */
object Exposures {
  val Topic = "gate-exposures"
  /** Exposures handed to the producer and not yet acknowledged: past this, the event is dropped. */
  val MaxPending = 1000
  val FlushTimeout: Duration = Duration.ofSeconds(5)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "20")
  props.put("max.block.ms", "0") // a full buffer throws instead of parking the request thread
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  val pending = new AtomicInteger() // in flight: handed to the producer, not yet acknowledged
  val dropped = new AtomicLong()    // exported as gate_exposures_dropped_total

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit = {
      // TODO: free the slot
      if (exception != null) System.err.println(s"exposure not delivered: \${exception.getMessage}")
    }
  }

  /** The decision from step 2 plus one exposure keyed by the gate name; the caller never waits for the broker. */
  def getExposedVariant(name: String, attrs: Map[String, String]): String = {
    val variant = getVariant(name, attrs)
    val userId = attrs.getOrElse("user_id", "")
    val value = s"""{"feature":"$name","variant":"$variant","version":\${snapshot.version},"user_id":"$userId","ts":\${System.currentTimeMillis() / 1000.0}}"""
    // TODO: at the bound → dropped.incrementAndGet(), log once, still return the variant
    // TODO: otherwise take a slot and send a record keyed by name with onDelivery; never block
    ??? // TODO
  }

  /** Flush what is pending, FlushTimeout at most; whatever is still unacknowledged is reported as dropped. */
  def shutdown(): Unit = {
    ??? // TODO
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.atomic.{AtomicInteger, AtomicLong}

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer

import Gates.{getVariant, snapshot}

/** Exposure events: every assignment logged to gate-exposures — never awaited, bounded, flushed on shutdown. */
object Exposures {
  val Topic = "gate-exposures"
  /** Exposures handed to the producer and not yet acknowledged: past this, the event is dropped. */
  val MaxPending = 1000
  val FlushTimeout: Duration = Duration.ofSeconds(5)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "20")
  props.put("max.block.ms", "0") // a full buffer throws instead of parking the request thread
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  val pending = new AtomicInteger() // in flight: handed to the producer, not yet acknowledged
  val dropped = new AtomicLong()    // exported as gate_exposures_dropped_total

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit = {
      pending.decrementAndGet() // the slot is free again
      if (exception != null) System.err.println(s"exposure not delivered: \${exception.getMessage}")
    }
  }

  /** The decision from step 2 plus one exposure keyed by the gate name; the caller never waits for the broker. */
  def getExposedVariant(name: String, attrs: Map[String, String]): String = {
    val variant = getVariant(name, attrs)
    val userId = attrs.getOrElse("user_id", "")
    val value = s"""{"feature":"$name","variant":"$variant","version":\${snapshot.version},"user_id":"$userId","ts":\${System.currentTimeMillis() / 1000.0}}"""
    if (pending.get() >= MaxPending) {
      // the broker is behind: lose one graph point, not the request
      if (dropped.incrementAndGet() == 1) System.err.println(s"exposures dropped: $MaxPending pending, the broker is behind")
      return variant
    }
    pending.incrementAndGet()
    try producer.send(new ProducerRecord[String, String](Topic, name, value), onDelivery) // the future is not awaited
    catch {
      case _: Exception => // the buffer is full within max.block.ms = 0: lose one graph point, not the request
        pending.decrementAndGet()
        dropped.incrementAndGet()
    }
    variant
  }

  /** Flush what is pending, FlushTimeout at most; whatever is still unacknowledged is reported as dropped. */
  def shutdown(): Unit = {
    producer.close(FlushTimeout) // flushes, 5 s at most; a dead broker does not hold the stop
    val left = pending.get()
    if (left > 0) {
      dropped.addAndGet(left)
      System.err.println(s"shutdown: $left exposures still unacknowledged after \${FlushTimeout.getSeconds} s")
    }
  }
}
`,
    },
    cpp: {
      starter: `// Exposure events: every assignment logged to gate-exposures — never awaited, bounded, flushed on shutdown.
#include <librdkafka/rdkafkacpp.h>

#include <atomic>
#include <chrono>
#include <iostream>
#include <map>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "gates.h"  // get_variant, snapshot

using json = nlohmann::json;

const std::string kTopic = "gate-exposures";
// Exposures handed to the producer and not yet acknowledged: past this, the event is dropped.
constexpr int kMaxPending = 1000;
constexpr int kFlushTimeoutMs = 5000;

std::atomic<int> pending{0};   // in flight: handed to the producer, not yet acknowledged
std::atomic<long> dropped{0};  // exported as gate_exposures_dropped_total

class OnDelivery : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    // TODO: free the slot
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "exposure not delivered: " << message.errstr() << "\\n";
  }
};

OnDelivery delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "20", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// The decision from step 2 plus one exposure keyed by the gate name; the caller never waits for the broker.
std::string get_exposed_variant(const std::string& name, const std::map<std::string, std::string>& attrs) {
  const std::string variant = get_variant(name, attrs);
  const auto user = attrs.find("user_id");
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const json event = {{"feature", name}, {"variant", variant}, {"version", std::atomic_load(&snapshot)->version},
                      {"user_id", user == attrs.end() ? "" : user->second}, {"ts", ts}};
  // TODO: at the bound → ++dropped, log once, still return the variant
  // TODO: poll(0) first so acknowledged exposures free their slots; otherwise take a slot and produce keyed by the gate name (RK_MSG_COPY); never flush here
  throw std::logic_error("not implemented");
}

// Flush what is pending, kFlushTimeoutMs at most; whatever is still unacknowledged is reported as dropped.
void shutdown() {
  // TODO
  throw std::logic_error("not implemented");
}
`,
      solution: `// Exposure events: every assignment logged to gate-exposures — never awaited, bounded, flushed on shutdown.
#include <librdkafka/rdkafkacpp.h>

#include <atomic>
#include <chrono>
#include <iostream>
#include <map>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "gates.h"  // get_variant, snapshot

using json = nlohmann::json;

const std::string kTopic = "gate-exposures";
// Exposures handed to the producer and not yet acknowledged: past this, the event is dropped.
constexpr int kMaxPending = 1000;
constexpr int kFlushTimeoutMs = 5000;

std::atomic<int> pending{0};   // in flight: handed to the producer, not yet acknowledged
std::atomic<long> dropped{0};  // exported as gate_exposures_dropped_total

class OnDelivery : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    --pending;  // the slot is free again
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "exposure not delivered: " << message.errstr() << "\\n";
  }
};

OnDelivery delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "20", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// The decision from step 2 plus one exposure keyed by the gate name; the caller never waits for the broker.
std::string get_exposed_variant(const std::string& name, const std::map<std::string, std::string>& attrs) {
  const std::string variant = get_variant(name, attrs);
  const auto user = attrs.find("user_id");
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const json event = {{"feature", name}, {"variant", variant}, {"version", std::atomic_load(&snapshot)->version},
                      {"user_id", user == attrs.end() ? "" : user->second}, {"ts", ts}};
  producer->poll(0);  // serve delivery reports (slots free up); returns immediately
  if (pending.load() >= kMaxPending) {
    // the broker is behind: lose one graph point, not the request
    if (++dropped == 1) std::cerr << "exposures dropped: " << kMaxPending << " pending, the broker is behind\\n";
    return variant;
  }
  std::string value = event.dump();
  ++pending;
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   value.data(), value.size(), name.c_str(), name.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    --pending;
    ++dropped;
    std::cerr << "exposure produce failed: " << RdKafka::err2str(err) << "\\n";
  }
  return variant;
}

// Flush what is pending, kFlushTimeoutMs at most; whatever is still unacknowledged is reported as dropped.
void shutdown() {
  producer->flush(kFlushTimeoutMs);  // a dead broker does not hold the stop past 5 s
  const int left = producer->outq_len();
  if (left > 0) {
    dropped += left;
    std::cerr << "shutdown: " << left << " exposures still unacknowledged after " << kFlushTimeoutMs << " ms\\n";
  }
}
`,
    },
  },
  harness: {
    python: `import importlib
import json
import logging

TOPIC = "gate-exposures"
MIX = [{"variant": "RED_BUTTON", "pct": 33}, {"variant": "BLUE_BUTTON", "pct": 33}, {"variant": "CONTROL", "pct": 34}]


def gate(name, populations, seed=None, default="OFF", overrides=(), version=1):
    return {"name": name, "seed": seed or name, "default": default, "populations": populations, "overrides": list(overrides), "version": version}


def publish(ctx, gates, version):
    """What step 1 leaves behind: one field per gate in the hash, and the global version."""
    for g in gates:
        ctx.redis.hset("gates", g["name"], json.dumps(g))
    ctx.redis.set("gates:version", version)


GATES = [
    gate("button_color", [{"match": {"locale": "de"}, "mix": MIX}, {"match": {}, "mix": [{"variant": "BLUE_BUTTON", "pct": 100}]}]),
    gate("dark_mode", [{"match": {}, "mix": [{"variant": "ON", "pct": 100}]}]),
]


def exposures(ctx, version=7):
    """The learner's module over a loaded snapshot, step 2's module it decides with, and every line it logs."""
    publish(ctx, GATES, version)
    m = ctx.load("exposures")
    gates = importlib.import_module("gates")  # the instance the learner's module imported
    gates.refresh()
    logged = []
    handler = logging.Handler()
    handler.emit = logged.append
    logging.getLogger().addHandler(handler)
    return m, gates, logged


def de(i):
    return {"user_id": f"u{i}", "locale": "de"}


def check_topic_keyed(ctx):
    m, gates, _ = exposures(ctx)
    calls = [("button_color", de(1)), ("button_color", {"user_id": "bo", "locale": "en"}), ("dark_mode", {"user_id": "cy"}), ("button_color", de(2))]
    for name, attrs in calls:
        want = gates.get_variant(name, attrs)
        got = m.get_exposed_variant(name, attrs)
        assert got == want, f"get_exposed_variant({name!r}, {attrs['user_id']}) answered {got!r} but step 2's get_variant says {want!r}: the decision is get_variant's, the exposure is a side effect"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 4, f"four decisions produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)}): every decision is one exposure"
    keys = [r.key for r in records]
    assert keys == [b"button_color", b"button_color", b"dark_mode", b"button_color"], f"records must be keyed by the gate name, got {keys}"
    assert records[0].partition == records[1].partition == records[3].partition, "the same gate must land on the same partition so its exposures stay in order"
    for (name, attrs), r in zip(calls, records):
        event = json.loads(r.value)
        assert event.get("feature") == name, f"the value must be JSON with feature, variant, version, user_id, ts; feature is {event.get('feature')!r} for a {name!r} decision: {event}"
        assert event.get("variant") == gates.get_variant(name, attrs), f"the exposure for {attrs['user_id']} says variant {event.get('variant')!r}, the decision was {gates.get_variant(name, attrs)!r}"
        assert event.get("version") == 7, f"the exposure must carry the snapshot version that made the assignment (7), it says {event.get('version')!r}"
        assert event.get("user_id") == attrs["user_id"], f"the exposure must carry the user it was made for ({attrs['user_id']}), it says {event.get('user_id')!r}"
        assert isinstance(event.get("ts"), (int, float)) and abs(event["ts"] - ctx.clock.time()) < 5, f"ts must be the current time in seconds, got {event.get('ts')!r}"
    publish(ctx, GATES, 8)
    gates.refresh()
    m.get_exposed_variant("button_color", de(3))
    last = json.loads(ctx.kafka.records(TOPIC)[-1].value)
    assert last.get("version") == 8, f"after the snapshot moved to version 8 the next exposure must say so (the graphs are annotated per edit), it says {last.get('version')!r}"


def check_non_blocking(ctx):
    m, gates, _ = exposures(ctx)
    ctx.kafka.stall(TOPIC, seconds=2)  # the broker answers 2 s later
    before = ctx.clock.offset
    got = m.get_exposed_variant("button_color", de(1))
    waited = ctx.clock.offset - before
    assert waited < 0.5, f"get_exposed_variant waited {waited:.1f} s for a stalled broker's acknowledgement: hand the record to the producer and return, the request path never waits for Kafka"
    assert got == gates.get_variant("button_color", de(1)), f"with the broker stalled the decision must still be get_variant's ({gates.get_variant('button_color', de(1))!r}), got {got!r}"
    assert ctx.kafka.records(TOPIC) == [], "get_exposed_variant returned only after the broker acknowledged the record: hand it to the producer and return"
    for i in range(2, 4):
        m.get_exposed_variant("button_color", de(i))
    assert ctx.clock.offset - before < 0.5, f"three decisions on a stalled broker took {ctx.clock.offset - before:.1f} s of virtual time: none of them may wait"
    ctx.clock.advance(2)  # the broker is back
    m.get_exposed_variant("button_color", de(4))  # the next decision serves the producer again
    users = sorted(json.loads(r.value).get("user_id") for r in ctx.kafka.records(TOPIC))
    assert users == ["u1", "u2", "u3", "u4"], f"the exposures handed to the producer while the broker was away must arrive once it answers: {TOPIC} holds {users}, expected u1..u4"


def check_bounded(ctx):
    m, gates, logged = exposures(ctx)
    ctx.kafka.stall(TOPIC)  # the broker stops acknowledging: nothing handed to the producer leaves the queue
    variants = [m.get_exposed_variant("button_color", de(i)) for i in range(1200)]
    assert variants == [gates.get_variant("button_color", de(i)) for i in range(1200)], "a dropped exposure must not change the decision: every call still answers get_variant's variant"
    assert m.dropped > 0, "1200 decisions on a stalled broker and nothing was dropped: the in-flight set is unbounded, a broker that is not answering grows it until the server runs out of memory"
    assert m.dropped == 200, f"dropped is {m.dropped} after 1200 exposures with MAX_PENDING = 1000, expected 200"
    assert len(logged) >= 1, "dropping exposures must be logged (logging.warning): a rising dropped counter is the alarm"
    assert ctx.clock.offset < 0.5, f"1200 decisions on a stalled broker took {ctx.clock.offset:.1f} s of virtual time: dropping must not wait either"
    assert ctx.kafka.records(TOPIC) == [], "nothing can reach the topic while the broker is stalled"
    ctx.kafka.resume(TOPIC)
    ctx.clock.advance(31)
    m.get_exposed_variant("button_color", de(1200))  # the next decision serves the producer again
    held = len(ctx.kafka.records(TOPIC))
    assert held == 1001, f"once the broker answers again the 1000 pending exposures must be delivered, the topic holds {held}"
    assert m.dropped == 200, f"dropped is {m.dropped} after the pending exposures were delivered, expected to stay at 200"
    for i in range(1000):
        m.get_exposed_variant("button_color", de(i))
    assert m.dropped == 200, f"after the pending exposures were acknowledged their slots must be free again, yet {m.dropped - 200} of the next 1000 decisions were dropped: release the slot in the delivery callback"
    assert len(ctx.kafka.records(TOPIC)) == 2001, f"with the broker back every decision is one exposure again, the topic holds {len(ctx.kafka.records(TOPIC))} of 2001"


def check_flush(ctx):
    m, _, _ = exposures(ctx)
    ctx.kafka.stall(TOPIC, seconds=2)  # the broker is slow to answer at the moment of the stop
    for i in range(3):
        m.get_exposed_variant("button_color", de(i))
    before = ctx.clock.offset
    m.shutdown()
    took = ctx.clock.offset - before
    users = sorted(json.loads(r.value).get("user_id") for r in ctx.kafka.records(TOPIC))
    assert users == ["u0", "u1", "u2"], f"shutdown() returned with exposures still in the producer's buffer ({TOPIC} holds the exposures of {users}; the broker answered after 2 s): flush so a clean stop loses nothing"
    assert took <= 5.5, f"the broker answered after 2 s yet shutdown() took {took:.0f} s: wait for the pending deliveries, not for the whole timeout"
    ctx.kafka.stall(TOPIC)  # now the broker is down for good
    for i in range(3, 6):
        m.get_exposed_variant("button_color", de(i))
    before = ctx.clock.offset
    m.shutdown()
    took = ctx.clock.offset - before
    assert took <= 6, f"with the broker down, shutdown() took {took:.0f} s: flush with a 5 s bound so a stop is not held for the producer's whole message timeout"
    assert len(ctx.kafka.records(TOPIC)) == 3, "nothing can reach the topic while the broker is down"
`,
    typescript: `const TOPIC = 'gate-exposures';
const MIX = [
  {variant: 'RED_BUTTON', pct: 33},
  {variant: 'BLUE_BUTTON', pct: 33},
  {variant: 'CONTROL', pct: 34},
];

type Share = {variant: string; pct: number};
type Population = {match: Record<string, string>; mix: Share[]};
type Gate = {name: string; seed: string; default: string; populations: Population[]; overrides: unknown[]; version: number};

function gate(name: string, populations: Population[], options: {seed?: string; default?: string; version?: number} = {}): Gate {
  return {
    name,
    seed: options.seed ?? name,
    default: options.default ?? 'OFF',
    populations,
    overrides: [],
    version: options.version ?? 1,
  };
}

/** What step 1 leaves behind: one field per gate in the hash, and the global version. */
function publish(ctx, gates: Gate[], version: number) {
  for (const g of gates) ctx.redis.hset('gates', g.name, JSON.stringify(g));
  ctx.redis.set('gates:version', version);
}

const GATES = [
  gate('button_color', [
    {match: {locale: 'de'}, mix: MIX},
    {match: {}, mix: [{variant: 'BLUE_BUTTON', pct: 100}]},
  ]),
  gate('dark_mode', [{match: {}, mix: [{variant: 'ON', pct: 100}]}]),
];

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

/** The learner's module over a loaded snapshot, step 2's module it decides with, and every line it warns. */
async function exposures(ctx, version = 7) {
  publish(ctx, GATES, version);
  const m = ctx.load('exposures');
  const gates = ctx.load('gates'); // the instance the learner's module imported
  await gates.refresh();
  const logged: string[] = [];
  console.warn = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  return {m, gates, logged};
}

const de = (i: number) => ({user_id: \`u\${i}\`, locale: 'de'});
const users = (ctx): string[] => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()).user_id);

export async function check_topic_keyed(ctx) {
  const {m, gates} = await exposures(ctx);
  const calls: [string, Record<string, string> & {user_id: string}][] = [
    ['button_color', de(1)],
    ['button_color', {user_id: 'bo', locale: 'en'}],
    ['dark_mode', {user_id: 'cy'}],
    ['button_color', de(2)],
  ];
  for (const [name, attrs] of calls) {
    const want = gates.getVariant(name, attrs);
    const got = await m.getExposedVariant(name, attrs);
    assert.equal(got, want, \`getExposedVariant('\${name}', \${attrs.user_id}) answered \${JSON.stringify(got)} but step 2's getVariant says \${JSON.stringify(want)}: the decision is getVariant's, the exposure is a side effect\`);
  }
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 4, \`four decisions produced \${records.length} records on \${TOPIC}: every decision is one exposure\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['button_color', 'button_color', 'dark_mode', 'button_color'], \`records must be keyed by the gate name, got \${JSON.stringify(keys)}\`);
  assert(records[0].partition === records[1].partition && records[1].partition === records[3].partition, 'the same gate must land on the same partition so its exposures stay in order');
  calls.forEach(([name, attrs], i) => {
    const raw = records[i].value.toString();
    const event = JSON.parse(raw);
    assert.equal(event.feature, name, \`the value must be JSON with feature, variant, version, user_id, ts; feature is \${JSON.stringify(event.feature)} for a '\${name}' decision: \${raw}\`);
    assert.equal(event.variant, gates.getVariant(name, attrs), \`the exposure for \${attrs.user_id} says variant \${JSON.stringify(event.variant)}, the decision was \${JSON.stringify(gates.getVariant(name, attrs))}\`);
    assert.equal(event.version, 7, \`the exposure must carry the snapshot version that made the assignment (7), it says \${JSON.stringify(event.version)}\`);
    assert.equal(event.user_id, attrs.user_id, \`the exposure must carry the user it was made for (\${attrs.user_id}), it says \${JSON.stringify(event.user_id)}\`);
    assert(typeof event.ts === 'number' && Math.abs(event.ts - ctx.clock.now() / 1000) < 5, \`ts must be the current time in seconds, got \${JSON.stringify(event.ts)}\`);
  });
  publish(ctx, GATES, 8);
  await gates.refresh();
  await m.getExposedVariant('button_color', de(3));
  await settle();
  const last = JSON.parse(ctx.kafka.records(TOPIC).at(-1).value.toString());
  assert.equal(last.version, 8, \`after the snapshot moved to version 8 the next exposure must say so (the graphs are annotated per edit), it says \${JSON.stringify(last.version)}\`);
}

export async function check_non_blocking(ctx) {
  const {m, gates} = await exposures(ctx);
  ctx.kafka.stall(TOPIC, 2); // the broker answers 2 s later
  const before = ctx.clock.now();
  const got = await m.getExposedVariant('button_color', de(1));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited < 0.5, \`getExposedVariant waited \${waited.toFixed(1)} s for a stalled broker's acknowledgement: hand the record to the producer and return, the request path never waits for Kafka\`);
  assert.equal(got, gates.getVariant('button_color', de(1)), \`with the broker stalled the decision must still be getVariant's (\${JSON.stringify(gates.getVariant('button_color', de(1)))}), got \${JSON.stringify(got)}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'getExposedVariant returned only after the broker acknowledged the record: hand it to the producer and return');
  for (let i = 2; i < 4; i += 1) await m.getExposedVariant('button_color', de(i));
  const total = (ctx.clock.now() - before) / 1000;
  assert(total < 0.5, \`three decisions on a stalled broker took \${total.toFixed(1)} s of virtual time: none of them may wait\`);
  ctx.clock.advance(2000); // the broker is back
  await settle();
  await m.getExposedVariant('button_color', de(4));
  await settle();
  assert.deepStrictEqual(users(ctx), ['u1', 'u2', 'u3', 'u4'], \`the exposures handed to the producer while the broker was away must arrive once it answers: \${TOPIC} holds \${JSON.stringify(users(ctx))}, expected u1..u4\`);
}

export async function check_bounded(ctx) {
  const {m, gates, logged} = await exposures(ctx);
  ctx.kafka.stall(TOPIC); // the broker stops acknowledging: nothing handed to the producer leaves the queue
  const before = ctx.clock.now();
  const variants: string[] = [];
  for (let i = 0; i < 1200; i += 1) variants.push(await m.getExposedVariant('button_color', de(i)));
  assert.deepStrictEqual(variants, Array.from({length: 1200}, (_, i) => gates.getVariant('button_color', de(i))), "a dropped exposure must not change the decision: every call still answers getVariant's variant");
  assert(m.dropped > 0, '1200 decisions on a stalled broker and nothing was dropped: the in-flight set is unbounded, a broker that is not answering grows it until the server runs out of memory');
  assert.equal(m.dropped, 200, \`dropped is \${m.dropped} after 1200 exposures with MAX_PENDING = 1000, expected 200\`);
  assert(logged.length >= 1, 'dropping exposures must be logged (console.warn): a rising dropped counter is the alarm');
  const took = (ctx.clock.now() - before) / 1000;
  assert(took < 0.5, \`1200 decisions on a stalled broker took \${took.toFixed(1)} s of virtual time: dropping must not wait either\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing can reach the topic while the broker is stalled');
  ctx.kafka.resume(TOPIC);
  ctx.clock.advance(31_000); // the broker is back: the pending sends are acknowledged
  await settle();
  await m.getExposedVariant('button_color', de(1200));
  await settle();
  const held = ctx.kafka.records(TOPIC).length;
  assert.equal(held, 1001, \`once the broker answers again the 1000 pending exposures must be delivered, the topic holds \${held}\`);
  assert.equal(m.dropped, 200, \`dropped is \${m.dropped} after the pending exposures were delivered, expected to stay at 200\`);
  for (let i = 0; i < 1000; i += 1) await m.getExposedVariant('button_color', de(i));
  await settle();
  assert.equal(m.dropped, 200, \`after the pending exposures were acknowledged their slots must be free again, yet \${m.dropped - 200} of the next 1000 decisions were dropped: release the slot when the send settles\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 2001, \`with the broker back every decision is one exposure again, the topic holds \${ctx.kafka.records(TOPIC).length} of 2001\`);
}

export async function check_flush(ctx) {
  const {m} = await exposures(ctx);
  ctx.kafka.stall(TOPIC, 2); // the broker is slow to answer at the moment of the stop
  for (let i = 0; i < 3; i += 1) await m.getExposedVariant('button_color', de(i));
  let before = ctx.clock.now();
  await m.shutdown();
  let took = (ctx.clock.now() - before) / 1000;
  assert.deepStrictEqual(users(ctx), ['u0', 'u1', 'u2'], \`shutdown() returned with exposures still in the producer's buffer (\${TOPIC} holds the exposures of \${JSON.stringify(users(ctx))}; the broker answered after 2 s): flush so a clean stop loses nothing\`);
  assert(took <= 5.5, \`the broker answered after 2 s yet shutdown() took \${took.toFixed(0)} s: wait for the pending deliveries, not for the whole timeout\`);
  ctx.kafka.stall(TOPIC); // now the broker is down for good
  for (let i = 3; i < 6; i += 1) await m.getExposedVariant('button_color', de(i));
  before = ctx.clock.now();
  await m.shutdown();
  took = (ctx.clock.now() - before) / 1000;
  assert(took <= 6, \`with the broker down, shutdown() took \${took.toFixed(0)} s: flush with a 5 s bound so a stop is not held for the producer's whole message timeout\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 3, 'nothing can reach the topic while the broker is down');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
	"leetbuild/harness"
)

// Step 2's gates.go, which this file builds on. Go judges one step's file at a time, so the harness
// supplies it as step 2's reference has it: the snapshot, its refresh and getVariant.

var gatesRdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Share struct {
	Variant string \`json:"variant"\`
	Pct     int    \`json:"pct"\`
}

type Population struct {
	Match map[string]string \`json:"match"\`
	Mix   []Share           \`json:"mix"\`
}

type Override struct {
	UserID    string \`json:"user_id"\`
	Variant   string \`json:"variant"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

type Gate struct {
	Name        string       \`json:"name"\`
	Seed        string       \`json:"seed"\`
	Default     string       \`json:"default"\`
	Populations []Population \`json:"populations"\`
	Overrides   []Override   \`json:"overrides"\`
	Version     int          \`json:"version"\`
}

type Snapshot struct {
	Version int
	Gates   map[string]Gate
}

type snapshotBox struct{ v atomic.Value }

func (b *snapshotBox) Load() *Snapshot   { return b.v.Load().(*Snapshot) }
func (b *snapshotBox) Store(s *Snapshot) { b.v.Store(s) }

var snapshot snapshotBox

func init() { snapshot.Store(&Snapshot{Gates: map[string]Gate{}}) }

func getVariant(name string, attrs map[string]string) string {
	gate, ok := snapshot.Load().Gates[name]
	if !ok {
		return "OFF"
	}
	now := time.Now().Unix()
	for _, override := range gate.Overrides {
		if override.UserID == attrs["user_id"] && override.ExpiresAt > now {
			return override.Variant
		}
	}
	for _, population := range gate.Populations {
		matched := true
		for key, value := range population.Match {
			matched = matched && attrs[key] == value
		}
		if !matched {
			continue
		}
		sum := sha256.Sum256([]byte(gate.Seed + ":" + attrs["user_id"]))
		b := int(binary.BigEndian.Uint32(sum[:4]) % 10_000)
		edge := 0
		for _, share := range population.Mix {
			edge += share.Pct * 100
			if b < edge {
				return share.Variant
			}
		}
		return population.Mix[len(population.Mix)-1].Variant
	}
	return gate.Default
}

func refresh(ctx context.Context) (bool, error) {
	raw, err := gatesRdb.Get(ctx, "gates:version").Result()
	if err != nil && err != redis.Nil {
		return false, err
	}
	version, _ := strconv.Atoi(raw)
	if version == snapshot.Load().Version {
		return false, nil
	}
	fields, err := gatesRdb.HGetAll(ctx, "gates").Result()
	if err != nil {
		return false, err
	}
	gates := make(map[string]Gate, len(fields))
	for name, body := range fields {
		var gate Gate
		if err := json.Unmarshal([]byte(body), &gate); err != nil {
			return false, fmt.Errorf("gate %s: %w", name, err)
		}
		gates[name] = gate
	}
	snapshot.Store(&Snapshot{Version: version, Gates: gates})
	return true, nil
}

// The checks.

const exposureTopic = "gate-exposures"

// publishExposureGates leaves what step 1 leaves behind: button_color and dark_mode in the hash, and the global version.
func publishExposureGates(ctx *harness.Ctx, version int) {
	share := func(variant string, pct int) map[string]any { return map[string]any{"variant": variant, "pct": pct} }
	gates := []map[string]any{
		{"name": "button_color", "seed": "button_color", "default": "OFF", "overrides": []any{}, "version": 1, "populations": []any{
			map[string]any{"match": map[string]any{"locale": "de"}, "mix": []any{share("RED_BUTTON", 33), share("BLUE_BUTTON", 33), share("CONTROL", 34)}},
			map[string]any{"match": map[string]any{}, "mix": []any{share("BLUE_BUTTON", 100)}},
		}},
		{"name": "dark_mode", "seed": "dark_mode", "default": "OFF", "overrides": []any{}, "version": 1, "populations": []any{
			map[string]any{"match": map[string]any{}, "mix": []any{share("ON", 100)}},
		}},
	}
	for _, g := range gates {
		encoded, _ := json.Marshal(g)
		ctx.Redis.Do("HSET", "gates", g["name"], string(encoded))
	}
	ctx.Redis.Set("gates:version", version)
}

// exposureLog collects the lines the learner logs, still passing them on to the original output.
type exposureLog struct {
	guard sync.Mutex
	lines []string
}

func (w *exposureLog) Write(p []byte) (int, error) {
	w.guard.Lock()
	defer w.guard.Unlock()
	w.lines = append(w.lines, string(p))
	return len(p), nil
}

func (w *exposureLog) count() int {
	w.guard.Lock()
	defer w.guard.Unlock()
	return len(w.lines)
}

// loadExposures publishes the gates, loads step 2's snapshot, and collects every line the learner logs.
func loadExposures(ctx *harness.Ctx, version int) *exposureLog {
	publishExposureGates(ctx, version)
	_, err := refresh(context.Background())
	ctx.NoError(err, "step 2's refresh")
	logged := &exposureLog{}
	log.SetOutput(io.MultiWriter(log.Writer(), logged))
	return logged
}

func deAttrs(i int) map[string]string {
	return map[string]string{"user_id": fmt.Sprintf("u%d", i), "locale": "de"}
}

func exposureUsers(ctx *harness.Ctx) []string {
	users := []string{}
	for _, raw := range ctx.Kafka.Values(exposureTopic) {
		var event struct {
			UserID string \`json:"user_id"\`
		}
		json.Unmarshal([]byte(raw), &event)
		users = append(users, event.UserID)
	}
	return users
}

func secondsSince(ctx *harness.Ctx, before int64) float64 {
	return float64(ctx.Clock.Now()-before) / 1000
}

func CheckTopicKeyed(ctx *harness.Ctx) {
	loadExposures(ctx, 7)
	calls := []struct {
		name  string
		attrs map[string]string
	}{
		{"button_color", deAttrs(1)},
		{"button_color", map[string]string{"user_id": "bo", "locale": "en"}},
		{"dark_mode", map[string]string{"user_id": "cy"}},
		{"button_color", deAttrs(2)},
	}
	for _, call := range calls {
		want := getVariant(call.name, call.attrs)
		got := getExposedVariant(call.name, call.attrs)
		ctx.Assert(got == want, "getExposedVariant(%q, %s) answered %q but step 2's getVariant says %q: the decision is getVariant's, the exposure is a side effect", call.name, call.attrs["user_id"], got, want)
	}
	ctx.Settle()
	records := ctx.Kafka.Records(exposureTopic)
	ctx.Equal(len(records), 4, "four decisions must produce four records on %s: every decision is one exposure; records", exposureTopic)
	// kafka-go writes a batch partition by partition, so records of different gates need not follow the calls:
	// each record is matched to its call by user_id (one per call); one gate's records must keep the call order.
	inCallOrder := make([]harness.KafkaRecord, len(calls))
	position := make([]int, len(calls))
	for i, call := range calls {
		position[i] = -1
		for j, r := range records {
			var event struct {
				UserID string \`json:"user_id"\`
			}
			json.Unmarshal(r.Value, &event)
			if event.UserID == call.attrs["user_id"] {
				inCallOrder[i], position[i] = r, j
			}
		}
		ctx.Assert(position[i] >= 0, "no exposure on %s carries user_id %q: every decision is one exposure for its user", exposureTopic, call.attrs["user_id"])
	}
	var keys []string
	for _, r := range inCallOrder {
		keys = append(keys, string(r.Key))
	}
	ctx.Equal(keys, []string{"button_color", "button_color", "dark_mode", "button_color"}, "records must be keyed by the gate name")
	ctx.Assert(inCallOrder[0].Partition == inCallOrder[1].Partition && inCallOrder[1].Partition == inCallOrder[3].Partition && position[0] < position[1] && position[1] < position[3], "the same gate must land on the same partition so its exposures stay in order")
	now := float64(ctx.Clock.Now()) / 1000
	for i, call := range calls {
		raw := inCallOrder[i].Value
		var event map[string]any
		ctx.NoError(json.Unmarshal(raw, &event), "the value must be JSON with feature, variant, version, user_id, ts: %s", raw)
		ctx.Equal(event["feature"], call.name, "the feature of the exposure for a %q decision (%s)", call.name, raw)
		ctx.Equal(event["variant"], getVariant(call.name, call.attrs), "the variant of the exposure for %s: the decision's", call.attrs["user_id"])
		ctx.Equal(event["version"], 7, "the exposure must carry the snapshot version that made the assignment")
		ctx.Equal(event["user_id"], call.attrs["user_id"], "the exposure must carry the user it was made for")
		ts, isNumber := event["ts"].(float64)
		ctx.Assert(isNumber && math.Abs(ts-now) < 5, "ts must be the current time in seconds, got %v", event["ts"])
	}
	publishExposureGates(ctx, 8)
	_, err := refresh(context.Background())
	ctx.NoError(err, "step 2's refresh")
	getExposedVariant("button_color", deAttrs(3))
	ctx.Settle()
	values := ctx.Kafka.Values(exposureTopic)
	var last map[string]any
	json.Unmarshal([]byte(values[len(values)-1]), &last)
	ctx.Equal(last["version"], 8, "after the snapshot moved to version 8 the next exposure must say so (the graphs are annotated per edit)")
}

func CheckNonBlocking(ctx *harness.Ctx) {
	loadExposures(ctx, 7)
	ctx.Kafka.StallFor(exposureTopic, 2) // the broker answers 2 s later
	before := ctx.Clock.Now()
	got := getExposedVariant("button_color", deAttrs(1))
	waited := secondsSince(ctx, before)
	ctx.Assert(waited < 0.5, "getExposedVariant waited %.1f s for a stalled broker's acknowledgement: hand the record to the producer and return, the request path never waits for Kafka", waited)
	ctx.Equal(got, getVariant("button_color", deAttrs(1)), "with the broker stalled the decision must still be getVariant's")
	ctx.Equal(len(ctx.Kafka.Records(exposureTopic)), 0, "getExposedVariant returned only after the broker acknowledged the record: hand it to the producer and return; records")
	for i := 2; i < 4; i++ {
		getExposedVariant("button_color", deAttrs(i))
	}
	total := secondsSince(ctx, before)
	ctx.Assert(total < 0.5, "three decisions on a stalled broker took %.1f s of virtual time: none of them may wait", total)
	ctx.Clock.Advance(2000) // the broker is back
	ctx.Settle()
	getExposedVariant("button_color", deAttrs(4))
	ctx.Settle()
	ctx.Equal(exposureUsers(ctx), []string{"u1", "u2", "u3", "u4"}, "the exposures handed to the producer while the broker was away must arrive once it answers: the users on %s", exposureTopic)
}

func CheckBounded(ctx *harness.Ctx) {
	logged := loadExposures(ctx, 7)
	ctx.Kafka.Stall(exposureTopic) // the broker stops acknowledging: nothing handed to the producer leaves the queue
	before := ctx.Clock.Now()
	sameDecisions := true
	for i := range 1200 {
		sameDecisions = getExposedVariant("button_color", deAttrs(i)) == getVariant("button_color", deAttrs(i)) && sameDecisions
	}
	ctx.Assert(sameDecisions, "a dropped exposure must not change the decision: every call still answers getVariant's variant")
	ctx.Assert(dropped.Load() > 0, "1200 decisions on a stalled broker and nothing was dropped: the queue is unbounded, a broker that is not answering grows it until the server runs out of memory")
	// Unlike TS's in-flight set, the Go step bounds the channel: the batch the pump is writing sits on top of it.
	stalledDrops := int(dropped.Load())
	inHand := 1200 - stalledDrops - len(queue)
	ctx.Assert(1 <= inHand && inHand <= 100, "pending = queued + the batch being written: %d exposures were accepted beyond the %d queued, expected the pump's one batch (1 to 100)", inHand, len(queue))
	ctx.Equal(stalledDrops+maxPending+inHand, 1200, "pending = queued + the batch being written: dropped + maxPending (1000) + the %d being written must account for the 1200 exposures", inHand)
	ctx.Assert(logged.count() >= 1, "dropping exposures must be logged: a rising dropped counter is the alarm")
	took := secondsSince(ctx, before)
	ctx.Assert(took < 0.5, "1200 decisions on a stalled broker took %.1f s of virtual time: dropping must not wait either", took)
	ctx.Equal(len(ctx.Kafka.Records(exposureTopic)), 0, "nothing can reach the topic while the broker is stalled; records")
	ctx.Kafka.Resume(exposureTopic)
	ctx.Clock.Advance(31_000) // the broker is back: the pending exposures are delivered
	ctx.Settle()
	getExposedVariant("button_color", deAttrs(1200))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(exposureTopic)), maxPending+inHand+1, "once the broker answers again the pending exposures (1000 queued + %d being written) must be delivered; records on the topic", inHand)
	ctx.Equal(dropped.Load(), stalledDrops, "dropped after the pending exposures were delivered must stay")
	for i := range 1000 {
		getExposedVariant("button_color", deAttrs(i))
	}
	ctx.Settle()
	ctx.Assert(int(dropped.Load()) == stalledDrops, "after the pending exposures were delivered their slots must be free again, yet %d of the next 1000 decisions were dropped: the queue must drain", int(dropped.Load())-stalledDrops)
	ctx.Equal(len(ctx.Kafka.Records(exposureTopic)), maxPending+inHand+1+1000, "with the broker back every decision is one exposure again; records on the topic")
}

func CheckFlush(ctx *harness.Ctx) {
	loadExposures(ctx, 7)
	// shutdown closes the queue and the writer: it ends the process's exposures for good. The second stop below
	// runs on a restarted process, re-initialised the way the program starts, with the queue the learner sized.
	restart := struct {
		capacity int
		writer   kafka.Writer
	}{cap(queue), *exposuresWriter}
	ctx.Kafka.StallFor(exposureTopic, 2) // the broker is slow to answer at the moment of the stop
	for i := range 3 {
		getExposedVariant("button_color", deAttrs(i))
	}
	before := ctx.Clock.Now()
	shutdown()
	took := secondsSince(ctx, before)
	ctx.Equal(exposureUsers(ctx), []string{"u0", "u1", "u2"}, "shutdown() returned with exposures still queued (the broker answered after 2 s): flush so a clean stop loses nothing; the users on %s", exposureTopic)
	ctx.Assert(took <= 5.5, "the broker answered after 2 s yet shutdown() took %.0f s: wait for the pending deliveries, not for the whole timeout", took)
	ctx.Kafka.Stall(exposureTopic) // now the broker is down for good
	writer := restart.writer
	exposuresWriter = &writer
	queue = make(chan kafka.Message, restart.capacity)
	pumped = make(chan struct{})
	pumpCtx, stopPump = context.WithCancel(context.Background())
	go pump()
	for i := 3; i < 6; i++ {
		getExposedVariant("button_color", deAttrs(i))
	}
	before = ctx.Clock.Now()
	shutdown()
	took = secondsSince(ctx, before)
	ctx.Assert(took <= 6, "with the broker down, shutdown() took %.0f s: flush with a 5 s bound so a stop is not held for the producer's whole write timeout", took)
	ctx.Equal(len(ctx.Kafka.Records(exposureTopic)), 3, "nothing can reach the topic while the broker is down; records")
}
`,
  },
  debrief: `Exposure logging is the part of a gating system that turns it from a switchboard into an experimentation platform — without the stream there are no per-variant graphs, no A/B result, no annotation of "this edit moved the curve". The engineering trade-off is that the log is on the hottest path there is, inside every request, so it must be fire-and-forget with a bounded buffer: a Kafka outage must cost dropped graph points, not latency or memory. Stripping the version into every event is what makes the graphs explain themselves later. Real systems sample exposures for the most common gates, dedupe one exposure per user per session, and batch the sends; the monitoring side (a consumer rolling the stream into per-minute counts per variant) is the Distributed Counters course.`,
};
