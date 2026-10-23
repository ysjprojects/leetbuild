import type {Step} from '@/lib/types';

export const countEventsStep: Step = {
  id: 'count-events',
  title: 'Eventually consistent: every add is an event, durable before the 202',
  concept: 'kafka',
  file: 'count_events',
  focus: ['api', 'kafka'],
  task: `## Task

An eventually-consistent counter is not a number anywhere yet — it is a log of adds that a rollup
will fold later. Implement \`append_event(ns, name, delta, token)\`, which the API calls before it
answers **202**:

- Produce one record to the **\`counter-events\`** topic, keyed by **\`{ns}:{name}\`**: every event of one
  counter lands on one partition, in order, and the rollup of the next step can fold a counter without
  merging partitions.
- The value is JSON: \`{"ns": …, "name": …, "delta": …, "token": …, "ts": …}\`. The \`token\` is carried as
  is — it is the client's idempotency key, and the rollup needs it to drop a retry.
- The producer must ask for **\`acks=all\`** and enable idempotence: a 202 is a durability promise, and
  a leader-only ack can be lost when the leader dies.
- Wait for the acknowledgement with a **bounded flush** — \`producer.flush(timeout=FLUSH_TIMEOUT_S)\`
  (1 s) — **before returning**. If the delivery callback reports an error or the flush leaves the
  record pending, raise \`EventNotDurable\`: the API turns it into a **503**, and the client retries
  with the *same token*, which is why the retry is safe.

:::widget idempotency {}

:::widget kafka-partitions {"partitions": 6}

> This is the opposite trade from a click stream: there a lost event was cheaper than a slow redirect,
> here a lost event is a wrong number forever. So the add waits — but never longer than a second.`,
  sequence: {
    participants: ['counters', 'Producer', 'Kafka'],
    messages: [
      {
        from: 'counters',
        to: 'Producer',
        label: 'produce(counter-events, key=plays:stranger-things, {delta: 1, token: t-9f3, ts})',
        kind: 'sync',
      },
      {from: 'Producer', to: 'Kafka', label: 'partition hash(plays:stranger-things) % 6 · acks=all', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack: every in-sync replica has it (offset 88 412)', kind: 'reply'},
      {from: 'Producer', to: 'counters', label: 'delivery callback (err = None)', kind: 'async'},
      {from: 'counters', to: 'counters', label: 'flush(timeout 1 s) → 0 pending · return', kind: 'sync'},
    ],
  },
  hints: [
    'Configure durability on the producer, not per call: `acks=all` and `enable.idempotence=true` in the producer configuration.',
    'Give `produce` a delivery callback that stores the error it receives, then `flush(timeout=FLUSH_TIMEOUT_S)`; `flush` returns how many records are still pending — anything but 0, or a stored error, means not durable.',
    'Raise `EventNotDurable` rather than returning a boolean: the API already knows how to turn an exception into a 503, and the token on the retry makes the duplicate harmless.',
  ],
  checks: [
    {
      id: 'topic-key',
      title: 'Produces to counter-events keyed by ns:name',
      detail:
        'The record goes to the `counter-events` topic with `{ns}:{name}` as its key, so one counter is one partition.',
      match: {
        python: {all: [/"counter-events"/, /f["']\{ns\}:\{name\}["']/, /producer\.produce\(/]},
        typescript: {all: [/['"]counter-events['"]/, /`\$\{ns\}:\$\{name\}`/, /producer\.send\(/]},
        go: {all: [/"counter-events"/, /Key:\s*\[\]byte\(\s*ns\s*\+\s*":"\s*\+\s*name\s*\)/, /WriteMessages\(/]},
        scala: {all: [/"counter-events"/, /s"\$ns:\$name"|s"\$\{ns\}:\$\{name\}"/, /producer\.send\(/]},
        cpp: {all: [/"counter-events"/, /ns\s*\+\s*":"\s*\+\s*name/, /producer->produce\(/]},
      },
    },
    {
      id: 'event-shape',
      title: 'The value carries ns, name, delta, token and ts as JSON',
      detail:
        'The event is a JSON document with the five fields; the token must travel with the event for the rollup to dedupe on it.',
      match: {
        python: {all: [/json\.dumps\(/, /"delta"/, /"token"/, /"ts"/]},
        typescript: {all: [/JSON\.stringify\(/, /\bdelta\b/, /\btoken\b/, /\bts\s*[:,}]/]},
        go: {all: [/json\.Marshal\(/, /json:"delta"/, /json:"token"/, /json:"ts"/]},
        scala: {all: [/"delta"\s*->/, /"token"\s*->/, /"ts"\s*->/, /compactPrint/]},
        cpp: {all: [/\{"delta",/, /\{"token",/, /\{"ts",/, /\.dump\(\)/]},
      },
    },
    {
      id: 'acks-all',
      title: 'Producer requires acks=all with idempotence',
      detail:
        'A 202 promises durability; `acks=all` means every in-sync replica has the record, and idempotence keeps the producer’s own retries from doubling it.',
      match: {
        python: {all: [/"acks"\s*:\s*"all"/, /"enable\.idempotence"\s*:\s*True/]},
        typescript: {all: [/idempotent:\s*true/], none: [/acks:\s*[01]\b/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {
          all: [
            /"acks"\s*,\s*"all"|ACKS_CONFIG\s*,\s*"all"/,
            /"enable\.idempotence"\s*,\s*"true"|ENABLE_IDEMPOTENCE_CONFIG\s*,\s*"true"/,
          ],
        },
        cpp: {all: [/"acks"\s*,\s*"all"/, /"enable\.idempotence"\s*,\s*"true"/]},
      },
    },
    {
      id: 'bounded-flush',
      title: 'Waits for the ack with a bounded flush before returning',
      detail:
        '`append_event` flushes with `FLUSH_TIMEOUT_S` (1 s) so the 202 is only sent once the broker acknowledged — and a dead broker fails the add instead of hanging it.',
      match: {
        python: {
          all: [/def append_event(?:(?!\ndef )[\s\S])*?producer\.flush\(\s*(timeout\s*=\s*)?FLUSH_TIMEOUT_S\s*\)/],
          none: [/producer\.flush\(\s*\)/],
        },
        typescript: {all: [/producer\.send\(/, /(timeout|messageTimeoutMs):\s*FLUSH_TIMEOUT_MS/]},
        go: {
          all: [/context\.WithTimeout\(\s*ctx\s*,\s*flushTimeout\s*\)/, /writer\.WriteMessages\(/],
          none: [/Async:\s*true/],
        },
        scala: {all: [/\.get\(\s*FlushTimeoutMillis\s*,\s*TimeUnit\.MILLISECONDS\s*\)/]},
        cpp: {all: [/producer->flush\(\s*kFlushTimeoutMs\s*\)/], none: [/producer->flush\(\s*-1\s*\)/]},
      },
    },
    {
      id: 'not-durable-raises',
      title: 'Raises EventNotDurable when the record was not acknowledged',
      detail:
        'A delivery error reported through the callback, or a record still pending after the flush, raises `EventNotDurable` so the API answers 503 and the client retries with the same token.',
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /raise EventNotDurable\(/]},
        typescript: {all: [/catch\s*(\(\s*\w+\s*\))?\s*\{/, /throw new EventNotDurable\(/]},
        go: {all: [/return ErrNotDurable|errors\.Join\(\s*ErrNotDurable|fmt\.Errorf\([^\n]*ErrNotDurable/]},
        scala: {all: [/throw new EventNotDurable\(/]},
        cpp: {all: [/dr_cb\(/, /throw EventNotDurable\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

from confluent_kafka import Producer

TOPIC = "counter-events"
FLUSH_TIMEOUT_S = 1.0

producer = Producer({"bootstrap.servers": "kafka:9092"})  # TODO: acks=all, enable.idempotence


class EventNotDurable(Exception):
    """The broker did not acknowledge the event in time; the API answers 503 and the client retries with the same token."""


def append_event(ns: str, name: str, delta: int, token: str) -> None:
    value = json.dumps({"ns": ns, "name": name, "delta": delta, "token": token, "ts": time.time()})
    # TODO: produce to TOPIC keyed by {ns}:{name} with a delivery callback that remembers the error
    # TODO: flush with timeout=FLUSH_TIMEOUT_S; a pending record or a delivery error → raise EventNotDurable
    raise NotImplementedError
`,
      solution: `import json
import time

from confluent_kafka import Producer

TOPIC = "counter-events"
FLUSH_TIMEOUT_S = 1.0

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


class EventNotDurable(Exception):
    """The broker did not acknowledge the event in time; the API answers 503 and the client retries with the same token."""


def append_event(ns: str, name: str, delta: int, token: str) -> None:
    value = json.dumps({"ns": ns, "name": name, "delta": delta, "token": token, "ts": time.time()})
    outcome: dict = {}

    def on_delivery(err, msg) -> None:
        outcome["err"] = err

    producer.produce(TOPIC, key=f"{ns}:{name}", value=value, on_delivery=on_delivery)
    pending = producer.flush(timeout=FLUSH_TIMEOUT_S)
    if pending or outcome.get("err") is not None:
        raise EventNotDurable(f"counter event {token} not acknowledged: {outcome.get('err') or 'timed out'}")
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'counter-events';
export const FLUSH_TIMEOUT_MS = 1000;

const kafka = new Kafka({clientId: 'counters', brokers: ['kafka:9092']});
const producer = kafka.producer(); // TODO: acks all with idempotence
const connected = producer.connect();

/** The broker did not acknowledge the event in time; the API answers 503 and the client retries with the same token. */
export class EventNotDurable extends Error {}

export async function appendEvent(ns: string, name: string, delta: number, token: string): Promise<void> {
  const value = JSON.stringify({ns, name, delta, token, ts: Date.now() / 1000});
  await connected;
  // TODO: send to TOPIC keyed by {ns}:{name}, waiting for the ack no longer than FLUSH_TIMEOUT_MS
  // TODO: a delivery error or a timed-out ack → throw EventNotDurable
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const TOPIC = 'counter-events';
export const FLUSH_TIMEOUT_MS = 1000;

const kafka = new Kafka({clientId: 'counters', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true}); // idempotence implies acks: -1 (all)
const connected = producer.connect();

/** The broker did not acknowledge the event in time; the API answers 503 and the client retries with the same token. */
export class EventNotDurable extends Error {}

export async function appendEvent(ns: string, name: string, delta: number, token: string): Promise<void> {
  const value = JSON.stringify({ns, name, delta, token, ts: Date.now() / 1000});
  await connected;
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{key: \`\${ns}:\${name}\`, value}],
      acks: -1,
      timeout: FLUSH_TIMEOUT_MS, // the ack is awaited, but never longer than this
    });
  } catch (e) {
    throw new EventNotDurable(\`counter event \${token} not acknowledged: \${(e as Error).message}\`);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	topic        = "counter-events"
	flushTimeout = time.Second
)

// ErrNotDurable: the broker did not acknowledge the event in time; the API answers 503 and the client retries with the same token.
var ErrNotDurable = errors.New("counter event not acknowledged")

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	BatchTimeout: 5 * time.Millisecond, // a sync write waits for its batch; the default lingers 1 s
	// TODO: RequiredAcks: every in-sync replica (kafka-go has no idempotent producer: a retry after a lost ack is a copy carrying the same token)
}

type countEvent struct {
	NS    string  \`json:"ns"\`
	Name  string  \`json:"name"\`
	Delta int64   \`json:"delta"\`
	Token string  \`json:"token"\`
	Ts    float64 \`json:"ts"\`
}

func appendEvent(ctx context.Context, ns, name string, delta int64, token string) error {
	value, _ := json.Marshal(countEvent{NS: ns, Name: name, Delta: delta, Token: token, Ts: float64(time.Now().UnixMilli()) / 1000})
	// TODO: WriteMessages keyed by ns:name under a context that expires after flushTimeout (a synchronous writer waits for the ack)
	// TODO: any error → ErrNotDurable
	_ = value
	return errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	topic        = "counter-events"
	flushTimeout = time.Second
)

// ErrNotDurable: the broker did not acknowledge the event in time; the API answers 503 and the client retries with the same token.
var ErrNotDurable = errors.New("counter event not acknowledged")

// kafka-go has no idempotent producer: RequireAll is what it can promise, and a retry after a lost ack
// is an identical copy carrying the same token, which the rollup drops.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	BatchTimeout: 5 * time.Millisecond, // a sync write waits for its batch; the default lingers 1 s
	RequiredAcks: kafka.RequireAll,
}

type countEvent struct {
	NS    string  \`json:"ns"\`
	Name  string  \`json:"name"\`
	Delta int64   \`json:"delta"\`
	Token string  \`json:"token"\`
	Ts    float64 \`json:"ts"\`
}

func appendEvent(ctx context.Context, ns, name string, delta int64, token string) error {
	value, _ := json.Marshal(countEvent{NS: ns, Name: name, Delta: delta, Token: token, Ts: float64(time.Now().UnixMilli()) / 1000})
	callCtx, cancel := context.WithTimeout(ctx, flushTimeout)
	defer cancel()
	// A synchronous writer returns once every in-sync replica acknowledged the batch, or the context expired.
	if err := writer.WriteMessages(callCtx, kafka.Message{Key: []byte(ns + ":" + name), Value: value}); err != nil {
		return fmt.Errorf("%w: %v", ErrNotDurable, err)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

/** The broker did not acknowledge the event in time; the API answers 503 and the client retries with the same token. */
final class EventNotDurable(message: String) extends RuntimeException(message)

object CountEvents {
  val Topic = "counter-events"
  val FlushTimeoutMillis = 1000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // TODO: acks=all, enable.idempotence=true
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def appendEvent(ns: String, name: String, delta: Long, token: String): Unit = {
    val value = JsObject(
      "ns" -> JsString(ns),
      "name" -> JsString(name),
      "delta" -> JsNumber(delta),
      "token" -> JsString(token),
      "ts" -> JsNumber(System.currentTimeMillis() / 1000.0),
    ).compactPrint
    // TODO: send a record keyed by s"$ns:$name" and wait on the future for at most FlushTimeoutMillis
    // TODO: any exception (timeout, delivery failure) → throw new EventNotDurable
    ???
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

/** The broker did not acknowledge the event in time; the API answers 503 and the client retries with the same token. */
final class EventNotDurable(message: String) extends RuntimeException(message)

object CountEvents {
  val Topic = "counter-events"
  val FlushTimeoutMillis = 1000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def appendEvent(ns: String, name: String, delta: Long, token: String): Unit = {
    val value = JsObject(
      "ns" -> JsString(ns),
      "name" -> JsString(name),
      "delta" -> JsNumber(delta),
      "token" -> JsString(token),
      "ts" -> JsNumber(System.currentTimeMillis() / 1000.0),
    ).compactPrint
    val record = new ProducerRecord[String, String](Topic, s"$ns:$name", value)
    try producer.send(record).get(FlushTimeoutMillis, TimeUnit.MILLISECONDS) // blocks until every in-sync replica acknowledged
    catch { case e: Exception => throw new EventNotDurable(s"counter event $token not acknowledged: \${e.getMessage}") }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "counter-events";
constexpr int kFlushTimeoutMs = 1000;

// The broker did not acknowledge the event in time; the API answers 503 and the client retries with the same token.
struct EventNotDurable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// TODO: a DeliveryReportCb that remembers the last delivery error

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // TODO: acks=all, enable.idempotence=true, dr_cb
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void append_event(const std::string& ns, const std::string& name, long long delta, const std::string& token) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string value = json{{"ns", ns}, {"name", name}, {"delta", delta}, {"token", token}, {"ts", ts}}.dump();
  // TODO: produce keyed by ns + ":" + name (RK_MSG_COPY); flush(kFlushTimeoutMs)
  // TODO: a produce error, a flush that leaves the record pending, or a delivery error → throw EventNotDurable
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "counter-events";
constexpr int kFlushTimeoutMs = 1000;

// The broker did not acknowledge the event in time; the API answers 503 and the client retries with the same token.
struct EventNotDurable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

class RememberFailure : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode last = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { last = message.err(); }
};

RememberFailure delivery;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void append_event(const std::string& ns, const std::string& name, long long delta, const std::string& token) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string value = json{{"ns", ns}, {"name", name}, {"delta", delta}, {"token", token}, {"ts", ts}}.dump();
  const std::string key = ns + ":" + name;
  delivery.last = RdKafka::ERR_NO_ERROR;
  const RdKafka::ErrorCode produced =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                        const_cast<char*>(value.data()), value.size(), key.c_str(), key.size(), 0, nullptr);
  if (produced != RdKafka::ERR_NO_ERROR) throw EventNotDurable("counter event " + token + ": " + RdKafka::err2str(produced));
  // flush serves the delivery report; a timeout leaves the record in the queue.
  if (producer->flush(kFlushTimeoutMs) != RdKafka::ERR_NO_ERROR || delivery.last != RdKafka::ERR_NO_ERROR)
    throw EventNotDurable("counter event " + token + " not acknowledged: " + RdKafka::err2str(delivery.last));
}
`,
    },
  },
  harness: {
    python: `import json
import time

TOPIC = "counter-events"
FLUSH_TIMEOUT_S = 1.0


def _tokens(ctx):
    return [json.loads(r.value).get("token") for r in ctx.kafka.records(TOPIC)]


def check_topic_key(ctx):
    m = ctx.load("count_events")
    m.append_event("plays", "stranger-things", 1, "t-9f3")
    m.append_event("plays", "stranger-things", 2, "t-9f4")
    m.append_event("plays", "the-crown", 1, "t-9f5")
    produced = ctx.kafka.records(TOPIC)
    assert len(produced) == 3, f"expected three records on {TOPIC}, found {len(produced)} (topics: {list(ctx.kafka.topics)})"
    keys = [r.key for r in produced]
    assert keys == [b"plays:stranger-things", b"plays:stranger-things", b"plays:the-crown"], f"records must be keyed by ns:name, got {keys}"
    assert produced[0].partition == produced[1].partition, "the same counter must land on the same partition"


def check_event_shape(ctx):
    m = ctx.load("count_events")
    m.append_event("plays", "stranger-things", -2, "t-9f3")
    produced = ctx.kafka.records(TOPIC)
    assert len(produced) == 1, f"expected one record on {TOPIC}, found {len(produced)}"
    event = json.loads(produced[0].value)
    assert event.get("ns") == "plays" and event.get("name") == "stranger-things", f"the value must carry ns and name: {event}"
    assert event.get("delta") == -2 and isinstance(event["delta"], int), f"the value must carry the delta as an integer: {event}"
    assert event.get("token") == "t-9f3", f"the value must carry the client's token unchanged — the rollup dedupes on it: {event}"
    assert isinstance(event.get("ts"), (int, float)) and abs(event["ts"] - time.time()) < 60, f"the value must carry a current timestamp: {event}"


def check_acks_all(ctx):
    m = ctx.load("count_events")
    # The partition leader fails right after acknowledging: only an event every in-sync replica has survives.
    m.append_event("plays", "stranger-things", 1, "t-9f3")
    ctx.kafka.failover(TOPIC)
    held = len(ctx.kafka.records(TOPIC))
    assert held == 1, f"append_event returned (the API would answer 202), then the partition leader failed and {TOPIC} holds {held} record(s) instead of the event: it had been acknowledged by the leader alone. A durability promise needs acks=all"
    # The broker writes the next event but its acknowledgement is lost: the producer retries it.
    ctx.kafka.lose_acks(TOPIC)
    m.append_event("plays", "stranger-things", 2, "t-9f4")
    copies = len(ctx.kafka.records(TOPIC)) - 1
    assert copies == 1, f"the broker wrote the second event, its acknowledgement was lost and the producer retried: {TOPIC} now holds it {copies} times. With enable.idempotence the broker recognises the retry and writes the event once"


def check_bounded_flush(ctx):
    m = ctx.load("count_events")
    # The broker is slow but answers within FLUSH_TIMEOUT_S: the add waits for the ack and succeeds.
    ctx.kafka.stall(TOPIC, seconds=0.8)
    try:
        m.append_event("plays", "stranger-things", 1, "t-9f3")
    except m.EventNotDurable as e:
        raise AssertionError(f"the broker acknowledged after 0.8 s, within FLUSH_TIMEOUT_S (1 s), but append_event raised EventNotDurable ({e}): it must wait for the acknowledgement up to the bound")
    held = len(ctx.kafka.records(TOPIC))
    assert held == 1, f"append_event returned while the event was still unacknowledged ({TOPIC} holds {held} record(s)): it must not return — and the API must not answer 202 — before the broker has the event, exactly once"
    # The broker is down: the add gives up after FLUSH_TIMEOUT_S instead of hanging the request.
    ctx.kafka.stall(TOPIC)
    start = ctx.clock.time()
    try:
        m.append_event("plays", "stranger-things", 1, "t-9f4")
        returned = True
    except m.EventNotDurable:
        returned = False
    waited = ctx.clock.time() - start
    assert waited <= FLUSH_TIMEOUT_S + 0.05, f"with the broker down append_event waited {waited:.0f} s before giving up — an unbounded flush waits for the whole message timeout while the client's request hangs: bound it with FLUSH_TIMEOUT_S (1 s)"
    assert not returned, f"with the broker down append_event returned normally after {waited:.1f} s without an acknowledgement: the API would answer 202 for an event that may never be written"
    held = len(ctx.kafka.records(TOPIC))
    assert held == 1, f"nothing can be written while the broker is down, yet {TOPIC} holds {held} record(s)"


def check_not_durable_raises(ctx):
    m = ctx.load("count_events")
    ctx.kafka.fail_next(TOPIC)
    try:
        m.append_event("plays", "stranger-things", 1, "t-9f3")
        raise AssertionError("the broker refused the record (delivery error) but append_event returned normally: the API would answer 202 for an event that was lost")
    except m.EventNotDurable:
        pass
    assert len(ctx.kafka.records(TOPIC)) == 0
    m.append_event("plays", "stranger-things", 1, "t-9f3")  # the client's retry, same token
    assert _tokens(ctx) == ["t-9f3"], f"after the failure the retry must be produced normally, carrying the same token, which is what makes it safe: {TOPIC} holds {_tokens(ctx)}"
    ctx.kafka.stall(TOPIC)
    try:
        m.append_event("plays", "stranger-things", 1, "t-9f4")
        raise AssertionError("the broker did not acknowledge the record within the flush (it is still pending) but append_event returned normally: the API would answer 202 for an event that may never be written")
    except m.EventNotDurable:
        pass
`,
    typescript: `const TOPIC = 'counter-events';
const FLUSH_TIMEOUT_S = 1;

/** Whether appendEvent returned normally or threw EventNotDurable; anything else propagates. */
async function attempt(m, ...args) {
  try {
    await m.appendEvent(...args);
    return {returned: true, error: null};
  } catch (e) {
    if (e instanceof m.EventNotDurable) return {returned: false, error: e};
    throw e;
  }
}

export async function check_topic_key(ctx) {
  const m = ctx.load('count_events');
  await m.appendEvent('plays', 'stranger-things', 1, 't-9f3');
  await m.appendEvent('plays', 'stranger-things', 2, 't-9f4');
  await m.appendEvent('plays', 'the-crown', 1, 't-9f5');
  const produced = ctx.kafka.records(TOPIC);
  assert.equal(produced.length, 3, \`expected three records on \${TOPIC}, found \${produced.length} (topics: \${JSON.stringify([...ctx.kafka.topics.keys()])})\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['plays:stranger-things', 'plays:stranger-things', 'plays:the-crown'], \`records must be keyed by ns:name, got \${JSON.stringify(keys)}\`);
  assert.equal(produced[0].partition, produced[1].partition, 'the same counter must land on the same partition');
}

export async function check_event_shape(ctx) {
  const m = ctx.load('count_events');
  await m.appendEvent('plays', 'stranger-things', -2, 't-9f3');
  const produced = ctx.kafka.values(TOPIC);
  assert.equal(produced.length, 1, \`expected one record on \${TOPIC}, found \${produced.length}\`);
  const event = JSON.parse(produced[0]);
  assert(event.ns === 'plays' && event.name === 'stranger-things', \`the value must carry ns and name: \${produced[0]}\`);
  assert(event.delta === -2, \`the value must carry the delta as an integer: \${produced[0]}\`);
  assert.equal(event.token, 't-9f3', \`the value must carry the client's token unchanged — the rollup dedupes on it: \${produced[0]}\`);
  assert(typeof event.ts === 'number' && Math.abs(event.ts - Date.now() / 1000) < 60, \`the value must carry a current timestamp in seconds: \${produced[0]}\`);
}

export async function check_acks_all(ctx) {
  const m = ctx.load('count_events');
  // The partition leader fails right after acknowledging: only an event every in-sync replica has survives.
  await m.appendEvent('plays', 'stranger-things', 1, 't-9f3');
  ctx.kafka.failover(TOPIC);
  const held = ctx.kafka.records(TOPIC).length;
  assert.equal(held, 1, \`appendEvent returned (the API would answer 202), then the partition leader failed and \${TOPIC} holds \${held} record(s) instead of the event: it had been acknowledged by the leader alone. A durability promise needs acks all\`);
  // The broker writes the next event but its acknowledgement is lost: the producer retries it.
  ctx.kafka.loseAcks(TOPIC);
  await m.appendEvent('plays', 'stranger-things', 2, 't-9f4');
  const copies = ctx.kafka.records(TOPIC).length - 1;
  assert.equal(copies, 1, \`the broker wrote the second event, its acknowledgement was lost and the producer retried: \${TOPIC} now holds it \${copies} times. With an idempotent producer the broker recognises the retry and writes the event once\`);
}

export async function check_bounded_flush(ctx) {
  const m = ctx.load('count_events');
  // The broker is slow but answers within FLUSH_TIMEOUT_S: the add waits for the ack and succeeds.
  ctx.kafka.stall(TOPIC, 0.8);
  const slow = await attempt(m, 'plays', 'stranger-things', 1, 't-9f3');
  assert(slow.returned, \`the broker acknowledged after 0.8 s, within FLUSH_TIMEOUT_S (1 s), but appendEvent threw EventNotDurable (\${slow.error?.message}): it must wait for the acknowledgement up to the bound\`);
  let held = ctx.kafka.records(TOPIC).length;
  assert.equal(held, 1, \`appendEvent returned while the event was still unacknowledged (\${TOPIC} holds \${held} record(s)): it must not return — and the API must not answer 202 — before the broker has the event, exactly once\`);
  // The broker is down: the add gives up after FLUSH_TIMEOUT_S instead of hanging the request.
  ctx.kafka.stall(TOPIC);
  const start = ctx.clock.now();
  const down = await attempt(m, 'plays', 'stranger-things', 1, 't-9f4');
  const waited = (ctx.clock.now() - start) / 1000;
  assert(waited <= FLUSH_TIMEOUT_S + 0.05, \`with the broker down appendEvent waited \${waited.toFixed(0)} s before giving up — an unbounded send waits for the whole message timeout while the client's request hangs: bound it with FLUSH_TIMEOUT_MS (1 s)\`);
  assert(!down.returned, \`with the broker down appendEvent returned normally after \${waited.toFixed(1)} s without an acknowledgement: the API would answer 202 for an event that may never be written\`);
  held = ctx.kafka.records(TOPIC).length;
  assert.equal(held, 1, \`nothing can be written while the broker is down, yet \${TOPIC} holds \${held} record(s)\`);
}

export async function check_not_durable_raises(ctx) {
  const m = ctx.load('count_events');
  ctx.kafka.failNext(TOPIC);
  const refused = await attempt(m, 'plays', 'stranger-things', 1, 't-9f3');
  assert(!refused.returned, 'the broker refused the record (delivery error) but appendEvent returned normally: the API would answer 202 for an event that was lost');
  assert.equal(ctx.kafka.records(TOPIC).length, 0);
  await m.appendEvent('plays', 'stranger-things', 1, 't-9f3'); // the client's retry, same token
  const tokens = ctx.kafka.values(TOPIC).map(v => JSON.parse(v).token);
  assert.deepEqual(tokens, ['t-9f3'], \`after the failure the retry must be produced normally, carrying the same token, which is what makes it safe: \${TOPIC} holds \${JSON.stringify(tokens)}\`);
  ctx.kafka.stall(TOPIC);
  const pending = await attempt(m, 'plays', 'stranger-things', 1, 't-9f4');
  assert(!pending.returned, 'the broker did not acknowledge the record within the flush (it is still pending) but appendEvent returned normally: the API would answer 202 for an event that may never be written');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"

	"leetbuild/harness"
)

const (
	ceTopic        = "counter-events"
	ceFlushTimeout = 1.0 // seconds
)

var ceBg = context.Background()

// ceAttempt is whether appendEvent returned nil, or the ErrNotDurable it returned; any other error fails the check.
func ceAttempt(ctx *harness.Ctx, ns, name string, delta int64, token string) (bool, error) {
	err := appendEvent(ceBg, ns, name, delta, token)
	if err == nil {
		return true, nil
	}
	ctx.Assert(errors.Is(err, ErrNotDurable), "appendEvent returned %v: a failed append must wrap ErrNotDurable", err)
	return false, err
}

func ceAppend(ctx *harness.Ctx, ns, name string, delta int64, token string) {
	ctx.NoError(appendEvent(ceBg, ns, name, delta, token), "appendEvent(ctx, %q, %q, %d, %q) returned an error", ns, name, delta, token)
}

func CheckTopicKey(ctx *harness.Ctx) {
	ceAppend(ctx, "plays", "stranger-things", 1, "t-9f3")
	ceAppend(ctx, "plays", "stranger-things", 2, "t-9f4")
	ceAppend(ctx, "plays", "the-crown", 1, "t-9f5")
	produced := ctx.Kafka.Records(ceTopic)
	ctx.Assert(len(produced) == 3, "expected three records on %s, found %d (topics: %q)", ceTopic, len(produced), ctx.Kafka.Topics())
	ctx.Equal(ctx.Kafka.Keys(ceTopic), []string{"plays:stranger-things", "plays:stranger-things", "plays:the-crown"}, "records must be keyed by ns:name")
	ctx.Equal(produced[0].Partition, produced[1].Partition, "the same counter must land on the same partition")
}

func CheckEventShape(ctx *harness.Ctx) {
	ceAppend(ctx, "plays", "stranger-things", -2, "t-9f3")
	produced := ctx.Kafka.Values(ceTopic)
	ctx.Equal(len(produced), 1, "the number of records on %s", ceTopic)
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(produced[0]), &event), "the value must be JSON: %s", produced[0])
	ctx.Assert(event["ns"] == "plays" && event["name"] == "stranger-things", "the value must carry ns and name: %s", produced[0])
	ctx.Assert(event["delta"] == -2.0, "the value must carry the delta as an integer: %s", produced[0])
	ctx.Equal(event["token"], "t-9f3", "the value must carry the client's token unchanged (the rollup dedupes on it): %s", produced[0])
	ts, isNumber := event["ts"].(float64)
	ctx.Assert(isNumber && math.Abs(ts-float64(ctx.Clock.Now())/1000) < 60, "the value must carry a current timestamp in seconds: %s", produced[0])
}

func CheckAcksAll(ctx *harness.Ctx) {
	// The partition leader fails right after acknowledging: only an event every in-sync replica has survives.
	ceAppend(ctx, "plays", "stranger-things", 1, "t-9f3")
	ctx.Kafka.Failover(ceTopic)
	held := len(ctx.Kafka.Records(ceTopic))
	ctx.Assert(held == 1, "appendEvent returned (the API would answer 202), then the partition leader failed and %s holds %d record(s) instead of the event: it had been acknowledged by the leader alone. A durability promise needs RequiredAcks: kafka.RequireAll", ceTopic, held)
	// The broker writes the next event but its acknowledgement is lost: the producer retries it.
	ctx.Kafka.LoseAcks(ceTopic, 1)
	ceAppend(ctx, "plays", "stranger-things", 2, "t-9f4")
	// kafka-go has no idempotent producer (the step's Go code): at least once, identical copies.
	copies := ctx.Kafka.Records(ceTopic)[1:]
	ctx.Assert(len(copies) >= 1, "the broker wrote the second event and its acknowledgement was lost, yet %s does not hold it", ceTopic)
	for _, c := range copies {
		ctx.Assert(string(c.Key) == string(copies[0].Key) && string(c.Value) == string(copies[0].Value), "the producer's retry after a lost ack must be an identical copy (same key and value, the same token) so the rollup can drop it: got %s %s and %s %s", copies[0].Key, copies[0].Value, c.Key, c.Value)
	}
}

func CheckBoundedFlush(ctx *harness.Ctx) {
	// The broker is slow but answers within flushTimeout: the add waits for the ack and succeeds.
	ctx.Kafka.StallFor(ceTopic, 0.8)
	returned, err := ceAttempt(ctx, "plays", "stranger-things", 1, "t-9f3")
	ctx.Assert(returned, "the broker acknowledged after 0.8 s, within flushTimeout (1 s), but appendEvent returned %v: it must wait for the acknowledgement up to the bound", err)
	held := len(ctx.Kafka.Records(ceTopic))
	ctx.Assert(held == 1, "appendEvent returned while the event was still unacknowledged (%s holds %d record(s)): it must not return (and the API must not answer 202) before the broker has the event, exactly once", ceTopic, held)
	// The broker is down: the add gives up after flushTimeout instead of hanging the request.
	ctx.Kafka.Stall(ceTopic)
	start := ctx.Clock.Now()
	returned, _ = ceAttempt(ctx, "plays", "stranger-things", 1, "t-9f4")
	waited := float64(ctx.Clock.Now()-start) / 1000
	ctx.Assert(waited <= ceFlushTimeout+0.05, "with the broker down appendEvent waited %.0f s before giving up (an unbounded send waits for the whole write timeout while the client's request hangs): bound it with context.WithTimeout(ctx, flushTimeout)", waited)
	ctx.Assert(!returned, "with the broker down appendEvent returned nil after %.1f s without an acknowledgement: the API would answer 202 for an event that may never be written", waited)
	held = len(ctx.Kafka.Records(ceTopic))
	ctx.Assert(held == 1, "nothing can be written while the broker is down, yet %s holds %d record(s)", ceTopic, held)
}

func CheckNotDurableRaises(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(ceTopic, 1)
	returned, _ := ceAttempt(ctx, "plays", "stranger-things", 1, "t-9f3")
	ctx.Assert(!returned, "the broker refused the record (delivery error) but appendEvent returned nil: the API would answer 202 for an event that was lost")
	ctx.Equal(len(ctx.Kafka.Records(ceTopic)), 0, "records on %s after the refused produce", ceTopic)
	ceAppend(ctx, "plays", "stranger-things", 1, "t-9f3") // the client's retry, same token
	tokens := []any{}
	for _, v := range ctx.Kafka.Values(ceTopic) {
		var event map[string]any
		ctx.NoError(json.Unmarshal([]byte(v), &event), "the value must be JSON: %s", v)
		tokens = append(tokens, event["token"])
	}
	ctx.Equal(tokens, []any{"t-9f3"}, "after the failure the retry must be produced normally, carrying the same token, which is what makes it safe: the tokens on %s", ceTopic)
	ctx.Kafka.Stall(ceTopic)
	returned, _ = ceAttempt(ctx, "plays", "stranger-things", 1, "t-9f4")
	ctx.Assert(!returned, "the broker did not acknowledge the record within the flush (it is still pending) but appendEvent returned nil: the API would answer 202 for an event that may never be written")
}
`,
  },
  debrief: `The eventually consistent counter does not exist as a number at write time; it exists as a durable fact — "add 1 to plays/stranger-things, token t-9f3, at this time" — and that fact is what the 202 vouches for. Everything about the producer follows from that: acks=all because a leader-only ack can vanish with the leader, idempotence because the producer's own retries must not double a fact, a bounded flush because a promise you cannot keep in a second is better refused than kept late. The token is the other half of the design: the API cannot know whether a 503 was returned before or after the record landed, so instead of guessing it lets the client retry and the rollup dedupe. Netflix logs these events to its TimeSeries abstraction with the same idea — write durably, dedupe downstream — and partitions them by time bucket as well as by counter.`,
};
