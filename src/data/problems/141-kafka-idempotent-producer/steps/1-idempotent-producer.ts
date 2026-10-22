import type {Step} from '@/lib/types';

export const idempotentProducerStep: Step = {
  id: 'idempotent-producer',
  title: 'Deliver once, retry bounded, never exceed the window',
  concept: 'kafka',
  file: 'idempotent_producer',
  focus: ['emitter', 'kafka'],
  task: `## Task

Implement a module of three functions over one producer on the **\`events\`** topic:

- \`send(event_id, payload)\`: produce one record, **key \`event_id\`**, value \`payload\`, and return as
  soon as the record is in the producer's hands — the outcome arrives through the delivery callback.
- \`stats()\`: \`{delivered, retried, dead, pending}\` — records acknowledged, retries issued, the ids
  given up on (a list, in order), and records in flight right now.
- \`shutdown()\`: flush, waiting at most **\`FLUSH_TIMEOUT_S = 3\`** seconds (\`FLUSH_TIMEOUT_MS = 3000\`);
  return how many records are still in flight when it gives up.

Rules:

- The producer is configured with **\`enable.idempotence=true\`** and **\`acks=all\`** (kafkajs:
  \`idempotent: true\`, \`acks: -1\`). A lost acknowledgement is retried by the client; with idempotence
  the broker writes the resend once, and the delivery report counts it as **delivered once**.
- The delivery callback decides: success → \`delivered += 1\`. A **retriable** error → produce the
  same record again (same key, same value), at most **\`MAX_RETRIES = 3\`** times per record, counting
  each in \`retried\`. A non-retriable error, or a record that has failed \`MAX_RETRIES + 1\` times →
  append its \`event_id\` to \`dead\`. One record never counts twice.
- At most **\`MAX_PENDING = 100\`** records may be in flight (produced, no delivery report yet).
  Beyond that \`send\` **waits** — serving delivery reports (\`poll\`) or awaiting a delivery — until
  there is room. It never drops the record and never lets the queue grow past the bound.
- Delivery reports are served by \`poll(0)\` after each produce (librdkafka clients) or by the
  delivery promise (kafkajs).

:::widget kafka-partitions {"partitions": 3}

> An idempotent producer makes *the client's* retries safe; the callback is where *your* retries
> are counted and bounded, and the in-flight window is what turns a slow broker into a slow caller
> instead of an out-of-memory.`,
  sequence: {
    participants: ['caller', 'Producer', 'Kafka'],
    messages: [
      {from: 'caller', to: 'Producer', label: 'produce(events, key=e1, value) · pending 1', kind: 'async'},
      {from: 'Producer', to: 'Kafka', label: 'batch (seq 7)', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack lost', kind: 'reply'},
      {from: 'Producer', to: 'Kafka', label: 'resend (seq 7) → written once', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack', kind: 'reply'},
      {from: 'Producer', to: 'caller', label: 'delivery report: ok → delivered 1, pending 0', kind: 'async'},
    ],
  },
  hints: [
    'Keep three counters and a list next to the producer, plus `pending`: `+1` at every produce (first attempt and retry alike), `-1` at the top of the callback. `stats()` is just a snapshot of them.',
    'The callback needs to know which record and which attempt it is reporting on: close over `(event_id, payload, attempt)` in a lambda (Python), a promise chain (TypeScript), the message opaque (librdkafka) or the callback object (Java).',
    'Back-pressure is a loop before the produce: `while pending >= MAX_PENDING: producer.poll(0.1)` — polling serves the delivery reports that free a slot. In kafkajs, `await Promise.race(inFlight)` waits for the first delivery to settle.',
  ],
  checks: [
    {
      id: 'lose-acks',
      title: 'A lost ack does not duplicate the record',
      detail:
        'The producer is idempotent with `acks=all`: when the acknowledgement is lost the client resends and the broker writes it once; `stats().delivered` counts the record once and the topic holds one copy.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'retries',
      title: 'A retriable failure is retried and delivered once',
      detail:
        'Two retriable delivery errors in a row: the callback re-produces the same record, `retried` is 2, `delivered` is 1, `dead` is empty, and the topic holds exactly one record with that key.',
      match: {
        python: {all: [/err\.retriable\(\)/, /attempt\s*<\s*MAX_RETRIES/]},
        typescript: {all: [/\.retriable\b/, /attempt\s*<\s*MAX_RETRIES/]},
        go: {all: [/IsRetriable\(\)/, /\.n\s*<\s*maxRetries/]},
        scala: {all: [/RetriableException/, /attempt\s*<\s*MaxRetries/]},
        cpp: {all: [/is_retriable\(/, /->n\s*<\s*kMaxRetries/]},
      },
    },
    {
      id: 'dead',
      title: 'Exhausted retries park the id in dead',
      detail:
        'A record that fails `MAX_RETRIES + 1` times is given up on: its id is in `dead`, `retried` is 3, it is on the topic at most once, and the next record still delivers.',
      match: {
        python: {all: [/dead\.append\(\s*event_id\s*\)/]},
        typescript: {all: [/dead\.push\(\s*eventId\s*\)/]},
        go: {all: [/dead\s*=\s*append\(\s*dead\s*,/]},
        scala: {all: [/dead\s*\+=\s*eventId/]},
        cpp: {all: [/dead\.push_back\(/]},
      },
    },
    {
      id: 'backpressure',
      title: 'Never more than MAX_PENDING records in flight',
      detail:
        'With the broker stalled for 5 s and 150 sends, at most 100 records are ever waiting on the broker — `send` blocks until a delivery report frees a slot — and every one of the 150 lands once the broker answers.',
      match: {
        python: {all: [/while[^\n]*>=\s*MAX_PENDING[^\n]*:\s*\n\s*producer\.poll\(/]},
        typescript: {all: [/while[^\n]*>=\s*MAX_PENDING[^\n]*\)\s*await/]},
        go: {all: [/for[^\n]*>=\s*maxPending[^\n]*\{/]},
        scala: {all: [/while[^\n]*>=\s*MaxPending/]},
        cpp: {all: [/while[^\n]*>=\s*kMaxPending[^\n]*\)\s*producer->poll\(/]},
      },
    },
    {
      id: 'keyed',
      title: 'Keys are the event ids',
      detail: 'Every record on `events` carries its `event_id` as the key and sits on the partition the key hashes to.',
      match: {
        python: {all: [/producer\.produce\(\s*TOPIC\s*,\s*key\s*=\s*event_id/]},
        typescript: {all: [/messages:\s*\[\s*\{[^\n]*key:\s*eventId/]},
        go: {all: [/Key:\s*\[\]byte\(\s*a\.eventID\s*\)/]},
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*eventId\s*,/]},
        cpp: {all: [/a->event_id\.c_str\(\)\s*,\s*a->event_id\.size\(\)/]},
      },
    },
    {
      id: 'flush-bound',
      title: 'shutdown gives up after FLUSH_TIMEOUT_S',
      detail:
        'With the broker dead, `shutdown()` returns after about 3 s of virtual time with the record still in flight (returns 1), not after the message timeout.',
      match: {
        python: {all: [/def shutdown(?:(?!\ndef )[\s\S])*?producer\.flush\(\s*(?:timeout\s*=\s*)?FLUSH_TIMEOUT_S/]},
        typescript: {all: [/function shutdown(?:(?!\nexport )[\s\S])*?FLUSH_TIMEOUT_MS/]},
        go: {all: [/func shutdown(?:(?!\n\})[\s\S])*?flushTimeoutMs/]},
        scala: {all: [/def shutdown(?:(?!\n {2}def )[\s\S])*?close\(\s*Duration\.ofMillis\(\s*FlushTimeoutMs/]},
        cpp: {all: [/int shutdown(?:(?!\n\})[\s\S])*?producer->flush\(\s*kFlushTimeoutMs/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from confluent_kafka import KafkaError, Producer

TOPIC = "events"
MAX_RETRIES = 3
MAX_PENDING = 100
FLUSH_TIMEOUT_S = 3

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        # TODO: enable.idempotence so the client's own retries never duplicate a record
        "linger.ms": 0,
    }
)

delivered = 0
retried = 0
dead: list[str] = []
pending = 0


def _on_delivery(err: KafkaError | None, event_id: str, payload: str, attempt: int) -> None:
    # TODO: pending -= 1; ok → delivered; retriable and attempt < MAX_RETRIES → retried, produce again; else dead
    raise NotImplementedError


def _produce(event_id: str, payload: str, attempt: int) -> None:
    # TODO: pending += 1; produce keyed by event_id with a callback that knows the record and the attempt
    raise NotImplementedError


def send(event_id: str, payload: str) -> None:
    # TODO: wait (poll) while pending >= MAX_PENDING; produce; poll(0) to serve delivery reports
    raise NotImplementedError


def stats() -> dict:
    return {"delivered": delivered, "retried": retried, "dead": list(dead), "pending": pending}


def shutdown() -> int:
    # TODO: flush bounded by FLUSH_TIMEOUT_S; return how many records are still in flight
    raise NotImplementedError
`,
      solution: `from confluent_kafka import KafkaError, Producer

TOPIC = "events"
MAX_RETRIES = 3
MAX_PENDING = 100
FLUSH_TIMEOUT_S = 3

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
        "linger.ms": 0,
    }
)

delivered = 0
retried = 0
dead: list[str] = []
pending = 0


def _on_delivery(err: KafkaError | None, event_id: str, payload: str, attempt: int) -> None:
    global delivered, retried, pending
    pending -= 1
    if err is None:
        delivered += 1
        return
    if err.retriable() and attempt < MAX_RETRIES:
        retried += 1
        _produce(event_id, payload, attempt + 1)
        return
    dead.append(event_id)


def _produce(event_id: str, payload: str, attempt: int) -> None:
    global pending
    pending += 1
    producer.produce(
        TOPIC,
        key=event_id,
        value=payload,
        on_delivery=lambda err, msg: _on_delivery(err, event_id, payload, attempt),
    )


def send(event_id: str, payload: str) -> None:
    while pending >= MAX_PENDING:
        producer.poll(0.1)  # serve delivery reports until one frees a slot
    _produce(event_id, payload, 0)
    producer.poll(0)


def stats() -> dict:
    return {"delivered": delivered, "retried": retried, "dead": list(dead), "pending": pending}


def shutdown() -> int:
    return producer.flush(timeout=FLUSH_TIMEOUT_S)
`,
    },
    typescript: {
      starter: `import {type KafkaJSError, Kafka} from 'kafkajs';
import {setTimeout as sleep} from 'node:timers/promises';

export const TOPIC = 'events';
export const MAX_RETRIES = 3;
export const MAX_PENDING = 100;
export const FLUSH_TIMEOUT_MS = 3000;

const kafka = new Kafka({clientId: 'emitter', brokers: ['kafka:9092']});
// TODO: idempotent: true (and acks: -1 on every send) so the client's own retries never duplicate a record
const producer = kafka.producer();
const ready = producer.connect();

let delivered = 0;
let retried = 0;
const dead: string[] = [];
/** Deliveries handed to the producer and not yet settled: delivered, retried or dead. */
const inFlight = new Set<Promise<void>>();

function onFailure(err: KafkaJSError, eventId: string, payload: string, attempt: number): void {
  // TODO: retriable and attempt < MAX_RETRIES → retried, produce again; otherwise dead
}

function produce(eventId: string, payload: string, attempt: number): void {
  // TODO: once ready, send keyed by eventId; success → delivered; failure → onFailure; track the delivery in inFlight
  void sleep;
}

export async function send(eventId: string, payload: string): Promise<void> {
  // TODO: while inFlight is full, await a delivery; then produce
  throw new Error('not implemented');
}

export function stats(): {delivered: number; retried: number; dead: string[]; pending: number} {
  return {delivered, retried, dead: [...dead], pending: inFlight.size};
}

export async function shutdown(): Promise<number> {
  // TODO: wait for every delivery, at most FLUSH_TIMEOUT_MS; disconnect; return how many are still in flight
  throw new Error('not implemented');
}
`,
      solution: `import {type KafkaJSError, Kafka} from 'kafkajs';
import {setTimeout as sleep} from 'node:timers/promises';

export const TOPIC = 'events';
export const MAX_RETRIES = 3;
export const MAX_PENDING = 100;
export const FLUSH_TIMEOUT_MS = 3000;

const kafka = new Kafka({clientId: 'emitter', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
const ready = producer.connect();

let delivered = 0;
let retried = 0;
const dead: string[] = [];
/** Deliveries handed to the producer and not yet settled: delivered, retried or dead. */
const inFlight = new Set<Promise<void>>();

function onFailure(err: KafkaJSError, eventId: string, payload: string, attempt: number): void {
  if (err.retriable && attempt < MAX_RETRIES) {
    retried += 1;
    produce(eventId, payload, attempt + 1);
    return;
  }
  dead.push(eventId);
}

function produce(eventId: string, payload: string, attempt: number): void {
  const delivery: Promise<void> = ready
    .then(() => producer.send({topic: TOPIC, messages: [{key: eventId, value: payload}], acks: -1}))
    .then(
      () => {
        delivered += 1;
      },
      (err: KafkaJSError) => onFailure(err, eventId, payload, attempt),
    )
    .finally(() => inFlight.delete(delivery));
  inFlight.add(delivery);
}

export async function send(eventId: string, payload: string): Promise<void> {
  while (inFlight.size >= MAX_PENDING) await Promise.race(inFlight); // a delivery settles → a slot frees
  produce(eventId, payload, 0);
}

export function stats(): {delivered: number; retried: number; dead: string[]; pending: number} {
  return {delivered, retried, dead: [...dead], pending: inFlight.size};
}

export async function shutdown(): Promise<number> {
  const bound = sleep(FLUSH_TIMEOUT_MS).then(() => 'timeout' as const);
  // A retry adds a new delivery while the old one settles: wait round by round, under one bound.
  while (inFlight.size > 0) {
    const outcome = await Promise.race([Promise.all(inFlight).then(() => 'settled' as const), bound]);
    if (outcome === 'timeout') break;
  }
  await producer.disconnect();
  return inFlight.size;
}
`,
    },
    go: {
      starter: `package main

import (
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

const (
	maxRetries     = 3
	maxPending     = 100
	flushTimeoutMs = 3000
)

var topic = "events"

// attempt is the message opaque: which record a delivery report is about and how often it was tried.
type attempt struct {
	eventID string
	payload string
	n       int
}

var (
	delivered  int
	retried    int
	dead       []string
	pending    int
	deliveries = make(chan kafka.Event, maxPending)
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers": "kafka:9092",
		"acks":              "all",
		// TODO: enable.idempotence so the client's own retries never duplicate a record
		"linger.ms": 0,
	})
	if err != nil {
		panic(err)
	}
	return p
}

var producer = newProducer()

func settle(a *attempt, err error) {
	// TODO: pending--; nil → delivered; retriable and a.n < maxRetries → retried, produce again; else dead
}

func handle(ev kafka.Event) {
	if m, ok := ev.(*kafka.Message); ok {
		settle(m.Opaque.(*attempt), m.TopicPartition.Error)
	}
}

func produce(a *attempt) {
	// TODO: pending++; Produce keyed by a.eventID with a as Opaque, reports on deliveries
}

func send(eventID, payload string) {
	// TODO: while pending >= maxPending handle a report (blocking); produce; drain ready reports without blocking
}

func stats() map[string]any {
	return map[string]any{"delivered": delivered, "retried": retried, "dead": append([]string(nil), dead...), "pending": pending}
}

func shutdown() int {
	// TODO: handle reports until pending is 0 or flushTimeoutMs passed; return pending
	_ = time.Millisecond
	return 0
}
`,
      solution: `package main

import (
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

const (
	maxRetries     = 3
	maxPending     = 100
	flushTimeoutMs = 3000
)

var topic = "events"

// attempt is the message opaque: which record a delivery report is about and how often it was tried.
type attempt struct {
	eventID string
	payload string
	n       int
}

var (
	delivered  int
	retried    int
	dead       []string
	pending    int
	deliveries = make(chan kafka.Event, maxPending)
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all",
		"enable.idempotence": true,
		"linger.ms":          0,
	})
	if err != nil {
		panic(err)
	}
	return p
}

var producer = newProducer()

func settle(a *attempt, err error) {
	pending--
	if err == nil {
		delivered++
		return
	}
	if kerr, ok := err.(kafka.Error); ok && kerr.IsRetriable() && a.n < maxRetries {
		a.n++
		retried++
		produce(a)
		return
	}
	dead = append(dead, a.eventID)
}

func handle(ev kafka.Event) {
	if m, ok := ev.(*kafka.Message); ok {
		settle(m.Opaque.(*attempt), m.TopicPartition.Error)
	}
}

func produce(a *attempt) {
	pending++
	msg := &kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny},
		Key:            []byte(a.eventID),
		Value:          []byte(a.payload),
		Opaque:         a,
	}
	if err := producer.Produce(msg, deliveries); err != nil {
		settle(a, err) // the local queue refused it: a report like any other
	}
}

func send(eventID, payload string) {
	for pending >= maxPending {
		handle(<-deliveries) // block until a report frees a slot
	}
	produce(&attempt{eventID: eventID, payload: payload})
	for {
		select {
		case ev := <-deliveries:
			handle(ev)
		default:
			return
		}
	}
}

func stats() map[string]any {
	return map[string]any{"delivered": delivered, "retried": retried, "dead": append([]string(nil), dead...), "pending": pending}
}

func shutdown() int {
	deadline := time.After(flushTimeoutMs * time.Millisecond)
	for pending > 0 {
		select {
		case ev := <-deliveries:
			handle(ev)
		case <-deadline:
			return pending
		}
	}
	producer.Close()
	return 0
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import scala.collection.mutable.ListBuffer

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.errors.RetriableException
import org.apache.kafka.common.serialization.StringSerializer

object IdempotentProducer {
  val Topic = "events"
  val MaxRetries = 3
  val MaxPending = 100
  val FlushTimeoutMs = 3000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  // TODO: enable.idempotence so the client's own retries never duplicate a record
  props.put("linger.ms", "0")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val lock = new Object
  private var delivered = 0
  private var retried = 0
  private val dead = ListBuffer.empty[String]
  @volatile private var pending = 0

  private def onDelivery(exception: Exception, eventId: String, payload: String, attempt: Int): Unit = lock.synchronized {
    // TODO: pending -= 1; null → delivered; RetriableException and attempt < MaxRetries → retried, produce again; else dead
  }

  private def produce(eventId: String, payload: String, attempt: Int): Unit = {
    // TODO: pending += 1; send a record keyed by eventId with a Callback that knows the record and the attempt
  }

  def send(eventId: String, payload: String): Unit = {
    // TODO: wait while pending >= MaxPending (the I/O thread serves the callbacks); then produce
  }

  def stats(): Map[String, Any] = lock.synchronized {
    Map("delivered" -> delivered, "retried" -> retried, "dead" -> dead.toList, "pending" -> pending)
  }

  def shutdown(): Int = {
    // TODO: close bounded by FlushTimeoutMs; return how many records are still in flight
    0
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import scala.collection.mutable.ListBuffer

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.errors.RetriableException
import org.apache.kafka.common.serialization.StringSerializer

object IdempotentProducer {
  val Topic = "events"
  val MaxRetries = 3
  val MaxPending = 100
  val FlushTimeoutMs = 3000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  props.put("linger.ms", "0")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val lock = new Object
  private var delivered = 0
  private var retried = 0
  private val dead = ListBuffer.empty[String]
  @volatile private var pending = 0

  private def onDelivery(exception: Exception, eventId: String, payload: String, attempt: Int): Unit = lock.synchronized {
    pending -= 1
    if (exception == null) delivered += 1
    else if (exception.isInstanceOf[RetriableException] && attempt < MaxRetries) {
      retried += 1
      produce(eventId, payload, attempt + 1)
    } else dead += eventId
  }

  private def produce(eventId: String, payload: String, attempt: Int): Unit = {
    lock.synchronized { pending += 1 }
    val record = new ProducerRecord[String, String](Topic, eventId, payload)
    producer.send(record, new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        onDelivery(exception, eventId, payload, attempt)
    })
  }

  def send(eventId: String, payload: String): Unit = {
    while (pending >= MaxPending) Thread.sleep(10) // the I/O thread serves callbacks that free a slot
    produce(eventId, payload, 0)
  }

  def stats(): Map[String, Any] = lock.synchronized {
    Map("delivered" -> delivered, "retried" -> retried, "dead" -> dead.toList, "pending" -> pending)
  }

  def shutdown(): Int = {
    producer.close(Duration.ofMillis(FlushTimeoutMs))
    pending
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <string>
#include <vector>

const std::string kTopic = "events";
const int kMaxRetries = 3;
const int kMaxPending = 100;
const int kFlushTimeoutMs = 3000;

// The message opaque: which record a delivery report is about and how often it was tried.
struct Attempt {
  std::string event_id;
  std::string payload;
  int n = 0;
};

struct Stats {
  int delivered;
  int retried;
  std::vector<std::string> dead;
  int pending;
};

int delivered = 0;
int retried = 0;
std::vector<std::string> dead;
int pending = 0;

bool is_retriable(RdKafka::ErrorCode err) {
  return err == RdKafka::ERR__MSG_TIMED_OUT || err == RdKafka::ERR__TRANSPORT || err == RdKafka::ERR_REQUEST_TIMED_OUT ||
         err == RdKafka::ERR_NOT_LEADER_FOR_PARTITION || err == RdKafka::ERR_NOT_ENOUGH_REPLICAS;
}

void produce(Attempt* a);

class Reports : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    auto* a = static_cast<Attempt*>(message.msg_opaque());
    // TODO: pending -= 1; ok → delivered; retriable and a->n < kMaxRetries → retried, produce again; else dead
    delete a;
  }
};

Reports reports;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  // TODO: enable.idempotence so the client's own retries never duplicate a record
  conf->set("linger.ms", "0", err);
  conf->set("dr_cb", &reports, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void produce(Attempt* a) {
  // TODO: pending += 1; produce keyed by a->event_id (RK_MSG_COPY) with a as the message opaque
}

void send(const std::string& event_id, const std::string& payload) {
  // TODO: poll while pending >= kMaxPending; produce a new Attempt; poll(0) to serve delivery reports
}

Stats stats() { return Stats{delivered, retried, dead, pending}; }

int shutdown() {
  // TODO: flush bounded by kFlushTimeoutMs; return how many records are still in flight
  return 0;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <string>
#include <vector>

const std::string kTopic = "events";
const int kMaxRetries = 3;
const int kMaxPending = 100;
const int kFlushTimeoutMs = 3000;

// The message opaque: which record a delivery report is about and how often it was tried.
struct Attempt {
  std::string event_id;
  std::string payload;
  int n = 0;
};

struct Stats {
  int delivered;
  int retried;
  std::vector<std::string> dead;
  int pending;
};

int delivered = 0;
int retried = 0;
std::vector<std::string> dead;
int pending = 0;

bool is_retriable(RdKafka::ErrorCode err) {
  return err == RdKafka::ERR__MSG_TIMED_OUT || err == RdKafka::ERR__TRANSPORT || err == RdKafka::ERR_REQUEST_TIMED_OUT ||
         err == RdKafka::ERR_NOT_LEADER_FOR_PARTITION || err == RdKafka::ERR_NOT_ENOUGH_REPLICAS;
}

void produce(Attempt* a);

class Reports : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    auto* a = static_cast<Attempt*>(message.msg_opaque());
    pending -= 1;
    if (message.err() == RdKafka::ERR_NO_ERROR) {
      delivered += 1;
      delete a;
      return;
    }
    if (is_retriable(message.err()) && a->n < kMaxRetries) {
      a->n += 1;
      retried += 1;
      produce(a);  // the same record, the same opaque, one more attempt
      return;
    }
    dead.push_back(a->event_id);
    delete a;
  }
};

Reports reports;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("linger.ms", "0", err);
  conf->set("dr_cb", &reports, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void produce(Attempt* a) {
  pending += 1;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, a->payload.data(),
                        a->payload.size(), a->event_id.c_str(), a->event_id.size(), 0, a);
  if (err != RdKafka::ERR_NO_ERROR) {
    // The local queue refused it: give up on this record like any non-retriable report.
    pending -= 1;
    dead.push_back(a->event_id);
    delete a;
  }
}

void send(const std::string& event_id, const std::string& payload) {
  while (pending >= kMaxPending) producer->poll(100);  // serve delivery reports until one frees a slot
  produce(new Attempt{event_id, payload, 0});
  producer->poll(0);
}

Stats stats() { return Stats{delivered, retried, dead, pending}; }

int shutdown() {
  producer->flush(kFlushTimeoutMs);
  return pending;
}
`,
    },
  },
  harness: {
    python: `TOPIC = "events"


def _m(ctx):
    return ctx.load("idempotent_producer")


def check_lose_acks(ctx):
    m = _m(ctx)
    ctx.kafka.lose_acks(TOPIC)
    m.send("e1", "p1")
    m.shutdown()
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"a lost ack must not duplicate the record (enable.idempotence): {len(records)} copies on {TOPIC}"
    s = m.stats()
    assert s["delivered"] == 1, f"the record was written once and must count as delivered once, got delivered={s['delivered']}"
    assert s["dead"] == [], f"a lost ack is not a failure: dead={s['dead']}"
    assert s["pending"] == 0, f"nothing is in flight after shutdown, got pending={s['pending']}"


def check_retries(ctx):
    m = _m(ctx)
    ctx.kafka.fail_next(TOPIC, 2)
    m.send("e1", "p1")
    m.shutdown()
    s = m.stats()
    assert s["retried"] == 2, f"two retriable failures mean two retries, got retried={s['retried']}"
    assert s["delivered"] == 1, f"the third attempt succeeds: delivered must be 1, got {s['delivered']}"
    assert s["dead"] == [], f"a record that eventually delivered must not be in dead: {s['dead']}"
    assert ctx.kafka.keys(TOPIC) == [b"e1"], f"exactly one record with key e1 on {TOPIC}, got {ctx.kafka.keys(TOPIC)}"
    assert ctx.kafka.values(TOPIC) == [b"p1"], "the retry must carry the same value"


def check_dead(ctx):
    m = _m(ctx)
    ctx.kafka.fail_next(TOPIC, 4)
    m.send("e1", "p1")
    m.send("e2", "p2")
    m.shutdown()
    s = m.stats()
    assert s["dead"] == ["e1"], f"a record that failed MAX_RETRIES + 1 times belongs in dead: {s['dead']}"
    assert s["retried"] == 3, f"MAX_RETRIES retries, no more: retried={s['retried']}"
    assert s["delivered"] == 1, f"e2 still delivers: delivered={s['delivered']}"
    keys = ctx.kafka.keys(TOPIC)
    assert keys.count(b"e1") <= 1, f"e1 is on the topic {keys.count(b'e1')} times"
    assert keys.count(b"e2") == 1, f"e2 must be on the topic exactly once, got {keys}"
    assert s["pending"] == 0, f"a dead record is not in flight: pending={s['pending']}"


def check_backpressure(ctx):
    m = _m(ctx)
    ctx.kafka.stall(TOPIC, 5)  # the broker answers again after 5 s
    ids = [f"e{i}" for i in range(150)]
    for event_id in ids:
        m.send(event_id, "p")
        assert m.stats()["pending"] <= 100, f"pending reached {m.stats()['pending']}: MAX_PENDING is 100"
    stalled = [e for e in ctx.kafka.events if e[0] == "produce-stalled"]
    assert len(stalled) <= 100, f"{len(stalled)} records were handed to the stalled broker: send must wait once MAX_PENDING are in flight"
    assert len(stalled) > 0, "with the broker stalled the first MAX_PENDING records must still be handed to the producer"
    m.shutdown()
    keys = ctx.kafka.keys(TOPIC)
    assert sorted(keys) == sorted(i.encode() for i in ids), f"every record must land once the broker answers: {len(keys)} of 150, {len(set(keys))} distinct"
    s = m.stats()
    assert s["delivered"] == 150 and s["dead"] == [], f"delivered={s['delivered']} dead={s['dead']}: waiting is not dropping"


def check_keyed(ctx):
    m = _m(ctx)
    for event_id in ("order-1", "order-2", "order-3"):
        m.send(event_id, "p")
    m.shutdown()
    records = ctx.kafka.records(TOPIC)
    assert [r.key for r in records] == [b"order-1", b"order-2", b"order-3"], f"keys must be the event ids, got {[r.key for r in records]}"
    for r in records:
        assert r.partition == ctx.kafka.partition_for(TOPIC, r.key), f"{r.key} sits on partition {r.partition}, not the one its key hashes to"


def check_flush_bound(ctx):
    m = _m(ctx)
    ctx.kafka.stall(TOPIC)  # dead broker
    m.send("e1", "p1")
    started = ctx.clock.time()
    left = m.shutdown()
    waited = ctx.clock.time() - started
    assert 2.5 <= waited <= 10, f"shutdown waited {waited:.1f} s on a dead broker: flush must be bounded by FLUSH_TIMEOUT_S = 3"
    assert left == 1, f"shutdown must return how many records are still in flight (1), got {left!r}"
    s = m.stats()
    assert s["delivered"] == 0 and s["pending"] == 1, f"nothing was delivered and one record is still in flight: {s}"
`,
    typescript: `import {setTimeout as sleep} from 'node:timers/promises';

const TOPIC = 'events';

export async function check_lose_acks(ctx) {
  const m = ctx.load('idempotent_producer');
  ctx.kafka.loseAcks(TOPIC);
  await m.send('e1', 'p1');
  await m.shutdown();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`a lost ack must not duplicate the record (idempotent: true): \${records.length} copies on \${TOPIC}\`);
  const s = m.stats();
  assert.equal(s.delivered, 1, \`the record was written once and must count as delivered once, got delivered=\${s.delivered}\`);
  assert.deepEqual(s.dead, [], \`a lost ack is not a failure: dead=\${JSON.stringify(s.dead)}\`);
  assert.equal(s.pending, 0, \`nothing is in flight after shutdown, got pending=\${s.pending}\`);
}

export async function check_retries(ctx) {
  const m = ctx.load('idempotent_producer');
  ctx.kafka.failNext(TOPIC, 2);
  await m.send('e1', 'p1');
  await m.shutdown();
  const s = m.stats();
  assert.equal(s.retried, 2, \`two retriable failures mean two retries, got retried=\${s.retried}\`);
  assert.equal(s.delivered, 1, \`the third attempt succeeds: delivered must be 1, got \${s.delivered}\`);
  assert.deepEqual(s.dead, [], \`a record that eventually delivered must not be in dead: \${JSON.stringify(s.dead)}\`);
  assert.deepEqual(ctx.kafka.keys(TOPIC), ['e1'], \`exactly one record with key e1 on \${TOPIC}, got \${JSON.stringify(ctx.kafka.keys(TOPIC))}\`);
  assert.deepEqual(ctx.kafka.values(TOPIC), ['p1'], 'the retry must carry the same value');
}

export async function check_dead(ctx) {
  const m = ctx.load('idempotent_producer');
  ctx.kafka.failNext(TOPIC, 4);
  await m.send('e1', 'p1');
  await sleep(10); // the retry chain runs
  await m.send('e2', 'p2');
  await m.shutdown();
  const s = m.stats();
  assert.deepEqual(s.dead, ['e1'], \`a record that failed MAX_RETRIES + 1 times belongs in dead: \${JSON.stringify(s.dead)}\`);
  assert.equal(s.retried, 3, \`MAX_RETRIES retries, no more: retried=\${s.retried}\`);
  assert.equal(s.delivered, 1, \`e2 still delivers: delivered=\${s.delivered}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert(keys.filter(k => k === 'e1').length <= 1, \`e1 is on the topic \${keys.filter(k => k === 'e1').length} times\`);
  assert.equal(keys.filter(k => k === 'e2').length, 1, \`e2 must be on the topic exactly once, got \${JSON.stringify(keys)}\`);
  assert.equal(s.pending, 0, \`a dead record is not in flight: pending=\${s.pending}\`);
}

export async function check_backpressure(ctx) {
  const m = ctx.load('idempotent_producer');
  ctx.kafka.stall(TOPIC, 5); // the broker answers again after 5 s
  const ids = Array.from({length: 150}, (_, i) => \`e\${i}\`);
  const sends: Promise<void>[] = ids.map(id => m.send(id, 'p'));
  await sleep(10); // the probe: the stall is still on
  const stalled = ctx.kafka.events.filter(e => e[0] === 'produce-stalled').length;
  assert(stalled <= 100, \`\${stalled} records were handed to the stalled broker: send must wait once MAX_PENDING are in flight\`);
  assert(stalled > 0, 'with the broker stalled the first MAX_PENDING records must still be handed to the producer');
  assert(m.stats().pending <= 100, \`pending is \${m.stats().pending} during the stall: MAX_PENDING is 100\`);
  await Promise.all(sends);
  await m.shutdown();
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual([...keys].sort(), [...ids].sort(), \`every record must land once the broker answers: \${keys.length} of 150, \${new Set(keys).size} distinct\`);
  const s = m.stats();
  assert(s.delivered === 150 && s.dead.length === 0, \`delivered=\${s.delivered} dead=\${JSON.stringify(s.dead)}: waiting is not dropping\`);
}

export async function check_keyed(ctx) {
  const m = ctx.load('idempotent_producer');
  for (const id of ['order-1', 'order-2', 'order-3']) await m.send(id, 'p');
  await m.shutdown();
  const records = ctx.kafka.records(TOPIC);
  const keys = records.map(r => (r.key === null ? null : String(r.key)));
  assert.deepEqual(keys, ['order-1', 'order-2', 'order-3'], \`keys must be the event ids, got \${JSON.stringify(keys)}\`);
  for (const r of records)
    assert.equal(r.partition, ctx.kafka.partitionFor(TOPIC, r.key), \`\${String(r.key)} sits on partition \${r.partition}, not the one its key hashes to\`);
}

export async function check_flush_bound(ctx) {
  const m = ctx.load('idempotent_producer');
  ctx.kafka.stall(TOPIC); // dead broker
  await m.send('e1', 'p1');
  const started = ctx.clock.now();
  const left = await m.shutdown();
  const waited = ctx.clock.now() - started;
  assert(waited >= 2500 && waited <= 10_000, \`shutdown waited \${Math.round(waited)} ms on a dead broker: flush must be bounded by FLUSH_TIMEOUT_MS = 3000\`);
  assert.equal(left, 1, \`shutdown must return how many records are still in flight (1), got \${JSON.stringify(left)}\`);
  const s = m.stats();
  assert(s.delivered === 0 && s.pending === 1, \`nothing was delivered and one record is still in flight: \${JSON.stringify(s)}\`);
}
`,
  },
  debrief: `Three things happen at three places, and the solution keeps them apart. **Idempotence is configuration**: \`enable.idempotence\` with \`acks=all\` makes the *client's* retries safe — a batch whose ack was lost is resent with the same producer id and sequence number and the broker writes it once — so the delivery report arrives exactly once per record and \`delivered\` is honest. **Retries are the callback's**: the client already retried what it could; what reaches the callback as a retriable error (a message timeout, a transport error) is yours to re-produce, bounded by \`MAX_RETRIES\`, with the same key so the retry lands on the same partition; everything else is parked in \`dead\` instead of looping forever. **The window is the caller's**: \`pending\` counts produces minus reports, and \`send\` waits on it — polling, which is what serves the reports that free a slot — so a stalled broker slows the caller down rather than filling memory, and the records wait their turn instead of being dropped. Real producers add a dead-letter *topic* for the parked ids, \`max.in.flight.requests.per.connection ≤ 5\` (idempotence keeps order within it), \`delivery.timeout.ms\` tuned to how long a retry is worth, and metrics on \`pending\` — the first number that moves when a broker is in trouble.`,
};
