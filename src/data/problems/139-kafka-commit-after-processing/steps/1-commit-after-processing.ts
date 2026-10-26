import type {Step} from '@/lib/types';

export const commitAfterProcessingStep: Step = {
  id: 'commit-after-processing',
  title: 'Process the record, then commit its offset',
  concept: 'kafka',
  file: 'ledger_consumer',
  focus: ['ledger', 'kafka'],
  task: `## Task

Implement **\`run(handler)\`**: a member of consumer group **\`ledger-writer\`** that reads topic
**\`payments\`** and hands every record to \`handler\`, committing each offset only once the handler
has returned. The loop runs until the runtime stops it.

- Consumer configuration: \`group.id\` \`ledger-writer\`, \`auto.offset.reset\` \`earliest\`
  (\`fromBeginning: true\`), and **auto-commit off** (\`enable.auto.commit=false\` / \`autoCommit: false\`).
  Auto-commit acknowledges on a timer whatever was last fetched, before you know it was processed.
- For every record, in the order the partition delivers them: parse the value as JSON, call
  \`handler(event)\` with the parsed object, **then** commit that record's offset — synchronously,
  per record: \`commit(message=msg, asynchronous=False)\` / \`commitOffsets([{topic, partition,
  offset: offset + 1}])\`. The committed offset is the *next* one to read.
- A value that fails to parse is a poison record: log it, skip the handler, and **still commit** it —
  otherwise the partition is stuck on it forever.
- A handler that raises stops the loop and that record is **not** committed: it is redelivered when
  the consumer comes back. Do not catch the handler's error.

:::widget delivery-semantics {}

> The committed offset is a statement about work already done. Nothing may commit a record the
> handler has not finished — not a timer, not a batch, not a catch-all.`,
  sequence: {
    participants: ['Kafka', 'ledger-writer', 'handler'],
    messages: [
      {from: 'Kafka', to: 'ledger-writer', label: 'poll → record (partition 1, offset 41)', kind: 'reply'},
      {from: 'ledger-writer', to: 'handler', label: 'handler(event)', kind: 'sync'},
      {from: 'handler', to: 'ledger-writer', label: 'returns', kind: 'reply'},
      {from: 'ledger-writer', to: 'Kafka', label: 'commit offset 42 (partition 1)', kind: 'sync'},
      {from: 'Kafka', to: 'ledger-writer', label: 'poll → record (partition 1, offset 42)', kind: 'reply'},
    ],
  },
  hints: [
    'Auto-commit is a consumer *configuration*: `enable.auto.commit: False` in the config dict, `autoCommit: false` in `consumer.run(...)`; kafka-go needs `FetchMessage` + `CommitMessages` (`ReadMessage` commits for you).',
    'One commit site at the bottom of the loop body is enough: parse → (handler, or log the poison record) → commit. A handler exception then never reaches the commit.',
    'Commit *this* record: `commit(message=msg)` commits `offset + 1` for its partition; in kafkajs you pass `offset + 1` yourself, as a string.',
  ],
  checks: [
    {
      id: 'in-order',
      title: 'Every payment reaches the handler, in partition order',
      detail:
        'Group `ledger-writer` subscribes to `payments` from the beginning; the handler sees every seeded record as a parsed object, each partition in offset order.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*"ledger-writer"/,
            /"auto\.offset\.reset"\s*:\s*"earliest"/,
            /subscribe\(\s*\[\s*"payments"\s*\]\s*\)/,
          ],
        },
        typescript: {
          all: [
            /groupId:\s*['"]ledger-writer['"]/,
            /subscribe\(\s*\{[^\n]*['"]payments['"][^\n]*fromBeginning:\s*true/,
          ],
        },
        go: {all: [/GroupID:\s*"ledger-writer"/, /Topic:\s*"payments"/, /StartOffset:\s*kafka\.FirstOffset/]},
        scala: {
          all: [
            /"group\.id"\s*,\s*"ledger-writer"|GROUP_ID_CONFIG\s*,\s*"ledger-writer"/,
            /"auto\.offset\.reset"\s*,\s*"earliest"|AUTO_OFFSET_RESET_CONFIG\s*,\s*"earliest"/,
            /subscribe\([^\n]*"payments"/,
          ],
        },
        cpp: {
          all: [
            /"group\.id"\s*,\s*"ledger-writer"/,
            /"auto\.offset\.reset"\s*,\s*"earliest"/,
            /subscribe\([^\n]*"payments"/,
          ],
        },
      },
    },
    {
      id: 'manual-commit',
      title: 'Auto-commit is off: one explicit commit per record',
      detail:
        "No offset is committed on a timer; the broker sees exactly one commit per delivered record, each naming that record's partition alone.",
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/]},
        typescript: {all: [/autoCommit:\s*false/]},
        go: {all: [/reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/]},
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/]},
      },
    },
    {
      id: 'committed-offset',
      title: 'The committed offset is the next one to read',
      detail:
        "After the topic is drained, each partition's committed offset equals its end offset — the record's offset + 1, committed synchronously for that record.",
      match: {
        python: {all: [/consumer\.commit\(\s*message\s*=\s*msg\s*,\s*asynchronous\s*=\s*False\s*\)/]},
        typescript: {all: [/consumer\.commitOffsets\(/, /Number\(message\.offset\)\s*\+\s*1/]},
        go: {all: [/reader\.CommitMessages\(\s*ctx\s*,\s*msg\s*\)/]},
        scala: {all: [/consumer\.commitSync\(/, /new OffsetAndMetadata\(\s*record\.offset\(\)\s*\+\s*1\s*\)/]},
        cpp: {all: [/consumer->commitSync\(\s*msg\.get\(\)\s*\)/]},
      },
    },
    {
      id: 'commit-after',
      title: "No commit precedes its record's processing",
      detail:
        'At the instant of every commit, the handler had already returned for the record being committed: process first, commit second.',
      match: {
        python: {order: [/\bhandler\(event\)/, /consumer\.commit\(/]},
        typescript: {order: [/await handler\(event\)/, /consumer\.commitOffsets\(/]},
        go: {order: [/\bhandler\(event\)/, /reader\.CommitMessages\(/]},
        scala: {order: [/\bhandler\(event\)/, /consumer\.commitSync\(/]},
        cpp: {order: [/\bhandler\(event\)/, /consumer->commitSync\(/]},
      },
    },
    {
      id: 'poison',
      title: 'A malformed record is skipped and committed',
      detail:
        "A value that is not JSON never reaches the handler, yet its offset is committed, so the records behind it are processed and the group's lag reaches zero.",
      match: {
        python: {all: [/json\.loads\(\s*msg\.value\(\)\s*\)/, /except\s*\(\s*ValueError\s*,\s*TypeError\s*\)/]},
        typescript: {all: [/JSON\.parse\(/, /catch\b/]},
        go: {all: [/if err := json\.Unmarshal\(msg\.Value, &event\); err != nil/]},
        scala: {all: [/Try\(\s*ujson\.read\(\s*record\.value\(\)\s*\)\s*\)/]},
        cpp: {all: [/json::parse\(/, /catch\s*\(\s*const\s+json::parse_error\s*&?\s*\)/]},
      },
    },
    {
      id: 'handler-fault',
      title: 'A failing handler leaves its record uncommitted',
      detail:
        "When the handler raises, the loop stops and the committed offset stays before that record: it will be redelivered. The handler's error must not be swallowed.",
      match: {
        python: {all: [/\bhandler\(event\)/], none: [/except\s+Exception\b/, /except\s*:/, /except\s+BaseException\b/]},
        typescript: {
          all: [/await handler\(event\)/],
          none: [/try\s*\{\s*\n?\s*await handler\(/, /handler\(event\)\.catch\(/],
        },
        go: {all: [/if err := handler\(event\); err != nil \{\n\s*return err/]},
        scala: {all: [/case Success\(event\)\s*=>\s*handler\(event\)/], none: [/Try\(\s*handler\(/, /NonFatal/]},
        cpp: {
          all: [/\bhandler\(event\)/],
          none: [/catch\s*\(\s*(const\s+)?std::exception/, /catch\s*\(\s*\.\.\.\s*\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
from collections.abc import Callable

from confluent_kafka import Consumer

log = logging.getLogger("ledger-writer")

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "ledger-writer",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["payments"])


def run(handler: Callable[[dict], None]) -> None:
    """Deliver every payment to \`handler\`; commit each record's offset once it is processed."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: parse the JSON value; log and skip a malformed record (but still commit it)
        # TODO: call handler(event), then commit this record's offset synchronously
        raise NotImplementedError
`,
      solution: `import json
import logging
from collections.abc import Callable

from confluent_kafka import Consumer

log = logging.getLogger("ledger-writer")

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "ledger-writer",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["payments"])


def run(handler: Callable[[dict], None]) -> None:
    """Deliver every payment to \`handler\`; commit each record's offset once it is processed."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        try:
            event = json.loads(msg.value())
        except (ValueError, TypeError):
            log.warning("skipping malformed record %s[%d]@%d", msg.topic(), msg.partition(), msg.offset())
        else:
            handler(event)  # raises → the loop ends here, this record uncommitted
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export type PaymentEvent = Record<string, unknown>;
export type Handler = (event: PaymentEvent) => void | Promise<void>;

const kafka = new Kafka({clientId: 'ledger-writer', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'ledger-writer'});

/** Deliver every payment to \`handler\`; commit each record's offset once it is processed. */
export async function run(handler: Handler): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'payments', fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit (autoCommit: false)
    eachMessage: async ({topic, partition, message}) => {
      // TODO: parse the JSON value; log and skip a malformed record (but still commit it)
      // TODO: await handler(event), then commitOffsets for this record (offset + 1)
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

export type PaymentEvent = Record<string, unknown>;
export type Handler = (event: PaymentEvent) => void | Promise<void>;

const kafka = new Kafka({clientId: 'ledger-writer', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'ledger-writer'});

/** Deliver every payment to \`handler\`; commit each record's offset once it is processed. */
export async function run(handler: Handler): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'payments', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      let event: PaymentEvent | null = null;
      try {
        event = JSON.parse(message.value?.toString() ?? '') as PaymentEvent;
      } catch {
        console.warn(\`skipping malformed record \${topic}[\${partition}]@\${message.offset}\`);
      }
      if (event !== null) await handler(event); // rejects → run rejects, this record uncommitted
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
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
	"log"

	"github.com/segmentio/kafka-go"
)

type PaymentEvent = map[string]any
type Handler func(event PaymentEvent) error

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     "ledger-writer",
	Topic:       "payments",
	StartOffset: kafka.FirstOffset,
})

// run delivers every payment to handler and commits each record's offset once it is processed.
func run(ctx context.Context, handler Handler) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: parse the JSON value; log and skip a malformed record (but still commit it)
		// TODO: call handler(event) — return its error uncommitted — then CommitMessages for this record
		_ = json.Unmarshal
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

	"github.com/segmentio/kafka-go"
)

type PaymentEvent = map[string]any
type Handler func(event PaymentEvent) error

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     "ledger-writer",
	Topic:       "payments",
	StartOffset: kafka.FirstOffset,
})

// run delivers every payment to handler and commits each record's offset once it is processed.
func run(ctx context.Context, handler Handler) error {
	for {
		msg, err := reader.FetchMessage(ctx) // FetchMessage leaves the commit to us
		if err != nil {
			return err
		}
		var event PaymentEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record %s[%d]@%d", msg.Topic, msg.Partition, msg.Offset)
		} else if err := handler(event); err != nil {
			return err // uncommitted: the record is redelivered
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

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.jdk.CollectionConverters._
import scala.util.{Failure, Success, Try}

object LedgerConsumer {
  type Handler = ujson.Value => Unit

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "ledger-writer")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("payments").asJava)

  /** Delivers every payment to \`handler\`; commits each record's offset once it is processed. */
  def run(handler: Handler): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        // TODO: parse the JSON value with ujson; log and skip a malformed record (but still commit it)
        // TODO: call handler(event), then commitSync this record's offset + 1 for its partition
        throw new NotImplementedError
      }
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.jdk.CollectionConverters._
import scala.util.{Failure, Success, Try}

object LedgerConsumer {
  type Handler = ujson.Value => Unit

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "ledger-writer")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("payments").asJava)

  /** Delivers every payment to \`handler\`; commits each record's offset once it is processed. */
  def run(handler: Handler): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        Try(ujson.read(record.value())) match {
          case Success(event) => handler(event) // throws → the loop ends here, this record uncommitted
          case Failure(_) =>
            System.err.println(s"skipping malformed record \${record.topic()}[\${record.partition()}]@\${record.offset()}")
        }
        val tp = new TopicPartition(record.topic(), record.partition())
        consumer.commitSync(Map(tp -> new OffsetAndMetadata(record.offset() + 1)).asJava)
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <functional>
#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;
using Handler = std::function<void(const json&)>;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "ledger-writer", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"payments"});
  return consumer;
}

auto consumer = make_consumer();

// Delivers every payment to handler; commits each record's offset once it is processed.
void run(const Handler& handler) {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    // TODO: json::parse the value; log and skip a malformed record (but still commit it)
    // TODO: call handler(event) — let it throw — then commitSync this message
    throw std::logic_error("not implemented");
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <functional>
#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;
using Handler = std::function<void(const json&)>;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "ledger-writer", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"payments"});
  return consumer;
}

auto consumer = make_consumer();

// Delivers every payment to handler; commits each record's offset once it is processed. A throwing
// handler propagates out of run with its record uncommitted, so it is redelivered.
void run(const Handler& handler) {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    json event;
    try {
      event = json::parse(value);
    } catch (const json::parse_error&) {
      std::cerr << "skipping malformed record " << msg->topic_name() << "[" << msg->partition() << "]@"
                << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    handler(event);
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

GROUP = "ledger-writer"
TOPIC = "payments"


def _seed(ctx, partition, n):
    """n well-formed payments on one partition; each value says where it sits, so the handler's view can be checked."""
    start = ctx.kafka.end_offset(TOPIC, partition)
    for i in range(n):
        offset = start + i
        value = json.dumps({"id": f"pay-{partition}-{offset}", "partition": partition, "offset": offset, "cents": 100 * (offset + 1)})
        ctx.kafka.seed(TOPIC, key=f"acct-{partition}", value=value, partition=partition)


def _run(ctx, handler):
    m = ctx.load("ledger_consumer")
    ctx.drain(m.run, handler)


def _offsets(seen, partition):
    return [e["offset"] for e in seen if e["partition"] == partition]


def check_in_order(ctx):
    _seed(ctx, 0, 3)
    _seed(ctx, 1, 3)
    _seed(ctx, 2, 2)
    seen = []
    _run(ctx, seen.append)
    assert all(isinstance(e, dict) for e in seen), "the handler must receive the parsed JSON object, not the raw value"
    assert len(seen) == 8, f"the handler saw {len(seen)} events, expected all 8"
    for p, n in ((0, 3), (1, 3), (2, 2)):
        got = _offsets(seen, p)
        assert got == list(range(n)), f"partition {p} reached the handler as offsets {got}, expected {list(range(n))}"


def check_manual_commit(ctx):
    _seed(ctx, 0, 2)
    _seed(ctx, 1, 1)
    _run(ctx, lambda event: None)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, before processing"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened"
    commits = ctx.kafka.commits(GROUP)
    assert len(commits) == 3, f"{len(commits)} commits for 3 records: commit once per record, after it is processed"
    assert all(len(c) == 1 for c in commits), "each commit must name the processed record's partition alone"


def check_committed_offset(ctx):
    _seed(ctx, 0, 3)
    _seed(ctx, 1, 2)
    _run(ctx, lambda event: None)
    for p, n in ((0, 3), (1, 2)):
        committed = ctx.kafka.committed_offset(GROUP, TOPIC, p)
        assert committed == n, f"partition {p}: committed offset is {committed}, expected {n} (the next offset to read)"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, "every processed record must be committed"


def check_commit_after(ctx):
    _seed(ctx, 0, 2)
    _seed(ctx, 1, 2)
    processed = set()
    early = []

    def hook(group, offsets):
        for (topic, partition), offset in offsets.items():
            if (partition, offset - 1) not in processed:
                early.append(f"{topic}[{partition}] committed to {offset} before the handler finished offset {offset - 1}")

    ctx.kafka.on_commit(hook)
    _run(ctx, lambda event: processed.add((event["partition"], event["offset"])))
    assert len(ctx.kafka.commits(GROUP)) == 4, "expected one commit per record"
    assert not early, early[0]


def check_poison(ctx):
    _seed(ctx, 0, 1)
    ctx.kafka.seed(TOPIC, key="acct-0", value="not json", partition=0)
    _seed(ctx, 0, 1)
    ctx.kafka.seed(TOPIC, key="acct-1", value='{"id": "pay-1-0", "cents": ', partition=1)
    seen = []
    _run(ctx, seen.append)
    assert _offsets(seen, 0) == [0, 2], f"partition 0 reached the handler as offsets {_offsets(seen, 0)}, expected [0, 2]: skip the poison record, process the ones behind it"
    assert len(seen) == 2, "the malformed records must not reach the handler"
    assert ctx.kafka.committed_offset(GROUP, TOPIC, 0) == 3, "partition 0 must be committed past the poison record"
    assert ctx.kafka.committed_offset(GROUP, TOPIC, 1) == 1, "partition 1 must be committed past the poison record"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, "a malformed record must be skipped and committed, not left to replay forever"


def check_handler_fault(ctx):
    _seed(ctx, 0, 3)
    seen = []

    def handler(event):
        seen.append(event)
        if event["offset"] == 1:
            raise RuntimeError("ledger unavailable")

    m = ctx.load("ledger_consumer")
    try:
        ctx.drain(m.run, handler)
    except RuntimeError:
        pass
    committed = ctx.kafka.committed_offset(GROUP, TOPIC, 0)
    assert committed == 1, f"committed offset is {committed}, expected 1: the record whose handler raised must stay uncommitted"
    assert _offsets(seen, 0) == [0, 1], f"the handler saw offsets {_offsets(seen, 0)}, expected [0, 1]: a raising handler stops the loop"
    assert ctx.kafka.lag(GROUP, TOPIC) == 2, "the failed record and the one behind it must remain for redelivery"
`,
    typescript: `const GROUP = 'ledger-writer';
const TOPIC = 'payments';

type Seen = {partition: number; offset: number};

/** n well-formed payments on one partition; each value says where it sits, so the handler's view can be checked. */
function seed(ctx, partition: number, n: number) {
  const start = ctx.kafka.endOffset(TOPIC, partition);
  for (let i = 0; i < n; i++) {
    const offset = start + i;
    const value = JSON.stringify({id: \`pay-\${partition}-\${offset}\`, partition, offset, cents: 100 * (offset + 1)});
    ctx.kafka.seed(TOPIC, {key: \`acct-\${partition}\`, value, partition});
  }
}

async function run(ctx, handler: (event: Seen) => void) {
  const m = ctx.load('ledger_consumer');
  await ctx.drain(m.run(handler));
}

const offsets = (seen: Seen[], partition: number) => seen.filter(e => e.partition === partition).map(e => e.offset);

export async function check_in_order(ctx) {
  seed(ctx, 0, 3);
  seed(ctx, 1, 3);
  seed(ctx, 2, 2);
  const seen: Seen[] = [];
  await run(ctx, e => seen.push(e));
  assert(seen.every(e => typeof e === 'object' && e !== null), 'the handler must receive the parsed JSON object, not the raw value');
  assert.equal(seen.length, 8, \`the handler saw \${seen.length} events, expected all 8\`);
  for (const [p, n] of [[0, 3], [1, 3], [2, 2]]) {
    const expected = Array.from({length: n}, (_, i) => i);
    assert.deepEqual(offsets(seen, p), expected, \`partition \${p} reached the handler as offsets \${JSON.stringify(offsets(seen, p))}, expected \${JSON.stringify(expected)}\`);
  }
}

export async function check_manual_commit(ctx) {
  seed(ctx, 0, 2);
  seed(ctx, 1, 1);
  await run(ctx, () => undefined);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, before processing');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened');
  const commits = ctx.kafka.commits(GROUP);
  assert.equal(commits.length, 3, \`\${commits.length} commits for 3 records: commit once per record, after it is processed\`);
  assert(commits.every(c => Object.keys(c).length === 1), "each commit must name the processed record's partition alone");
}

export async function check_committed_offset(ctx) {
  seed(ctx, 0, 3);
  seed(ctx, 1, 2);
  await run(ctx, () => undefined);
  for (const [p, n] of [[0, 3], [1, 2]]) {
    const committed = ctx.kafka.committedOffset(GROUP, TOPIC, p);
    assert.equal(committed, n, \`partition \${p}: committed offset is \${committed}, expected \${n} (the next offset to read)\`);
  }
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'every processed record must be committed');
}

export async function check_commit_after(ctx) {
  seed(ctx, 0, 2);
  seed(ctx, 1, 2);
  const processed = new Set<string>();
  const early: string[] = [];
  ctx.kafka.onCommit((group, offsets: Map<string, number>) => {
    for (const [tp, offset] of offsets) {
      const [topic, partition] = tp.split('|');
      if (!processed.has(\`\${partition}|\${offset - 1}\`))
        early.push(\`\${topic}[\${partition}] committed to \${offset} before the handler finished offset \${offset - 1}\`);
    }
  });
  await run(ctx, e => {
    processed.add(\`\${e.partition}|\${e.offset}\`);
  });
  assert.equal(ctx.kafka.commits(GROUP).length, 4, 'expected one commit per record');
  assert(early.length === 0, early[0]);
}

export async function check_poison(ctx) {
  seed(ctx, 0, 1);
  ctx.kafka.seed(TOPIC, {key: 'acct-0', value: 'not json', partition: 0});
  seed(ctx, 0, 1);
  ctx.kafka.seed(TOPIC, {key: 'acct-1', value: '{"id": "pay-1-0", "cents": ', partition: 1});
  const seen: Seen[] = [];
  await run(ctx, e => seen.push(e));
  assert.deepEqual(offsets(seen, 0), [0, 2], \`partition 0 reached the handler as offsets \${JSON.stringify(offsets(seen, 0))}, expected [0, 2]: skip the poison record, process the ones behind it\`);
  assert.equal(seen.length, 2, 'the malformed records must not reach the handler');
  assert.equal(ctx.kafka.committedOffset(GROUP, TOPIC, 0), 3, 'partition 0 must be committed past the poison record');
  assert.equal(ctx.kafka.committedOffset(GROUP, TOPIC, 1), 1, 'partition 1 must be committed past the poison record');
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'a malformed record must be skipped and committed, not left to replay forever');
}

export async function check_handler_fault(ctx) {
  seed(ctx, 0, 3);
  const seen: Seen[] = [];
  const m = ctx.load('ledger_consumer');
  await ctx
    .drain(
      m.run((e: Seen) => {
        seen.push(e);
        if (e.offset === 1) throw new Error('ledger unavailable');
      }),
    )
    .catch(() => undefined);
  const committed = ctx.kafka.committedOffset(GROUP, TOPIC, 0);
  assert.equal(committed, 1, \`committed offset is \${committed}, expected 1: the record whose handler threw must stay uncommitted\`);
  assert.deepEqual(offsets(seen, 0), [0, 1], \`the handler saw offsets \${JSON.stringify(offsets(seen, 0))}, expected [0, 1]: a throwing handler stops the loop\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 2, 'the failed record and the one behind it must remain for redelivery');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"leetbuild/harness"
)

const ledgerGroup, ledgerTopic = "ledger-writer", "payments"

// ledgerSeen is where a record the handler received sits: its value says so.
type ledgerSeen struct{ partition, offset int }

// seedLedger puts n well-formed payments on one partition; each value says where it sits, so the
// handler's view can be checked.
func seedLedger(ctx *harness.Ctx, partition, n int) {
	start := ctx.Kafka.EndOffset(ledgerTopic, partition)
	for i := range n {
		offset := start + int64(i)
		value, _ := json.Marshal(map[string]any{"id": fmt.Sprintf("pay-%d-%d", partition, offset), "partition": partition, "offset": offset, "cents": 100 * (offset + 1)})
		ctx.Kafka.SeedPartition(ledgerTopic, partition, fmt.Sprintf("acct-%d", partition), value)
	}
}

// runLedger drains the learner's loop with handler.
func runLedger(ctx *harness.Ctx, handler Handler) {
	loop, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx.Drain(func() { _ = run(loop, handler) })
}

// ledgerPlace reads where an event sits from its value (-1 for a field that is missing).
func ledgerPlace(event PaymentEvent) ledgerSeen {
	at := func(field string) int {
		if v, ok := event[field].(float64); ok {
			return int(v)
		}
		return -1
	}
	return ledgerSeen{at("partition"), at("offset")}
}

func ledgerOffsets(seen []ledgerSeen, partition int) []int {
	out := []int{}
	for _, s := range seen {
		if s.partition == partition {
			out = append(out, s.offset)
		}
	}
	return out
}

func CheckInOrder(ctx *harness.Ctx) {
	seedLedger(ctx, 0, 3)
	seedLedger(ctx, 1, 3)
	seedLedger(ctx, 2, 2)
	var events []PaymentEvent
	runLedger(ctx, func(e PaymentEvent) error {
		events = append(events, e)
		return nil
	})
	var seen []ledgerSeen
	for _, e := range events {
		ctx.Assert(e != nil, "the handler must receive the parsed JSON object, not the raw value")
		seen = append(seen, ledgerPlace(e))
	}
	ctx.Assert(len(seen) == 8, "the handler saw %d events, expected all 8", len(seen))
	for _, pn := range [][2]int{{0, 3}, {1, 3}, {2, 2}} {
		p, n := pn[0], pn[1]
		expected := []int{}
		for i := range n {
			expected = append(expected, i)
		}
		ctx.Equal(ledgerOffsets(seen, p), expected, "partition %d reached the handler as offsets", p)
	}
}

func CheckManualCommit(ctx *harness.Ctx) {
	seedLedger(ctx, 0, 2)
	seedLedger(ctx, 1, 1)
	runLedger(ctx, func(PaymentEvent) error { return nil })
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "auto-commit is on: offsets were committed on a timer, before processing")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened")
	commits := ctx.Kafka.Commits(ledgerGroup)
	ctx.Assert(len(commits) == 3, "%d commits for 3 records: commit once per record, after it is processed", len(commits))
	for _, c := range commits {
		ctx.Assert(len(c) == 1, "each commit must name the processed record's partition alone")
	}
}

func CheckCommittedOffset(ctx *harness.Ctx) {
	seedLedger(ctx, 0, 3)
	seedLedger(ctx, 1, 2)
	runLedger(ctx, func(PaymentEvent) error { return nil })
	for _, pn := range [][2]int{{0, 3}, {1, 2}} {
		p, n := pn[0], pn[1]
		committed := ctx.Kafka.CommittedOffset(ledgerGroup, ledgerTopic, p)
		ctx.Assert(committed == int64(n), "partition %d: committed offset is %d, expected %d (the next offset to read)", p, committed, n)
	}
	ctx.Equal(ctx.Kafka.Lag(ledgerGroup, ledgerTopic), 0, "every processed record must be committed")
}

func CheckCommitAfter(ctx *harness.Ctx) {
	seedLedger(ctx, 0, 2)
	seedLedger(ctx, 1, 2)
	processed := map[ledgerSeen]bool{}
	var early []string
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		for tp, offset := range offsets {
			if !processed[ledgerSeen{tp.Partition, int(offset - 1)}] {
				early = append(early, fmt.Sprintf("%s[%d] committed to %d before the handler finished offset %d", tp.Topic, tp.Partition, offset, offset-1))
			}
		}
	})
	runLedger(ctx, func(e PaymentEvent) error {
		processed[ledgerPlace(e)] = true
		return nil
	})
	ctx.Equal(len(ctx.Kafka.Commits(ledgerGroup)), 4, "expected one commit per record")
	if len(early) > 0 {
		ctx.Fatalf("%s", early[0])
	}
}

func CheckPoison(ctx *harness.Ctx) {
	seedLedger(ctx, 0, 1)
	ctx.Kafka.SeedPartition(ledgerTopic, 0, "acct-0", "not json")
	seedLedger(ctx, 0, 1)
	ctx.Kafka.SeedPartition(ledgerTopic, 1, "acct-1", \`{"id": "pay-1-0", "cents": \`)
	var seen []ledgerSeen
	runLedger(ctx, func(e PaymentEvent) error {
		seen = append(seen, ledgerPlace(e))
		return nil
	})
	ctx.Equal(ledgerOffsets(seen, 0), []int{0, 2}, "partition 0 reached the handler as offsets (skip the poison record, process the ones behind it)")
	ctx.Equal(len(seen), 2, "the malformed records must not reach the handler")
	ctx.Equal(ctx.Kafka.CommittedOffset(ledgerGroup, ledgerTopic, 0), 3, "partition 0 must be committed past the poison record")
	ctx.Equal(ctx.Kafka.CommittedOffset(ledgerGroup, ledgerTopic, 1), 1, "partition 1 must be committed past the poison record")
	ctx.Equal(ctx.Kafka.Lag(ledgerGroup, ledgerTopic), 0, "a malformed record must be skipped and committed, not left to replay forever")
}

func CheckHandlerFault(ctx *harness.Ctx) {
	seedLedger(ctx, 0, 3)
	var seen []ledgerSeen
	runLedger(ctx, func(e PaymentEvent) error {
		s := ledgerPlace(e)
		seen = append(seen, s)
		if s.offset == 1 {
			return errors.New("ledger unavailable")
		}
		return nil
	})
	committed := ctx.Kafka.CommittedOffset(ledgerGroup, ledgerTopic, 0)
	ctx.Assert(committed == 1, "committed offset is %d, expected 1: the record whose handler failed must stay uncommitted", committed)
	ctx.Equal(ledgerOffsets(seen, 0), []int{0, 1}, "the handler saw offsets (a failing handler stops the loop)")
	ctx.Equal(ctx.Kafka.Lag(ledgerGroup, ledgerTopic), 2, "the failed record and the one behind it must remain for redelivery")
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <exception>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

const std::string ledgerGroup = "ledger-writer";
const std::string ledgerTopic = "payments";

// ledgerSeen is where a record the handler received sits: its value says so.
using ledgerSeen = std::pair<int, int>;

// seedLedger puts n well-formed payments on one partition; each value says where it sits, so the
// handler's view can be checked.
void seedLedger(harness::Ctx& ctx, int partition, int n) {
  const int64_t start = ctx.Kafka.EndOffset(ledgerTopic, partition);
  for (int i = 0; i < n; i++) {
    const int64_t offset = start + i;
    const nlohmann::json value = {{"id", "pay-" + std::to_string(partition) + "-" + std::to_string(offset)},
                                  {"partition", partition},
                                  {"offset", offset},
                                  {"cents", 100 * (offset + 1)}};
    ctx.Kafka.SeedPartition(ledgerTopic, partition, "acct-" + std::to_string(partition), value);
  }
}

// runLedger drains the learner's loop with handler; a handler's error ends the loop.
void runLedger(harness::Ctx& ctx, const Handler& handler) {
  try {
    ctx.Drain([&] { run(handler); });
  } catch (const std::exception&) {
  }
}

// ledgerPlace reads where an event sits from its value (-1 for a field that is missing).
ledgerSeen ledgerPlace(const nlohmann::json& event) {
  const auto at = [&](const char* field) {
    return event.is_object() && event.contains(field) && event[field].is_number() ? event[field].get<int>() : -1;
  };
  return {at("partition"), at("offset")};
}

std::vector<int> ledgerOffsets(const std::vector<ledgerSeen>& seen, int partition) {
  std::vector<int> out;
  for (const auto& s : seen)
    if (s.first == partition) out.push_back(s.second);
  return out;
}

}  // namespace

void CheckInOrder(harness::Ctx& ctx) {
  seedLedger(ctx, 0, 3);
  seedLedger(ctx, 1, 3);
  seedLedger(ctx, 2, 2);
  std::vector<nlohmann::json> events;
  runLedger(ctx, [&](const nlohmann::json& e) { events.push_back(e); });
  std::vector<ledgerSeen> seen;
  for (const auto& e : events) {
    ctx.Assert(e.is_object(), "the handler must receive the parsed JSON object, not the raw value");
    seen.push_back(ledgerPlace(e));
  }
  ctx.Assert(seen.size() == 8, "the handler saw %d events, expected all 8", seen.size());
  for (const auto& [p, n] : std::vector<std::pair<int, int>>{{0, 3}, {1, 3}, {2, 2}}) {
    std::vector<int> expected;
    for (int i = 0; i < n; i++) expected.push_back(i);
    ctx.Equal(ledgerOffsets(seen, p), expected, "partition %d reached the handler as offsets", p);
  }
}

void CheckManualCommit(harness::Ctx& ctx) {
  seedLedger(ctx, 0, 2);
  seedLedger(ctx, 1, 1);
  runLedger(ctx, [](const nlohmann::json&) {});
  ctx.Assert(ctx.Kafka.EventsOf("auto-commit").empty(), "auto-commit is on: offsets were committed on a timer, before processing");
  ctx.Assert(!ctx.Kafka.EventsOf("manual-commit").empty(), "no explicit commit happened");
  const auto commits = ctx.Kafka.Commits(ledgerGroup);
  ctx.Assert(commits.size() == 3, "%d commits for 3 records: commit once per record, after it is processed", commits.size());
  for (const auto& c : commits) ctx.Assert(c.size() == 1, "each commit must name the processed record's partition alone");
}

void CheckCommittedOffset(harness::Ctx& ctx) {
  seedLedger(ctx, 0, 3);
  seedLedger(ctx, 1, 2);
  runLedger(ctx, [](const nlohmann::json&) {});
  for (const auto& [p, n] : std::vector<std::pair<int, int>>{{0, 3}, {1, 2}}) {
    const int64_t committed = ctx.Kafka.CommittedOffset(ledgerGroup, ledgerTopic, p);
    ctx.Assert(committed == n, "partition %d: committed offset is %d, expected %d (the next offset to read)", p, committed, n);
  }
  ctx.Equal(ctx.Kafka.Lag(ledgerGroup, ledgerTopic), 0, "every processed record must be committed");
}

void CheckCommitAfter(harness::Ctx& ctx) {
  seedLedger(ctx, 0, 2);
  seedLedger(ctx, 1, 2);
  std::vector<ledgerSeen> processed;
  std::vector<std::string> early;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) {
    for (const auto& [tp, offset] : offsets) {
      bool done = false;
      for (const auto& s : processed) done = done || s == ledgerSeen{tp.Partition, static_cast<int>(offset - 1)};
      if (!done)
        early.push_back(harness::Sprintf("%s[%d] committed to %d before the handler finished offset %d", tp.Topic,
                                         tp.Partition, offset, offset - 1));
    }
  });
  runLedger(ctx, [&](const nlohmann::json& e) { processed.push_back(ledgerPlace(e)); });
  ctx.Equal(ctx.Kafka.Commits(ledgerGroup).size(), 4, "expected one commit per record");
  if (!early.empty()) ctx.Fatalf("%s", early[0]);
}

void CheckPoison(harness::Ctx& ctx) {
  seedLedger(ctx, 0, 1);
  ctx.Kafka.SeedPartition(ledgerTopic, 0, "acct-0", "not json");
  seedLedger(ctx, 0, 1);
  ctx.Kafka.SeedPartition(ledgerTopic, 1, "acct-1", R"({"id": "pay-1-0", "cents": )");
  std::vector<ledgerSeen> seen;
  runLedger(ctx, [&](const nlohmann::json& e) { seen.push_back(ledgerPlace(e)); });
  ctx.Equal(ledgerOffsets(seen, 0), {0, 2},
            "partition 0 reached the handler as offsets (skip the poison record, process the ones behind it)");
  ctx.Equal(seen.size(), 2, "the malformed records must not reach the handler");
  ctx.Equal(ctx.Kafka.CommittedOffset(ledgerGroup, ledgerTopic, 0), 3, "partition 0 must be committed past the poison record");
  ctx.Equal(ctx.Kafka.CommittedOffset(ledgerGroup, ledgerTopic, 1), 1, "partition 1 must be committed past the poison record");
  ctx.Equal(ctx.Kafka.Lag(ledgerGroup, ledgerTopic), 0,
            "a malformed record must be skipped and committed, not left to replay forever");
}

void CheckHandlerFault(harness::Ctx& ctx) {
  seedLedger(ctx, 0, 3);
  std::vector<ledgerSeen> seen;
  runLedger(ctx, [&](const nlohmann::json& e) {
    const ledgerSeen s = ledgerPlace(e);
    seen.push_back(s);
    if (s.second == 1) throw std::runtime_error("ledger unavailable");
  });
  const int64_t committed = ctx.Kafka.CommittedOffset(ledgerGroup, ledgerTopic, 0);
  ctx.Assert(committed == 1, "committed offset is %d, expected 1: the record whose handler failed must stay uncommitted", committed);
  ctx.Equal(ledgerOffsets(seen, 0), {0, 1}, "the handler saw offsets (a failing handler stops the loop)");
  ctx.Equal(ctx.Kafka.Lag(ledgerGroup, ledgerTopic), 2, "the failed record and the one behind it must remain for redelivery");
}
`,
  },
  debrief: `The loop has one commit site and it sits last, so the only question is which records reach it. A poison record reaches it by skipping the handler: committing it is the right call because nothing a retry does will make it parse, and leaving it uncommitted stalls the partition behind it. A record whose handler raised never reaches it: the exception leaves the loop before the commit, the offset stays where it was, and the restart replays that record — at-least-once, which means the handler must tolerate seeing it twice. Auto-commit would have broken both properties at once: it commits what was fetched, on a timer, regardless of what the handler did with it. Real consumers keep this exact shape and add what the drill leaves out — a commit per poll batch instead of per record, \`on_revoke\` committing before a rebalance takes the partition away, a dead-letter topic for poison records, and bounded retries before giving up on a handler.`,
};
