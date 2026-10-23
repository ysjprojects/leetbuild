import type {Step} from '@/lib/types';

export const tumblingWindowStep: Step = {
  id: 'tumbling-window',
  title: 'Tumbling-window counts closed by a watermark',
  concept: 'kafka',
  file: 'tumbling_window',
  focus: ['aggregator', 'counts'],
  task: `## Task

Implement a windowed aggregator over **\`clicks\`**: every record is JSON \`{"page", "ts"}\` where \`ts\` is the
event time in milliseconds. Count clicks per \`(page, window)\` in tumbling windows of **\`WINDOW_MS = 60000\`**
(window start = \`ts - ts % WINDOW_MS\`) and publish a window once the stream has moved far enough past
it that nothing more is expected for it.

- \`run()\` joins group **\`windows\`**, subscribes to \`clicks\` with auto-commit **off**, and loops until stopped.
- The **watermark** is \`max_ts_seen - LATENESS_MS\` with **\`LATENESS_MS = 5000\`**: the stream's clock,
  held back by the lateness you tolerate. It only moves forward.
- An event with \`ts < watermark\` is **late**: drop it and count it in \`stats().late\`. An event at or after
  the watermark counts, even if it belongs to an earlier window than the newest one.
- After every event, every window whose **end** (\`start + WINDOW_MS\`) is \`<= watermark\` is **closed**: emit one
  record per page to **\`page-counts\`** — key \`page\`, value \`{"page", "window_start", "count"}\` — and forget
  the window. Open windows emit nothing.
- Commit the input offsets **only after** the emitted records are acknowledged (flush / await the send),
  and only when something was emitted. A crash before the commit replays the window; a commit before the
  ack can lose it.
- \`stats()\` returns \`{"late", "open"}\` — late events dropped so far, windows still open.
- \`shutdown()\` closes the clients and emits nothing: open windows stay open.

:::widget delivery-semantics {}

> A window is not closed by the wall clock but by the data: the watermark says "no event older than this
> will be counted", and that promise is what lets you publish a count once.`,
  sequence: {
    participants: ['clicks', 'windows', 'page-counts'],
    messages: [
      {from: 'clicks', to: 'windows', label: 'poll → {page: home, ts: 1000}', kind: 'reply'},
      {from: 'windows', to: 'windows', label: 'window 0 · home = 1 · watermark −4000'},
      {from: 'clicks', to: 'windows', label: 'poll → {page: home, ts: 125000}', kind: 'reply'},
      {from: 'windows', to: 'windows', label: 'watermark 120000 ≥ ends of windows 0 and 60000'},
      {from: 'windows', to: 'page-counts', label: 'produce key=home {window_start: 0, count: 1} · flush', kind: 'sync'},
      {from: 'page-counts', to: 'windows', label: 'acked', kind: 'reply'},
      {from: 'windows', to: 'clicks', label: 'commit offsets', kind: 'sync'},
    ],
  },
  hints: [
    'Keep three pieces of state: `windows[start][page] -> count`, `max_ts`, and the late counter. The watermark is derived (`max_ts - LATENESS_MS`), never stored.',
    'Order inside the handler: decide late or not against the watermark *before* raising `max_ts` with this event; then count; then close every window with `start + WINDOW_MS <= watermark`.',
    'Closing is where durability lives: produce every page of the window, flush (or await the send) so the broker has acknowledged, and only then commit — and skip the commit entirely when nothing closed.',
  ],
  checks: [
    {
      id: 'windows',
      title: 'Closed windows are emitted with exact counts; open ones are not',
      detail:
        'Events across three windows: once the watermark passes the ends of the first two, `page-counts` holds one record per page for each with the right counts, and nothing for the third.',
      match: {
        python: {all: [/WINDOW_MS\s*=\s*60_?000/, /producer\.produce\(\s*"page-counts"/]},
        typescript: {all: [/WINDOW_MS\s*=\s*60_?000/, /producer\.send\(\s*\{\s*topic:\s*['"]page-counts['"]/]},
        go: {all: [/windowMs\s+int64\s*=\s*60000/, /Topic:\s*"page-counts"/, /writer\.WriteMessages\(/]},
        scala: {all: [/WindowMs\s*=\s*60000L/, /OutTopic\s*=\s*"page-counts"/, /producer\.send\(/]},
        cpp: {all: [/kWindowMs\s*=\s*60000/, /kOutTopic\s*=\s*"page-counts"/, /producer->produce\(/]},
      },
    },
    {
      id: 'boundary',
      title: 'Window boundaries are exact',
      detail:
        '`ts` 59999 belongs to the window starting at 0 and `ts` 60000 to the one starting at 60000: the start is `ts - ts % WINDOW_MS`.',
      match: {
        python: {all: [/ts\s*-\s*ts\s*%\s*WINDOW_MS/]},
        typescript: {all: [/ts\s*-\s*\(?ts\s*%\s*WINDOW_MS\)?/]},
        go: {all: [/ts\s*-\s*ts\s*%\s*windowMs/]},
        scala: {all: [/ts\s*-\s*ts\s*%\s*WindowMs/]},
        cpp: {all: [/ts\s*-\s*ts\s*%\s*kWindowMs/]},
      },
    },
    {
      id: 'late',
      title: 'Events behind the watermark are dropped and counted',
      detail:
        'An event more than `LATENESS_MS` behind the newest one is not counted, does not reopen a closed window, and increments `stats().late`.',
      match: {
        python: {all: [/<\s*watermark/, /late\s*\+=\s*1/]},
        typescript: {all: [/<\s*watermark/, /late\s*\+=\s*1/]},
        go: {all: [/<\s*watermark/, /late\+\+/]},
        scala: {all: [/<\s*watermark/, /late\s*\+=\s*1/]},
        cpp: {all: [/<\s*watermark/, /late\+\+|late\s*\+=\s*1/]},
      },
    },
    {
      id: 'within-lateness',
      title: 'Events inside the lateness bound still count',
      detail:
        'An out-of-order event that is at most `LATENESS_MS` behind the newest one is counted in its own (older) window: the watermark is `max_ts - LATENESS_MS`, not `max_ts`.',
      match: {
        python: {all: [/watermark\s*=\s*max_ts\s*-\s*LATENESS_MS/, /\+\s*WINDOW_MS\s*<=\s*watermark/]},
        typescript: {all: [/watermark\s*=\s*maxTs\s*-\s*LATENESS_MS/, /\+\s*WINDOW_MS\s*<=\s*watermark/]},
        go: {all: [/watermark\s*:?=\s*maxTs\s*-\s*latenessMs/, /\+\s*windowMs\s*<=\s*watermark/]},
        scala: {all: [/watermark\s*=\s*maxTs\s*-\s*LatenessMs/, /\+\s*WindowMs\s*<=\s*watermark/]},
        cpp: {all: [/watermark\s*=\s*max_ts\s*-\s*kLatenessMs/, /\+\s*kWindowMs\s*<=\s*watermark/]},
      },
    },
    {
      id: 'keyed',
      title: 'Output records are keyed by page',
      detail:
        'Every `page-counts` record has the page as its key and `{"page", "window_start", "count"}` as its value, so one page’s counts stay on one partition.',
      match: {
        python: {all: [/produce\([^\n]*key\s*=\s*page/, /"window_start"/]},
        typescript: {all: [/key:\s*page\b/, /window_start/]},
        go: {all: [/Key:\s*\[\]byte\(page\)/, /json:"window_start"/]},
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*OutTopic\s*,\s*page\s*,/, /window_start/]},
        cpp: {all: [/page\.c_str\(\)\s*,\s*page\.size\(\)/, /window_start/]},
      },
    },
    {
      id: 'commit-after-emit',
      title: 'Commits only after the emits are acknowledged',
      detail:
        'Auto-commit is off; at commit time `page-counts` already holds the closed window, and with the output topic stalled the commit waits for the broker to answer.',
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/], order: [/producer\.flush\(/, /consumer\.commit\(/]},
        typescript: {all: [/autoCommit:\s*false/], order: [/await producer\.send\(/, /consumer\.commitOffsets\(/]},
        go: {
          all: [/reader\.FetchMessage\(/],
          none: [/ReadMessage\(/],
          order: [/writer\.WriteMessages\(/, /reader\.CommitMessages\(/],
        },
        scala: {
          all: [/"enable\.auto\.commit"\s*,\s*"false"/],
          order: [/producer\.flush\(\)/, /consumer\.commitSync\(/],
        },
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/], order: [/producer->flush\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer

WINDOW_MS = 60_000
LATENESS_MS = 5_000

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "windows",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})

# window start → page → count
windows: dict[int, dict[str, int]] = {}
max_ts = 0
late = 0


def stats() -> dict:
    return {"late": late, "open": len(windows)}


def run() -> None:
    consumer.subscribe(["clicks"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        page, ts = str(event["page"]), int(event["ts"])
        # TODO: drop the event if it is behind the watermark (max_ts - LATENESS_MS), counting it as late
        # TODO: count it in its window (start = ts - ts % WINDOW_MS) and raise max_ts
        # TODO: close every window whose end <= watermark: produce one record per page to
        #       page-counts (key = page), flush, then commit the input offsets
        raise NotImplementedError


def shutdown() -> None:
    consumer.close()
    producer.flush()
`,
      solution: `import json

from confluent_kafka import Consumer, Producer

WINDOW_MS = 60_000
LATENESS_MS = 5_000

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "windows",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})

# window start → page → count
windows: dict[int, dict[str, int]] = {}
max_ts = 0
late = 0


def stats() -> dict:
    return {"late": late, "open": len(windows)}


def _close_windows(watermark: int) -> bool:
    """Emit every window that ended at or before the watermark; True if any did."""
    closed = sorted(start for start in windows if start + WINDOW_MS <= watermark)
    for start in closed:
        for page, count in windows.pop(start).items():
            value = json.dumps({"page": page, "window_start": start, "count": count})
            producer.produce("page-counts", key=page, value=value)
    if closed:
        producer.flush()
    return bool(closed)


def run() -> None:
    global max_ts, late
    consumer.subscribe(["clicks"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        page, ts = str(event["page"]), int(event["ts"])
        watermark = max_ts - LATENESS_MS
        if ts < watermark:
            late += 1
            continue
        start = ts - ts % WINDOW_MS
        counts = windows.setdefault(start, {})
        counts[page] = counts.get(page, 0) + 1
        max_ts = max(max_ts, ts)
        watermark = max_ts - LATENESS_MS
        if _close_windows(watermark):
            consumer.commit(asynchronous=False)


def shutdown() -> None:
    consumer.close()
    producer.flush()
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const WINDOW_MS = 60_000;
export const LATENESS_MS = 5_000;

const kafka = new Kafka({clientId: 'windows', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'windows'});
const producer = kafka.producer();

/** window start → page → count */
const windows = new Map<number, Map<string, number>>();
let maxTs = 0;
let late = 0;

export function stats(): {late: number; open: number} {
  return {late, open: windows.size};
}

export async function run(): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({topic: 'clicks', fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit (autoCommit: false)
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '') as {page: string; ts: number};
      // TODO: drop the event if it is behind the watermark (maxTs - LATENESS_MS), counting it as late
      // TODO: count it in its window (start = ts - ts % WINDOW_MS) and raise maxTs
      // TODO: close every window whose end <= watermark: send one record per page to
      //       page-counts (key = page), await the ack, then commitOffsets for the input
      throw new Error('not implemented');
    },
  });
}

export async function shutdown(): Promise<void> {
  await consumer.disconnect();
  await producer.disconnect();
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const WINDOW_MS = 60_000;
export const LATENESS_MS = 5_000;

const kafka = new Kafka({clientId: 'windows', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'windows'});
const producer = kafka.producer();

/** window start → page → count */
const windows = new Map<number, Map<string, number>>();
/** partition → next offset to commit */
const positions = new Map<number, number>();
let maxTs = 0;
let late = 0;

export function stats(): {late: number; open: number} {
  return {late, open: windows.size};
}

/** Emit every window that ended at or before the watermark; true if any did. */
async function closeWindows(watermark: number): Promise<boolean> {
  const closed = [...windows.keys()].filter(start => start + WINDOW_MS <= watermark).sort((a, b) => a - b);
  for (const start of closed) {
    const counts = windows.get(start)!;
    windows.delete(start);
    const messages = [...counts].map(([page, count]) => ({
      key: page,
      value: JSON.stringify({page, window_start: start, count}),
    }));
    await producer.send({topic: 'page-counts', messages, acks: -1});
  }
  return closed.length > 0;
}

export async function run(): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({topic: 'clicks', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      positions.set(partition, Number(message.offset) + 1);
      const event = JSON.parse(message.value?.toString() ?? '') as {page: string; ts: number};
      const page = String(event.page);
      const ts = Number(event.ts);
      let watermark = maxTs - LATENESS_MS;
      if (ts < watermark) {
        late += 1;
        return;
      }
      const start = ts - (ts % WINDOW_MS);
      const counts = windows.get(start) ?? new Map<string, number>();
      counts.set(page, (counts.get(page) ?? 0) + 1);
      windows.set(start, counts);
      maxTs = Math.max(maxTs, ts);
      watermark = maxTs - LATENESS_MS;
      if (await closeWindows(watermark))
        await consumer.commitOffsets([...positions].map(([p, offset]) => ({topic, partition: p, offset: String(offset)})));
    },
  });
}

export async function shutdown(): Promise<void> {
  await consumer.disconnect();
  await producer.disconnect();
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const (
	windowMs   int64 = 60000
	latenessMs int64 = 5000
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "windows",
	Topic:   "clicks",
})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "page-counts",
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type click struct {
	Page string \`json:"page"\`
	Ts   int64  \`json:"ts"\`
}

type pageCount struct {
	Page        string \`json:"page"\`
	WindowStart int64  \`json:"window_start"\`
	Count       int    \`json:"count"\`
}

// window start → page → count
var windows = map[int64]map[string]int{}
var maxTs int64
var late int

type Stats struct {
	Late int
	Open int
}

func stats() Stats { return Stats{Late: late, Open: len(windows)} }

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: drop the event if it is behind the watermark (maxTs - latenessMs), counting it as late
		// TODO: count it in its window (start = ts - ts % windowMs) and raise maxTs
		// TODO: close every window whose end <= watermark: WriteMessages one record per page
		//       (Key = page) — synchronous, so it returns after the ack — then CommitMessages
		_ = json.Unmarshal
		log.Println("not implemented")
		return nil
	}
}

func shutdown() {
	reader.Close()
	writer.Close()
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sort"

	"github.com/segmentio/kafka-go"
)

const (
	windowMs   int64 = 60000
	latenessMs int64 = 5000
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "windows",
	Topic:   "clicks",
})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "page-counts",
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type click struct {
	Page string \`json:"page"\`
	Ts   int64  \`json:"ts"\`
}

type pageCount struct {
	Page        string \`json:"page"\`
	WindowStart int64  \`json:"window_start"\`
	Count       int    \`json:"count"\`
}

// window start → page → count
var windows = map[int64]map[string]int{}
var maxTs int64
var late int

// Fetched since the last commit; committed once their windows' emits are acknowledged.
var pending []kafka.Message

type Stats struct {
	Late int
	Open int
}

func stats() Stats { return Stats{Late: late, Open: len(windows)} }

// closeWindows emits every window that ended at or before the watermark; true if any did.
func closeWindows(ctx context.Context, watermark int64) (bool, error) {
	var closed []int64
	for start := range windows {
		if start+windowMs <= watermark {
			closed = append(closed, start)
		}
	}
	sort.Slice(closed, func(i, j int) bool { return closed[i] < closed[j] })
	for _, start := range closed {
		var msgs []kafka.Message
		for page, count := range windows[start] {
			value, _ := json.Marshal(pageCount{Page: page, WindowStart: start, Count: count})
			msgs = append(msgs, kafka.Message{Key: []byte(page), Value: value})
		}
		delete(windows, start)
		if err := writer.WriteMessages(ctx, msgs...); err != nil { // synchronous: returns after the ack
			return false, err
		}
	}
	return len(closed) > 0, nil
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		pending = append(pending, msg)
		var event click
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			continue
		}
		ts := event.Ts
		watermark := maxTs - latenessMs
		if ts < watermark {
			late++
			continue
		}
		start := ts - ts%windowMs
		if windows[start] == nil {
			windows[start] = map[string]int{}
		}
		windows[start][event.Page]++
		if ts > maxTs {
			maxTs = ts
		}
		watermark = maxTs - latenessMs
		emitted, err := closeWindows(ctx, watermark)
		if err != nil {
			return err // nothing committed: the window replays
		}
		if emitted {
			if err := reader.CommitMessages(ctx, pending...); err != nil {
				return err
			}
			pending = pending[:0]
		}
	}
}

func shutdown() {
	reader.Close()
	writer.Close()
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.collection.mutable
import scala.jdk.CollectionConverters._

object TumblingWindow {
  val WindowMs = 60000L
  val LatenessMs = 5000L
  val OutTopic = "page-counts"

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", "windows")
  consumerProps.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("clicks").asJava)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  private val PageField = """"page"\\s*:\\s*"([^"]+)"""".r
  private val TsField = """"ts"\\s*:\\s*(\\d+)""".r

  // window start → page → count
  private val windows = mutable.Map.empty[Long, mutable.Map[String, Int]]
  private var maxTs = 0L
  private var late = 0

  def stats(): Map[String, Int] = Map("late" -> late, "open" -> windows.size)

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        for (page <- PageField.findFirstMatchIn(record.value()).map(_.group(1));
             ts <- TsField.findFirstMatchIn(record.value()).map(_.group(1).toLong)) {
          // TODO: drop the event if it is behind the watermark (maxTs - LatenessMs), counting it as late
          // TODO: count it in its window (start = ts - ts % WindowMs) and raise maxTs
          // TODO: close every window whose end <= watermark: send one record per page to
          //       page-counts (key = page), flush, then commitSync the input offsets
          throw new NotImplementedError()
        }
      }
    }

  def shutdown(): Unit = {
    consumer.close()
    producer.flush()
    producer.close()
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.collection.mutable
import scala.jdk.CollectionConverters._

object TumblingWindow {
  val WindowMs = 60000L
  val LatenessMs = 5000L
  val OutTopic = "page-counts"

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", "windows")
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("clicks").asJava)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  private val PageField = """"page"\\s*:\\s*"([^"]+)"""".r
  private val TsField = """"ts"\\s*:\\s*(\\d+)""".r

  // window start → page → count
  private val windows = mutable.Map.empty[Long, mutable.Map[String, Int]]
  // partition → next offset to commit, for the records consumed since the last commit
  private val pending = mutable.Map.empty[TopicPartition, OffsetAndMetadata]
  private var maxTs = 0L
  private var late = 0

  def stats(): Map[String, Int] = Map("late" -> late, "open" -> windows.size)

  /** Emit every window that ended at or before the watermark; true if any did. */
  private def closeWindows(watermark: Long): Boolean = {
    val closed = windows.keys.filter(start => start + WindowMs <= watermark).toSeq.sorted
    closed.foreach { start =>
      windows.remove(start).get.foreach { case (page, count) =>
        val value = s"""{"page":"$page","window_start":$start,"count":$count}"""
        producer.send(new ProducerRecord[String, String](OutTopic, page, value))
      }
    }
    if (closed.nonEmpty) producer.flush() // every send acknowledged before the commit below
    closed.nonEmpty
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        pending(new TopicPartition(record.topic(), record.partition())) = new OffsetAndMetadata(record.offset() + 1)
        for (page <- PageField.findFirstMatchIn(record.value()).map(_.group(1));
             ts <- TsField.findFirstMatchIn(record.value()).map(_.group(1).toLong)) {
          var watermark = maxTs - LatenessMs
          if (ts < watermark) late += 1
          else {
            val start = ts - ts % WindowMs
            val counts = windows.getOrElseUpdate(start, mutable.Map.empty[String, Int])
            counts(page) = counts.getOrElse(page, 0) + 1
            maxTs = math.max(maxTs, ts)
            watermark = maxTs - LatenessMs
            if (closeWindows(watermark)) {
              consumer.commitSync(pending.asJava)
              pending.clear()
            }
          }
        }
      }
    }

  def shutdown(): Unit = {
    consumer.close()
    producer.flush()
    producer.close()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <map>
#include <memory>
#include <regex>
#include <string>
#include <vector>

const int64_t kWindowMs = 60000;
const int64_t kLatenessMs = 5000;
const std::string kOutTopic = "page-counts";

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "windows", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"clicks"});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();
const std::regex kPageField(R"("page"\\s*:\\s*"([^"]+)")");
const std::regex kTsField(R"("ts"\\s*:\\s*(\\d+))");

// window start → page → count
std::map<int64_t, std::map<std::string, int>> windows;
int64_t max_ts = 0;
int late = 0;

struct Stats {
  int late;
  int open;
};

Stats stats() { return Stats{late, static_cast<int>(windows.size())}; }

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    std::smatch page_m, ts_m;
    if (!std::regex_search(value, page_m, kPageField) || !std::regex_search(value, ts_m, kTsField)) continue;
    const std::string page = page_m[1].str();
    const int64_t ts = std::stoll(ts_m[1].str());
    // TODO: drop the event if it is behind the watermark (max_ts - kLatenessMs), counting it as late
    // TODO: count it in its window (start = ts - ts % kWindowMs) and raise max_ts
    // TODO: close every window whose end <= watermark: produce one record per page to
    //       page-counts (key = page), flush, then commitSync the input offsets
    throw std::runtime_error("not implemented");
  }
}

void shutdown() {
  consumer->close();
  producer->flush(5000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <map>
#include <memory>
#include <regex>
#include <string>
#include <vector>

const int64_t kWindowMs = 60000;
const int64_t kLatenessMs = 5000;
const std::string kOutTopic = "page-counts";

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "windows", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"clicks"});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();
const std::regex kPageField(R"("page"\\s*:\\s*"([^"]+)")");
const std::regex kTsField(R"("ts"\\s*:\\s*(\\d+))");

// window start → page → count
std::map<int64_t, std::map<std::string, int>> windows;
int64_t max_ts = 0;
int late = 0;

struct Stats {
  int late;
  int open;
};

Stats stats() { return Stats{late, static_cast<int>(windows.size())}; }

// Emits every window that ended at or before the watermark; true if any did.
bool close_windows(int64_t watermark) {
  std::vector<int64_t> closed;
  for (const auto& [start, counts] : windows)
    if (start + kWindowMs <= watermark) closed.push_back(start);
  for (int64_t start : closed) {
    for (const auto& [page, count] : windows[start]) {
      std::string value = "{\\"page\\":\\"" + page + "\\",\\"window_start\\":" + std::to_string(start) +
                          ",\\"count\\":" + std::to_string(count) + "}";
      producer->produce(kOutTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                        value.data(), value.size(), page.c_str(), page.size(), 0, nullptr);
    }
    windows.erase(start);
  }
  if (!closed.empty()) producer->flush(10000);  // every record acknowledged before the commit
  return !closed.empty();
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    std::smatch page_m, ts_m;
    if (!std::regex_search(value, page_m, kPageField) || !std::regex_search(value, ts_m, kTsField)) continue;
    const std::string page = page_m[1].str();
    const int64_t ts = std::stoll(ts_m[1].str());
    int64_t watermark = max_ts - kLatenessMs;
    if (ts < watermark) {
      late++;
      continue;
    }
    const int64_t start = ts - ts % kWindowMs;
    windows[start][page]++;
    max_ts = std::max(max_ts, ts);
    watermark = max_ts - kLatenessMs;
    if (close_windows(watermark)) consumer->commitSync();  // the current positions: everything consumed so far
  }
}

void shutdown() {
  consumer->close();
  producer->flush(5000);
}
`,
    },
  },
  harness: {
    python: `import json


def _seed(ctx, *events):
    """Clicks on one partition, delivered in this order (event time is in the value, not the log)."""
    for page, ts in events:
        ctx.kafka.seed("clicks", key=page, value=json.dumps({"page": page, "ts": ts}), partition=0)


def _counts(ctx):
    out = []
    for r in ctx.kafka.records("page-counts"):
        v = json.loads(r.value)
        out.append((v["page"], v["window_start"], v["count"]))
    return sorted(out)


def check_windows(ctx):
    _seed(ctx, ("home", 1000), ("home", 2000), ("about", 3000), ("home", 61000), ("about", 62000), ("home", 125000))
    m = ctx.load("tumbling_window")
    ctx.drain(m.run)
    expected = [("about", 0, 1), ("about", 60000, 1), ("home", 0, 2), ("home", 60000, 1)]
    assert _counts(ctx) == expected, f"after ts 125000 (watermark 120000) windows 0 and 60000 must be emitted as {expected}, got {_counts(ctx)}"
    assert m.stats()["open"] == 1, f"the window starting at 120000 must stay open, stats() says {m.stats()}"
    m.shutdown()
    assert _counts(ctx) == expected, f"shutdown() must not emit open windows, got {_counts(ctx)}"


def check_boundary(ctx):
    _seed(ctx, ("home", 59999), ("home", 60000), ("home", 60001), ("home", 126000))
    m = ctx.load("tumbling_window")
    ctx.drain(m.run)
    assert _counts(ctx) == [("home", 0, 1), ("home", 60000, 2)], f"ts 59999 belongs to window 0, ts 60000 and 60001 to window 60000; got {_counts(ctx)}"


def check_late(ctx):
    _seed(ctx, ("home", 1000), ("home", 70000), ("home", 50000), ("home", 130000))
    m = ctx.load("tumbling_window")
    ctx.drain(m.run)
    assert _counts(ctx) == [("home", 0, 1), ("home", 60000, 1)], f"ts 50000 arrives behind the watermark 65000: it must neither reopen window 0 nor count; got {_counts(ctx)}"
    assert m.stats()["late"] == 1, f"one late event must be counted, stats() says {m.stats()}"


def check_within_lateness(ctx):
    _seed(ctx, ("home", 61000), ("home", 124000), ("home", 119500), ("home", 118000), ("home", 126000))
    m = ctx.load("tumbling_window")
    ctx.drain(m.run)
    assert _counts(ctx) == [("home", 60000, 2)], f"ts 119500 is 4500 ms behind 124000, inside the lateness: it counts in window 60000; got {_counts(ctx)}"
    assert m.stats()["late"] == 1, f"ts 118000 is 6000 ms behind: late; stats() says {m.stats()}"
    assert m.stats()["open"] == 1, f"the window starting at 120000 must stay open, stats() says {m.stats()}"


def check_keyed(ctx):
    _seed(ctx, ("home", 1000), ("about", 2000), ("home", 3000), ("pricing", 4000), ("home", 70000))
    m = ctx.load("tumbling_window")
    ctx.drain(m.run)
    records = ctx.kafka.records("page-counts")
    assert len(records) == 3, f"window 0 has three pages: expected three records, got {len(records)}"
    for r in records:
        v = json.loads(r.value)
        assert set(v) == {"page", "window_start", "count"}, f"the value must be exactly page, window_start, count: {v}"
        assert r.key == v["page"].encode(), f"the key must be the page, got {r.key!r} for {v}"
    assert {r.key for r in records} == {b"home", b"about", b"pricing"}


def check_commit_after_emit(ctx):
    _seed(ctx, ("home", 1000), ("home", 70000))
    ctx.kafka.stall("page-counts", 2)  # the broker acknowledges page-counts 2 s later
    started = ctx.clock.time()
    seen = []
    ctx.kafka.on_commit(lambda group, offsets: seen.append((group, ctx.clock.time() - started, _counts(ctx))))
    m = ctx.load("tumbling_window")
    ctx.drain(m.run)
    assert seen, "closing window 0 must commit the input offsets"
    group, waited, counts = seen[0]
    assert group == "windows", f"the consumer must commit as group windows, got {group!r}"
    assert counts == [("home", 0, 1)], f"at commit time page-counts must already hold window 0, it held {counts}"
    assert waited >= 2, f"committed {waited:.1f} s in: the output topic was stalled, the commit must wait for the ack (flush) first"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer"
    assert ctx.kafka.lag("windows", "clicks") == 0, "after the emit every consumed record must be committed"
`,
    typescript: `/** Clicks on one partition, delivered in this order (event time is in the value, not the log). */
function seed(ctx, ...events: [string, number][]) {
  for (const [page, ts] of events)
    ctx.kafka.seed('clicks', {key: page, value: JSON.stringify({page, ts}), partition: 0});
}

function counts(ctx): [string, number, number][] {
  return ctx.kafka
    .records('page-counts')
    .map(r => JSON.parse(String(r.value)))
    .map(v => [v.page, v.window_start, v.count] as [string, number, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
}

export async function check_windows(ctx) {
  seed(ctx, ['home', 1000], ['home', 2000], ['about', 3000], ['home', 61000], ['about', 62000], ['home', 125000]);
  const m = ctx.load('tumbling_window');
  await ctx.drain(m.run());
  const expected = [['about', 0, 1], ['about', 60000, 1], ['home', 0, 2], ['home', 60000, 1]];
  assert.deepEqual(counts(ctx), expected, \`after ts 125000 (watermark 120000) windows 0 and 60000 must be emitted as \${JSON.stringify(expected)}, got \${JSON.stringify(counts(ctx))}\`);
  assert.equal(m.stats().open, 1, \`the window starting at 120000 must stay open, stats() says \${JSON.stringify(m.stats())}\`);
  await m.shutdown();
  assert.deepEqual(counts(ctx), expected, \`shutdown() must not emit open windows, got \${JSON.stringify(counts(ctx))}\`);
}

export async function check_boundary(ctx) {
  seed(ctx, ['home', 59999], ['home', 60000], ['home', 60001], ['home', 126000]);
  const m = ctx.load('tumbling_window');
  await ctx.drain(m.run());
  assert.deepEqual(counts(ctx), [['home', 0, 1], ['home', 60000, 2]], \`ts 59999 belongs to window 0, ts 60000 and 60001 to window 60000; got \${JSON.stringify(counts(ctx))}\`);
}

export async function check_late(ctx) {
  seed(ctx, ['home', 1000], ['home', 70000], ['home', 50000], ['home', 130000]);
  const m = ctx.load('tumbling_window');
  await ctx.drain(m.run());
  assert.deepEqual(counts(ctx), [['home', 0, 1], ['home', 60000, 1]], \`ts 50000 arrives behind the watermark 65000: it must neither reopen window 0 nor count; got \${JSON.stringify(counts(ctx))}\`);
  assert.equal(m.stats().late, 1, \`one late event must be counted, stats() says \${JSON.stringify(m.stats())}\`);
}

export async function check_within_lateness(ctx) {
  seed(ctx, ['home', 61000], ['home', 124000], ['home', 119500], ['home', 118000], ['home', 126000]);
  const m = ctx.load('tumbling_window');
  await ctx.drain(m.run());
  assert.deepEqual(counts(ctx), [['home', 60000, 2]], \`ts 119500 is 4500 ms behind 124000, inside the lateness: it counts in window 60000; got \${JSON.stringify(counts(ctx))}\`);
  assert.equal(m.stats().late, 1, \`ts 118000 is 6000 ms behind: late; stats() says \${JSON.stringify(m.stats())}\`);
  assert.equal(m.stats().open, 1, \`the window starting at 120000 must stay open, stats() says \${JSON.stringify(m.stats())}\`);
}

export async function check_keyed(ctx) {
  seed(ctx, ['home', 1000], ['about', 2000], ['home', 3000], ['pricing', 4000], ['home', 70000]);
  const m = ctx.load('tumbling_window');
  await ctx.drain(m.run());
  const records = ctx.kafka.records('page-counts');
  assert.equal(records.length, 3, \`window 0 has three pages: expected three records, got \${records.length}\`);
  for (const r of records) {
    const v = JSON.parse(String(r.value));
    assert.deepEqual(Object.keys(v).sort(), ['count', 'page', 'window_start'], \`the value must be exactly page, window_start, count: \${JSON.stringify(v)}\`);
    assert.equal(r.key === null ? null : String(r.key), v.page, \`the key must be the page, got \${JSON.stringify(r.key)} for \${JSON.stringify(v)}\`);
  }
  assert.deepEqual(ctx.kafka.keys('page-counts').sort(), ['about', 'home', 'pricing']);
}

export async function check_commit_after_emit(ctx) {
  seed(ctx, ['home', 1000], ['home', 70000]);
  ctx.kafka.stall('page-counts', 2); // the broker acknowledges page-counts 2 s later
  const started = ctx.clock.now();
  const seen: [string, number, [string, number, number][]][] = [];
  ctx.kafka.onCommit((group: string) => seen.push([group, ctx.clock.now() - started, counts(ctx)]));
  const m = ctx.load('tumbling_window');
  await ctx.drain(m.run());
  assert(seen.length > 0, 'closing window 0 must commit the input offsets');
  const [group, waited, held] = seen[0];
  assert.equal(group, 'windows', \`the consumer must commit as group windows, got \${JSON.stringify(group)}\`);
  assert.deepEqual(held, [['home', 0, 1]], \`at commit time page-counts must already hold window 0, it held \${JSON.stringify(held)}\`);
  assert(waited >= 2000, \`committed \${waited} ms in: the output topic was stalled, the commit must wait for the ack (await the send) first\`);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer');
  assert.equal(ctx.kafka.lag('windows', 'clicks'), 0, 'after the emit every consumed record must be committed');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"leetbuild/harness"
)

// seedClicks puts clicks on partition 0 of clicks, delivered in this order (event time is in the
// value, not the log).
func seedClicks(ctx *harness.Ctx, events ...click) {
	for _, e := range events {
		ctx.Kafka.SeedPartition("clicks", 0, e.Page, fmt.Sprintf(\`{"page":%q,"ts":%d}\`, e.Page, e.Ts))
	}
}

// emittedCounts is page-counts as "page window_start count", sorted by page then window start.
func emittedCounts(ctx *harness.Ctx) []string {
	var got []pageCount
	for _, r := range ctx.Kafka.Records("page-counts") {
		var v pageCount
		ctx.NoError(json.Unmarshal(r.Value, &v), "the page-counts value %q is not JSON", r.Value)
		got = append(got, v)
	}
	sort.Slice(got, func(i, j int) bool {
		if got[i].Page != got[j].Page {
			return got[i].Page < got[j].Page
		}
		return got[i].WindowStart < got[j].WindowStart
	})
	var out []string
	for _, v := range got {
		out = append(out, fmt.Sprintf("%s %d %d", v.Page, v.WindowStart, v.Count))
	}
	return out
}

// drainWindows runs the aggregator until it waits for clicks that will not come.
func drainWindows(ctx *harness.Ctx) { ctx.Drain(func() { run(context.Background()) }) }

func CheckWindows(ctx *harness.Ctx) {
	seedClicks(ctx, click{"home", 1000}, click{"home", 2000}, click{"about", 3000}, click{"home", 61000}, click{"about", 62000}, click{"home", 125000})
	drainWindows(ctx)
	expected := []string{"about 0 1", "about 60000 1", "home 0 2", "home 60000 1"}
	ctx.Equal(emittedCounts(ctx), expected, "after ts 125000 (watermark 120000) windows 0 and 60000 must be emitted as page window_start count")
	ctx.Equal(stats().Open, 1, "the window starting at 120000 must stay open: stats().Open (stats() is %+v)", stats())
	shutdown()
	ctx.Settle()
	ctx.Equal(emittedCounts(ctx), expected, "shutdown() must not emit open windows")
}

func CheckBoundary(ctx *harness.Ctx) {
	seedClicks(ctx, click{"home", 59999}, click{"home", 60000}, click{"home", 60001}, click{"home", 126000})
	drainWindows(ctx)
	ctx.Equal(emittedCounts(ctx), []string{"home 0 1", "home 60000 2"}, "ts 59999 belongs to window 0, ts 60000 and 60001 to window 60000")
}

func CheckLate(ctx *harness.Ctx) {
	seedClicks(ctx, click{"home", 1000}, click{"home", 70000}, click{"home", 50000}, click{"home", 130000})
	drainWindows(ctx)
	ctx.Equal(emittedCounts(ctx), []string{"home 0 1", "home 60000 1"}, "ts 50000 arrives behind the watermark 65000: it must neither reopen window 0 nor count")
	ctx.Equal(stats().Late, 1, "one late event must be counted: stats().Late (stats() is %+v)", stats())
}

func CheckWithinLateness(ctx *harness.Ctx) {
	seedClicks(ctx, click{"home", 61000}, click{"home", 124000}, click{"home", 119500}, click{"home", 118000}, click{"home", 126000})
	drainWindows(ctx)
	ctx.Equal(emittedCounts(ctx), []string{"home 60000 2"}, "ts 119500 is 4500 ms behind 124000, inside the lateness: it counts in window 60000")
	ctx.Equal(stats().Late, 1, "ts 118000 is 6000 ms behind, late: stats().Late (stats() is %+v)", stats())
	ctx.Equal(stats().Open, 1, "the window starting at 120000 must stay open: stats().Open (stats() is %+v)", stats())
}

func CheckKeyed(ctx *harness.Ctx) {
	seedClicks(ctx, click{"home", 1000}, click{"about", 2000}, click{"home", 3000}, click{"pricing", 4000}, click{"home", 70000})
	drainWindows(ctx)
	records := ctx.Kafka.Records("page-counts")
	ctx.Equal(len(records), 3, "window 0 has three pages: records on page-counts")
	for _, r := range records {
		var v map[string]any
		ctx.NoError(json.Unmarshal(r.Value, &v), "the page-counts value %q is not JSON", r.Value)
		var fields []string
		for k := range v {
			fields = append(fields, k)
		}
		sort.Strings(fields)
		ctx.Equal(fields, []string{"count", "page", "window_start"}, "the value %s must have exactly page, window_start, count", r.Value)
		var key any
		if r.Key != nil {
			key = string(r.Key)
		}
		ctx.Equal(key, v["page"], "the key must be the page (value %s)", r.Value)
	}
	keys := ctx.Kafka.Keys("page-counts")
	sort.Strings(keys)
	ctx.Equal(keys, []string{"about", "home", "pricing"}, "the keys of page-counts")
}

func CheckCommitAfterEmit(ctx *harness.Ctx) {
	seedClicks(ctx, click{"home", 1000}, click{"home", 70000})
	ctx.Kafka.StallFor("page-counts", 2) // the broker acknowledges page-counts 2 s later
	started := ctx.Clock.Now()
	type commitSeen struct {
		group  string
		waited int64
		held   []string
	}
	var seen []commitSeen
	ctx.Kafka.OnCommit(func(group string, _ harness.KafkaOffsets) {
		seen = append(seen, commitSeen{group, ctx.Clock.Now() - started, emittedCounts(ctx)})
	})
	drainWindows(ctx)
	ctx.Assert(len(seen) > 0, "closing window 0 must commit the input offsets")
	first := seen[0]
	ctx.Equal(first.group, "windows", "the consumer must commit as group windows")
	ctx.Equal(first.held, []string{"home 0 1"}, "at commit time page-counts must already hold window 0")
	ctx.Assert(first.waited >= 2000, "committed %d ms in: the output topic was stalled, the commit must wait for the ack (a synchronous WriteMessages) first", first.waited)
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "offsets were committed on a timer: auto-commits")
	ctx.Equal(ctx.Kafka.Lag("windows", "clicks"), 0, "after the emit every consumed record must be committed: lag")
}
`,
  },
  debrief: `The watermark turns an unbounded, out-of-order stream into finite, publishable windows: it is a promise — "nothing older than this will count" — derived from the data (\`max_ts - lateness\`), not from the wall clock, so a replay of yesterday's topic closes yesterday's windows the same way. Everything else follows from it: an event behind it is dropped (the count has already been published), an event ahead of it counts even into an older window, and a window closes exactly when its end falls at or before it. The commit sits last because the emitted counts are the side effect: commit first and a crash between the two loses a window; emit, wait for the ack, then commit and a crash replays it (a duplicate count, which downstream can dedupe by \`(page, window_start)\`). Real stream processors (Kafka Streams, Flink) add what this drill leaves out: open windows are checkpointed in a state store or changelog topic so a restart does not recount from the committed offset, watermarks are tracked per partition and merged, late events can update an already-emitted window instead of being dropped, and the emit-and-commit pair becomes a Kafka transaction so the output and the offsets land atomically.`,
};
