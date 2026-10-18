import type {Step} from '@/lib/types';

export const placementEventsStep: Step = {
  id: 'placement-events',
  title: 'One placements event per painted tile',
  concept: 'kafka',
  file: 'placement_events',
  focus: ['api', 'kafka'],
  task: `## Task

Every painted tile is something the stream servers, the leaderboard and the history want to know
about. Implement \`record_placement(user, x, y, color)\` — \`POST /place\` calls it right after
\`place_tile\` returned 0 — so each accepted tile produces one record on the **\`placements\`** topic:

- Key the record by the **tile**, \`"{x}:{y}"\`, not the user. The consumer that keeps per-pixel history
  needs the placements of one pixel in order; a user's tile count is a sum and does not care about
  order. The key is the ordering contract — pick the thing whose order matters.
- The value is a small JSON document: \`{"user": …, "x": …, "y": …, "color": …, "ts": <epoch ms>}\`.
- The request must **not wait for the broker**: hand the record to the producer, \`poll(0)\` so delivery
  callbacks get served, return. The tile is already on the board; a slow or dead broker must not turn
  a painted pixel into a 5xx.
- Failures surface through the delivery callback and are **logged**, nothing more. The placement
  stands — the board in Redis is the truth, the event is a notification.
- Provide \`shutdown()\` that flushes what is still buffered so a clean stop loses nothing.

:::widget kafka-partitions {"partitions": 8}

> Reddit called its websocket service synchronously after each write. Putting a log in between is
> what lets you add a second consumer — a leaderboard, an archive, a replay — without touching the
> write path.`,
  sequence: {
    participants: ['place-api', 'Producer', 'Kafka'],
    messages: [
      {from: 'place-api', to: 'place-api', label: 'place_tile → 0 (painted)', kind: 'sync'},
      {from: 'place-api', to: 'Producer', label: 'produce(placements, key=3:7, value=json)', kind: 'async'},
      {from: 'place-api', to: 'place-api', label: '200 sent to the client', kind: 'sync'},
      {from: 'Producer', to: 'Kafka', label: 'batch → partition hash(3:7) % 8', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack (offset 41 207)', kind: 'reply'},
      {from: 'Producer', to: 'place-api', label: 'delivery callback', kind: 'async'},
    ],
  },
  hints: [
    'Producers batch in the background: `produce` enqueues and returns. Only `flush()` (or blocking on the future) waits — keep that in `shutdown()` and out of `record_placement`.',
    'The key is the string `f"{x}:{y}"` (the partitioner hashes its bytes); the timestamp is `int(time.time() * 1000)` so the stream and the history agree on the unit.',
    'Delivery callbacks run when the broker answers — inside `poll()` for librdkafka-based clients. Call `poll(0)` right after `produce`; a failure reported there is a `log.warning`, never an exception back to the handler.',
  ],
  checks: [
    {
      id: 'topic',
      title: 'Produces to placements',
      detail:
        'The record goes to the `placements` topic with the user, coordinates, colour and a millisecond timestamp as JSON.',
      match: {
        python: {all: [/"placements"/, /producer\.produce\(/, /"ts"/]},
        typescript: {all: [/'placements'|"placements"/, /producer\s*\.send\(/, /\bts:/]},
        go: {all: [/"placements"/, /WriteMessages\(/, /json:"ts"/]},
        scala: {all: [/"placements"/, /producer\.send\(/, /"ts"/]},
        cpp: {all: [/"placements"/, /producer->produce\(/, /"ts"/]},
      },
    },
    {
      id: 'keyed-by-tile',
      title: 'Keys records by tile',
      detail:
        'The key is `"{x}:{y}"`: all placements on one pixel land on one partition, in order, for the history consumer.',
      match: {
        python: {all: [/produce\([^\n]*key\s*=\s*f["']\{x\}:\{y\}["']/]},
        typescript: {all: [/`\$\{x\}:\$\{y\}`/, /messages:\s*\[\s*\{\s*key\b/]},
        go: {all: [/Key:\s*\[\]byte\(\s*fmt\.Sprintf\(\s*"%d:%d"\s*,\s*x\s*,\s*y\s*\)\s*\)/]},
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*s"\$x:\$y"\s*,/]},
        cpp: {
          all: [
            /produce\([\s\S]{0,400}?tile\.(c_str|data)\(\)\s*,\s*tile\.(size|length)\(\)/,
            /std::to_string\(\s*x\s*\)\s*\+\s*":"\s*\+\s*std::to_string\(\s*y\s*\)/,
          ],
        },
      },
    },
    {
      id: 'non-blocking',
      title: 'Does not wait for the broker on the request path',
      detail:
        'Enqueue and return; serve delivery callbacks with `poll(0)` (or async writes) instead of blocking on an acknowledgement.',
      match: {
        python: {
          all: [/producer\.poll\(\s*0\s*\)/],
          none: [/def record_placement(?:(?!\ndef )[\s\S])*?producer\.flush\(/],
        },
        typescript: {
          all: [/\.catch\(|\.then\([^\n]*,/],
          none: [/function recordPlacement(?:(?!\nexport )[\s\S])*?await producer\.send\(/],
        },
        go: {all: [/Async:\s*true/], none: [/if err := writer\.WriteMessages/]},
        scala: {all: [/producer\.send\(\s*\w+\s*,/], none: [/\.send\([^\n]*\)\.get\(/]},
        cpp: {all: [/producer->poll\(\s*0\s*\)/], none: [/void record_placement(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
    {
      id: 'callback',
      title: 'Logs delivery failures through a callback',
      detail:
        'A delivery report callback logs failed records; the placement itself is not undone and the handler never sees an exception.',
      match: {
        python: {all: [/on_delivery\s*=\s*on_delivery|callback\s*=\s*on_delivery/, /log\.(warning|error)\(/]},
        typescript: {all: [/onDelivery\(/, /console\.(warn|error)\(/]},
        go: {all: [/Completion:\s*func\(/, /log\.Printf\(/]},
        scala: {all: [/onCompletion\(/, /System\.err\.println|log(ger)?\.(warn|error)\(/]},
        cpp: {all: [/dr_cb\(|DeliveryReportCb/, /std::cerr/]},
      },
    },
    {
      id: 'flush',
      title: 'Flushes on shutdown',
      detail: 'Buffered records are only sent when the producer flushes; do it once at shutdown, with a timeout.',
      match: {
        python: {all: [/def shutdown(?:(?!\ndef )[\s\S])*?producer\.flush\(/]},
        typescript: {
          all: [
            /function shutdown(?:(?!\nexport )[\s\S])*?Promise\.(all|allSettled)\((?:(?!\nexport )[\s\S])*?setTimeout\(/,
          ],
        },
        go: {all: [/func shutdown(?:(?!\n\})[\s\S])*?writer\.Close\(\)/]},
        scala: {all: [/def shutdown(?:(?!\n {2}def )[\s\S])*?producer\.(flush|close)\(/]},
        cpp: {all: [/void shutdown(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

from confluent_kafka import Producer

TOPIC = "placements"
log = logging.getLogger("placements")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 5})


def on_delivery(err, msg) -> None:
    # TODO: log a warning when err is set; the tile stays painted either way
    pass


def record_placement(user: str, x: int, y: int, color: int) -> None:
    """One event per painted tile; the board already holds the pixel, whatever happens here."""
    value = json.dumps({"user": user, "x": x, "y": y, "color": color, "ts": int(time.time() * 1000)})
    # TODO: produce keyed by f"{x}:{y}" with on_delivery; poll(0) to serve callbacks; never block here
    raise NotImplementedError


def shutdown() -> None:
    # TODO: flush with a timeout so buffered placements reach the broker
    raise NotImplementedError
`,
      solution: `import json
import logging
import time

from confluent_kafka import Producer

TOPIC = "placements"
log = logging.getLogger("placements")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 5})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("placement on %s not delivered: %s", msg.key(), err)


def record_placement(user: str, x: int, y: int, color: int) -> None:
    """One event per painted tile; the board already holds the pixel, whatever happens here."""
    value = json.dumps({"user": user, "x": x, "y": y, "color": color, "ts": int(time.time() * 1000)})
    producer.produce(TOPIC, key=f"{x}:{y}", value=value, on_delivery=on_delivery)
    producer.poll(0)  # serve delivery callbacks; returns immediately


def shutdown() -> None:
    remaining = producer.flush(timeout=5)
    if remaining:
        log.warning("%d placements were not delivered", remaining)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';
import {setTimeout} from 'node:timers/promises';

export const TOPIC = 'placements';

const kafka = new Kafka({clientId: 'place-api', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect(); // in the background; the first send queues behind the handshake

/** Sends still in flight: shutdown() waits for them, the request path never does. */
const inFlight = new Set<Promise<void>>();

/** Delivery report for one record, keyed by its tile. */
export function onDelivery(key: string, err: Error | null): void {
  // TODO: log a warning when err is set; the tile stays painted either way
}

/** One event per painted tile; the board already holds the pixel, whatever happens here. */
export function recordPlacement(user: string, x: number, y: number, color: number): void {
  const value = JSON.stringify({user, x, y, color, ts: Date.now()});
  // TODO: producer.send keyed by \`\${x}:\${y}\`; report through onDelivery; keep the promise in inFlight; never await here
  throw new Error('not implemented');
}

/** A clean stop loses nothing: wait for what is in flight, with a timeout. */
export async function shutdown(): Promise<void> {
  // TODO: Promise.all(inFlight) raced against setTimeout(5000) so buffered placements reach the broker
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';
import {setTimeout} from 'node:timers/promises';

export const TOPIC = 'placements';

const kafka = new Kafka({clientId: 'place-api', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect(); // in the background; the first send queues behind the handshake

/** Sends still in flight: shutdown() waits for them, the request path never does. */
const inFlight = new Set<Promise<void>>();

/** Delivery report for one record, keyed by its tile. */
export function onDelivery(key: string, err: Error | null): void {
  if (err !== null) console.warn(\`placement on \${key} not delivered: \${err.message}\`);
}

/** One event per painted tile; the board already holds the pixel, whatever happens here. */
export function recordPlacement(user: string, x: number, y: number, color: number): void {
  const key = \`\${x}:\${y}\`;
  const value = JSON.stringify({user, x, y, color, ts: Date.now()});
  const delivery: Promise<void> = producer
    .send({topic: TOPIC, messages: [{key, value}], acks: 1})
    .then(
      () => onDelivery(key, null),
      (err: Error) => onDelivery(key, err),
    )
    .finally(() => inFlight.delete(delivery));
  inFlight.add(delivery); // the handler returns now; the broker answers later
}

/** A clean stop loses nothing: wait for what is in flight, with a timeout. */
export async function shutdown(): Promise<void> {
  const flushed = await Promise.race([Promise.all(inFlight).then(() => true), setTimeout(5000, false)]);
  if (!flushed) console.warn(\`\${inFlight.size} placements were not delivered\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

const topic = "placements"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 5 * time.Millisecond,
	// TODO: Async writes with a Completion callback that logs failures
}

type placementEvent struct {
	User  string \`json:"user"\`
	X     int    \`json:"x"\`
	Y     int    \`json:"y"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

// recordPlacement emits one event per painted tile; the board already holds the pixel, whatever happens here.
func recordPlacement(ctx context.Context, user string, x, y, color int) {
	value, _ := json.Marshal(placementEvent{User: user, X: x, Y: y, Color: color, Ts: time.Now().UnixMilli()})
	// TODO: WriteMessages keyed by fmt.Sprintf("%d:%d", x, y); never block the request on the broker
	_ = value
	_ = fmt.Sprintf
	log.Println("not implemented")
}

func shutdown() {
	// TODO: close the writer so buffered placements reach the broker
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

const topic = "placements"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 5 * time.Millisecond,
	Async:        true,
	Completion: func(messages []kafka.Message, err error) {
		if err != nil {
			log.Printf("%d placements not delivered: %v", len(messages), err)
		}
	},
}

type placementEvent struct {
	User  string \`json:"user"\`
	X     int    \`json:"x"\`
	Y     int    \`json:"y"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

// recordPlacement emits one event per painted tile; the board already holds the pixel, whatever happens here.
func recordPlacement(ctx context.Context, user string, x, y, color int) {
	value, _ := json.Marshal(placementEvent{User: user, X: x, Y: y, Color: color, Ts: time.Now().UnixMilli()})
	// Async writer: this enqueues and returns; Completion reports the outcome.
	writer.WriteMessages(ctx, kafka.Message{Key: []byte(fmt.Sprintf("%d:%d", x, y)), Value: value})
}

func shutdown() {
	if err := writer.Close(); err != nil {
		log.Printf("closing placements writer: %v", err)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

object PlacementEvents {
  val Topic = "placements"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** One event per painted tile; the board already holds the pixel, whatever happens here. */
  def recordPlacement(user: String, x: Int, y: Int, color: Int): Unit = {
    val value = JsObject(
      "user" -> JsString(user),
      "x" -> JsNumber(x),
      "y" -> JsNumber(y),
      "color" -> JsNumber(color),
      "ts" -> JsNumber(System.currentTimeMillis()),
    ).compactPrint
    // TODO: send a record keyed by s"$x:$y" with a Callback that logs failures; do not block on the future
  }

  def shutdown(): Unit = {
    // TODO: flush and close so buffered placements reach the broker
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

object PlacementEvents {
  val Topic = "placements"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"placement not delivered: \${exception.getMessage}")
  }

  /** One event per painted tile; the board already holds the pixel, whatever happens here. */
  def recordPlacement(user: String, x: Int, y: Int, color: Int): Unit = {
    val value = JsObject(
      "user" -> JsString(user),
      "x" -> JsNumber(x),
      "y" -> JsNumber(y),
      "color" -> JsNumber(color),
      "ts" -> JsNumber(System.currentTimeMillis()),
    ).compactPrint
    val record = new ProducerRecord[String, String](Topic, s"$x:$y", value)
    producer.send(record, onDelivery) // enqueues; the future is not awaited
  }

  def shutdown(): Unit = {
    producer.flush()
    producer.close()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "placements";

// TODO: a DeliveryReportCb that logs failed messages

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "5", err);
  // TODO: conf->set("dr_cb", &callback, err)
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One event per painted tile; the board already holds the pixel, whatever happens here.
void record_placement(const std::string& user, int x, int y, int color) {
  const long long ts =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string value = json{{"user", user}, {"x", x}, {"y", y}, {"color", color}, {"ts", ts}}.dump();
  // TODO: produce keyed by "x:y" (RK_MSG_COPY); poll(0) to serve callbacks; never block here
}

void shutdown() {
  // TODO: flush with a timeout so buffered placements reach the broker
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "placements";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR)
      std::cerr << "placement not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "5", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One event per painted tile; the board already holds the pixel, whatever happens here.
void record_placement(const std::string& user, int x, int y, int color) {
  const long long ts =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string value = json{{"user", user}, {"x", x}, {"y", y}, {"color", color}, {"ts", ts}}.dump();
  const std::string tile = std::to_string(x) + ":" + std::to_string(y);
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(value.data()), value.size(), tile.c_str(), tile.size(), 0, nullptr);
  producer->poll(0);  // serve delivery callbacks; returns immediately
}

void shutdown() {
  if (producer->flush(5000) != RdKafka::ERR_NO_ERROR)
    std::cerr << producer->outq_len() << " placements were not delivered\\n";
}
`,
    },
  },
  harness: {
    python: `import importlib
import json
import logging
import time


def _events(ctx):
    m = ctx.load("placement_events")
    return m, _logged()


def _logged():
    records = []
    handler = logging.Handler()
    handler.emit = records.append
    logging.getLogger().addHandler(handler)
    return records


def _pixel(ctx, api, x, y):
    board = ctx.redis_bytes.get("board") or b""
    off = y * api.SIZE + x
    return board[off] if off < len(board) else 0


def check_topic(ctx):
    m, _ = _events(ctx)
    m.record_placement("ana", 3, 7, 12)
    produced = ctx.kafka.records("placements")
    assert len(produced) == 1, f"expected one record on placements, found {len(produced)} (topics: {list(ctx.kafka.topics)})"
    event = json.loads(produced[0].value)
    assert {k: event.get(k) for k in ("user", "x", "y", "color")} == {"user": "ana", "x": 3, "y": 7, "color": 12}, f"the value must be JSON carrying user, x, y and color: {event}"
    assert isinstance(event.get("ts"), int) and abs(event["ts"] - int(time.time() * 1000)) < 60000, f"ts must be the current time in epoch milliseconds, got {event.get('ts')!r}"


def check_keyed_by_tile(ctx):
    m, _ = _events(ctx)
    m.record_placement("ana", 3, 7, 12)
    m.record_placement("bo", 3, 7, 5)
    m.record_placement("ana", 7, 3, 12)
    produced = ctx.kafka.records("placements")
    assert [r.key for r in produced] == [b"3:7", b"3:7", b"7:3"], f"records must be keyed by the tile 'x:y', got {[r.key for r in produced]}"
    assert produced[0].partition == produced[1].partition, "two placements on the same pixel must land on the same partition, in order"


async def check_non_blocking(ctx):
    api = ctx.load("board_api")
    events = importlib.import_module("placement_events")
    ctx.kafka.stall()  # the brokers stop answering
    start = ctx.clock.time()
    async with ctx.client(api.app) as c:
        r = await c.post("/place", json={"x": 3, "y": 7, "color": 12, "user": "ana"})
    took = ctx.clock.time() - start
    assert took < 0.5, f"with the broker not answering, POST /place took {took:.1f} s: record_placement must hand the record to the producer and return, not wait for the acknowledgement"
    assert r.status_code == 200, f"with the broker not answering, POST /place answered {r.status_code}: the tile is painted, the event follows when the broker is back"
    assert _pixel(ctx, api, 3, 7) == 12, "the tile must be on the board while its event waits for the broker"
    start = ctx.clock.time()
    events.record_placement("bo", 4, 7, 1)
    took = ctx.clock.time() - start
    assert took < 0.5, f"record_placement waited {took:.1f} s for a broker that does not answer: enqueue and return"
    ctx.kafka.resume()
    events.record_placement("cy", 5, 7, 2)  # the next request serves the producer again
    users = sorted(json.loads(r.value).get("user") for r in ctx.kafka.records("placements"))
    assert users == ["ana", "bo", "cy"], f"once the broker answered again the next record_placement must deliver what was waiting: placements holds the tiles of {users}, expected ana's, bo's and cy's"


async def check_callback(ctx):
    m, records = _events(ctx)
    ctx.kafka.fail_next("placements")
    m.record_placement("ana", 3, 7, 12)  # the failure arrives through the delivery callback, not as an exception
    m.record_placement("ana", 4, 7, 12)  # poll() on the next call serves the pending callback at the latest
    m.shutdown()
    warnings = [r for r in records if r.levelno >= logging.WARNING]
    assert warnings, "a failed delivery must be logged by the delivery callback"
    assert len(ctx.kafka.records("placements")) == 1, "the second placement must still be produced after the first one failed"
    # Through the API: a broker failure must not undo a painted tile.
    api = ctx.load("board_api")
    events = importlib.import_module("placement_events")
    records.clear()
    ctx.kafka.fail_next("placements")
    async with ctx.client(api.app) as c:
        r = await c.post("/place", json={"x": 5, "y": 7, "color": 9, "user": "cy"})
    assert r.status_code == 200, f"with the broker failing, POST /place answered {r.status_code}: the tile is painted, the event is best effort"
    assert _pixel(ctx, api, 5, 7) == 9, "the tile must stay on the board even though its event was not delivered"
    events.shutdown()
    assert [r for r in records if r.levelno >= logging.WARNING], "the failed delivery of cy's placement must be logged"


def check_flush(ctx):
    m, _ = _events(ctx)
    ctx.kafka.stall(seconds=2)  # the broker is slow to answer at the moment of the stop
    m.record_placement("ana", 3, 7, 12)
    m.shutdown()
    users = [json.loads(r.value).get("user") for r in ctx.kafka.records("placements")]
    assert users == ["ana"], f"shutdown() returned with ana's placement still in the producer's buffer (placements holds the tiles of {users}; the broker answered after 2 s): flush so a clean stop loses nothing"
    ctx.kafka.stall()  # now the broker is down for good
    m.record_placement("bo", 4, 7, 1)
    start = ctx.clock.time()
    m.shutdown()
    took = ctx.clock.time() - start
    assert took <= 60, f"with the broker down, shutdown() took {took:.0f} s: flush with a timeout so a stop is not held for the producer's whole message timeout"
`,
    typescript: `const TILE = {x: 3, y: 7, color: 12, user: 'ana'};

/** What the module logs at warning level or above while the check runs. */
function logged(): string[] {
  const records: string[] = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...args) => {
    records.push(args.map(String).join(' '));
    warn(...args);
  };
  console.error = (...args) => {
    records.push(args.map(String).join(' '));
    error(...args);
  };
  return records;
}

function pixel(ctx, api, x: number, y: number): number {
  const board: Uint8Array = ctx.redis.getBuffer('board') ?? new Uint8Array();
  const off = y * api.SIZE + x;
  return off < board.length ? board[off] : 0;
}

function placements(ctx): Record<string, unknown>[] {
  return ctx.kafka.values('placements').map((v: string) => JSON.parse(v));
}

/** Let the producer's delivery promises settle: pending timers (a broker answering late, a flush deadline) get their turn. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const {promise, resolve} = Promise.withResolvers<void>();
    globalThis.setTimeout(resolve, 0);
    await promise;
  }
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const {promise, resolve} = Promise.withResolvers<void>();
    queueMicrotask(resolve);
    await promise;
  }
}

export async function check_topic(ctx) {
  const m = ctx.load('placement_events');
  m.recordPlacement('ana', 3, 7, 12);
  await settle();
  const produced = placements(ctx);
  assert.equal(produced.length, 1, \`expected one record on placements, found \${produced.length}\`);
  const event = produced[0];
  assert.deepEqual({user: event.user, x: event.x, y: event.y, color: event.color}, {user: 'ana', x: 3, y: 7, color: 12}, \`the value must be JSON carrying user, x, y and color: \${JSON.stringify(event)}\`);
  assert(Number.isInteger(event.ts) && Math.abs((event.ts as number) - Date.now()) < 60000, \`ts must be the current time in epoch milliseconds, got \${JSON.stringify(event.ts)}\`);
}

export async function check_keyed_by_tile(ctx) {
  const m = ctx.load('placement_events');
  m.recordPlacement('ana', 3, 7, 12);
  m.recordPlacement('bo', 3, 7, 5);
  m.recordPlacement('ana', 7, 3, 12);
  await settle();
  const keys = ctx.kafka.keys('placements');
  assert.deepEqual(keys, ['3:7', '3:7', '7:3'], \`records must be keyed by the tile 'x:y', got \${JSON.stringify(keys)}\`);
  const records = ctx.kafka.records('placements');
  assert.equal(records[0].partition, records[1].partition, 'two placements on the same pixel must land on the same partition, in order');
}

export async function check_non_blocking(ctx) {
  const api = ctx.load('board_api');
  const events = ctx.load('placement_events');
  ctx.kafka.stall(); // the brokers stop answering
  let start = ctx.clock.now();
  const r = await ctx.client(api.app).post('/place', {json: TILE});
  let took = (ctx.clock.now() - start) / 1000;
  assert(took < 0.5, \`with the broker not answering, POST /place took \${took.toFixed(1)} s: recordPlacement must hand the record to the producer and return, not wait for the acknowledgement\`);
  assert.equal(r.status, 200, \`with the broker not answering, POST /place answered \${r.status}: the tile is painted, the event follows when the broker is back\`);
  assert.equal(pixel(ctx, api, 3, 7), 12, 'the tile must be on the board while its event waits for the broker');
  start = ctx.clock.now();
  await events.recordPlacement('bo', 4, 7, 1); // returns at once; a promise here would be the wait itself
  took = (ctx.clock.now() - start) / 1000;
  assert(took < 0.5, \`recordPlacement waited \${took.toFixed(1)} s for a broker that does not answer: enqueue and return\`);
  ctx.kafka.resume();
  events.recordPlacement('cy', 5, 7, 2); // the producer's retries get served again
  await settle();
  const users = placements(ctx).map(e => e.user).sort();
  assert.deepEqual(users, ['ana', 'bo', 'cy'], \`once the broker answered again every placement handed to the producer must be delivered: placements holds the tiles of \${JSON.stringify(users)}, expected ana's, bo's and cy's\`);
}

export async function check_callback(ctx) {
  const m = ctx.load('placement_events');
  const records = logged();
  ctx.kafka.failNext('placements');
  m.recordPlacement('ana', 3, 7, 12); // the failure arrives through the delivery report, not as an exception
  m.recordPlacement('ana', 4, 7, 12);
  await m.shutdown();
  assert(records.length > 0, 'a failed delivery must be logged by the delivery callback');
  assert.equal(ctx.kafka.records('placements').length, 1, 'the second placement must still be produced after the first one failed');
  // Through the API: a broker failure must not undo a painted tile.
  const api = ctx.load('board_api');
  records.length = 0;
  ctx.kafka.failNext('placements');
  const r = await ctx.client(api.app).post('/place', {json: {x: 5, y: 7, color: 9, user: 'cy'}});
  assert.equal(r.status, 200, \`with the broker failing, POST /place answered \${r.status}: the tile is painted, the event is best effort\`);
  assert.equal(pixel(ctx, api, 5, 7), 9, 'the tile must stay on the board even though its event was not delivered');
  await m.shutdown();
  assert(records.length > 0, "the failed delivery of cy's placement must be logged");
}

export async function check_flush(ctx) {
  const m = ctx.load('placement_events');
  ctx.kafka.stall(null, 2); // the broker is slow to answer at the moment of the stop
  m.recordPlacement('ana', 3, 7, 12);
  await m.shutdown();
  const users = placements(ctx).map(e => e.user);
  assert.deepEqual(users, ['ana'], \`shutdown() returned with ana's placement still in the producer's buffer (placements holds the tiles of \${JSON.stringify(users)}; the broker answered after 2 s): flush so a clean stop loses nothing\`);
  ctx.kafka.stall(); // now the broker is down for good
  m.recordPlacement('bo', 4, 7, 1);
  const start = ctx.clock.now();
  await m.shutdown();
  const took = (ctx.clock.now() - start) / 1000;
  assert(took <= 10, \`with the broker down, shutdown() took \${took.toFixed(0)} s: flush with a timeout so a stop is not held for the producer's whole request timeout\`);
}
`,
  },
  debrief: `A Kafka producer is a buffer with a background thread: \`produce\` costs microseconds and the network happens later in batches, which is what makes "one event per tile" free on the request path — as long as nobody blocks on the acknowledgement. The key is the ordering contract: the only consumer that needs order is the per-pixel history, so the pixel is the key, and the leaderboard, which only sums, rides along. Decoupling the write from its consumers is also the operational lesson of the original: Reddit's write path called the websocket fan-out directly, and when the message bus behind it buckled under the burst, the fix was to lengthen the cooldown for everyone. With a log in between, a slow consumer falls behind on its own; the board keeps taking tiles.`,
};
