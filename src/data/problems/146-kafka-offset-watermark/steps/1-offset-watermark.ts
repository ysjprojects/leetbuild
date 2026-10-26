import type {Step} from '@/lib/types';

export const offsetWatermarkStep: Step = {
  id: 'offset-watermark',
  title: 'Apply above the watermark, move it, then commit',
  concept: 'kafka',
  file: 'balance_consumer',
  focus: ['consumer', 'kafka'],
  task: `## Task

Implement a consumer of **\`transfers\`** in group **\`balances\`** whose apply is idempotent under
redelivery. Every record is JSON \`{"account": "a", "delta": 5}\`; the consumer keeps an in-memory
**store** with the balances and one **watermark** per partition.

- \`store()\` returns \`{"applied": {account: balance}, "watermark": {partition: offset}}\` — the
  current balances and, per partition, the offset of the **last record applied** (a partition the
  consumer has never applied from has no entry).
- \`run()\` consumes until the runtime stops it, with **auto-commit off**. For each record:
  apply it **only if** \`offset > watermark[partition]\` (a partition without an entry counts as
  \`-1\`, so the very first record, offset 0, is applied); on apply, add \`delta\` to the account's
  balance (missing account starts at 0) and set \`watermark[partition] = offset\`; then **commit**
  the record's offset — applied or skipped, after the store has been updated, never before.
- \`restart()\` closes the consumer and creates a new one in the same group: the process survived,
  only the consumer did not, so the store is **kept** and the new consumer resumes from the
  group's committed offsets. Records the broker redelivers because the commit never landed are at
  or below the watermark and are skipped.

:::widget delivery-semantics {}

> The broker's committed offset says where to resume; the watermark says what has been done. A
> crash between the apply and the commit makes the two disagree, and the comparison
> \`offset > watermark[partition]\` is what makes the replay harmless.`,
  sequence: {
    participants: ['Kafka', 'balances', 'store'],
    messages: [
      {from: 'Kafka', to: 'balances', label: 'poll → partition 0, offset 7: {a, +5}', kind: 'reply'},
      {from: 'balances', to: 'store', label: 'watermark[0] = 6 < 7 → applied[a] += 5, watermark[0] = 7', kind: 'sync'},
      {from: 'balances', to: 'Kafka', label: 'commit (0 → 8) — crash before it lands', kind: 'sync'},
      {from: 'balances', to: 'balances', label: 'restart(): new consumer, same store', kind: 'sync'},
      {from: 'Kafka', to: 'balances', label: 'poll → partition 0, offset 7 again', kind: 'reply'},
      {from: 'balances', to: 'store', label: '7 > watermark[0] = 7? no → skip', kind: 'sync'},
      {from: 'balances', to: 'Kafka', label: 'commit (0 → 8)', kind: 'sync'},
    ],
  },
  hints: [
    'Two module-level maps — balances by account and the watermark by partition — outlive the consumer; `restart()` only replaces the consumer object (close the old one, create and subscribe a new one in the same group).',
    'Read the watermark with a default of `-1`, not 0: offsets start at 0 and the first record of a partition must be applied. Then `offset > watermark` decides; a skipped record still gets its offset committed, or it would be redelivered forever.',
    'The order inside the loop is apply → watermark → commit. The harness snapshots the store at every commit: the balance and the watermark must already include the committed record.',
  ],
  checks: [
    {
      id: 'applies',
      title: 'Applies every transfer once to its account',
      detail:
        'After a normal run each account’s balance is the sum of its deltas across partitions; a missing account starts at 0, negative deltas are subtracted.',
      match: {
        python: {all: [/\+ event\["delta"\]/]},
        typescript: {all: [/\+ event\.delta/]},
        go: {all: [/\+= event\.Delta/]},
        scala: {all: [/\+ delta/]},
        cpp: {all: [/\+= delta/]},
      },
    },
    {
      id: 'manual-commit',
      title: 'Consumes transfers in group balances without auto-commit',
      detail:
        'The consumer joins group `balances`, subscribes to `transfers`, and commits offsets itself: no commit may come from a timer, and after the run nothing is left uncommitted.',
      match: {
        python: {
          all: [
            /GROUP = "balances"/,
            /"group\.id"\s*:\s*GROUP/,
            /"enable\.auto\.commit"\s*:\s*False/,
            /subscribe\(\s*\[\s*TOPIC\s*\]\s*\)/,
          ],
        },
        typescript: {all: [/GROUP = 'balances'/, /groupId:\s*GROUP/, /autoCommit:\s*false/, /topic:\s*TOPIC/]},
        go: {
          all: [/group\s*=\s*"balances"/, /GroupID:\s*group/, /Topic:\s*topic/, /\.FetchMessage\(/],
          none: [/\.ReadMessage\(/],
        },
        scala: {
          all: [
            /Group = "balances"/,
            /"group\.id"\s*,\s*Group/,
            /"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/,
            /subscribe\(List\(Topic\)/,
          ],
        },
        cpp: {
          all: [
            /kGroup = "balances"/,
            /"group\.id"\s*,\s*kGroup/,
            /"enable\.auto\.commit"\s*,\s*"false"/,
            /subscribe\(\{kTopic\}\)/,
          ],
        },
      },
    },
    {
      id: 'skips-redelivery',
      title: 'Redelivered records at or below the watermark are skipped',
      detail:
        'After `restart()` with the committed offset behind the watermark, the redelivered records are not applied again — balances are unchanged — and are still committed; a record is applied only when `offset > watermark[partition]`.',
      match: {
        python: {all: [/offset > WATERMARK\.get\(partition, -1\)/]},
        typescript: {all: [/offset > \(WATERMARK\[partition\] \?\? -1\)/]},
        go: {all: [/msg\.Offset > wm/]},
        scala: {all: [/offset > watermark\.getOrElse\(partition, -1L\)/]},
        cpp: {all: [/offset > wm/]},
      },
    },
    {
      id: 'watermark',
      title: 'The watermark is the last applied offset per partition',
      detail:
        'After the run `store().watermark` holds, for every partition that delivered records, exactly the offset of the last one applied — and no entry for partitions that delivered nothing.',
      match: {
        python: {all: [/WATERMARK\[partition\] = offset/]},
        typescript: {all: [/WATERMARK\[partition\] = offset/]},
        go: {all: [/watermark\[msg\.Partition\] = msg\.Offset/]},
        scala: {all: [/watermark\(partition\) = offset/]},
        cpp: {all: [/watermark\[partition\] = offset/]},
      },
    },
    {
      id: 'fresh-partition',
      title: 'A partition never applied from starts at -1',
      detail:
        'The first record of a partition has offset 0 and must be applied: the missing watermark counts as `-1`, not 0, and after it the watermark of that partition is 0.',
      match: {
        python: {all: [/WATERMARK\.get\(partition, -1\)/]},
        typescript: {all: [/WATERMARK\[partition\] \?\? -1/]},
        go: {all: [/wm = -1/]},
        scala: {all: [/watermark\.getOrElse\(partition, -1L\)/]},
        cpp: {all: [/\? -1 :/]},
      },
    },
    {
      id: 'commit-after',
      title: 'Commits only after the store is updated',
      detail:
        'At the moment each offset is committed, the balance already includes that record and the partition’s watermark already equals its offset: apply, then watermark, then commit.',
      match: {
        python: {order: [/WATERMARK\[partition\] = offset/, /consumer\.commit\(/]},
        typescript: {order: [/WATERMARK\[partition\] = offset/, /consumer\.commitOffsets\(/]},
        go: {order: [/watermark\[msg\.Partition\] = msg\.Offset/, /reader\.CommitMessages\(/]},
        scala: {order: [/watermark\(partition\) = offset/, /consumer\.commitSync\(/]},
        cpp: {order: [/watermark\[partition\] = offset/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Balances from transfers: an idempotent consumer with a watermark per partition."""
import json

from confluent_kafka import Consumer

TOPIC = "transfers"
GROUP = "balances"

# The store outlives the consumer: balances by account, last applied offset by partition.
APPLIED: dict[str, int] = {}
WATERMARK: dict[int, int] = {}


def _connect() -> Consumer:
    c = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": GROUP,
            "auto.offset.reset": "earliest",
            # TODO: disable auto-commit
        }
    )
    c.subscribe([TOPIC])
    return c


consumer = _connect()


def store() -> dict:
    return {"applied": dict(APPLIED), "watermark": dict(WATERMARK)}


def restart() -> None:
    """The consumer died, the process did not: a new consumer, the same store."""
    global consumer
    consumer.close()
    consumer = _connect()


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        partition, offset = msg.partition(), msg.offset()
        # TODO: apply only if offset is above the partition's watermark (-1 when unknown)
        # TODO: on apply, add delta to the account and set the watermark to offset
        # TODO: commit this record's offset, applied or skipped
        raise NotImplementedError
`,
      solution: `"""Balances from transfers: an idempotent consumer with a watermark per partition."""
import json

from confluent_kafka import Consumer

TOPIC = "transfers"
GROUP = "balances"

# The store outlives the consumer: balances by account, last applied offset by partition.
APPLIED: dict[str, int] = {}
WATERMARK: dict[int, int] = {}


def _connect() -> Consumer:
    c = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": GROUP,
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
        }
    )
    c.subscribe([TOPIC])
    return c


consumer = _connect()


def store() -> dict:
    return {"applied": dict(APPLIED), "watermark": dict(WATERMARK)}


def restart() -> None:
    """The consumer died, the process did not: a new consumer, the same store."""
    global consumer
    consumer.close()
    consumer = _connect()


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        partition, offset = msg.partition(), msg.offset()
        if offset > WATERMARK.get(partition, -1):
            account = event["account"]
            APPLIED[account] = APPLIED.get(account, 0) + event["delta"]
            WATERMARK[partition] = offset
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {type Consumer, Kafka} from 'kafkajs';

const TOPIC = 'transfers';
const GROUP = 'balances';

const kafka = new Kafka({clientId: 'balances', brokers: ['kafka:9092']});

// The store outlives the consumer: balances by account, last applied offset by partition.
const APPLIED: Record<string, number> = {};
const WATERMARK: Record<number, number> = {};

let consumer: Consumer = kafka.consumer({groupId: GROUP});

export function store(): {applied: Record<string, number>; watermark: Record<number, number>} {
  return {applied: {...APPLIED}, watermark: {...WATERMARK}};
}

/** The consumer died, the process did not: a new consumer, the same store. */
export async function restart(): Promise<void> {
  await consumer.disconnect();
  consumer = kafka.consumer({groupId: GROUP});
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit (autoCommit: false)
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '') as {account: string; delta: number};
      const offset = Number(message.offset);
      // TODO: apply only if offset is above the partition's watermark (-1 when unknown)
      // TODO: on apply, add delta to the account and set the watermark to offset
      // TODO: commitOffsets for this record (offset + 1), applied or skipped
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import {type Consumer, Kafka} from 'kafkajs';

const TOPIC = 'transfers';
const GROUP = 'balances';

const kafka = new Kafka({clientId: 'balances', brokers: ['kafka:9092']});

// The store outlives the consumer: balances by account, last applied offset by partition.
const APPLIED: Record<string, number> = {};
const WATERMARK: Record<number, number> = {};

let consumer: Consumer = kafka.consumer({groupId: GROUP});

export function store(): {applied: Record<string, number>; watermark: Record<number, number>} {
  return {applied: {...APPLIED}, watermark: {...WATERMARK}};
}

/** The consumer died, the process did not: a new consumer, the same store. */
export async function restart(): Promise<void> {
  await consumer.disconnect();
  consumer = kafka.consumer({groupId: GROUP});
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '') as {account: string; delta: number};
      const offset = Number(message.offset);
      if (offset > (WATERMARK[partition] ?? -1)) {
        APPLIED[event.account] = (APPLIED[event.account] ?? 0) + event.delta;
        WATERMARK[partition] = offset;
      }
      await consumer.commitOffsets([{topic, partition, offset: String(offset + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const (
	topic = "transfers"
	group = "balances"
)

// The store outlives the reader: balances by account, last applied offset by partition.
var (
	applied   = map[string]int64{}
	watermark = map[int]int64{}
)

type transfer struct {
	Account string \`json:"account"\`
	Delta   int64  \`json:"delta"\`
}

type Store struct {
	Applied   map[string]int64
	Watermark map[int]int64
}

func connect() *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		GroupID: group,
		Topic:   topic,
	})
}

var reader = connect()

func store() Store {
	s := Store{Applied: map[string]int64{}, Watermark: map[int]int64{}}
	for k, v := range applied {
		s.Applied[k] = v
	}
	for k, v := range watermark {
		s.Watermark[k] = v
	}
	return s
}

// restart: the reader died, the process did not — a new reader, the same store.
func restart() {
	reader.Close()
	reader = connect()
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits before you apply — not what we want)
		// TODO: apply only if msg.Offset is above the partition's watermark (-1 when unknown)
		// TODO: on apply, add Delta to the account and set the watermark to msg.Offset
		// TODO: CommitMessages for this record, applied or skipped
		_ = json.Unmarshal
		return nil
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const (
	topic = "transfers"
	group = "balances"
)

// The store outlives the reader: balances by account, last applied offset by partition.
var (
	applied   = map[string]int64{}
	watermark = map[int]int64{}
)

type transfer struct {
	Account string \`json:"account"\`
	Delta   int64  \`json:"delta"\`
}

type Store struct {
	Applied   map[string]int64
	Watermark map[int]int64
}

func connect() *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		GroupID: group,
		Topic:   topic,
	})
}

var reader = connect()

func store() Store {
	s := Store{Applied: map[string]int64{}, Watermark: map[int]int64{}}
	for k, v := range applied {
		s.Applied[k] = v
	}
	for k, v := range watermark {
		s.Watermark[k] = v
	}
	return s
}

// restart: the reader died, the process did not — a new reader, the same store.
func restart() {
	reader.Close()
	reader = connect()
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event transfer
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		wm, ok := watermark[msg.Partition]
		if !ok {
			wm = -1
		}
		if msg.Offset > wm {
			applied[event.Account] += event.Delta
			watermark[msg.Partition] = msg.Offset
		}
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
import org.apache.kafka.common.serialization.StringDeserializer
import scala.collection.mutable
import scala.jdk.CollectionConverters._

object BalanceConsumer {
  val Topic = "transfers"
  val Group = "balances"

  // The store outlives the consumer: balances by account, last applied offset by partition.
  private val applied = mutable.Map[String, Long]()
  private val watermark = mutable.Map[Int, Long]()

  private val AccountField = """"account"\\s*:\\s*"([^"]+)"""".r
  private val DeltaField = """"delta"\\s*:\\s*(-?\\d+)""".r

  private def connect(): KafkaConsumer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    // TODO: disable auto-commit
    val c = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    c.subscribe(List(Topic).asJava)
    c
  }

  private var consumer = connect()

  def store(): (Map[String, Long], Map[Int, Long]) = (applied.toMap, watermark.toMap)

  /** The consumer died, the process did not: a new consumer, the same store. */
  def restart(): Unit = {
    consumer.close()
    consumer = connect()
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val account = AccountField.findFirstMatchIn(record.value()).map(_.group(1)).getOrElse("")
        val delta = DeltaField.findFirstMatchIn(record.value()).map(_.group(1).toLong).getOrElse(0L)
        val partition = record.partition()
        val offset = record.offset()
        // TODO: apply only if offset is above the partition's watermark (-1L when unknown)
        // TODO: on apply, add delta to the account and set the watermark to offset
        // TODO: commitSync this record's offset + 1, applied or skipped
      }
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.collection.mutable
import scala.jdk.CollectionConverters._

object BalanceConsumer {
  val Topic = "transfers"
  val Group = "balances"

  // The store outlives the consumer: balances by account, last applied offset by partition.
  private val applied = mutable.Map[String, Long]()
  private val watermark = mutable.Map[Int, Long]()

  private val AccountField = """"account"\\s*:\\s*"([^"]+)"""".r
  private val DeltaField = """"delta"\\s*:\\s*(-?\\d+)""".r

  private def connect(): KafkaConsumer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val c = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    c.subscribe(List(Topic).asJava)
    c
  }

  private var consumer = connect()

  def store(): (Map[String, Long], Map[Int, Long]) = (applied.toMap, watermark.toMap)

  /** The consumer died, the process did not: a new consumer, the same store. */
  def restart(): Unit = {
    consumer.close()
    consumer = connect()
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val account = AccountField.findFirstMatchIn(record.value()).map(_.group(1)).getOrElse("")
        val delta = DeltaField.findFirstMatchIn(record.value()).map(_.group(1).toLong).getOrElse(0L)
        val partition = record.partition()
        val offset = record.offset()
        if (offset > watermark.getOrElse(partition, -1L)) {
          applied(account) = applied.getOrElse(account, 0L) + delta
          watermark(partition) = offset
        }
        consumer.commitSync(
          Map(new TopicPartition(Topic, partition) -> new OffsetAndMetadata(offset + 1)).asJava
        )
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <cstdint>
#include <map>
#include <memory>
#include <regex>
#include <string>

const std::string kTopic = "transfers";
const std::string kGroup = "balances";

// The store outlives the consumer: balances by account, last applied offset by partition.
std::map<std::string, long long> applied;
std::map<int, int64_t> watermark;

struct Store {
  std::map<std::string, long long> applied;
  std::map<int, int64_t> watermark;
};

std::unique_ptr<RdKafka::KafkaConsumer> connect() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto consumer = connect();
const std::regex kAccountField(R"re("account"\\s*:\\s*"([^"]+)")re");
const std::regex kDeltaField(R"("delta"\\s*:\\s*(-?\\d+))");

Store store() { return Store{applied, watermark}; }

// The consumer died, the process did not: a new consumer, the same store.
void restart() {
  consumer->close();
  consumer = connect();
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    std::smatch account, delta_match;
    if (!std::regex_search(value, account, kAccountField) || !std::regex_search(value, delta_match, kDeltaField)) continue;
    const long long delta = std::stoll(delta_match[1].str());
    const int partition = msg->partition();
    const int64_t offset = msg->offset();
    // TODO: apply only if offset is above the partition's watermark (-1 when unknown)
    // TODO: on apply, add delta to the account and set the watermark to offset
    // TODO: commitSync this record, applied or skipped
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <cstdint>
#include <map>
#include <memory>
#include <regex>
#include <string>

const std::string kTopic = "transfers";
const std::string kGroup = "balances";

// The store outlives the consumer: balances by account, last applied offset by partition.
std::map<std::string, long long> applied;
std::map<int, int64_t> watermark;

struct Store {
  std::map<std::string, long long> applied;
  std::map<int, int64_t> watermark;
};

std::unique_ptr<RdKafka::KafkaConsumer> connect() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto consumer = connect();
const std::regex kAccountField(R"re("account"\\s*:\\s*"([^"]+)")re");
const std::regex kDeltaField(R"("delta"\\s*:\\s*(-?\\d+))");

Store store() { return Store{applied, watermark}; }

// The consumer died, the process did not: a new consumer, the same store.
void restart() {
  consumer->close();
  consumer = connect();
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    std::smatch account, delta_match;
    if (!std::regex_search(value, account, kAccountField) || !std::regex_search(value, delta_match, kDeltaField)) continue;
    const long long delta = std::stoll(delta_match[1].str());
    const int partition = msg->partition();
    const int64_t offset = msg->offset();
    const auto it = watermark.find(partition);
    const int64_t wm = it == watermark.end() ? -1 : it->second;
    if (offset > wm) {
      applied[account[1].str()] += delta;
      watermark[partition] = offset;
    }
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "transfers"
GROUP = "balances"


def _seed(ctx, partition, *transfers):
    """Transfers on one partition, in this order: (account, delta) pairs."""
    for account, delta in transfers:
        ctx.kafka.seed(TOPIC, key=account, value=json.dumps({"account": account, "delta": delta}), partition=partition)


def check_applies(ctx):
    _seed(ctx, 0, ("a", 100), ("a", -30))
    _seed(ctx, 1, ("b", 50), ("b", -50))
    _seed(ctx, 2, ("c", 7))
    m = ctx.load("balance_consumer")
    ctx.drain(m.run)
    applied = m.store()["applied"]
    assert applied == {"a": 70, "b": 0, "c": 7}, f"balances are {applied}, expected a=70 b=0 c=7"


def check_manual_commit(ctx):
    _seed(ctx, 0, ("a", 1), ("b", 2))
    m = ctx.load("balance_consumer")
    ctx.drain(m.run)
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions and subscriptions[-1][1] == GROUP and TOPIC in subscriptions[-1][2], f"the consumer must subscribe to {TOPIC} in group {GROUP}"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, before the apply"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened"
    assert ctx.kafka.committed_offset(GROUP, TOPIC, 0) == 2, f"partition 0 should be committed at 2, got {ctx.kafka.committed_offset(GROUP, TOPIC, 0)}"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, "every processed record must be committed"


def check_skips_redelivery(ctx):
    _seed(ctx, 0, ("a", 10), ("a", 5), ("b", 3))
    _seed(ctx, 1, ("b", 4))
    m = ctx.load("balance_consumer")
    ctx.drain(m.run)
    before = m.store()
    assert before["applied"] == {"a": 15, "b": 7}, f"balances after the first run are {before['applied']}, expected a=15 b=7"
    # The commits for offsets 1 and 2 of partition 0 never landed: the group resumes from 1.
    ctx.kafka.commit(GROUP, {(TOPIC, 0): 1})
    m.restart()
    ctx.drain(m.run)
    after = m.store()
    assert after["applied"] == {"a": 15, "b": 7}, f"redelivered records were applied again: balances are {after['applied']}, expected a=15 b=7"
    assert after["watermark"] == before["watermark"], f"the watermark moved on a redelivery: {after['watermark']} (was {before['watermark']})"
    assert ctx.kafka.committed_offset(GROUP, TOPIC, 0) == 3, "skipped records must still be committed, or they are redelivered forever"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, "every record must be committed after the restart"


def check_watermark(ctx):
    _seed(ctx, 0, ("a", 1), ("a", 1), ("a", 1))
    _seed(ctx, 1, ("b", 1), ("b", 1))
    m = ctx.load("balance_consumer")
    ctx.drain(m.run)
    watermark = m.store()["watermark"]
    assert watermark == {0: 2, 1: 1}, f"watermark is {watermark}, expected {{0: 2, 1: 1}} (the last applied offset per partition, no entry for partition 2)"


def check_fresh_partition(ctx):
    _seed(ctx, 2, ("z", 9))
    m = ctx.load("balance_consumer")
    ctx.drain(m.run)
    s = m.store()
    assert s["applied"] == {"z": 9}, f"the first record of a partition (offset 0) must be applied: balances are {s['applied']}"
    assert s["watermark"] == {2: 0}, f"watermark is {s['watermark']}, expected {{2: 0}}"


def check_commit_after(ctx):
    _seed(ctx, 0, ("a", 5), ("a", 6))
    m = ctx.load("balance_consumer")
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((dict(offsets), m.store())))
    ctx.drain(m.run)
    assert at_commit, "the offsets were never committed"
    expected = {1: 5, 2: 11}
    for offsets, snapshot in at_commit:
        for (topic, partition), offset in offsets.items():
            assert snapshot["watermark"].get(partition) == offset - 1, f"committing {topic}[{partition}] → {offset} while the watermark was {snapshot['watermark'].get(partition)}: the watermark must move before the commit"
            assert snapshot["applied"].get("a") == expected[offset], f"committing offset {offset} while a = {snapshot['applied'].get('a')}: the apply must come before the commit"
`,
    typescript: `const TOPIC = 'transfers';
const GROUP = 'balances';

/** Transfers on one partition, in this order: [account, delta] pairs. */
function seed(ctx, partition: number, ...transfers: [string, number][]) {
  for (const [account, delta] of transfers)
    ctx.kafka.seed(TOPIC, {key: account, value: JSON.stringify({account, delta}), partition});
}

export async function check_applies(ctx) {
  seed(ctx, 0, ['a', 100], ['a', -30]);
  seed(ctx, 1, ['b', 50], ['b', -50]);
  seed(ctx, 2, ['c', 7]);
  const m = ctx.load('balance_consumer');
  await ctx.drain(m.run());
  const {applied} = m.store();
  assert.deepEqual(applied, {a: 70, b: 0, c: 7}, \`balances are \${JSON.stringify(applied)}, expected a=70 b=0 c=7\`);
}

export async function check_manual_commit(ctx) {
  seed(ctx, 0, ['a', 1], ['b', 2]);
  const m = ctx.load('balance_consumer');
  await ctx.drain(m.run());
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  const last = subscriptions[subscriptions.length - 1];
  assert(last !== undefined && last[1] === GROUP && last[2].includes(TOPIC), \`the consumer must subscribe to \${TOPIC} in group \${GROUP}\`);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, before the apply');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened');
  assert.equal(ctx.kafka.committedOffset(GROUP, TOPIC, 0), 2, 'partition 0 should be committed at 2');
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'every processed record must be committed');
}

export async function check_skips_redelivery(ctx) {
  seed(ctx, 0, ['a', 10], ['a', 5], ['b', 3]);
  seed(ctx, 1, ['b', 4]);
  const m = ctx.load('balance_consumer');
  await ctx.drain(m.run());
  const before = m.store();
  assert.deepEqual(before.applied, {a: 15, b: 7}, \`balances after the first run are \${JSON.stringify(before.applied)}, expected a=15 b=7\`);
  // The commits for offsets 1 and 2 of partition 0 never landed: the group resumes from 1.
  ctx.kafka.commit(GROUP, new Map([[\`\${TOPIC}|0\`, 1]]));
  await m.restart();
  await ctx.drain(m.run());
  const after = m.store();
  assert.deepEqual(after.applied, {a: 15, b: 7}, \`redelivered records were applied again: balances are \${JSON.stringify(after.applied)}, expected a=15 b=7\`);
  assert.deepEqual(after.watermark, before.watermark, \`the watermark moved on a redelivery: \${JSON.stringify(after.watermark)} (was \${JSON.stringify(before.watermark)})\`);
  assert.equal(ctx.kafka.committedOffset(GROUP, TOPIC, 0), 3, 'skipped records must still be committed, or they are redelivered forever');
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'every record must be committed after the restart');
}

export async function check_watermark(ctx) {
  seed(ctx, 0, ['a', 1], ['a', 1], ['a', 1]);
  seed(ctx, 1, ['b', 1], ['b', 1]);
  const m = ctx.load('balance_consumer');
  await ctx.drain(m.run());
  const {watermark} = m.store();
  assert.deepEqual(watermark, {0: 2, 1: 1}, \`watermark is \${JSON.stringify(watermark)}, expected {0: 2, 1: 1} (the last applied offset per partition, no entry for partition 2)\`);
}

export async function check_fresh_partition(ctx) {
  seed(ctx, 2, ['z', 9]);
  const m = ctx.load('balance_consumer');
  await ctx.drain(m.run());
  const s = m.store();
  assert.deepEqual(s.applied, {z: 9}, \`the first record of a partition (offset 0) must be applied: balances are \${JSON.stringify(s.applied)}\`);
  assert.deepEqual(s.watermark, {2: 0}, \`watermark is \${JSON.stringify(s.watermark)}, expected {2: 0}\`);
}

export async function check_commit_after(ctx) {
  seed(ctx, 0, ['a', 5], ['a', 6]);
  const m = ctx.load('balance_consumer');
  const atCommit: [Map<string, number>, {applied: Record<string, number>; watermark: Record<number, number>}][] = [];
  ctx.kafka.onCommit((group, offsets) => atCommit.push([new Map(offsets), m.store()]));
  await ctx.drain(m.run());
  assert(atCommit.length > 0, 'the offsets were never committed');
  const expected: Record<number, number> = {1: 5, 2: 11};
  for (const [offsets, snapshot] of atCommit)
    for (const [tp, offset] of offsets) {
      const partition = Number(tp.split('|')[1]);
      assert.equal(snapshot.watermark[partition], offset - 1, \`committing \${tp} → \${offset} while the watermark was \${snapshot.watermark[partition]}: the watermark must move before the commit\`);
      assert.equal(snapshot.applied.a, expected[offset], \`committing offset \${offset} while a = \${snapshot.applied.a}: the apply must come before the commit\`);
    }
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"slices"

	"leetbuild/harness"
)

// seedTransfers puts transfers on one partition, in this order: account, delta, account, delta…
func seedTransfers(ctx *harness.Ctx, partition int, pairs ...any) {
	for i := 0; i+1 < len(pairs); i += 2 {
		account := pairs[i].(string)
		ctx.Kafka.SeedPartition("transfers", partition, account, fmt.Sprintf(\`{"account":%q,"delta":%d}\`, account, pairs[i+1]))
	}
}

// drainBalances runs the consumer until it waits for transfers that will not come.
func drainBalances(ctx *harness.Ctx) { ctx.Drain(func() { run(context.Background()) }) }

func CheckApplies(ctx *harness.Ctx) {
	seedTransfers(ctx, 0, "a", 100, "a", -30)
	seedTransfers(ctx, 1, "b", 50, "b", -50)
	seedTransfers(ctx, 2, "c", 7)
	drainBalances(ctx)
	ctx.Equal(store().Applied, map[string]int64{"a": 70, "b": 0, "c": 7}, "the balances")
}

func CheckManualCommit(ctx *harness.Ctx) {
	seedTransfers(ctx, 0, "a", 1, "b", 2)
	drainBalances(ctx)
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	ok := len(subscriptions) > 0
	if ok {
		last := subscriptions[len(subscriptions)-1]
		ok = last.Group == "balances" && slices.Contains(last.Topics, "transfers")
	}
	ctx.Assert(ok, "the consumer must subscribe to transfers in group balances")
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "offsets were committed on a timer, before the apply: auto-commits")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened")
	ctx.Equal(ctx.Kafka.CommittedOffset("balances", "transfers", 0), 2, "partition 0's committed offset")
	ctx.Equal(ctx.Kafka.Lag("balances", "transfers"), 0, "every processed record must be committed: lag")
}

func CheckSkipsRedelivery(ctx *harness.Ctx) {
	seedTransfers(ctx, 0, "a", 10, "a", 5, "b", 3)
	seedTransfers(ctx, 1, "b", 4)
	drainBalances(ctx)
	before := store()
	ctx.Equal(before.Applied, map[string]int64{"a": 15, "b": 7}, "the balances after the first run")
	// The commits for offsets 1 and 2 of partition 0 never landed: the group resumes from 1.
	ctx.Kafka.Commit("balances", harness.KafkaOffsets{harness.KafkaTopicPartition{Topic: "transfers", Partition: 0}: 1})
	restart()
	drainBalances(ctx)
	after := store()
	ctx.Equal(after.Applied, map[string]int64{"a": 15, "b": 7}, "redelivered records must not be applied again: the balances")
	ctx.Equal(after.Watermark, before.Watermark, "the watermark must not move on a redelivery")
	ctx.Equal(ctx.Kafka.CommittedOffset("balances", "transfers", 0), 3, "skipped records must still be committed, or they are redelivered forever: partition 0's committed offset")
	ctx.Equal(ctx.Kafka.Lag("balances", "transfers"), 0, "every record must be committed after the restart: lag")
}

func CheckWatermark(ctx *harness.Ctx) {
	seedTransfers(ctx, 0, "a", 1, "a", 1, "a", 1)
	seedTransfers(ctx, 1, "b", 1, "b", 1)
	drainBalances(ctx)
	ctx.Equal(store().Watermark, map[int]int64{0: 2, 1: 1}, "the watermark (the last applied offset per partition, no entry for partition 2)")
}

func CheckFreshPartition(ctx *harness.Ctx) {
	seedTransfers(ctx, 2, "z", 9)
	drainBalances(ctx)
	s := store()
	ctx.Equal(s.Applied, map[string]int64{"z": 9}, "the first record of a partition (offset 0) must be applied: the balances")
	ctx.Equal(s.Watermark, map[int]int64{2: 0}, "the watermark")
}

func CheckCommitAfter(ctx *harness.Ctx) {
	seedTransfers(ctx, 0, "a", 5, "a", 6)
	type commitSnapshot struct {
		offsets harness.KafkaOffsets
		store   Store
	}
	var atCommit []commitSnapshot
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		atCommit = append(atCommit, commitSnapshot{offsets, store()})
	})
	drainBalances(ctx)
	ctx.Assert(len(atCommit) > 0, "the offsets were never committed")
	expected := map[int64]int64{1: 5, 2: 11}
	for _, c := range atCommit {
		for tp, offset := range c.offsets {
			var wm any
			if w, ok := c.store.Watermark[tp.Partition]; ok {
				wm = w
			}
			ctx.Equal(wm, offset-1, "committing %s → %d: the watermark must move before the commit; the watermark", tp, offset)
			ctx.Equal(c.store.Applied["a"], expected[offset], "committing offset %d: the apply must come before the commit; a", offset)
		}
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace {

// seedTransfers puts transfers on one partition, in this order.
void seedTransfers(harness::Ctx& ctx, int partition, const std::vector<std::pair<std::string, int>>& transfers) {
  for (const auto& [account, delta] : transfers)
    ctx.Kafka.SeedPartition("transfers", partition, account,
                            R"({"account":")" + account + R"(","delta":)" + std::to_string(delta) + "}");
}

// drainBalances runs the consumer until it waits for transfers that will not come.
void drainBalances(harness::Ctx& ctx) { ctx.Drain([] { run(); }); }

}  // namespace

void CheckApplies(harness::Ctx& ctx) {
  seedTransfers(ctx, 0, {{"a", 100}, {"a", -30}});
  seedTransfers(ctx, 1, {{"b", 50}, {"b", -50}});
  seedTransfers(ctx, 2, {{"c", 7}});
  drainBalances(ctx);
  ctx.Equal(store().applied, std::map<std::string, int64_t>{{"a", 70}, {"b", 0}, {"c", 7}}, "the balances");
}

void CheckManualCommit(harness::Ctx& ctx) {
  seedTransfers(ctx, 0, {{"a", 1}, {"b", 2}});
  drainBalances(ctx);
  const auto subscriptions = ctx.Kafka.EventsOf("subscribe");
  bool ok = !subscriptions.empty();
  if (ok) {
    const auto& last = subscriptions.back();
    ok = last.Group == "balances" && std::find(last.Topics.begin(), last.Topics.end(), "transfers") != last.Topics.end();
  }
  ctx.Assert(ok, "the consumer must subscribe to transfers in group balances");
  ctx.Equal(ctx.Kafka.EventsOf("auto-commit").size(), 0, "offsets were committed on a timer, before the apply: auto-commits");
  ctx.Assert(!ctx.Kafka.EventsOf("manual-commit").empty(), "no explicit commit happened");
  ctx.Equal(ctx.Kafka.CommittedOffset("balances", "transfers", 0), 2, "partition 0's committed offset");
  ctx.Equal(ctx.Kafka.Lag("balances", "transfers"), 0, "every processed record must be committed: lag");
}

void CheckSkipsRedelivery(harness::Ctx& ctx) {
  seedTransfers(ctx, 0, {{"a", 10}, {"a", 5}, {"b", 3}});
  seedTransfers(ctx, 1, {{"b", 4}});
  drainBalances(ctx);
  const Store before = store();
  ctx.Equal(before.applied, std::map<std::string, int64_t>{{"a", 15}, {"b", 7}}, "the balances after the first run");
  // The commits for offsets 1 and 2 of partition 0 never landed: the group resumes from 1.
  ctx.Kafka.Commit("balances", {{{"transfers", 0}, 1}});
  restart();
  drainBalances(ctx);
  const Store after = store();
  ctx.Equal(after.applied, std::map<std::string, int64_t>{{"a", 15}, {"b", 7}}, "redelivered records must not be applied again: the balances");
  ctx.Equal(after.watermark, before.watermark, "the watermark must not move on a redelivery");
  ctx.Equal(ctx.Kafka.CommittedOffset("balances", "transfers", 0), 3,
            "skipped records must still be committed, or they are redelivered forever: partition 0's committed offset");
  ctx.Equal(ctx.Kafka.Lag("balances", "transfers"), 0, "every record must be committed after the restart: lag");
}

void CheckWatermark(harness::Ctx& ctx) {
  seedTransfers(ctx, 0, {{"a", 1}, {"a", 1}, {"a", 1}});
  seedTransfers(ctx, 1, {{"b", 1}, {"b", 1}});
  drainBalances(ctx);
  ctx.Equal(store().watermark, std::map<int, int64_t>{{0, 2}, {1, 1}},
            "the watermark (the last applied offset per partition, no entry for partition 2)");
}

void CheckFreshPartition(harness::Ctx& ctx) {
  seedTransfers(ctx, 2, {{"z", 9}});
  drainBalances(ctx);
  const Store s = store();
  ctx.Equal(s.applied, std::map<std::string, int64_t>{{"z", 9}}, "the first record of a partition (offset 0) must be applied: the balances");
  ctx.Equal(s.watermark, std::map<int, int64_t>{{2, 0}}, "the watermark");
}

void CheckCommitAfter(harness::Ctx& ctx) {
  seedTransfers(ctx, 0, {{"a", 5}, {"a", 6}});
  std::vector<std::pair<harness::KafkaOffsets, Store>> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) { atCommit.emplace_back(offsets, store()); });
  drainBalances(ctx);
  ctx.Assert(!atCommit.empty(), "the offsets were never committed");
  const std::map<int64_t, int64_t> expected = {{1, 5}, {2, 11}};
  for (const auto& [offsets, s] : atCommit) {
    for (const auto& [tp, offset] : offsets) {
      const auto it = s.watermark.find(tp.Partition);
      const std::optional<int64_t> wm = it == s.watermark.end() ? std::nullopt : std::optional<int64_t>(it->second);
      ctx.Equal(wm, offset - 1, "committing %s → %d: the watermark must move before the commit; the watermark", tp, offset);
      const auto a = s.applied.find("a");
      ctx.Equal(a == s.applied.end() ? 0 : a->second, expected.count(offset) ? expected.at(offset) : -1,
                "committing offset %d: the apply must come before the commit; a", offset);
    }
  }
}
`,
  },
  debrief: `The commit never became safer — it is still process-then-commit, still at-least-once — the *apply* became idempotent, and that is the only place idempotence can live, because only the consumer knows what it has done. A watermark works because offsets are a per-partition total order: one integer summarises every record applied before it, so the check is a comparison, not a lookup in a set of seen ids, and the store never grows with the traffic. Two details carry the drill: the default is \`-1\` because the first record of a partition is offset 0, and the watermark moves *before* the commit so that a crash anywhere leaves the store ahead of (or equal to) the broker, never behind. Real systems keep the balance and the watermark in one durable write — a database row updated in the same transaction, a Kafka Streams state store, a Flink checkpoint — because an in-memory watermark that dies with the process is exactly the crash this drill pretends did not happen; they also reset the watermark when a partition is reassigned to another instance, which is why the store is keyed by partition and not by consumer.`,
};
