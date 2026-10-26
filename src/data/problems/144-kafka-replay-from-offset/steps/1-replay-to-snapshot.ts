import type {Step} from '@/lib/types';

export const replayToSnapshotStep: Step = {
  id: 'replay-to-snapshot',
  title: 'Replay from an offset to a snapshot of the end, committing nothing',
  concept: 'kafka',
  file: 'replay_tool',
  focus: ['tool', 'kafka'],
  task: `## Task

Implement \`replay(topic, from_offset, handler)\`: a stand-alone consumer that rewinds every partition of
\`topic\` to \`from_offset\`, hands every record from there up to a **snapshot of the end** to \`handler\`,
and returns how many it handled. Every topic in this drill has \`PARTITIONS\` = 3 partitions.

- **Snapshot first.** Before reading anything, capture each partition's end offset from the broker:
  \`get_watermark_offsets(TopicPartition(topic, p))\` in Python (the \`high\` watermark),
  \`admin.fetchTopicOffsets(topic)\` in kafkajs (\`high\`). That snapshot is where the replay stops —
  records appended while it runs are **not** handled; they are the next replay's business.
- **Stand-alone.** A fresh consumer per call with \`group.id\` \`replay-tool\` and auto-commit **off**:
  Python \`assign\`s \`TopicPartition(topic, p, from_offset)\` for every partition (no \`subscribe\`);
  kafkajs \`subscribe\`s then \`seek\`s every partition to \`from_offset\`. \`0\` means the beginning.
  **Never commit**: not explicitly, not on a timer, not on close. The live group's committed offsets
  are untouched.
- **Bounded.** Track each partition's position; a record at or past its snapshot is skipped, a partition
  that has reached its snapshot is \`pause\`d, and the loop ends when every partition has. A partition whose
  snapshot is at or below \`from_offset\` contributes nothing.
- \`handler\` receives a \`ReplayRecord\` — \`partition\`, \`offset\`, \`key\`, \`value\` (text, \`None\`/\`null\`
  when absent) — in each partition's offset order. The return value is exactly the number of calls.

:::widget consumer-groups {"partitions": 3}

> A replay is a read with two fixed ends: the offset you chose and the end that existed when you
> started. Everything in between is the job; nothing outside it — not the records that keep arriving,
> not the live group's bookmarks — is touched.`,
  sequence: {
    participants: ['replay tool', 'Kafka'],
    messages: [
      {from: 'replay tool', to: 'Kafka', label: 'watermarks for order-events[0..2]', kind: 'sync'},
      {from: 'Kafka', to: 'replay tool', label: 'high = {0: 4, 1: 2, 2: 3}', kind: 'reply'},
      {from: 'replay tool', to: 'Kafka', label: 'assign [0..2] at offset 1 (group replay-tool)', kind: 'sync'},
      {from: 'replay tool', to: 'Kafka', label: 'poll', kind: 'sync'},
      {from: 'Kafka', to: 'replay tool', label: 'order-events[1]@1 → handler', kind: 'reply'},
      {from: 'replay tool', to: 'Kafka', label: 'pause [1] (reached 2)', kind: 'async'},
      {from: 'Kafka', to: 'replay tool', label: '[0]@1 … [0]@3, [2]@1, [2]@2 → handler', kind: 'reply'},
      {from: 'replay tool', to: 'Kafka', label: 'close — no commit', kind: 'async'},
    ],
  },
  hints: [
    'Three maps of partition → offset: `end` from the watermarks (taken before anything else), `position` starting at `from_offset`, and a loop that runs while any `position[p] < end[p]`.',
    'In the loop, advance `position[p]` to `offset + 1` for every record you get, call the handler only when `offset < end[p]`, and pause the partition once `position[p] >= end[p]`.',
    'The group id and `enable.auto.commit: false` / `autoCommit: false` go on the consumer; `assign` (Python) or `subscribe` + `seek` (kafkajs) replaces the group’s bookmarks with your own starting offsets, and the file never calls `commit`.',
  ],
  checks: [
    {
      id: 'replays-in-order',
      title: 'Handles every record from the offset, in partition order',
      detail:
        'With `from_offset` 0 every record of every partition reaches the handler, in offset order within each partition, and the return value is their number.',
      match: {
        python: {all: [/TopicPartition\(topic, p, from_offset\)/, /handler\(ReplayRecord\(/]},
        typescript: {
          all: [/consumer\.seek\(\{topic, partition: p, offset: String\(fromOffset\)\}\)/, /await handler\(\{/],
        },
        go: {all: [/reader\.SetOffset\(fromOffset\)/, /handler\(ReplayRecord\{/]},
        scala: {all: [/consumer\.seek\(tp, fromOffset\)/, /handler\(ReplayRecord\(/]},
        cpp: {all: [/RdKafka::TopicPartition::create\(topic, p, from_offset\)/, /handler\(ReplayRecord\{/]},
      },
    },
    {
      id: 'snapshot-end',
      title: 'Stops at the end captured before the replay started',
      detail:
        'The end offsets are read from the broker before the first record is fetched; records appended to the topic while the replay runs are not handled and not counted.',
      match: {
        python: {
          order: [/consumer\.get_watermark_offsets\(TopicPartition\(topic, p\)\)/, /consumer\.poll\(/],
          all: [/< end\[/],
        },
        typescript: {order: [/admin\.fetchTopicOffsets\(topic\)/, /consumer\.run\(\{/], all: [/< end\[/]},
        go: {order: [/conn\.ReadLastOffset\(\)/, /reader\.FetchMessage\(ctx\)/], all: [/< end\[p\]/]},
        scala: {order: [/consumer\.endOffsets\(/, /consumer\.poll\(/], all: [/< end\(/]},
        cpp: {
          order: [/consumer->query_watermark_offsets\(topic, p, &low, &high/, /consumer->consume\(/],
          all: [/< end\[/],
        },
      },
    },
    {
      id: 'no-commits',
      title: 'Commits nothing, in group replay-tool with auto-commit off',
      detail:
        'The consumer joins no live group: `group.id` is `replay-tool`, auto-commit is disabled, no commit is issued, and the live group’s committed offsets are the same after the replay as before.',
      match: {
        python: {
          all: [/"group\.id":\s*GROUP/, /"enable\.auto\.commit":\s*False/],
          none: [/\.commit\(/, /store_offsets\(/, /\.subscribe\(/],
        },
        typescript: {all: [/groupId:\s*GROUP/, /autoCommit:\s*false/], none: [/commitOffsets\(/]},
        go: {all: [/Partition:\s*p,/], none: [/GroupID/, /CommitMessages\(/, /ReadMessage\(/]},
        scala: {
          all: [/"group\.id",\s*Group/, /"enable\.auto\.commit",\s*"false"/],
          none: [/commitSync\(/, /commitAsync\(/, /\.subscribe\(/],
        },
        cpp: {
          all: [/"group\.id",\s*kGroup/, /"enable\.auto\.commit",\s*"false"/],
          none: [/commitSync\(/, /commitAsync\(/, /->subscribe\(/],
        },
      },
    },
    {
      id: 'from-offset',
      title: 'Skips everything before from_offset',
      detail:
        'Replaying from offset 2 handles only records at offsets 2 and above in every partition; a partition shorter than that contributes nothing, and a `from_offset` beyond every end returns 0 without calling the handler.',
      match: {
        python: {all: [/position = \{p: from_offset for p in range\(PARTITIONS\)\}/, /consumer\.pause\(/]},
        typescript: {
          all: [/position\[p\] = fromOffset;/, /consumer\.pause\(\[\{topic, partitions: \[partition\]\}\]\)/],
        },
        go: {all: [/if fromOffset >= end\[p\]/, /msg\.Offset\+1 >= end\[p\]/]},
        scala: {all: [/tp\.partition -> fromOffset/, /consumer\.pause\(/]},
        cpp: {all: [/position\[p\] = from_offset;/, /consumer->pause\(/]},
      },
    },
    {
      id: 'independent',
      title: 'Each replay is a fresh consumer',
      detail:
        'A second call starts over from its own `from_offset` and its own snapshot: records appended between the two replays are handled by the second one, and the first replay’s position never leaks into it. The consumer is closed when the call returns.',
      match: {
        python: {order: [/def replay\(/, /consumer = Consumer\(/, /consumer\.close\(\)/]},
        typescript: {
          order: [
            /export async function replay\(/,
            /const consumer = kafka\.consumer\(\{/,
            /await consumer\.disconnect\(\)/,
          ],
        },
        go: {order: [/func replay\(/, /kafka\.NewReader\(/, /reader\.Close\(\)/]},
        scala: {order: [/def replay\(/, /new KafkaConsumer\[String, String\]\(/, /consumer\.close\(\)/]},
        cpp: {order: [/int replay\(/, /RdKafka::KafkaConsumer::create\(/, /consumer->close\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""A replay tool: rewind a topic to an offset and read to a snapshot of its end, committing nothing."""
from dataclasses import dataclass
from typing import Callable

from confluent_kafka import Consumer, TopicPartition

PARTITIONS = 3
GROUP = "replay-tool"


@dataclass(frozen=True)
class ReplayRecord:
    partition: int
    offset: int
    key: str | None
    value: str | None


def _text(raw: bytes | None) -> str | None:
    return None if raw is None else raw.decode()


def replay(topic: str, from_offset: int, handler: Callable[[ReplayRecord], None]) -> int:
    """Hand every record of \`topic\` from \`from_offset\` up to the end as of now to \`handler\`; return the count."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP})
    # TODO: disable auto-commit; this consumer never commits
    # TODO: capture every partition's high watermark before reading anything
    # TODO: assign every partition at from_offset (no subscribe)
    # TODO: poll; track positions; handler() only below the snapshot; pause finished partitions; stop when all are
    # TODO: close the consumer; return how many records were handled
    raise NotImplementedError
`,
      solution: `"""A replay tool: rewind a topic to an offset and read to a snapshot of its end, committing nothing."""
from dataclasses import dataclass
from typing import Callable

from confluent_kafka import Consumer, TopicPartition

PARTITIONS = 3
GROUP = "replay-tool"


@dataclass(frozen=True)
class ReplayRecord:
    partition: int
    offset: int
    key: str | None
    value: str | None


def _text(raw: bytes | None) -> str | None:
    return None if raw is None else raw.decode()


def replay(topic: str, from_offset: int, handler: Callable[[ReplayRecord], None]) -> int:
    """Hand every record of \`topic\` from \`from_offset\` up to the end as of now to \`handler\`; return the count."""
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": GROUP,
            "enable.auto.commit": False,
        }
    )
    try:
        # The snapshot: where every partition ends right now. Anything appended later is out of scope.
        end = {p: consumer.get_watermark_offsets(TopicPartition(topic, p))[1] for p in range(PARTITIONS)}
        consumer.assign([TopicPartition(topic, p, from_offset) for p in range(PARTITIONS)])
        position = {p: from_offset for p in range(PARTITIONS)}
        for p in range(PARTITIONS):
            if position[p] >= end[p]:
                consumer.pause([TopicPartition(topic, p)])
        handled = 0
        while any(position[p] < end[p] for p in range(PARTITIONS)):
            msg = consumer.poll(1.0)
            if msg is None or msg.error():
                continue
            p = msg.partition()
            position[p] = msg.offset() + 1
            if msg.offset() < end[p]:
                handler(ReplayRecord(p, msg.offset(), _text(msg.key()), _text(msg.value())))
                handled += 1
            if position[p] >= end[p]:
                consumer.pause([TopicPartition(topic, p)])
        return handled
    finally:
        consumer.close()
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

const PARTITIONS = 3;
const GROUP = 'replay-tool';
const kafka = new Kafka({clientId: 'replay-tool', brokers: ['kafka:9092']});

export interface ReplayRecord {
  partition: number;
  offset: number;
  key: string | null;
  value: string | null;
}

/** Hand every record of \`topic\` from \`fromOffset\` up to the end as of now to \`handler\`; resolve with the count. */
export async function replay(
  topic: string,
  fromOffset: number,
  handler: (record: ReplayRecord) => void | Promise<void>,
): Promise<number> {
  // TODO: capture every partition's high watermark (admin.fetchTopicOffsets) before reading anything
  // TODO: a fresh consumer in group GROUP; subscribe from the beginning; seek every one of the PARTITIONS to fromOffset
  // TODO: run with auto-commit off; track positions; handler() only below the snapshot; pause finished partitions; stop when all are
  // TODO: disconnect; resolve with how many records were handled
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';

const PARTITIONS = 3;
const GROUP = 'replay-tool';
const kafka = new Kafka({clientId: 'replay-tool', brokers: ['kafka:9092']});

export interface ReplayRecord {
  partition: number;
  offset: number;
  key: string | null;
  value: string | null;
}

/** Hand every record of \`topic\` from \`fromOffset\` up to the end as of now to \`handler\`; resolve with the count. */
export async function replay(
  topic: string,
  fromOffset: number,
  handler: (record: ReplayRecord) => void | Promise<void>,
): Promise<number> {
  // The snapshot: where every partition ends right now. Anything appended later is out of scope.
  const admin = kafka.admin();
  await admin.connect();
  const end: number[] = [];
  for (const {partition, high} of await admin.fetchTopicOffsets(topic)) end[partition] = Number(high);
  await admin.disconnect();

  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic, fromBeginning: true});
  const position: number[] = [];
  for (let p = 0; p < PARTITIONS; p++) {
    consumer.seek({topic, partition: p, offset: String(fromOffset)});
    position[p] = fromOffset;
    if (fromOffset >= end[p]) consumer.pause([{topic, partitions: [p]}]);
  }
  const pending = (): boolean => position.some((pos, p) => pos < end[p]);

  let handled = 0;
  if (pending())
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({partition, message}) => {
        const offset = Number(message.offset);
        position[partition] = offset + 1;
        if (offset < end[partition]) {
          await handler({
            partition,
            offset,
            key: message.key === null ? null : message.key.toString(),
            value: message.value === null ? null : message.value.toString(),
          });
          handled += 1;
        }
        if (position[partition] >= end[partition]) consumer.pause([{topic, partitions: [partition]}]);
        if (!pending()) consumer.stop();
      },
    });
  await consumer.disconnect();
  return handled;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/segmentio/kafka-go"
)

const Partitions = 3

type ReplayRecord struct {
	Partition int
	Offset    int64
	Key       []byte
	Value     []byte
}

// replay hands every record of topic from fromOffset up to the end as of now to handler and returns the count.
func replay(ctx context.Context, topic string, fromOffset int64, handler func(ReplayRecord) error) (int, error) {
	// TODO: capture every partition's last offset (DialLeader + ReadLastOffset) before reading anything
	// TODO: one Reader per partition (no GroupID: nothing to commit), SetOffset(fromOffset)
	// TODO: FetchMessage until the snapshot; handler() for each; never CommitMessages
	// TODO: close the readers; return how many records were handled
	return 0, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/segmentio/kafka-go"
)

const Partitions = 3

type ReplayRecord struct {
	Partition int
	Offset    int64
	Key       []byte
	Value     []byte
}

// replay hands every record of topic from fromOffset up to the end as of now to handler and returns the count.
func replay(ctx context.Context, topic string, fromOffset int64, handler func(ReplayRecord) error) (int, error) {
	// The snapshot: where every partition ends right now. Anything appended later is out of scope.
	end := make([]int64, Partitions)
	for p := 0; p < Partitions; p++ {
		conn, err := kafka.DialLeader(ctx, "tcp", "kafka:9092", topic, p)
		if err != nil {
			return 0, err
		}
		last, err := conn.ReadLastOffset()
		conn.Close()
		if err != nil {
			return 0, err
		}
		end[p] = last
	}

	handled := 0
	for p := 0; p < Partitions; p++ {
		if fromOffset >= end[p] {
			continue
		}
		// A partition reader has no group: it commits nothing and the live group never notices it.
		reader := kafka.NewReader(kafka.ReaderConfig{
			Brokers:   []string{"kafka:9092"},
			Topic:     topic,
			Partition: p,
		})
		if err := reader.SetOffset(fromOffset); err != nil {
			reader.Close()
			return handled, err
		}
		for {
			msg, err := reader.FetchMessage(ctx)
			if err != nil {
				reader.Close()
				return handled, err
			}
			if msg.Offset < end[p] {
				if err := handler(ReplayRecord{Partition: p, Offset: msg.Offset, Key: msg.Key, Value: msg.Value}); err != nil {
					reader.Close()
					return handled, err
				}
				handled++
			}
			if msg.Offset+1 >= end[p] {
				break
			}
		}
		reader.Close()
	}
	return handled, nil
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.jdk.CollectionConverters._

final case class ReplayRecord(partition: Int, offset: Long, key: String, value: String)

object ReplayTool {
  val Partitions = 3
  val Group = "replay-tool"

  /** Hand every record of \`topic\` from \`fromOffset\` up to the end as of now to \`handler\`; return the count. */
  def replay(topic: String, fromOffset: Long, handler: ReplayRecord => Unit): Int = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    // TODO: disable auto-commit; this consumer never commits
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    // TODO: assign every partition (no subscribe); capture endOffsets before reading anything
    // TODO: seek every partition to fromOffset
    // TODO: poll; track positions; handler() only below the snapshot; pause finished partitions; stop when all are
    // TODO: close the consumer; return how many records were handled
    0
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.jdk.CollectionConverters._

final case class ReplayRecord(partition: Int, offset: Long, key: String, value: String)

object ReplayTool {
  val Partitions = 3
  val Group = "replay-tool"

  /** Hand every record of \`topic\` from \`fromOffset\` up to the end as of now to \`handler\`; return the count. */
  def replay(topic: String, fromOffset: Long, handler: ReplayRecord => Unit): Int = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    try {
      val partitions = (0 until Partitions).map(p => new TopicPartition(topic, p))
      consumer.assign(partitions.asJava)
      // The snapshot: where every partition ends right now. Anything appended later is out of scope.
      val end = consumer.endOffsets(partitions.asJava).asScala.map { case (tp, o) => tp.partition -> o.longValue }.toMap
      partitions.foreach(tp => consumer.seek(tp, fromOffset))
      val position = scala.collection.mutable.Map(partitions.map(tp => tp.partition -> fromOffset): _*)
      val done = (p: Int) => position(p) >= end(p)
      consumer.pause(partitions.filter(tp => done(tp.partition)).asJava)
      var handled = 0
      while (partitions.exists(tp => !done(tp.partition))) {
        consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
          val p = record.partition
          position(p) = record.offset + 1
          if (record.offset < end(p)) {
            handler(ReplayRecord(p, record.offset, record.key, record.value))
            handled += 1
          }
          if (done(p)) consumer.pause(List(new TopicPartition(topic, p)).asJava)
        }
      }
      handled
    } finally consumer.close()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

constexpr int kPartitions = 3;
const std::string kGroup = "replay-tool";

struct ReplayRecord {
  int partition;
  int64_t offset;
  std::string key;
  std::string value;
};

// Hands every record of topic from from_offset up to the end as of now to handler; returns the count.
int replay(const std::string& topic, int64_t from_offset, const std::function<void(const ReplayRecord&)>& handler) {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  // TODO: disable auto-commit; this consumer never commits
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  // TODO: query_watermark_offsets for every partition before reading anything
  // TODO: assign every partition at from_offset (no subscribe)
  // TODO: consume; track positions; handler() only below the snapshot; pause finished partitions; stop when all are
  // TODO: close the consumer; return how many records were handled
  return 0;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

constexpr int kPartitions = 3;
const std::string kGroup = "replay-tool";

struct ReplayRecord {
  int partition;
  int64_t offset;
  std::string key;
  std::string value;
};

// Hands every record of topic from from_offset up to the end as of now to handler; returns the count.
int replay(const std::string& topic, int64_t from_offset, const std::function<void(const ReplayRecord&)>& handler) {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));

  // The snapshot: where every partition ends right now. Anything appended later is out of scope.
  std::map<int, int64_t> end;
  std::map<int, int64_t> position;
  std::vector<RdKafka::TopicPartition*> assignment;
  for (int p = 0; p < kPartitions; ++p) {
    int64_t low = 0, high = 0;
    consumer->query_watermark_offsets(topic, p, &low, &high, 5000);
    end[p] = high;
    position[p] = from_offset;
    assignment.push_back(RdKafka::TopicPartition::create(topic, p, from_offset));
  }
  consumer->assign(assignment);
  auto pause = [&](int p) {
    std::vector<RdKafka::TopicPartition*> one{RdKafka::TopicPartition::create(topic, p)};
    consumer->pause(one);
    RdKafka::TopicPartition::destroy(one);
  };
  auto pending = [&] {
    for (const auto& [p, pos] : position)
      if (pos < end[p]) return true;
    return false;
  };
  for (int p = 0; p < kPartitions; ++p)
    if (position[p] >= end[p]) pause(p);

  int handled = 0;
  while (pending()) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const int p = msg->partition();
    position[p] = msg->offset() + 1;
    if (msg->offset() < end[p]) {
      handler(ReplayRecord{p, msg->offset(), msg->key() ? *msg->key() : std::string(),
                           std::string(static_cast<const char*>(msg->payload()), msg->len())});
      ++handled;
    }
    if (position[p] >= end[p]) pause(p);
  }
  consumer->close();
  RdKafka::TopicPartition::destroy(assignment);
  return handled;
}
`,
    },
  },
  harness: {
    python: `TOPIC = "order-events"
LIVE = "orders"


def _seed(ctx, partition, *values):
    for value in values:
        ctx.kafka.seed(TOPIC, key=None, value=value, partition=partition)


def _by_partition(records):
    out = {}
    for r in records:
        out.setdefault(r.partition, []).append((r.offset, r.value))
    return out


def check_replays_in_order(ctx):
    _seed(ctx, 0, "a0", "a1", "a2")
    _seed(ctx, 1, "b0")
    _seed(ctx, 2, "c0", "c1")
    m = ctx.load("replay_tool")
    seen = []
    count = m.replay(TOPIC, 0, seen.append)
    assert count == 6, f"replay returned {count}, expected 6 (the number of records handled)"
    got = _by_partition(seen)
    assert got.get(0) == [(0, "a0"), (1, "a1"), (2, "a2")], f"partition 0 handled {got.get(0)}, expected offsets 0..2 in order"
    assert got.get(1) == [(0, "b0")], f"partition 1 handled {got.get(1)}, expected [(0, 'b0')]"
    assert got.get(2) == [(0, "c0"), (1, "c1")], f"partition 2 handled {got.get(2)}, expected offsets 0..1 in order"
    assert all(r.key is None for r in seen), "records seeded without a key must reach the handler with key None"


def check_snapshot_end(ctx):
    _seed(ctx, 0, "a0", "a1")
    _seed(ctx, 1, "b0")
    _seed(ctx, 2, "c0", "c1", "c2")
    m = ctx.load("replay_tool")
    seen = []

    def handler(record):
        if not seen:
            # Producers keep writing while the replay runs: one more record on every partition.
            _seed(ctx, 0, "a-late")
            _seed(ctx, 1, "b-late")
            _seed(ctx, 2, "c-late")
        seen.append(record)

    count = m.replay(TOPIC, 0, handler)
    assert ctx.kafka.end_offset(TOPIC, 0) == 3, "the harness appended a record to partition 0 mid-replay"
    late = [r.value for r in seen if r.value.endswith("-late")]
    assert not late, f"records appended after the replay started were handled: {late}; the end is a snapshot taken before the first fetch"
    assert count == 6, f"replay returned {count}, expected 6: the records that existed when it started"
    assert len(seen) == 6, f"{len(seen)} records handled, expected 6"


def check_no_commits(ctx):
    _seed(ctx, 0, "a0", "a1", "a2")
    _seed(ctx, 1, "b0", "b1")
    _seed(ctx, 2, "c0")
    # The live group is half-way through the topic.
    ctx.kafka.commit(LIVE, {(TOPIC, 0): 1, (TOPIC, 1): 2, (TOPIC, 2): 0})
    m = ctx.load("replay_tool")
    seen = []
    count = m.replay(TOPIC, 0, seen.append)
    ctx.clock.advance(30)
    assert count == 6, f"replay returned {count}, expected 6"
    for p, expected in ((0, 1), (1, 2), (2, 0)):
        got = ctx.kafka.committed_offset(LIVE, TOPIC, p)
        assert got == expected, f"group {LIVE} committed offset for partition {p} moved from {expected} to {got}: the replay must not touch the live group"
    assert ctx.kafka.commits("replay-tool") == [], f"group replay-tool committed {ctx.kafka.commits('replay-tool')}; a replay tool never commits"
    assert len(ctx.kafka.commits()) == 1, f"{len(ctx.kafka.commits()) - 1} commit(s) were made during the replay; expected none"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit fired: the replay consumer must disable enable.auto.commit"
    groups = {e[1] for e in ctx.kafka.events if e[0] == "consumer"}
    assert groups == {"replay-tool"}, f"consumers were created in groups {sorted(groups)}; expected only replay-tool"


def check_from_offset(ctx):
    _seed(ctx, 0, "a0", "a1", "a2", "a3")
    _seed(ctx, 1, "b0")
    _seed(ctx, 2, "c0", "c1", "c2")
    m = ctx.load("replay_tool")
    seen = []
    count = m.replay(TOPIC, 2, seen.append)
    got = _by_partition(seen)
    assert got.get(0) == [(2, "a2"), (3, "a3")], f"partition 0 handled {got.get(0)}, expected offsets 2 and 3 only"
    assert 1 not in got, f"partition 1 has one record (offset 0) and must contribute nothing from offset 2, handled {got.get(1)}"
    assert got.get(2) == [(2, "c2")], f"partition 2 handled {got.get(2)}, expected offset 2 only"
    assert count == 3, f"replay returned {count}, expected 3"
    beyond = []
    count = m.replay(TOPIC, 10, beyond.append)
    assert count == 0 and beyond == [], f"replay from beyond every end handled {len(beyond)} record(s) and returned {count}; expected 0"


def check_independent(ctx):
    _seed(ctx, 0, "a0", "a1")
    _seed(ctx, 1, "b0")
    m = ctx.load("replay_tool")
    first = []
    assert m.replay(TOPIC, 1, first.append) == 1, "first replay from offset 1 should handle exactly a1"
    assert [r.value for r in first] == ["a1"]
    _seed(ctx, 0, "a2")
    _seed(ctx, 2, "c0")
    second = []
    count = m.replay(TOPIC, 0, second.append)
    assert count == 5, f"second replay from 0 returned {count}, expected 5: it starts over and sees the records appended since the first"
    got = _by_partition(second)
    assert got.get(0) == [(0, "a0"), (1, "a1"), (2, "a2")], f"partition 0 handled {got.get(0)} in the second replay; expected offsets 0..2"
    assert got.get(2) == [(0, "c0")], f"partition 2 handled {got.get(2)} in the second replay; expected [(0, 'c0')]"
    assert ctx.kafka.commits() == [], "neither replay may commit"
    assert all(e[0] != "close" or e[1] == "replay-tool" for e in ctx.kafka.events)
    assert sum(1 for e in ctx.kafka.events if e[0] == "close") == 2, "each replay creates and closes its own consumer"
`,
    typescript: `const TOPIC = 'order-events';
const LIVE = 'orders';

interface Seen {
  partition: number;
  offset: number;
  key: string | null;
  value: string | null;
}

function seed(ctx, partition: number, ...values: string[]) {
  for (const value of values) ctx.kafka.seed(TOPIC, {value, partition});
}

function byPartition(records: Seen[]): Record<number, [number, string | null][]> {
  const out: Record<number, [number, string | null][]> = {};
  for (const r of records) (out[r.partition] ??= []).push([r.offset, r.value]);
  return out;
}

export async function check_replays_in_order(ctx) {
  seed(ctx, 0, 'a0', 'a1', 'a2');
  seed(ctx, 1, 'b0');
  seed(ctx, 2, 'c0', 'c1');
  const m = ctx.load('replay_tool');
  const seen: Seen[] = [];
  const count = await m.replay(TOPIC, 0, (r: Seen) => void seen.push(r));
  assert.equal(count, 6, \`replay returned \${count}, expected 6 (the number of records handled)\`);
  const got = byPartition(seen);
  assert.deepEqual(got[0], [[0, 'a0'], [1, 'a1'], [2, 'a2']], \`partition 0 handled \${JSON.stringify(got[0])}, expected offsets 0..2 in order\`);
  assert.deepEqual(got[1], [[0, 'b0']], \`partition 1 handled \${JSON.stringify(got[1])}, expected [[0, 'b0']]\`);
  assert.deepEqual(got[2], [[0, 'c0'], [1, 'c1']], \`partition 2 handled \${JSON.stringify(got[2])}, expected offsets 0..1 in order\`);
  assert(seen.every(r => r.key === null), 'records seeded without a key must reach the handler with key null');
}

export async function check_snapshot_end(ctx) {
  seed(ctx, 0, 'a0', 'a1');
  seed(ctx, 1, 'b0');
  seed(ctx, 2, 'c0', 'c1', 'c2');
  const m = ctx.load('replay_tool');
  const seen: Seen[] = [];
  const count = await m.replay(TOPIC, 0, (r: Seen) => {
    if (seen.length === 0) {
      // Producers keep writing while the replay runs: one more record on every partition.
      seed(ctx, 0, 'a-late');
      seed(ctx, 1, 'b-late');
      seed(ctx, 2, 'c-late');
    }
    seen.push(r);
  });
  assert.equal(ctx.kafka.endOffset(TOPIC, 0), 3, 'the harness appended a record to partition 0 mid-replay');
  const late = seen.filter(r => r.value?.endsWith('-late')).map(r => r.value);
  assert.equal(late.length, 0, \`records appended after the replay started were handled: \${JSON.stringify(late)}; the end is a snapshot taken before the first fetch\`);
  assert.equal(count, 6, \`replay returned \${count}, expected 6: the records that existed when it started\`);
  assert.equal(seen.length, 6, \`\${seen.length} records handled, expected 6\`);
}

export async function check_no_commits(ctx) {
  seed(ctx, 0, 'a0', 'a1', 'a2');
  seed(ctx, 1, 'b0', 'b1');
  seed(ctx, 2, 'c0');
  // The live group is half-way through the topic.
  ctx.kafka.commit(LIVE, new Map([[\`\${TOPIC}|0\`, 1], [\`\${TOPIC}|1\`, 2], [\`\${TOPIC}|2\`, 0]]));
  const m = ctx.load('replay_tool');
  const seen: Seen[] = [];
  const count = await m.replay(TOPIC, 0, (r: Seen) => void seen.push(r));
  ctx.clock.advance(30);
  assert.equal(count, 6, \`replay returned \${count}, expected 6\`);
  for (const [p, expected] of [[0, 1], [1, 2], [2, 0]] as const) {
    const got = ctx.kafka.committedOffset(LIVE, TOPIC, p);
    assert.equal(got, expected, \`group \${LIVE} committed offset for partition \${p} moved from \${expected} to \${got}: the replay must not touch the live group\`);
  }
  assert.deepEqual(ctx.kafka.commits('replay-tool'), [], \`group replay-tool committed \${JSON.stringify(ctx.kafka.commits('replay-tool'))}; a replay tool never commits\`);
  assert.equal(ctx.kafka.commits().length, 1, \`\${ctx.kafka.commits().length - 1} commit(s) were made during the replay; expected none\`);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit fired: the replay consumer must run with autoCommit: false');
  const groups = new Set(ctx.kafka.events.filter(e => e[0] === 'consumer').map(e => e[1]));
  assert.deepEqual([...groups], ['replay-tool'], \`consumers were created in groups \${JSON.stringify([...groups])}; expected only replay-tool\`);
}

export async function check_from_offset(ctx) {
  seed(ctx, 0, 'a0', 'a1', 'a2', 'a3');
  seed(ctx, 1, 'b0');
  seed(ctx, 2, 'c0', 'c1', 'c2');
  const m = ctx.load('replay_tool');
  const seen: Seen[] = [];
  const count = await m.replay(TOPIC, 2, (r: Seen) => void seen.push(r));
  const got = byPartition(seen);
  assert.deepEqual(got[0], [[2, 'a2'], [3, 'a3']], \`partition 0 handled \${JSON.stringify(got[0])}, expected offsets 2 and 3 only\`);
  assert.equal(got[1], undefined, \`partition 1 has one record (offset 0) and must contribute nothing from offset 2, handled \${JSON.stringify(got[1])}\`);
  assert.deepEqual(got[2], [[2, 'c2']], \`partition 2 handled \${JSON.stringify(got[2])}, expected offset 2 only\`);
  assert.equal(count, 3, \`replay returned \${count}, expected 3\`);
  const beyond: Seen[] = [];
  const none = await m.replay(TOPIC, 10, (r: Seen) => void beyond.push(r));
  assert(none === 0 && beyond.length === 0, \`replay from beyond every end handled \${beyond.length} record(s) and returned \${none}; expected 0\`);
}

export async function check_independent(ctx) {
  seed(ctx, 0, 'a0', 'a1');
  seed(ctx, 1, 'b0');
  const m = ctx.load('replay_tool');
  const first: Seen[] = [];
  assert.equal(await m.replay(TOPIC, 1, (r: Seen) => void first.push(r)), 1, 'first replay from offset 1 should handle exactly a1');
  assert.deepEqual(first.map(r => r.value), ['a1']);
  seed(ctx, 0, 'a2');
  seed(ctx, 2, 'c0');
  const second: Seen[] = [];
  const count = await m.replay(TOPIC, 0, (r: Seen) => void second.push(r));
  assert.equal(count, 5, \`second replay from 0 returned \${count}, expected 5: it starts over and sees the records appended since the first\`);
  const got = byPartition(second);
  assert.deepEqual(got[0], [[0, 'a0'], [1, 'a1'], [2, 'a2']], \`partition 0 handled \${JSON.stringify(got[0])} in the second replay; expected offsets 0..2\`);
  assert.deepEqual(got[2], [[0, 'c0']], \`partition 2 handled \${JSON.stringify(got[2])} in the second replay; expected [[0, 'c0']]\`);
  assert.deepEqual(ctx.kafka.commits(), [], 'neither replay may commit');
  assert(ctx.kafka.events.every(e => e[0] !== 'close' || e[1] === 'replay-tool'));
  assert.equal(ctx.kafka.events.filter(e => e[0] === 'close').length, 2, 'each replay creates and closes its own consumer');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"

	"leetbuild/harness"
)

const (
	replayTopic = "order-events"
	liveGroup   = "orders"
)

// seedAt appends keyless records to one partition of the topic.
func seedAt(ctx *harness.Ctx, partition int, values ...string) {
	for _, v := range values {
		ctx.Kafka.SeedPartition(replayTopic, partition, nil, v)
	}
}

// replayed runs replay until it returns (or waits for records that will not come); an error fails
// the check.
func replayed(ctx *harness.Ctx, from int64, handler func(ReplayRecord)) int {
	var n int
	var err error
	ctx.Drain(func() {
		n, err = replay(context.Background(), replayTopic, from, func(r ReplayRecord) error {
			handler(r)
			return nil
		})
	})
	ctx.NoError(err, "replay(%q, %d) returned an error", replayTopic, from)
	return n
}

// perPartition lists the handled records as "offset:value", per partition.
func perPartition(records []ReplayRecord) map[int][]string {
	out := map[int][]string{}
	for _, r := range records {
		out[r.Partition] = append(out[r.Partition], fmt.Sprintf("%d:%s", r.Offset, r.Value))
	}
	return out
}

func countEvents(ctx *harness.Ctx, kind string) int { return len(ctx.Kafka.EventsOf(kind)) }

func CheckReplaysInOrder(ctx *harness.Ctx) {
	seedAt(ctx, 0, "a0", "a1", "a2")
	seedAt(ctx, 1, "b0")
	seedAt(ctx, 2, "c0", "c1")
	var seen []ReplayRecord
	count := replayed(ctx, 0, func(r ReplayRecord) { seen = append(seen, r) })
	ctx.Equal(count, 6, "replay's return value (the number of records handled)")
	got := perPartition(seen)
	ctx.Equal(got[0], []string{"0:a0", "1:a1", "2:a2"}, "partition 0 must be handled at offsets 0..2 in order")
	ctx.Equal(got[1], []string{"0:b0"}, "partition 1")
	ctx.Equal(got[2], []string{"0:c0", "1:c1"}, "partition 2 must be handled at offsets 0..1 in order")
	for _, r := range seen {
		ctx.Assert(r.Key == nil, "records seeded without a key must reach the handler with a nil Key, got %q", r.Key)
	}
}

func CheckSnapshotEnd(ctx *harness.Ctx) {
	seedAt(ctx, 0, "a0", "a1")
	seedAt(ctx, 1, "b0")
	seedAt(ctx, 2, "c0", "c1", "c2")
	var seen []ReplayRecord
	count := replayed(ctx, 0, func(r ReplayRecord) {
		if len(seen) == 0 {
			// Producers keep writing while the replay runs: one more record on every partition.
			seedAt(ctx, 0, "a-late")
			seedAt(ctx, 1, "b-late")
			seedAt(ctx, 2, "c-late")
		}
		seen = append(seen, r)
	})
	ctx.Equal(ctx.Kafka.EndOffset(replayTopic, 0), 3, "the harness appended a record to partition 0 mid-replay: its end offset")
	var late []string
	for _, r := range seen {
		if strings.HasSuffix(string(r.Value), "-late") {
			late = append(late, string(r.Value))
		}
	}
	ctx.Equal(late, []string(nil), "records appended after the replay started must not be handled: the end is a snapshot taken before the first fetch")
	ctx.Equal(count, 6, "replay's return value (the records that existed when it started)")
	ctx.Equal(len(seen), 6, "records handled")
}

func CheckNoCommits(ctx *harness.Ctx) {
	seedAt(ctx, 0, "a0", "a1", "a2")
	seedAt(ctx, 1, "b0", "b1")
	seedAt(ctx, 2, "c0")
	// The live group is half-way through the topic.
	live := map[int]int64{0: 1, 1: 2, 2: 0}
	offsets := harness.KafkaOffsets{}
	for p, o := range live {
		offsets[harness.KafkaTopicPartition{Topic: replayTopic, Partition: p}] = o
	}
	ctx.Kafka.Commit(liveGroup, offsets)
	var seen []ReplayRecord
	count := replayed(ctx, 0, func(r ReplayRecord) { seen = append(seen, r) })
	ctx.Clock.Advance(30)
	ctx.Equal(count, 6, "replay's return value")
	for p := range 3 {
		ctx.Equal(ctx.Kafka.CommittedOffset(liveGroup, replayTopic, p), live[p], "group orders' committed offset for partition %d must not move: the replay must not touch the live group", p)
	}
	ctx.Equal(len(ctx.Kafka.Commits("replay-tool")), 0, "commits by group replay-tool (a replay tool never commits)")
	ctx.Equal(len(ctx.Kafka.Commits(""))-1, 0, "commits made during the replay")
	ctx.Equal(countEvents(ctx, "auto-commit"), 0, "auto-commits (the replay consumer must not commit on a timer)")
	// The step's Go readers are partition readers without a GroupID (nothing to commit), where the
	// other languages use group replay-tool: no consumer may join any group.
	groups := map[string]bool{}
	for _, e := range ctx.Kafka.EventsOf("consumer") {
		groups[e.Group] = true
	}
	ctx.Equal(groups, map[string]bool{"": true}, "groups the replay's consumers joined (partition readers join none)")
}

func CheckFromOffset(ctx *harness.Ctx) {
	seedAt(ctx, 0, "a0", "a1", "a2", "a3")
	seedAt(ctx, 1, "b0")
	seedAt(ctx, 2, "c0", "c1", "c2")
	var seen []ReplayRecord
	count := replayed(ctx, 2, func(r ReplayRecord) { seen = append(seen, r) })
	got := perPartition(seen)
	ctx.Equal(got[0], []string{"2:a2", "3:a3"}, "partition 0 must be handled at offsets 2 and 3 only")
	ctx.Equal(got[1], []string(nil), "partition 1 has one record (offset 0) and must contribute nothing from offset 2")
	ctx.Equal(got[2], []string{"2:c2"}, "partition 2 must be handled at offset 2 only")
	ctx.Equal(count, 3, "replay's return value")
	var beyond []ReplayRecord
	none := replayed(ctx, 10, func(r ReplayRecord) { beyond = append(beyond, r) })
	ctx.Assert(none == 0 && len(beyond) == 0, "replay from beyond every end handled %d record(s) and returned %d; expected 0", len(beyond), none)
}

func CheckIndependent(ctx *harness.Ctx) {
	seedAt(ctx, 0, "a0", "a1")
	seedAt(ctx, 1, "b0")
	var first []ReplayRecord
	ctx.Equal(replayed(ctx, 1, func(r ReplayRecord) { first = append(first, r) }), 1, "the first replay from offset 1 should handle exactly a1")
	ctx.Equal(perPartition(first), map[int][]string{0: {"1:a1"}}, "records handled by the first replay")
	firstReaders := countEvents(ctx, "consumer")
	seedAt(ctx, 0, "a2")
	seedAt(ctx, 2, "c0")
	var second []ReplayRecord
	count := replayed(ctx, 0, func(r ReplayRecord) { second = append(second, r) })
	ctx.Equal(count, 5, "the second replay from 0 starts over and sees the records appended since the first")
	got := perPartition(second)
	ctx.Equal(got[0], []string{"0:a0", "1:a1", "2:a2"}, "partition 0 in the second replay")
	ctx.Equal(got[2], []string{"0:c0"}, "partition 2 in the second replay")
	ctx.Equal(len(ctx.Kafka.Commits("")), 0, "neither replay may commit: commits")
	// The step's Go replay opens one group-less reader per partition, not one consumer per call:
	// each replay creates its own readers, and every reader is closed.
	for _, e := range ctx.Kafka.EventsOf("close") {
		ctx.Equal(e.Group, "", "a closed consumer's group (partition readers join none)")
	}
	ctx.Assert(firstReaders > 0 && countEvents(ctx, "consumer") > firstReaders, "each replay creates its own readers")
	ctx.Equal(countEvents(ctx, "close"), countEvents(ctx, "consumer"), "each replay closes the readers it created: closes")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <exception>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace {

const std::string replayTopic = "order-events";
const std::string liveGroup = "orders";

// seedAt appends keyless records to one partition of the topic.
void seedAt(harness::Ctx& ctx, int partition, const std::vector<std::string>& values) {
  for (const auto& v : values) ctx.Kafka.SeedPartition(replayTopic, partition, nullptr, v);
}

// replayed runs replay until it returns (or waits for records that will not come); a throw fails the check.
int replayed(harness::Ctx& ctx, int64_t from, const std::function<void(const ReplayRecord&)>& handler) {
  int n = 0;
  try {
    ctx.Drain([&] { n = replay(replayTopic, from, handler); });
  } catch (const std::exception& e) {
    ctx.Fatalf("replay(%q, %d) threw: %v", replayTopic, from, e.what());
  }
  return n;
}

// perPartition lists the handled records as "offset:value", per partition.
std::map<int, std::vector<std::string>> perPartition(const std::vector<ReplayRecord>& records) {
  std::map<int, std::vector<std::string>> out;
  for (const auto& r : records) out[r.partition].push_back(std::to_string(r.offset) + ":" + r.value);
  return out;
}

size_t countEvents(harness::Ctx& ctx, const std::string& kind) { return ctx.Kafka.EventsOf(kind).size(); }

}  // namespace

void CheckReplaysInOrder(harness::Ctx& ctx) {
  seedAt(ctx, 0, {"a0", "a1", "a2"});
  seedAt(ctx, 1, {"b0"});
  seedAt(ctx, 2, {"c0", "c1"});
  std::vector<ReplayRecord> seen;
  const int count = replayed(ctx, 0, [&](const ReplayRecord& r) { seen.push_back(r); });
  ctx.Equal(count, 6, "replay's return value (the number of records handled)");
  auto got = perPartition(seen);
  ctx.Equal(got[0], {"0:a0", "1:a1", "2:a2"}, "partition 0 must be handled at offsets 0..2 in order");
  ctx.Equal(got[1], {"0:b0"}, "partition 1");
  ctx.Equal(got[2], {"0:c0", "1:c1"}, "partition 2 must be handled at offsets 0..1 in order");
  for (const auto& r : seen)
    ctx.Assert(r.key.empty(), "records seeded without a key must reach the handler with an empty key, got %q", r.key);
}

void CheckSnapshotEnd(harness::Ctx& ctx) {
  seedAt(ctx, 0, {"a0", "a1"});
  seedAt(ctx, 1, {"b0"});
  seedAt(ctx, 2, {"c0", "c1", "c2"});
  std::vector<ReplayRecord> seen;
  const int count = replayed(ctx, 0, [&](const ReplayRecord& r) {
    if (seen.empty()) {
      // Producers keep writing while the replay runs: one more record on every partition.
      seedAt(ctx, 0, {"a-late"});
      seedAt(ctx, 1, {"b-late"});
      seedAt(ctx, 2, {"c-late"});
    }
    seen.push_back(r);
  });
  ctx.Equal(ctx.Kafka.EndOffset(replayTopic, 0), 3, "the harness appended a record to partition 0 mid-replay: its end offset");
  std::vector<std::string> late;
  for (const auto& r : seen)
    if (r.value.size() >= 5 && r.value.compare(r.value.size() - 5, 5, "-late") == 0) late.push_back(r.value);
  ctx.Equal(late, std::vector<std::string>{},
            "records appended after the replay started must not be handled: the end is a snapshot taken before the first fetch");
  ctx.Equal(count, 6, "replay's return value (the records that existed when it started)");
  ctx.Equal(seen.size(), 6, "records handled");
}

void CheckNoCommits(harness::Ctx& ctx) {
  seedAt(ctx, 0, {"a0", "a1", "a2"});
  seedAt(ctx, 1, {"b0", "b1"});
  seedAt(ctx, 2, {"c0"});
  // The live group is half-way through the topic.
  const std::map<int, int64_t> live = {{0, 1}, {1, 2}, {2, 0}};
  harness::KafkaOffsets offsets;
  for (const auto& [p, o] : live) offsets[{replayTopic, p}] = o;
  ctx.Kafka.Commit(liveGroup, offsets);
  std::vector<ReplayRecord> seen;
  const int count = replayed(ctx, 0, [&](const ReplayRecord& r) { seen.push_back(r); });
  ctx.Clock.Advance(30);
  ctx.Equal(count, 6, "replay's return value");
  for (int p = 0; p < 3; p++)
    ctx.Equal(ctx.Kafka.CommittedOffset(liveGroup, replayTopic, p), live.at(p),
              "group orders' committed offset for partition %d must not move: the replay must not touch the live group", p);
  ctx.Equal(ctx.Kafka.Commits("replay-tool").size(), 0, "commits by group replay-tool (a replay tool never commits)");
  ctx.Equal(ctx.Kafka.Commits("").size() - 1, 0, "commits made during the replay");
  ctx.Equal(countEvents(ctx, "auto-commit"), 0, "auto-commits (the replay consumer must not commit on a timer)");
  // A replay assigns the partitions it reads: no consumer may join a group (subscribe), which
  // would take partitions from the live consumers of that group.
  std::vector<std::string> groups;
  for (const auto& e : ctx.Kafka.EventsOf("subscribe")) groups.push_back(e.Group);
  ctx.Equal(groups, std::vector<std::string>{}, "groups the replay's consumers joined (assign partitions, do not subscribe)");
}

void CheckFromOffset(harness::Ctx& ctx) {
  seedAt(ctx, 0, {"a0", "a1", "a2", "a3"});
  seedAt(ctx, 1, {"b0"});
  seedAt(ctx, 2, {"c0", "c1", "c2"});
  std::vector<ReplayRecord> seen;
  const int count = replayed(ctx, 2, [&](const ReplayRecord& r) { seen.push_back(r); });
  auto got = perPartition(seen);
  ctx.Equal(got[0], {"2:a2", "3:a3"}, "partition 0 must be handled at offsets 2 and 3 only");
  ctx.Equal(got[1], std::vector<std::string>{}, "partition 1 has one record (offset 0) and must contribute nothing from offset 2");
  ctx.Equal(got[2], {"2:c2"}, "partition 2 must be handled at offset 2 only");
  ctx.Equal(count, 3, "replay's return value");
  std::vector<ReplayRecord> beyond;
  const int none = replayed(ctx, 10, [&](const ReplayRecord& r) { beyond.push_back(r); });
  ctx.Assert(none == 0 && beyond.empty(), "replay from beyond every end handled %d record(s) and returned %d; expected 0",
             beyond.size(), none);
}

void CheckIndependent(harness::Ctx& ctx) {
  seedAt(ctx, 0, {"a0", "a1"});
  seedAt(ctx, 1, {"b0"});
  std::vector<ReplayRecord> first;
  ctx.Equal(replayed(ctx, 1, [&](const ReplayRecord& r) { first.push_back(r); }), 1,
            "the first replay from offset 1 should handle exactly a1");
  ctx.Equal(perPartition(first), std::map<int, std::vector<std::string>>{{0, {"1:a1"}}}, "records handled by the first replay");
  const size_t firstReaders = countEvents(ctx, "consumer");
  seedAt(ctx, 0, {"a2"});
  seedAt(ctx, 2, {"c0"});
  std::vector<ReplayRecord> second;
  const int count = replayed(ctx, 0, [&](const ReplayRecord& r) { second.push_back(r); });
  ctx.Equal(count, 5, "the second replay from 0 starts over and sees the records appended since the first");
  auto got = perPartition(second);
  ctx.Equal(got[0], {"0:a0", "1:a1", "2:a2"}, "partition 0 in the second replay");
  ctx.Equal(got[2], {"0:c0"}, "partition 2 in the second replay");
  ctx.Equal(ctx.Kafka.Commits("").size(), 0, "neither replay may commit: commits");
  // Each replay creates its own consumer, and closes it.
  ctx.Assert(firstReaders > 0 && countEvents(ctx, "consumer") > firstReaders, "each replay creates its own consumer");
  ctx.Equal(countEvents(ctx, "close"), countEvents(ctx, "consumer"), "each replay closes the consumer it created: closes");
}
`,
  },
  debrief: `Three decisions make this a replay tool and not a second live consumer. It owns its **assignment** — \`assign\` in Python and the Java client, \`subscribe\` + \`seek\` in kafkajs — so it starts where it is told, not where a group's bookmark is; it **never commits** (auto-commit off, no commit call, nothing on close), so group \`orders\` resumes exactly where it was and no other tool ever inherits the replay's position; and it reads to a **snapshot of the end** taken before the first fetch, so the job is bounded by two offsets per partition no matter how fast producers write. The pause-when-done loop is the shape every bounded read takes: the broker keeps serving a partition past its snapshot, so the position check — not the fetch — decides what the handler sees. Real tools add \`offsets_for_times\` to pick \`from_offset\` by timestamp, read the partition count from metadata instead of a constant, write the handler's output through an idempotent sink (a replay is by definition a duplicate), and run one replay per partition in parallel with the same two fixed ends.`,
};
