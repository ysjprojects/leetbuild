import type {Step} from '@/lib/types';

export const batchConsumerStep: Step = {
  id: 'batch-consumer',
  title: 'Close the batch on count or clock, commit once',
  concept: 'kafka',
  file: 'batch_consumer',
  focus: ['consumer', 'kafka'],
  task: `## Task

Implement \`run(flush)\`: a member of consumer group **\`rollup\`** reading **\`metrics\`** from the
earliest offset with **auto-commit off**, that hands the sink one batch at a time.

- \`BATCH_SIZE = 50\`, \`BATCH_WAIT_MS = 500\`. A batch closes on whichever comes first: it holds
  \`BATCH_SIZE\` records, or \`BATCH_WAIT_MS\` have passed since collecting it started.
- A closed batch is \`flush(records)\` **once**, the records exactly as the client delivered them, in
  delivery order (\`Message\` objects in Python; the \`{topic, partition, message}\` payloads of
  \`eachMessage\` in kafkajs). \`flush\` is never called with an empty batch — an empty poll closes
  nothing.
- After \`flush\` returns, **one synchronous commit per batch**: for every partition present in the
  batch, its highest offset + 1 (\`consumer.commit(offsets=[TopicPartition(...)], asynchronous=False)\`
  / \`consumer.commitOffsets([{topic, partition, offset}])\`). A partition absent from the batch is
  absent from the commit.
- No record is flushed twice and none is skipped: the next batch starts after the last one, empty.
- Python: \`consumer.consume(BATCH_SIZE, BATCH_WAIT_MS / 1000)\` is the whole wait. kafkajs has no batch
  API: assemble the batch across \`eachMessage\` calls, with a \`setTimeout\` of \`BATCH_WAIT_MS\` armed on
  the batch's first record and cleared when the count closes it first.

:::widget consumer-groups {"partitions": 3}

> Two knobs, one rule: the count bounds the batch, the clock bounds the latency, and the commit is
> the batch's receipt — one per batch, after the flush, one offset per partition it touched.`,
  sequence: {
    participants: ['Kafka', 'rollup consumer', 'store'],
    messages: [
      {from: 'Kafka', to: 'rollup consumer', label: 'poll → 50 records (p0 0–16, p1 0–16, p2 0–15)', kind: 'reply'},
      {from: 'rollup consumer', to: 'store', label: 'flush(50 records)', kind: 'sync'},
      {from: 'store', to: 'rollup consumer', label: 'ok', kind: 'reply'},
      {from: 'rollup consumer', to: 'Kafka', label: 'commit {p0: 17, p1: 17, p2: 16}', kind: 'sync'},
      {from: 'Kafka', to: 'rollup consumer', label: 'poll → 20 records, then nothing for 500 ms', kind: 'reply'},
      {from: 'rollup consumer', to: 'store', label: 'flush(20 records)', kind: 'sync'},
      {from: 'store', to: 'rollup consumer', label: 'ok', kind: 'reply'},
      {from: 'rollup consumer', to: 'Kafka', label: 'commit {p0: 24, p1: 24, p2: 22}', kind: 'sync'},
    ],
  },
  hints: [
    'Python: `consumer.consume(BATCH_SIZE, BATCH_WAIT_MS / 1000)` returns up to 50 messages and gives up after 500 ms — an empty list when nothing arrived, which you skip. kafkajs: push every payload onto a list; on the first one arm `setTimeout(flushBatch, BATCH_WAIT_MS)`, on the 50th call `flushBatch` yourself and `clearTimeout`.',
    'Build the commit from the batch, not from the consumer’s position: a map partition → highest offset + 1 over the records you just flushed, one `TopicPartition` / `{topic, partition, offset}` per entry.',
    'In kafkajs, swap the list out (`const records = batch; batch = []`) before you `await flush(records)`: a timer firing mid-flush must find an empty list, and an empty list must return before calling `flush` at all.',
  ],
  checks: [
    {
      id: 'group',
      title: 'Joins group rollup on metrics with auto-commit off',
      detail:
        'The consumer uses `group.id` `rollup`, subscribes to `metrics` and disables auto-commit: the only commits are the synchronous ones the batch loop makes, and nothing flushed is left uncommitted.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*"rollup"/,
            /subscribe\(\s*\[\s*"metrics"\s*\]\s*\)/,
            /"enable\.auto\.commit"\s*:\s*False/,
          ],
        },
        typescript: {
          all: [/groupId:\s*['"]rollup['"]/, /subscribe\(\s*\{[^\n]*['"]metrics['"]/, /autoCommit:\s*false/],
        },
        go: {all: [/GroupID:\s*"rollup"/, /Topic:\s*"metrics"/, /reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {
          all: [/"group\.id"\s*,\s*"rollup"/, /subscribe\([^\n]*"metrics"/, /"enable\.auto\.commit"\s*,\s*"false"/],
        },
        cpp: {
          all: [/"group\.id"\s*,\s*"rollup"/, /subscribe\([^\n]*"metrics"/, /"enable\.auto\.commit"\s*,\s*"false"/],
        },
      },
    },
    {
      id: 'batch-size',
      title: 'Closes at 50 records: 120 → 50, 50, 20, one commit each',
      detail:
        '120 seeded records are flushed as 50, 50 and 20 with exactly one commit after each flush; every record is flushed once, and within a batch each partition’s offsets ascend.',
      match: {
        python: {all: [/consumer\.consume\(\s*BATCH_SIZE\s*,/]},
        typescript: {all: [/batch\.length\s*>=\s*BATCH_SIZE/]},
        go: {all: [/len\(batch\)\s*<\s*BatchSize/]},
        scala: {all: [/pending\.size\s*<\s*BatchSize/]},
        cpp: {all: [/batch\.size\(\)\s*<\s*kBatchSize/]},
      },
    },
    {
      id: 'batch-wait',
      title: 'Closes at 500 ms: a short batch flushes once the window passes',
      detail:
        '70 records: 50 flush at once; the other 20 flush and commit 500 ms after they arrived — not before, and not a whole poll later — with nothing new on the topic.',
      match: {
        python: {all: [/consumer\.consume\(\s*BATCH_SIZE\s*,\s*BATCH_WAIT_MS\s*\/\s*1000\s*\)/]},
        typescript: {all: [/setTimeout\([^\n]*BATCH_WAIT_MS\s*\)/, /clearTimeout\(/]},
        go: {
          all: [
            /context\.WithTimeout\(\s*ctx\s*,\s*BatchWaitMs\s*\*\s*time\.Millisecond\s*\)/,
            /context\.DeadlineExceeded/,
          ],
        },
        scala: {all: [/\+\s*BatchWaitMs/, /Duration\.ofMillis\(\s*remaining\s*\)/]},
        cpp: {all: [/std::chrono::milliseconds\(\s*kBatchWaitMs\s*\)/, /ERR__TIMED_OUT/]},
      },
    },
    {
      id: 'commit-offsets',
      title: 'Commits the batch’s last offset + 1 per partition, after the flush',
      detail:
        'Each commit names exactly the partitions of the batch just flushed, each at its highest offset in the batch + 1, and comes after `flush` returned; a partition absent from the batch is absent from the commit.',
      match: {
        python: {
          order: [/flush\(batch\)/, /consumer\.commit\(\s*offsets\s*=\s*next_offsets\(batch\)/],
          all: [/msg\.offset\(\)\s*\+\s*1/],
        },
        typescript: {
          order: [/await flush\(records\)/, /consumer\.commitOffsets\(\s*nextOffsets\(records\)\s*\)/],
          all: [/Number\(message\.offset\)\s*\+\s*1/],
        },
        go: {order: [/flush\(batch\)/, /reader\.CommitMessages\(\s*ctx\s*,\s*batch\.\.\.\s*\)/]},
        scala: {
          order: [/flush\(batch\)/, /consumer\.commitSync\(\s*nextOffsets\(batch\)\s*\)/],
          all: [/\.max\s*\+\s*1/],
        },
        cpp: {order: [/flush\(batch\)/, /consumer->commitSync\(\s*offsets\s*\)/], all: [/msg->offset\(\)\s*\+\s*1/]},
      },
    },
    {
      id: 'no-empty-flush',
      title: 'Never flushes an empty batch',
      detail:
        'Exactly 50 records then silence: one flush and one commit; the window closing on nothing — or a timer left armed after the count closed the batch — calls neither `flush` nor commit.',
      match: {
        python: {all: [/if not batch:/]},
        typescript: {all: [/if \(batch\.length === 0\) return;/]},
        go: {all: [/if len\(batch\) == 0 \{/]},
        scala: {all: [/if \(batch\.nonEmpty\)/]},
        cpp: {all: [/if \(batch\.empty\(\)\) continue;/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from confluent_kafka import Consumer, TopicPartition

BATCH_SIZE = 50
BATCH_WAIT_MS = 500

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "rollup",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["metrics"])


def next_offsets(batch):
    """The offset to commit per partition: one past the last record of the batch on it."""
    # TODO: {(topic, partition): highest offset + 1} -> [TopicPartition(topic, partition, offset), ...]
    raise NotImplementedError


def run(flush) -> None:
    while True:
        # TODO: consume up to BATCH_SIZE records, waiting at most BATCH_WAIT_MS / 1000 s
        # TODO: skip an empty batch; otherwise flush(batch), then commit next_offsets(batch) synchronously
        raise NotImplementedError
`,
      solution: `from confluent_kafka import Consumer, TopicPartition

BATCH_SIZE = 50
BATCH_WAIT_MS = 500

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "rollup",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["metrics"])


def next_offsets(batch):
    """The offset to commit per partition: one past the last record of the batch on it."""
    last = {}
    for msg in batch:
        key = (msg.topic(), msg.partition())
        last[key] = max(last.get(key, 0), msg.offset() + 1)
    return [TopicPartition(topic, partition, offset) for (topic, partition), offset in last.items()]


def run(flush) -> None:
    while True:
        # Up to BATCH_SIZE records; gives up BATCH_WAIT_MS after the call: the count or the clock.
        batch = [msg for msg in consumer.consume(BATCH_SIZE, BATCH_WAIT_MS / 1000) if msg.error() is None]
        if not batch:
            continue
        flush(batch)
        consumer.commit(offsets=next_offsets(batch), asynchronous=False)
`,
    },
    typescript: {
      starter: `import {type EachMessagePayload, Kafka} from 'kafkajs';

export const BATCH_SIZE = 50;
export const BATCH_WAIT_MS = 500;

const kafka = new Kafka({clientId: 'rollup', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'rollup'});

export type Flush = (records: EachMessagePayload[]) => Promise<void> | void;

/** The offset to commit per partition: one past the last record of the batch on it. */
export function nextOffsets(records: EachMessagePayload[]): {topic: string; partition: number; offset: string}[] {
  // TODO: partition -> highest offset + 1 over the batch, one entry per partition present
  throw new Error('not implemented');
}

export async function run(flush: Flush): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'metrics', fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit (autoCommit: false)
    eachMessage: async payload => {
      // TODO: push the payload; arm a BATCH_WAIT_MS timer on the first record of a batch
      // TODO: at BATCH_SIZE records, flush now: clear the timer, swap the batch out, await flush(records), commitOffsets(nextOffsets(records))
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import {type EachMessagePayload, Kafka} from 'kafkajs';

export const BATCH_SIZE = 50;
export const BATCH_WAIT_MS = 500;

const kafka = new Kafka({clientId: 'rollup', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'rollup'});

export type Flush = (records: EachMessagePayload[]) => Promise<void> | void;

/** The offset to commit per partition: one past the last record of the batch on it. */
export function nextOffsets(records: EachMessagePayload[]): {topic: string; partition: number; offset: string}[] {
  const last = new Map<string, {topic: string; partition: number; offset: number}>();
  for (const {topic, partition, message} of records) {
    const key = \`\${topic}|\${partition}\`;
    const next = Number(message.offset) + 1;
    const seen = last.get(key);
    if (seen === undefined || next > seen.offset) last.set(key, {topic, partition, offset: next});
  }
  return [...last.values()].map(o => ({topic: o.topic, partition: o.partition, offset: String(o.offset)}));
}

export async function run(flush: Flush): Promise<void> {
  let batch: EachMessagePayload[] = [];
  let timer: NodeJS.Timeout | null = null;

  // Closes the batch: by the count (called from eachMessage) or by the clock (called from the timer).
  const flushBatch = async (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (batch.length === 0) return;
    const records = batch;
    batch = [];
    await flush(records);
    await consumer.commitOffsets(nextOffsets(records));
  };

  await consumer.connect();
  await consumer.subscribe({topic: 'metrics', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async payload => {
      if (batch.length === 0) timer = setTimeout(() => void flushBatch(), BATCH_WAIT_MS);
      batch.push(payload);
      if (batch.length >= BATCH_SIZE) await flushBatch();
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	BatchSize   = 50
	BatchWaitMs = 500
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "rollup",
	Topic:   "metrics",
})

// collect returns up to BatchSize messages, or whatever arrived BatchWaitMs after it started.
func collect(ctx context.Context) ([]kafka.Message, error) {
	var batch []kafka.Message
	// TODO: a context that expires BatchWaitMs after collecting started
	// TODO: FetchMessage (not ReadMessage: it commits) until BatchSize messages or context.DeadlineExceeded
	_ = time.Millisecond
	_ = errors.Is
	return batch, nil
}

func run(ctx context.Context, flush func([]kafka.Message) error) error {
	for {
		// TODO: collect; skip an empty batch; flush, then CommitMessages(ctx, batch...) — the highest offset + 1 per partition
		return errors.New("not implemented")
	}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	BatchSize   = 50
	BatchWaitMs = 500
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "rollup",
	Topic:   "metrics",
})

// collect returns up to BatchSize messages, or whatever arrived BatchWaitMs after it started.
func collect(ctx context.Context) ([]kafka.Message, error) {
	var batch []kafka.Message
	window, cancel := context.WithTimeout(ctx, BatchWaitMs*time.Millisecond)
	defer cancel()
	for len(batch) < BatchSize {
		msg, err := reader.FetchMessage(window)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				break // the clock closed the batch: flush what arrived
			}
			return nil, err
		}
		batch = append(batch, msg)
	}
	return batch, nil
}

func run(ctx context.Context, flush func([]kafka.Message) error) error {
	for {
		batch, err := collect(ctx)
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			continue
		}
		if err := flush(batch); err != nil {
			return err // not committed: the batch is redelivered
		}
		// CommitMessages commits, per partition, the highest offset + 1 among the messages given.
		if err := reader.CommitMessages(ctx, batch...); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.collection.mutable.ArrayBuffer
import scala.jdk.CollectionConverters._

object BatchConsumer {
  val BatchSize = 50
  val BatchWaitMs = 500L

  type Record = ConsumerRecord[String, String]

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "rollup")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("metrics").asJava)

  /** Records a poll returned beyond the batch that closed: they open the next one. */
  private val pending = ArrayBuffer.empty[Record]

  /** One past the last offset of the batch on each partition it touches. */
  def nextOffsets(batch: Seq[Record]): java.util.Map[TopicPartition, OffsetAndMetadata] = {
    // TODO: group by (topic, partition); each -> OffsetAndMetadata(highest offset + 1)
    Map.empty[TopicPartition, OffsetAndMetadata].asJava
  }

  /** Up to BatchSize records, or whatever arrived BatchWaitMs after collecting started. */
  private def collect(): Seq[Record] = {
    // TODO: poll with the time left in the window into pending until BatchSize or the window closes
    // TODO: take BatchSize from pending (the rest stays for the next batch)
    Seq.empty
  }

  def run(flush: Seq[Record] => Unit): Unit =
    while (true) {
      val batch = collect()
      // TODO: skip an empty batch; otherwise flush, then commitSync(nextOffsets(batch))
      throw new NotImplementedError()
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.collection.mutable.ArrayBuffer
import scala.jdk.CollectionConverters._

object BatchConsumer {
  val BatchSize = 50
  val BatchWaitMs = 500L

  type Record = ConsumerRecord[String, String]

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "rollup")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("metrics").asJava)

  /** Records a poll returned beyond the batch that closed: they open the next one. */
  private val pending = ArrayBuffer.empty[Record]

  /** One past the last offset of the batch on each partition it touches. */
  def nextOffsets(batch: Seq[Record]): java.util.Map[TopicPartition, OffsetAndMetadata] =
    batch
      .groupBy(r => new TopicPartition(r.topic(), r.partition()))
      .map { case (tp, records) => tp -> new OffsetAndMetadata(records.map(_.offset()).max + 1) }
      .asJava

  /** Up to BatchSize records, or whatever arrived BatchWaitMs after collecting started. */
  private def collect(): Seq[Record] = {
    val deadline = System.currentTimeMillis() + BatchWaitMs
    var remaining = BatchWaitMs
    while (pending.size < BatchSize && remaining > 0) {
      pending ++= consumer.poll(Duration.ofMillis(remaining)).asScala
      remaining = deadline - System.currentTimeMillis()
    }
    val batch = pending.take(BatchSize).toSeq
    pending.remove(0, batch.size)
    batch
  }

  def run(flush: Seq[Record] => Unit): Unit =
    while (true) {
      val batch = collect()
      if (batch.nonEmpty) {
        flush(batch)
        consumer.commitSync(nextOffsets(batch))
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

constexpr std::size_t kBatchSize = 50;
constexpr int kBatchWaitMs = 500;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "rollup", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"metrics"});
  return consumer;
}

auto consumer = make_consumer();

using Batch = std::vector<std::unique_ptr<RdKafka::Message>>;
using Flush = std::function<void(const Batch&)>;

// One past the last offset of the batch on each partition it touches.
std::vector<RdKafka::TopicPartition*> next_offsets(const Batch& batch) {
  std::vector<RdKafka::TopicPartition*> offsets;
  // TODO: (topic, partition) -> highest offset + 1, one TopicPartition::create per entry
  return offsets;
}

// Up to kBatchSize messages, or whatever arrived kBatchWaitMs after collecting started.
Batch collect() {
  Batch batch;
  // TODO: consume() with the time left in the window until kBatchSize or ERR__TIMED_OUT
  return batch;
}

void run(const Flush& flush) {
  while (true) {
    Batch batch = collect();
    // TODO: skip an empty batch; otherwise flush, then commitSync(next_offsets(batch)) and destroy the partitions
    return;
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

constexpr std::size_t kBatchSize = 50;
constexpr int kBatchWaitMs = 500;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "rollup", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"metrics"});
  return consumer;
}

auto consumer = make_consumer();

using Batch = std::vector<std::unique_ptr<RdKafka::Message>>;
using Flush = std::function<void(const Batch&)>;

// One past the last offset of the batch on each partition it touches.
std::vector<RdKafka::TopicPartition*> next_offsets(const Batch& batch) {
  std::map<std::pair<std::string, int32_t>, int64_t> last;
  for (const auto& msg : batch) {
    auto& next = last[{msg->topic_name(), msg->partition()}];
    next = std::max(next, msg->offset() + 1);
  }
  std::vector<RdKafka::TopicPartition*> offsets;
  for (const auto& [tp, offset] : last) offsets.push_back(RdKafka::TopicPartition::create(tp.first, tp.second, offset));
  return offsets;
}

// Up to kBatchSize messages, or whatever arrived kBatchWaitMs after collecting started.
Batch collect() {
  Batch batch;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kBatchWaitMs);
  while (batch.size() < kBatchSize) {
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
    if (remaining <= 0) break;
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(static_cast<int>(remaining)));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) break;  // the clock closed the batch
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    batch.push_back(std::move(msg));
  }
  return batch;
}

void run(const Flush& flush) {
  while (true) {
    Batch batch = collect();
    if (batch.empty()) continue;
    flush(batch);
    auto offsets = next_offsets(batch);
    consumer->commitSync(offsets);
    RdKafka::TopicPartition::destroy(offsets);
  }
}
`,
    },
  },
  harness: {
    python: `import json

GROUP = "rollup"
TOPIC = "metrics"


def _seed(ctx, n, partition=lambda i: i % 3):
    for i in range(n):
        ctx.kafka.seed(TOPIC, key=f"host-{i}", value=json.dumps({"host": f"host-{i}", "cpu": i}), partition=partition(i))


def _place(record):
    assert hasattr(record, "partition") and hasattr(record, "offset"), f"flush must receive the consumer's Message objects as delivered, got {type(record).__name__}"
    return (record.partition(), record.offset())


class Recorder:
    """What the learner's loop did: every flush as (partition, offset) pairs, every commit with the clock at that moment, and their order."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.flushes = []
        self.commits = []
        self.log = []
        ctx.kafka.on_commit(self._on_commit)

    def flush(self, records):
        records = list(records)
        self.flushes.append([_place(r) for r in records])
        self.log.append(("flush", len(records)))

    def _on_commit(self, group, offsets):
        self.commits.append((group, dict(offsets), self.ctx.clock.time()))
        self.log.append(("commit", group))


def _consumer(ctx, seconds=2.0):
    """
    Load the learner's module with its consumer under an operator who stops it \`seconds\` of virtual
    time later: the topic drains, the loop keeps polling (a window can close on nothing new), then
    the next poll is interrupted the way Ctrl-C would.
    """
    stop_at = ctx.clock.time() + seconds

    def armed(group, topics):
        ctx.kafka.stop_when_drained = False
        consumer = ctx.kafka.consumers[-1]
        inner = consumer.poll
        polls = 0

        def poll(timeout=None):
            nonlocal polls
            polls += 1
            if ctx.clock.time() >= stop_at or polls > 10_000:
                raise KeyboardInterrupt("the operator stopped the consumer")
            return inner(timeout)

        consumer.poll = poll

    ctx.kafka.on_subscribe(armed)
    return ctx.load("batch_consumer")


def _expected_commit(flush):
    last = {}
    for partition, offset in flush:
        last[(TOPIC, partition)] = max(last.get((TOPIC, partition), 0), offset + 1)
    return last


def check_group(ctx):
    _seed(ctx, 50)
    rec = Recorder(ctx)
    m = _consumer(ctx)
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer must subscribe to a topic"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == GROUP, f"group.id must be {GROUP}, got {group!r}"
    assert TOPIC in topics, f"the consumer must subscribe to {TOPIC}, got {topics}"
    assert ctx.kafka.consumers[-1].auto_commit is False, "enable.auto.commit is on: offsets would be committed on a timer, not once per flushed batch"
    ctx.drain(m.run, rec.flush)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "offsets were auto-committed"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened after the flush"
    assert not any(e[0] == "manual-commit" and e[2] for e in ctx.kafka.events), "commit with asynchronous=False: a rejected commit must surface before the next batch is flushed"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, f"{ctx.kafka.lag(GROUP, TOPIC)} flushed record(s) are not committed"


def check_batch_size(ctx):
    _seed(ctx, 120)
    rec = Recorder(ctx)
    m = _consumer(ctx)
    ctx.drain(m.run, rec.flush)
    sizes = [len(f) for f in rec.flushes]
    assert sizes == [50, 50, 20], f"120 records must flush as [50, 50, 20], got {sizes}"
    assert rec.log == [("flush", 50), ("commit", GROUP), ("flush", 50), ("commit", GROUP), ("flush", 20), ("commit", GROUP)], f"expected flush, commit, flush, commit, flush, commit — one commit right after each flush; got {rec.log}"
    seen = [place for f in rec.flushes for place in f]
    assert len(set(seen)) == len(seen), "a record was flushed twice: the batch must start empty after a flush"
    seeded = {(r.partition, r.offset) for r in ctx.kafka.records(TOPIC)}
    assert set(seen) == seeded, f"{len(seeded - set(seen))} seeded record(s) never reached flush"
    for i, f in enumerate(rec.flushes):
        for partition in {p for p, _ in f}:
            offsets = [o for p, o in f if p == partition]
            assert offsets == sorted(offsets), f"flush {i + 1} holds partition {partition} out of order: {offsets} — keep the records in delivery order"


def check_batch_wait(ctx):
    _seed(ctx, 70)
    rec = Recorder(ctx)
    m = _consumer(ctx)
    ctx.drain(m.run, rec.flush)
    sizes = [len(f) for f in rec.flushes]
    assert sizes == [50, 20], f"70 records must flush as [50, 20] — the 20 once 500 ms pass with nothing new; got {sizes}"
    assert len(rec.commits) == 2, f"expected one commit per batch (2), got {len(rec.commits)}"
    # Measured from the previous commit (the batch starts right after it); a few real ms of slack.
    elapsed = rec.commits[1][2] - rec.commits[0][2]
    assert 0.49 <= elapsed < 0.75, f"the trailing batch must flush and commit 500 ms after it started, not {elapsed * 1000:.0f} ms later"


def check_commit_offsets(ctx):
    _seed(ctx, 55, partition=lambda i: 1 if i < 50 else 2)
    rec = Recorder(ctx)
    m = _consumer(ctx)
    ctx.drain(m.run, rec.flush)
    assert len(rec.flushes) == 2, f"55 records on partitions 1 and 2 must flush as two batches, got {[len(f) for f in rec.flushes]}"
    assert len(rec.commits) == len(rec.flushes), f"expected one commit per flush ({len(rec.flushes)}), got {len(rec.commits)}"
    for i, (flush, (group, offsets, _)) in enumerate(zip(rec.flushes, rec.commits)):
        assert group == GROUP, f"commit {i + 1} came from group {group!r}, expected {GROUP!r}"
        expected = _expected_commit(flush)
        assert offsets == expected, f"commit {i + 1} must be the batch's highest offset + 1 per partition it touched, {expected}; got {offsets}"
    assert ctx.kafka.committed_offset(GROUP, TOPIC, 1) == 50 and ctx.kafka.committed_offset(GROUP, TOPIC, 2) == 5, "after both batches partition 1 must be committed at 50 and partition 2 at 5"
    assert ctx.kafka.committed_offset(GROUP, TOPIC, 0) is None, "partition 0 had no records: it must not appear in any commit"


def check_no_empty_flush(ctx):
    _seed(ctx, 50)
    rec = Recorder(ctx)
    m = _consumer(ctx)
    ctx.drain(m.run, rec.flush)
    assert all(rec.flushes), f"flush was called with an empty batch: flushes of sizes {[len(f) for f in rec.flushes]}"
    assert len(rec.flushes) == 1, f"exactly 50 records then silence must flush once, got {len(rec.flushes)} flushes"
    assert len(rec.commits) == 1, f"one batch, one commit: got {len(rec.commits)} commits"
`,
    typescript: `const GROUP = 'rollup';
const TOPIC = 'metrics';

function seed(ctx, n: number, partition: (i: number) => number = i => i % 3) {
  for (let i = 0; i < n; i++)
    ctx.kafka.seed(TOPIC, {key: \`host-\${i}\`, value: JSON.stringify({host: \`host-\${i}\`, cpu: i}), partition: partition(i)});
}

type Place = [number, number];

function place(record): Place {
  const payload = record as {partition?: unknown; message?: {offset?: unknown}} | null;
  assert(
    payload !== null && typeof payload === 'object' && typeof payload.partition === 'number' && payload.message?.offset !== undefined,
    'flush must receive the {topic, partition, message} payloads as eachMessage delivered them',
  );
  return [payload.partition, Number(payload.message.offset)];
}

/** What the learner's loop did: every flush as [partition, offset] pairs, every commit with the clock at that moment, and their order. */
function recorder(ctx) {
  const rec = {
    flushes: [] as Place[][],
    commits: [] as {group: string; offsets: Record<string, number>; at: number}[],
    log: [] as string[],
    flush: async (records: unknown[]): Promise<void> => {
      rec.flushes.push([...records].map(place));
      rec.log.push(\`flush \${records.length}\`);
    },
  };
  ctx.kafka.onCommit((group: string, offsets: Map<string, number>) => {
    rec.commits.push({group, offsets: Object.fromEntries(offsets), at: ctx.clock.now()});
    rec.log.push('commit');
  });
  return rec;
}

/** The learner's loop over everything seeded, then \`seconds\` of silence in quarter-second steps: a window still open closes on the way. */
async function run(ctx, m, flush, seconds = 2) {
  await ctx.drain(m.run(flush));
  for (let t = 0; t < seconds; t += 0.25) {
    ctx.clock.advance(0.25);
    // A real turn of the event loop: a timer that just fired finishes its flush and commit.
    const turn = Promise.withResolvers<void>();
    setTimeout(turn.resolve, 0);
    await turn.promise;
  }
}

function expectedCommit(flush: Place[]): Record<string, number> {
  const last: Record<string, number> = {};
  for (const [partition, offset] of flush) {
    const key = \`\${TOPIC}|\${partition}\`;
    last[key] = Math.max(last[key] ?? 0, offset + 1);
  }
  return last;
}

export async function check_group(ctx) {
  seed(ctx, 50);
  const rec = recorder(ctx);
  const m = ctx.load('batch_consumer');
  await run(ctx, m, rec.flush);
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer must subscribe to a topic');
  const [, group, topics] = subscriptions[subscriptions.length - 1];
  assert.equal(group, GROUP, \`groupId must be \${GROUP}, got \${JSON.stringify(group)}\`);
  assert(topics.includes(TOPIC), \`the consumer must subscribe to \${TOPIC}, got \${JSON.stringify(topics)}\`);
  const consumer = ctx.kafka.consumers[ctx.kafka.consumers.length - 1];
  assert(consumer !== undefined && consumer.autoCommit === false, 'autoCommit is on: offsets would be committed on a timer, not once per flushed batch');
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'offsets were auto-committed');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened after the flush');
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, \`\${ctx.kafka.lag(GROUP, TOPIC)} flushed record(s) are not committed\`);
}

export async function check_batch_size(ctx) {
  seed(ctx, 120);
  const rec = recorder(ctx);
  const m = ctx.load('batch_consumer');
  await run(ctx, m, rec.flush);
  const sizes = rec.flushes.map(f => f.length);
  assert.deepEqual(sizes, [50, 50, 20], \`120 records must flush as [50, 50, 20], got \${JSON.stringify(sizes)}\`);
  assert.deepEqual(
    rec.log,
    ['flush 50', 'commit', 'flush 50', 'commit', 'flush 20', 'commit'],
    \`expected flush, commit, flush, commit, flush, commit — one commit right after each flush; got \${JSON.stringify(rec.log)}\`,
  );
  const seen = rec.flushes.flat().map(([p, o]) => \`\${p}:\${o}\`);
  assert.equal(new Set(seen).size, seen.length, 'a record was flushed twice: the batch must start empty after a flush');
  const seeded = new Set(ctx.kafka.records(TOPIC).map(r => \`\${r.partition}:\${r.offset}\`));
  assert.equal(seen.filter(s => seeded.has(s)).length, seeded.size, \`\${[...seeded].filter(s => !seen.includes(s)).length} seeded record(s) never reached flush\`);
  rec.flushes.forEach((f, i) => {
    for (const partition of new Set(f.map(([p]) => p))) {
      const offsets = f.filter(([p]) => p === partition).map(([, o]) => o);
      const sorted = [...offsets].sort((a, b) => a - b);
      assert.deepEqual(offsets, sorted, \`flush \${i + 1} holds partition \${partition} out of order: \${JSON.stringify(offsets)} — keep the records in delivery order\`);
    }
  });
}

export async function check_batch_wait(ctx) {
  seed(ctx, 70);
  const rec = recorder(ctx);
  const m = ctx.load('batch_consumer');
  await run(ctx, m, rec.flush);
  const sizes = rec.flushes.map(f => f.length);
  assert.deepEqual(sizes, [50, 20], \`70 records must flush as [50, 20] — the 20 once 500 ms pass with nothing new; got \${JSON.stringify(sizes)}\`);
  assert.equal(rec.commits.length, 2, \`expected one commit per batch (2), got \${rec.commits.length}\`);
  // Measured from the previous commit (the batch starts right after it); a few real ms of slack.
  const elapsed = rec.commits[1].at - rec.commits[0].at;
  assert(elapsed >= 490 && elapsed < 750, \`the trailing batch must flush and commit 500 ms after it started, not \${Math.round(elapsed)} ms later\`);
}

export async function check_commit_offsets(ctx) {
  seed(ctx, 55, i => (i < 50 ? 1 : 2));
  const rec = recorder(ctx);
  const m = ctx.load('batch_consumer');
  await run(ctx, m, rec.flush);
  assert.equal(rec.flushes.length, 2, \`55 records on partitions 1 and 2 must flush as two batches, got \${JSON.stringify(rec.flushes.map(f => f.length))}\`);
  assert.equal(rec.commits.length, rec.flushes.length, \`expected one commit per flush (\${rec.flushes.length}), got \${rec.commits.length}\`);
  rec.flushes.forEach((flush, i) => {
    const {group, offsets} = rec.commits[i];
    assert.equal(group, GROUP, \`commit \${i + 1} came from group \${JSON.stringify(group)}, expected \${JSON.stringify(GROUP)}\`);
    const expected = expectedCommit(flush);
    assert.deepEqual(offsets, expected, \`commit \${i + 1} must be the batch's highest offset + 1 per partition it touched, \${JSON.stringify(expected)}; got \${JSON.stringify(offsets)}\`);
  });
  assert(ctx.kafka.committedOffset(GROUP, TOPIC, 1) === 50 && ctx.kafka.committedOffset(GROUP, TOPIC, 2) === 5, 'after both batches partition 1 must be committed at 50 and partition 2 at 5');
  assert.equal(ctx.kafka.committedOffset(GROUP, TOPIC, 0), null, 'partition 0 had no records: it must not appear in any commit');
}

export async function check_no_empty_flush(ctx) {
  seed(ctx, 50);
  const rec = recorder(ctx);
  const m = ctx.load('batch_consumer');
  await run(ctx, m, rec.flush);
  assert(rec.flushes.every(f => f.length > 0), \`flush was called with an empty batch: flushes of sizes \${JSON.stringify(rec.flushes.map(f => f.length))}\`);
  assert.equal(rec.flushes.length, 1, \`exactly 50 records then silence must flush once, got \${rec.flushes.length} flushes\`);
  assert.equal(rec.commits.length, 1, \`one batch, one commit: got \${rec.commits.length} commits\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/segmentio/kafka-go"
	"leetbuild/harness"
)

const rollupGroup, metricsTopic = "rollup", "metrics"

func seedMetrics(ctx *harness.Ctx, n int, partition func(int) int) {
	for i := range n {
		host := fmt.Sprintf("host-%d", i)
		ctx.Kafka.SeedPartition(metricsTopic, partition(i), host, fmt.Sprintf("{%q:%q,%q:%d}", "host", host, "cpu", i))
	}
}

func roundRobin3(i int) int { return i % 3 }

// metricPlace is a flushed record: its partition and offset.
type metricPlace struct {
	partition int
	offset    int64
}

type rollupCommit struct {
	group   string
	offsets map[string]int64
	at      int64
}

// rollupRecorder is what the learner's loop did: every flush as places, every commit with the clock
// at that moment, and their order.
type rollupRecorder struct {
	flushes [][]metricPlace
	commits []rollupCommit
	log     []string
}

func (rec *rollupRecorder) flush(records []kafka.Message) error {
	places := make([]metricPlace, 0, len(records))
	for _, r := range records {
		places = append(places, metricPlace{r.Partition, r.Offset})
	}
	rec.flushes = append(rec.flushes, places)
	rec.log = append(rec.log, fmt.Sprintf("flush %d", len(records)))
	return nil
}

func (rec *rollupRecorder) sizes() []int {
	sizes := []int{}
	for _, f := range rec.flushes {
		sizes = append(sizes, len(f))
	}
	return sizes
}

func recordRollup(ctx *harness.Ctx) *rollupRecorder {
	rec := &rollupRecorder{}
	ctx.Kafka.OnCommit(func(group string, offsets harness.KafkaOffsets) {
		byKey := map[string]int64{}
		for tp, o := range offsets {
			byKey[tp.String()] = o
		}
		rec.commits = append(rec.commits, rollupCommit{group, byKey, ctx.Clock.Now()})
		rec.log = append(rec.log, "commit")
	})
	return rec
}

// runRollup runs the learner's loop over everything seeded, then 2 s of silence: a window still
// open closes on the way, and the operator stops the loop.
func runRollup(ctx *harness.Ctx, rec *rollupRecorder) {
	c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ctx.Drain(func() { _ = run(c, rec.flush) })
}

func expectedRollupCommit(flush []metricPlace) map[string]int64 {
	last := map[string]int64{}
	for _, p := range flush {
		key := fmt.Sprintf("%s|%d", metricsTopic, p.partition)
		last[key] = max(last[key], p.offset+1)
	}
	return last
}

func CheckGroup(ctx *harness.Ctx) {
	seedMetrics(ctx, 50, roundRobin3)
	rec := recordRollup(ctx)
	runRollup(ctx, rec)
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	ctx.Assert(len(subscriptions) > 0, "the consumer must subscribe to a topic")
	last := subscriptions[len(subscriptions)-1]
	ctx.Equal(last.Group, rollupGroup, "GroupID must be %s", rollupGroup)
	ctx.Assert(slices.Contains(last.Topics, metricsTopic), "the consumer must read %s, got %q", metricsTopic, last.Topics)
	consumers := ctx.Kafka.Consumers()
	ctx.Assert(len(consumers) > 0 && !consumers[len(consumers)-1].AutoCommit, "auto-commit is on (ReadMessage or a CommitInterval): offsets would be committed as read, not once per flushed batch")
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "offsets were auto-committed")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened after the flush")
	lag := ctx.Kafka.Lag(rollupGroup, metricsTopic)
	ctx.Equal(lag, 0, "%d flushed record(s) are not committed", lag)
}

func CheckBatchSize(ctx *harness.Ctx) {
	seedMetrics(ctx, 120, roundRobin3)
	rec := recordRollup(ctx)
	runRollup(ctx, rec)
	ctx.Equal(rec.sizes(), []int{50, 50, 20}, "120 records must flush as [50, 50, 20]")
	ctx.Equal(rec.log, []string{"flush 50", "commit", "flush 50", "commit", "flush 20", "commit"}, "expected flush, commit, flush, commit, flush, commit — one commit right after each flush")
	seen := map[metricPlace]bool{}
	total := 0
	for _, f := range rec.flushes {
		for _, p := range f {
			seen[p] = true
			total++
		}
	}
	ctx.Equal(len(seen), total, "a record was flushed twice: the batch must start empty after a flush; distinct records flushed")
	missing := 0
	seeded := ctx.Kafka.Records(metricsTopic)
	for _, r := range seeded {
		if !seen[metricPlace{r.Partition, r.Offset}] {
			missing++
		}
	}
	ctx.Equal(len(seeded)-missing, len(seeded), "%d seeded record(s) never reached flush; seeded records flushed", missing)
	for i, f := range rec.flushes {
		partitions := []int{}
		for _, p := range f {
			if !slices.Contains(partitions, p.partition) {
				partitions = append(partitions, p.partition)
			}
		}
		for _, partition := range partitions {
			offsets := []int64{}
			for _, p := range f {
				if p.partition == partition {
					offsets = append(offsets, p.offset)
				}
			}
			ctx.Assert(sort.SliceIsSorted(offsets, func(a, b int) bool { return offsets[a] < offsets[b] }), "flush %d holds partition %d out of order: %v — keep the records in delivery order", i+1, partition, offsets)
		}
	}
}

func CheckBatchWait(ctx *harness.Ctx) {
	seedMetrics(ctx, 70, roundRobin3)
	rec := recordRollup(ctx)
	runRollup(ctx, rec)
	ctx.Equal(rec.sizes(), []int{50, 20}, "70 records must flush as [50, 20] — the 20 once 500 ms pass with nothing new")
	ctx.Equal(len(rec.commits), 2, "expected one commit per batch")
	// Measured from the previous commit (the batch starts right after it); a few real ms of slack.
	elapsed := rec.commits[1].at - rec.commits[0].at
	ctx.Assert(elapsed >= 490 && elapsed < 750, "the trailing batch must flush and commit 500 ms after it started, not %d ms later", elapsed)
}

func CheckCommitOffsets(ctx *harness.Ctx) {
	seedMetrics(ctx, 55, func(i int) int {
		if i < 50 {
			return 1
		}
		return 2
	})
	rec := recordRollup(ctx)
	runRollup(ctx, rec)
	ctx.Equal(len(rec.flushes), 2, "55 records on partitions 1 and 2 must flush as two batches, got sizes %v; batches", rec.sizes())
	ctx.Equal(len(rec.commits), len(rec.flushes), "expected one commit per flush")
	for i, flush := range rec.flushes {
		commit := rec.commits[i]
		ctx.Equal(commit.group, rollupGroup, "commit %d came from the wrong group", i+1)
		ctx.Equal(commit.offsets, expectedRollupCommit(flush), "commit %d must be the batch's highest offset + 1 per partition it touched", i+1)
	}
	ctx.Assert(ctx.Kafka.CommittedOffset(rollupGroup, metricsTopic, 1) == 50 && ctx.Kafka.CommittedOffset(rollupGroup, metricsTopic, 2) == 5, "after both batches partition 1 must be committed at 50 and partition 2 at 5")
	ctx.Equal(ctx.Kafka.CommittedOffset(rollupGroup, metricsTopic, 0), -1, "partition 0 had no records: it must not appear in any commit (-1: no committed offset)")
}

func CheckNoEmptyFlush(ctx *harness.Ctx) {
	seedMetrics(ctx, 50, roundRobin3)
	rec := recordRollup(ctx)
	runRollup(ctx, rec)
	for _, f := range rec.flushes {
		ctx.Assert(len(f) > 0, "flush was called with an empty batch: flushes of sizes %v", rec.sizes())
	}
	ctx.Equal(len(rec.flushes), 1, "exactly 50 records then silence must flush once; flushes")
	ctx.Equal(len(rec.commits), 1, "one batch, one commit; commits")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cstdint>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace {

const std::string rollupGroup = "rollup";
const std::string metricsTopic = "metrics";

void seedMetrics(harness::Ctx& ctx, int n, const std::function<int(int)>& partition) {
  for (int i = 0; i < n; i++) {
    const std::string host = "host-" + std::to_string(i);
    ctx.Kafka.SeedPartition(metricsTopic, partition(i), host,
                            R"({"host":")" + host + R"(","cpu":)" + std::to_string(i) + "}");
  }
}

int roundRobin3(int i) { return i % 3; }

// metricPlace is a flushed record: its partition and offset.
using metricPlace = std::pair<int, int64_t>;

struct rollupCommit {
  std::string group;
  std::map<std::string, int64_t> offsets;
  int64_t at;
};

// rollupRecorder is what the learner's loop did: every flush as places, every commit with the clock
// at that moment, and their order.
struct rollupRecorder {
  std::vector<std::vector<metricPlace>> flushes;
  std::vector<rollupCommit> commits;
  std::vector<std::string> log;

  void flush(const Batch& records) {
    std::vector<metricPlace> places;
    for (const auto& r : records) places.emplace_back(r->partition(), r->offset());
    flushes.push_back(places);
    log.push_back("flush " + std::to_string(records.size()));
  }

  std::vector<int> sizes() const {
    std::vector<int> out;
    for (const auto& f : flushes) out.push_back(static_cast<int>(f.size()));
    return out;
  }
};

void recordRollup(harness::Ctx& ctx, rollupRecorder& rec) {
  ctx.Kafka.OnCommit([&ctx, &rec](const std::string& group, const harness::KafkaOffsets& offsets) {
    std::map<std::string, int64_t> byKey;
    for (const auto& [tp, o] : offsets) byKey[tp.String()] = o;
    rec.commits.push_back({group, byKey, ctx.Clock.Now()});
    rec.log.push_back("commit");
  });
}

// runRollup runs the learner's loop over everything seeded, until it waits for records that will not
// come: a window still open closes on the way.
void runRollup(harness::Ctx& ctx, rollupRecorder& rec) {
  ctx.Drain([&] { run([&](const Batch& batch) { rec.flush(batch); }); });
}

std::map<std::string, int64_t> expectedRollupCommit(const std::vector<metricPlace>& flush) {
  std::map<std::string, int64_t> last;
  for (const auto& [partition, offset] : flush) {
    const std::string key = metricsTopic + "|" + std::to_string(partition);
    last[key] = std::max(last[key], offset + 1);
  }
  return last;
}

}  // namespace

void CheckGroup(harness::Ctx& ctx) {
  seedMetrics(ctx, 50, roundRobin3);
  rollupRecorder rec;
  recordRollup(ctx, rec);
  runRollup(ctx, rec);
  const auto subscriptions = ctx.Kafka.EventsOf("subscribe");
  ctx.Assert(!subscriptions.empty(), "the consumer must subscribe to a topic");
  const auto& last = subscriptions.back();
  ctx.Equal(last.Group, rollupGroup, "group.id must be %s", rollupGroup);
  ctx.Assert(std::find(last.Topics.begin(), last.Topics.end(), metricsTopic) != last.Topics.end(),
             "the consumer must read %s, got %q", metricsTopic, last.Topics);
  const auto consumers = ctx.Kafka.Consumers();
  ctx.Assert(!consumers.empty() && !consumers.back().AutoCommit,
             "auto-commit is on (enable.auto.commit): offsets would be committed as read, not once per flushed batch");
  ctx.Assert(ctx.Kafka.EventsOf("auto-commit").empty(), "offsets were auto-committed");
  ctx.Assert(!ctx.Kafka.EventsOf("manual-commit").empty(), "no explicit commit happened after the flush");
  const int64_t lag = ctx.Kafka.Lag(rollupGroup, metricsTopic);
  ctx.Equal(lag, 0, "%d flushed record(s) are not committed", lag);
}

void CheckBatchSize(harness::Ctx& ctx) {
  seedMetrics(ctx, 120, roundRobin3);
  rollupRecorder rec;
  recordRollup(ctx, rec);
  runRollup(ctx, rec);
  ctx.Equal(rec.sizes(), {50, 50, 20}, "120 records must flush as [50, 50, 20]");
  ctx.Equal(rec.log, {"flush 50", "commit", "flush 50", "commit", "flush 20", "commit"},
            "expected flush, commit, flush, commit, flush, commit — one commit right after each flush");
  std::set<metricPlace> seen;
  size_t total = 0;
  for (const auto& f : rec.flushes) {
    for (const auto& p : f) {
      seen.insert(p);
      total++;
    }
  }
  ctx.Equal(seen.size(), total, "a record was flushed twice: the batch must start empty after a flush; distinct records flushed");
  size_t missing = 0;
  const auto seeded = ctx.Kafka.Records(metricsTopic);
  for (const auto& r : seeded)
    if (!seen.count({r.Partition, r.Offset})) missing++;
  ctx.Equal(seeded.size() - missing, seeded.size(), "%d seeded record(s) never reached flush; seeded records flushed", missing);
  for (size_t i = 0; i < rec.flushes.size(); i++) {
    const auto& f = rec.flushes[i];
    std::vector<int> partitions;
    for (const auto& p : f)
      if (std::find(partitions.begin(), partitions.end(), p.first) == partitions.end()) partitions.push_back(p.first);
    for (const int partition : partitions) {
      std::vector<int64_t> offsets;
      for (const auto& p : f)
        if (p.first == partition) offsets.push_back(p.second);
      ctx.Assert(std::is_sorted(offsets.begin(), offsets.end()),
                 "flush %d holds partition %d out of order: %v — keep the records in delivery order", i + 1, partition,
                 offsets);
    }
  }
}

void CheckBatchWait(harness::Ctx& ctx) {
  seedMetrics(ctx, 70, roundRobin3);
  rollupRecorder rec;
  recordRollup(ctx, rec);
  runRollup(ctx, rec);
  ctx.Equal(rec.sizes(), {50, 20}, "70 records must flush as [50, 20] — the 20 once 500 ms pass with nothing new");
  ctx.Equal(rec.commits.size(), 2, "expected one commit per batch");
  // Measured from the previous commit (the batch starts right after it); a few real ms of slack.
  const int64_t elapsed = rec.commits[1].at - rec.commits[0].at;
  ctx.Assert(elapsed >= 490 && elapsed < 750, "the trailing batch must flush and commit 500 ms after it started, not %d ms later", elapsed);
}

void CheckCommitOffsets(harness::Ctx& ctx) {
  seedMetrics(ctx, 55, [](int i) { return i < 50 ? 1 : 2; });
  rollupRecorder rec;
  recordRollup(ctx, rec);
  runRollup(ctx, rec);
  ctx.Equal(rec.flushes.size(), 2, "55 records on partitions 1 and 2 must flush as two batches, got sizes %v; batches", rec.sizes());
  ctx.Equal(rec.commits.size(), rec.flushes.size(), "expected one commit per flush");
  for (size_t i = 0; i < rec.flushes.size(); i++) {
    const auto& commit = rec.commits[i];
    ctx.Equal(commit.group, rollupGroup, "commit %d came from the wrong group", i + 1);
    ctx.Equal(commit.offsets, expectedRollupCommit(rec.flushes[i]),
              "commit %d must be the batch's highest offset + 1 per partition it touched", i + 1);
  }
  ctx.Assert(ctx.Kafka.CommittedOffset(rollupGroup, metricsTopic, 1) == 50 &&
                 ctx.Kafka.CommittedOffset(rollupGroup, metricsTopic, 2) == 5,
             "after both batches partition 1 must be committed at 50 and partition 2 at 5");
  ctx.Equal(ctx.Kafka.CommittedOffset(rollupGroup, metricsTopic, 0), -1,
            "partition 0 had no records: it must not appear in any commit (-1: no committed offset)");
}

void CheckNoEmptyFlush(harness::Ctx& ctx) {
  seedMetrics(ctx, 50, roundRobin3);
  rollupRecorder rec;
  recordRollup(ctx, rec);
  runRollup(ctx, rec);
  for (const auto& f : rec.flushes) ctx.Assert(!f.empty(), "flush was called with an empty batch: flushes of sizes %v", rec.sizes());
  ctx.Equal(rec.flushes.size(), 1, "exactly 50 records then silence must flush once; flushes");
  ctx.Equal(rec.commits.size(), 1, "one batch, one commit; commits");
}
`,
  },
  debrief: `The batch is closed by whichever of two conditions comes first because each bounds a different thing: the count bounds how much one sink call carries (and how much is at risk between flush and commit), the clock bounds how stale the sink may be when the stream is quiet. The commit is built from the batch itself — one offset per partition the batch touched, the highest + 1 — so a partition the batch never saw is left alone and a crash after the flush replays at most one batch: at-least-once, batch-granular. \`consume(n, timeout)\` is that loop in one call in librdkafka; kafkajs's real client has \`eachBatch\`, but assembling the batch across \`eachMessage\` with a timer is what every "window by count or time" looks like inside a connector. Production versions add: commit what you hold when a partition is revoked (\`on_revoke\`), pause the partition when the sink is slow instead of blowing \`max.poll.interval.ms\`, retry or dead-letter a failed flush rather than crash-loop on it, and size the batch in bytes as well as records.`,
};
