import type {Step} from '@/lib/types';

export const tieredRetryStep: Step = {
  id: 'tiered-retry',
  title: 'Tiered retry topics with non-blocking delays',
  concept: 'kafka',
  file: 'tiered_retry',
  focus: ['worker', 'retry'],
  task: `## Task

Implement \`run(handler)\`: a member of consumer group **\`tasks-workers\`** over **\`tasks\`**,
**\`tasks.retry.5s\`**, **\`tasks.retry.30s\`** and **\`tasks.retry.5m\`**, auto-commit off, that calls
\`handler(key, value)\` (both strings) for every record that is due. \`TIERS = [5000, 30000, 300000]\`
milliseconds, one per retry topic in that order; \`tasks.dlq\` is the end of the line.

- **Hand-off on failure.** When the handler raises, read the record's \`attempt\` header (0 when absent)
  and produce the record — **same key, same value** — with \`attempt + 1\`:
  - to the tier whose index is \`attempt\` (\`tasks\` → \`tasks.retry.5s\` → \`tasks.retry.30s\` →
    \`tasks.retry.5m\`), with headers \`attempt\` (decimal string), \`error\` (the exception's message) and
    \`not_before\` = the current time in **epoch milliseconds** plus that tier's delay;
  - after the last tier (\`attempt + 1 > 3\`) to **\`tasks.dlq\`** with \`attempt\` and \`error\` only.
  - **Flush / await the send (\`acks=all\`) before committing** the source offset; a hand-off that was
    not acknowledged is not committed.
- **A record that is not due** (\`not_before\` in the future) is **not handled and not skipped**:
  \`pause\` its partition, \`seek\` the partition back to that record's offset, remember when it is due,
  and move on — the main topic and the other partitions keep flowing. Never sleep until \`not_before\`.
- **When the clock reaches a remembered \`not_before\`**, \`resume\` the partition (the seek makes the
  same record the next one read) and handle it like any other; a record without \`not_before\` is due.
- Success → commit the record's offset synchronously; a hand-off → commit after the flush. Every
  record the loop handles, on any of the four topics, ends with its offset committed.

:::widget delivery-semantics {}

> Kafka has no delayed delivery. A delay is a topic per tier, a timestamp in a header, and a consumer
> that pauses a partition instead of its own thread.`,
  sequence: {
    participants: ['Kafka', 'worker', 'handler'],
    messages: [
      {from: 'Kafka', to: 'worker', label: 'poll → tasks (key a)', kind: 'reply'},
      {from: 'worker', to: 'handler', label: 'handler("a", "job-a")', kind: 'sync'},
      {from: 'handler', to: 'worker', label: 'raises "boom"', kind: 'reply'},
      {
        from: 'worker',
        to: 'Kafka',
        label: 'produce tasks.retry.5s (attempt=1, not_before=now+5000) · flush',
        kind: 'sync',
      },
      {from: 'Kafka', to: 'worker', label: 'ack (acks=all)', kind: 'reply'},
      {from: 'worker', to: 'Kafka', label: 'commit tasks offset', kind: 'sync'},
      {from: 'Kafka', to: 'worker', label: 'poll → tasks.retry.5s (not due for 5 s)', kind: 'reply'},
      {
        from: 'worker',
        to: 'Kafka',
        label: 'pause(tasks.retry.5s[p]) · seek(offset) — tasks keeps flowing',
        kind: 'sync',
      },
      {from: 'worker', to: 'Kafka', label: 'now ≥ not_before: resume(tasks.retry.5s[p])', kind: 'sync'},
      {
        from: 'Kafka',
        to: 'worker',
        label: 'poll → the same record → handler → … → tasks.dlq (attempt=4)',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'One `forward(msg, error)` for every destination: next attempt = header + 1; `attempt <= len(TIERS)` picks `RETRY_TOPICS[attempt - 1]` and adds `not_before = now_ms + TIERS[attempt - 1]`, otherwise the DLQ; produce with the same key and value, then flush / await before returning to the loop.',
    'Keep a map `(topic, partition) → (not_before, offset)` of paused partitions. On a record that is not due: `pause([tp])`, `seek(tp at that offset)` (the consumer already moved past it), record it, `continue` — no commit. At the top of every loop turn (TypeScript: on a `setInterval`), resume and seek every entry whose time has come and drop it from the map.',
    'Never `sleep` until `not_before` and never commit a record you did not handle: the first stalls every partition behind one delayed record, the second loses it. The checks measure both — the clock may only move as much as the handlers move it, and the main topic must be handled while a retry partition waits.',
  ],
  checks: [
    {
      id: 'group',
      title: 'Consumes tasks and all three retry topics in tasks-workers, auto-commit off',
      detail:
        'The consumer uses group `tasks-workers`, subscribes to `tasks`, `tasks.retry.5s`, `tasks.retry.30s` and `tasks.retry.5m`, never auto-commits, and commits every handled record explicitly.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*(GROUP|"tasks-workers")/,
            /"enable\.auto\.commit"\s*:\s*False/,
            /subscribe\(\s*\[\s*TOPIC,\s*\*RETRY_TOPICS\s*\]/,
          ],
        },
        typescript: {
          all: [
            /groupId:\s*(GROUP|['"]tasks-workers['"])/,
            /autoCommit:\s*false/,
            /subscribe\(\s*\{[^}]*topics:\s*\[\s*TOPIC,\s*\.\.\.RETRY_TOPICS\s*\]/,
          ],
        },
        go: {
          all: [
            /"group\.id":\s*(group|"tasks-workers")/,
            /"enable\.auto\.commit":\s*false/,
            /SubscribeTopics\(\s*append\(\[\]string\{topic\},\s*retryTopics\.\.\.\)/,
          ],
        },
        scala: {
          all: [
            /"group\.id"\s*,\s*(Group|"tasks-workers")/,
            /"enable\.auto\.commit"\s*,\s*"false"/,
            /subscribe\(\s*\(Topic \+: RetryTopics\)\.asJava\s*\)/,
          ],
        },
        cpp: {
          all: [
            /"group\.id"\s*,\s*(kGroup|"tasks-workers")/,
            /"enable\.auto\.commit"\s*,\s*"false"/,
            /consumer->subscribe\(\s*topics\s*\)/,
          ],
        },
      },
    },
    {
      id: 'escalates',
      title: 'A record that always fails climbs 5s → 30s → 5m → dlq with attempt and not_before headers',
      detail:
        'With the clock moved past each tier by other handlers, the record appears once on every retry topic (same key and value, `attempt` 1, 2, 3, `not_before` = the failure time + 5 000 / 30 000 / 300 000 ms, handled no earlier than that) and ends on `tasks.dlq` with `attempt` 4 and `error`.',
      match: {
        python: {all: [/producer\.produce\(/, /"attempt"/, /"not_before"/, /TIERS\[/, /DLQ_TOPIC/]},
        typescript: {all: [/producer\.send\(/, /attempt:\s*String\(/, /not_before/, /TIERS\[/, /DLQ_TOPIC/]},
        go: {all: [/producer\.Produce\(/, /Key:\s*"attempt"/, /Key:\s*"not_before"/, /tiers\[/, /dlqTopic/]},
        scala: {all: [/producer\.send\(/, /"attempt"/, /"not_before"/, /Tiers\(/, /DlqTopic/]},
        cpp: {all: [/producer->produce\(/, /"attempt"/, /"not_before"/, /kTiers\[/, /kDlqTopic/]},
      },
    },
    {
      id: 'not-before',
      title: 'A retry record is not handled before its not_before, and not skipped either',
      detail:
        'A `tasks.retry.5s` record due in 5 s is handled exactly once, at a clock time ≥ `not_before`, and its partition is not committed before that: the consumer pauses the partition and seeks back to the record.',
      match: {
        python: {all: [/consumer\.pause\(/, /consumer\.seek\(/]},
        typescript: {all: [/consumer\.pause\(/, /consumer\.seek\(/]},
        go: {all: [/consumer\.Pause\(/, /consumer\.Seek\(/]},
        scala: {all: [/consumer\.pause\(/, /consumer\.seek\(/]},
        cpp: {all: [/consumer->pause\(/, /consumer->seek\(/]},
      },
    },
    {
      id: 'non-blocking',
      title: 'A paused retry partition never blocks tasks and never sleeps the delay away',
      detail:
        'While a retry record waits 5 s, records on `tasks` keep being handled before it is due, and the clock moves only as much as the handlers move it — no `sleep` until `not_before`; the partition is resumed when the time comes.',
      match: {
        python: {all: [/consumer\.resume\(/], none: [/time\.sleep\(/]},
        typescript: {all: [/consumer\.resume\(/], none: [/new Promise\([^\n]*setTimeout/]},
        go: {all: [/consumer\.Resume\(/], none: [/time\.Sleep\(/]},
        scala: {all: [/consumer\.resume\(/], none: [/Thread\.sleep\(/]},
        cpp: {all: [/consumer->resume\(/], none: [/sleep_for\(/]},
      },
    },
    {
      id: 'flush-before-commit',
      title: 'The hand-off is acknowledged before the source offset is committed',
      detail:
        'With `tasks.retry.5s` stalled for 2 s, the commit of the failed `tasks` record happens only once the broker answers and the retry record is on the topic — never with the hand-off still in flight.',
      match: {
        python: {order: [/producer\.produce\(/, /producer\.flush\(/, /consumer\.commit\(/]},
        typescript: {order: [/await producer\.send\(/, /consumer\.commitOffsets\(/]},
        go: {order: [/producer\.Produce\(/, /producer\.Flush\(/, /consumer\.CommitMessage\(/]},
        scala: {order: [/producer\.send\([^\n]*\)\.get\(\)/, /consumer\.commitSync\(/]},
        cpp: {order: [/producer->produce\(/, /producer->flush\(/, /consumer->commitSync\(/]},
      },
    },
    {
      id: 'retry-succeeds',
      title: 'A retry that succeeds is not forwarded; nothing is lost',
      detail:
        'A due `tasks.retry.5s` record whose handler succeeds and a `tasks` record that succeeds are each handled once, nothing new lands on any retry topic or the DLQ, and every offset is committed.',
      match: {
        python: {order: [/(?<!def )handler\(/, /except Exception/, /(?<!def )forward\(/]},
        typescript: {order: [/await handler\(/, /catch/, /await forward\(/]},
        go: {order: [/:= handler\(/, /err != nil/, /(?<!func )forward\(/]},
        scala: {order: [/try handler\(/, /case NonFatal\(/, /(?<!def )forward\(/]},
        cpp: {order: [/\bhandler\(/, /catch \(const std::exception/, /(?<!void )forward\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Tiered retry topics: a failed task climbs tasks.retry.5s → 30s → 5m → tasks.dlq; a record that is not due pauses its partition."""
import logging
import time
from typing import Callable

from confluent_kafka import Consumer, Producer, TopicPartition

TOPIC = "tasks"
TIERS = [5000, 30000, 300000]  # ms, one per retry topic
RETRY_TOPICS = ["tasks.retry.5s", "tasks.retry.30s", "tasks.retry.5m"]
DLQ_TOPIC = "tasks.dlq"
GROUP = "tasks-workers"

log = logging.getLogger(GROUP)

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe([TOPIC])  # TODO: the three retry topics too
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def now_ms() -> int:
    return int(time.time() * 1000)


def header(msg, name: str) -> str | None:
    """A header's value as text, None when absent."""
    for key, value in msg.headers() or []:
        if key == name:
            return None if value is None else value.decode()
    return None


def forward(msg, error: Exception) -> None:
    """Hand the record to the next tier — or the DLQ after the last — and wait for the acknowledgement."""
    # TODO: attempt = header attempt + 1; attempt <= len(TIERS) → RETRY_TOPICS[attempt - 1] with not_before = now_ms() + TIERS[attempt - 1], else DLQ_TOPIC
    # TODO: produce with the same key and value, headers attempt / error (/ not_before); flush before returning
    raise NotImplementedError


def run(handler: Callable[[str, str], None]) -> None:
    while True:
        # TODO: resume (and seek back to the remembered offset) every paused partition whose not_before has passed
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: not_before in the future → pause the partition, seek back to msg.offset(), remember when it is due, continue
        # TODO: call handler(key, value); on an exception forward(msg, exc); then commit the offset synchronously
        handler((msg.key() or b"").decode(), (msg.value() or b"").decode())
        consumer.commit(message=msg, asynchronous=False)
`,
      solution: `"""Tiered retry topics: a failed task climbs tasks.retry.5s → 30s → 5m → tasks.dlq; a record that is not due pauses its partition."""
import logging
import time
from typing import Callable

from confluent_kafka import Consumer, Producer, TopicPartition

TOPIC = "tasks"
TIERS = [5000, 30000, 300000]  # ms, one per retry topic
RETRY_TOPICS = ["tasks.retry.5s", "tasks.retry.30s", "tasks.retry.5m"]
DLQ_TOPIC = "tasks.dlq"
GROUP = "tasks-workers"

log = logging.getLogger(GROUP)

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC, *RETRY_TOPICS])
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def now_ms() -> int:
    return int(time.time() * 1000)


def header(msg, name: str) -> str | None:
    """A header's value as text, None when absent."""
    for key, value in msg.headers() or []:
        if key == name:
            return None if value is None else value.decode()
    return None


def forward(msg, error: Exception) -> None:
    """Hand the record to the next tier — or the DLQ after the last — and wait for the acknowledgement."""
    attempt = int(header(msg, "attempt") or 0) + 1
    headers = {"attempt": str(attempt), "error": str(error)}
    if attempt <= len(TIERS):
        topic = RETRY_TOPICS[attempt - 1]
        headers["not_before"] = str(now_ms() + TIERS[attempt - 1])
    else:
        topic = DLQ_TOPIC
    producer.produce(topic, key=msg.key(), value=msg.value(), headers=headers)
    producer.flush()  # acknowledged before the caller commits the source offset


def run(handler: Callable[[str, str], None]) -> None:
    waiting: dict[tuple[str, int], tuple[int, int]] = {}  # (topic, partition) -> (not_before, offset)
    while True:
        now = now_ms()
        for (topic, partition), (due, offset) in list(waiting.items()):
            if now >= due:
                tp = TopicPartition(topic, partition, offset)
                consumer.resume([tp])
                consumer.seek(tp)  # the next record read from this partition is the one that waited
                del waiting[(topic, partition)]
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        not_before = int(header(msg, "not_before") or 0)
        if not_before > now_ms():
            tp = TopicPartition(msg.topic(), msg.partition(), msg.offset())
            consumer.pause([tp])  # nothing from this partition until it is due; every other partition keeps flowing
            consumer.seek(tp)  # the consumer already moved past the record: put it back under the cursor
            waiting[(msg.topic(), msg.partition())] = (not_before, msg.offset())
            continue  # not committed: a crash here replays it, which is correct — it was never handled
        try:
            handler((msg.key() or b"").decode(), (msg.value() or b"").decode())
        except Exception as exc:
            forward(msg, exc)
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';
import type {KafkaMessage} from 'kafkajs';

export const TOPIC = 'tasks';
export const TIERS = [5000, 30000, 300000]; // ms, one per retry topic
export const RETRY_TOPICS = ['tasks.retry.5s', 'tasks.retry.30s', 'tasks.retry.5m'];
export const DLQ_TOPIC = 'tasks.dlq';
export const GROUP = 'tasks-workers';

export type Handler = (key: string, value: string) => void | Promise<void>;

const kafka = new Kafka({clientId: GROUP, brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});
const producer = kafka.producer({idempotent: true});

/** A header's value as text, null when absent. */
function header(message: KafkaMessage, name: string): string | null {
  const raw = message.headers?.[name];
  return raw === undefined || raw === null ? null : raw.toString();
}

/** Hand the record to the next tier — or the DLQ after the last — and resolve once the broker acknowledged it. */
async function forward(message: KafkaMessage, error: Error): Promise<void> {
  // TODO: attempt = header attempt + 1; attempt <= TIERS.length → RETRY_TOPICS[attempt - 1] with not_before = Date.now() + TIERS[attempt - 1], else DLQ_TOPIC
  // TODO: send the same key and value with headers attempt / error (/ not_before), acks: -1, and await it
  throw new Error('not implemented');
}

export async function run(handler: Handler): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({topics: [TOPIC], fromBeginning: true}); // TODO: the three retry topics too
  await consumer.run({
    // TODO: autoCommit: false
    eachMessage: async ({topic, partition, message}) => {
      // TODO: not_before in the future → consumer.pause the partition, seek back to message.offset, remember when it is due, return
      // TODO: a timer (setInterval) that resumes and seeks every remembered partition whose not_before has passed
      // TODO: await handler(key, value); on a throw await forward(message, error); then commitOffsets (offset + 1)
      await handler(message.key?.toString() ?? '', message.value?.toString() ?? '');
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';
import type {KafkaMessage} from 'kafkajs';

export const TOPIC = 'tasks';
export const TIERS = [5000, 30000, 300000]; // ms, one per retry topic
export const RETRY_TOPICS = ['tasks.retry.5s', 'tasks.retry.30s', 'tasks.retry.5m'];
export const DLQ_TOPIC = 'tasks.dlq';
export const GROUP = 'tasks-workers';

export type Handler = (key: string, value: string) => void | Promise<void>;

const kafka = new Kafka({clientId: GROUP, brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});
const producer = kafka.producer({idempotent: true});

/** A header's value as text, null when absent. */
function header(message: KafkaMessage, name: string): string | null {
  const raw = message.headers?.[name];
  return raw === undefined || raw === null ? null : raw.toString();
}

/** Hand the record to the next tier — or the DLQ after the last — and resolve once the broker acknowledged it. */
async function forward(message: KafkaMessage, error: Error): Promise<void> {
  const attempt = Number(header(message, 'attempt') ?? 0) + 1;
  const headers: Record<string, string> = {attempt: String(attempt), error: error.message};
  let topic = DLQ_TOPIC;
  if (attempt <= TIERS.length) {
    topic = RETRY_TOPICS[attempt - 1];
    headers.not_before = String(Date.now() + TIERS[attempt - 1]);
  }
  await producer.send({topic, acks: -1, messages: [{key: message.key, value: message.value, headers}]});
}

interface Waiting {
  topic: string;
  partition: number;
  offset: string;
  notBefore: number;
}

export async function run(handler: Handler): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({topics: [TOPIC, ...RETRY_TOPICS], fromBeginning: true});
  const waiting = new Map<string, Waiting>(); // paused partitions and the record each one waits for
  const resumeDue = (): void => {
    const now = Date.now();
    for (const [key, w] of waiting) {
      if (now < w.notBefore) continue;
      waiting.delete(key);
      consumer.resume([{topic: w.topic, partitions: [w.partition]}]);
      consumer.seek({topic: w.topic, partition: w.partition, offset: w.offset}); // the waiting record is read next
    }
  };
  setInterval(resumeDue, 1000); // the worker's clock: a paused partition is resumed the second it is due
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const notBefore = Number(header(message, 'not_before') ?? 0);
      if (notBefore > Date.now()) {
        consumer.pause([{topic, partitions: [partition]}]); // nothing more from this partition; every other one keeps flowing
        consumer.seek({topic, partition, offset: message.offset}); // put the record back under the cursor
        waiting.set(\`\${topic}|\${partition}\`, {topic, partition, offset: message.offset, notBefore});
        return; // not committed: it was never handled
      }
      try {
        await handler(message.key?.toString() ?? '', message.value?.toString() ?? '');
      } catch (e) {
        await forward(message, e as Error);
      }
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

const (
	topic    = "tasks"
	dlqTopic = "tasks.dlq"
	group    = "tasks-workers"
)

var (
	tiers       = []int64{5000, 30000, 300000} // ms, one per retry topic
	retryTopics = []string{"tasks.retry.5s", "tasks.retry.30s", "tasks.retry.5m"}
)

var consumer, _ = kafka.NewConsumer(&kafka.ConfigMap{
	"bootstrap.servers": "kafka:9092",
	"group.id":          group,
	"auto.offset.reset": "earliest",
	// TODO: "enable.auto.commit": false
})

var producer, _ = kafka.NewProducer(&kafka.ConfigMap{
	"bootstrap.servers":  "kafka:9092",
	"acks":               "all",
	"enable.idempotence": true,
})

type Handler func(key, value string) error

func nowMs() int64 { return time.Now().UnixMilli() }

// header returns a header's value as text, "" when absent.
func header(msg *kafka.Message, name string) string {
	for _, h := range msg.Headers {
		if h.Key == name {
			return string(h.Value)
		}
	}
	return ""
}

// forward hands the record to the next tier — or the DLQ after the last — and waits for the acknowledgement.
func forward(msg *kafka.Message, cause error) error {
	// TODO: attempt = header attempt + 1; attempt <= len(tiers) → retryTopics[attempt-1] with not_before = nowMs() + tiers[attempt-1], else dlqTopic
	// TODO: Produce the same Key and Value with headers attempt / error (/ not_before); Flush and check the delivery report
	return fmt.Errorf("not implemented")
}

func run(handler Handler) error {
	if err := consumer.SubscribeTopics([]string{topic}, nil); err != nil { // TODO: the three retry topics too
		return err
	}
	for {
		// TODO: Resume (and Seek back to the remembered offset) every paused partition whose not_before has passed
		ev := consumer.Poll(1000)
		msg, ok := ev.(*kafka.Message)
		if !ok {
			if e, isErr := ev.(kafka.Error); isErr {
				log.Printf("consumer error: %v", e)
			}
			continue
		}
		// TODO: not_before in the future → Pause the partition, Seek back to msg.TopicPartition, remember when it is due, continue
		// TODO: handler(key, value); on an error forward(msg, err); then CommitMessage
		_ = strconv.Itoa
		if err := handler(string(msg.Key), string(msg.Value)); err != nil {
			return err
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

const (
	topic    = "tasks"
	dlqTopic = "tasks.dlq"
	group    = "tasks-workers"
)

var (
	tiers       = []int64{5000, 30000, 300000} // ms, one per retry topic
	retryTopics = []string{"tasks.retry.5s", "tasks.retry.30s", "tasks.retry.5m"}
)

var consumer, _ = kafka.NewConsumer(&kafka.ConfigMap{
	"bootstrap.servers":  "kafka:9092",
	"group.id":           group,
	"auto.offset.reset":  "earliest",
	"enable.auto.commit": false,
})

var producer, _ = kafka.NewProducer(&kafka.ConfigMap{
	"bootstrap.servers":  "kafka:9092",
	"acks":               "all",
	"enable.idempotence": true,
})

type Handler func(key, value string) error

// pending is a paused partition and the record it waits for.
type pending struct {
	tp  kafka.TopicPartition // Offset = the waiting record
	due int64
}

func nowMs() int64 { return time.Now().UnixMilli() }

// header returns a header's value as text, "" when absent.
func header(msg *kafka.Message, name string) string {
	for _, h := range msg.Headers {
		if h.Key == name {
			return string(h.Value)
		}
	}
	return ""
}

// forward hands the record to the next tier — or the DLQ after the last — and waits for the acknowledgement.
func forward(msg *kafka.Message, cause error) error {
	attempt, _ := strconv.Atoi(header(msg, "attempt"))
	attempt++
	target := dlqTopic
	headers := []kafka.Header{
		{Key: "attempt", Value: []byte(strconv.Itoa(attempt))},
		{Key: "error", Value: []byte(cause.Error())},
	}
	if attempt <= len(tiers) {
		target = retryTopics[attempt-1]
		headers = append(headers, kafka.Header{Key: "not_before", Value: []byte(strconv.FormatInt(nowMs()+tiers[attempt-1], 10))})
	}
	delivered := make(chan kafka.Event, 1)
	err := producer.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &target, Partition: kafka.PartitionAny},
		Key:            msg.Key,
		Value:          msg.Value,
		Headers:        headers,
	}, delivered)
	if err != nil {
		return err
	}
	producer.Flush(5000) // acknowledged before the caller commits the source offset
	if report := (<-delivered).(*kafka.Message); report.TopicPartition.Error != nil {
		return report.TopicPartition.Error
	}
	return nil
}

func run(handler Handler) error {
	if err := consumer.SubscribeTopics(append([]string{topic}, retryTopics...), nil); err != nil {
		return err
	}
	waiting := map[string]pending{} // "topic|partition" → the paused partition
	for {
		now := nowMs()
		for key, p := range waiting {
			if now >= p.due {
				consumer.Resume([]kafka.TopicPartition{p.tp})
				consumer.Seek(p.tp, 0) // the waiting record is read next
				delete(waiting, key)
			}
		}
		ev := consumer.Poll(1000)
		msg, ok := ev.(*kafka.Message)
		if !ok {
			if e, isErr := ev.(kafka.Error); isErr {
				log.Printf("consumer error: %v", e)
			}
			continue
		}
		notBefore, _ := strconv.ParseInt(header(msg, "not_before"), 10, 64)
		if notBefore > nowMs() {
			tp := msg.TopicPartition // Offset is this record's offset
			consumer.Pause([]kafka.TopicPartition{tp}) // nothing more from this partition; every other one keeps flowing
			consumer.Seek(tp, 0)                       // put the record back under the cursor
			waiting[fmt.Sprintf("%s|%d", *tp.Topic, tp.Partition)] = pending{tp: tp, due: notBefore}
			continue // not committed: it was never handled
		}
		if err := handler(string(msg.Key), string(msg.Value)); err != nil {
			if ferr := forward(msg, err); ferr != nil {
				return ferr // not committed: the record is redelivered
			}
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
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
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.collection.mutable
import scala.jdk.CollectionConverters._
import scala.util.control.NonFatal

object TieredRetry {
  val Topic = "tasks"
  val Tiers = Seq(5000L, 30000L, 300000L) // ms, one per retry topic
  val RetryTopics = Seq("tasks.retry.5s", "tasks.retry.30s", "tasks.retry.5m")
  val DlqTopic = "tasks.dlq"
  val Group = "tasks-workers"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", Group)
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava) // TODO: the three retry topics too

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** A header's value as text, None when absent. */
  private def header(record: ConsumerRecord[String, String], name: String): Option[String] =
    Option(record.headers().lastHeader(name)).map(h => new String(h.value()))

  /** Hand the record to the next tier — or the DLQ after the last — and wait for the acknowledgement. */
  def forward(record: ConsumerRecord[String, String], cause: Throwable): Unit = {
    // TODO: attempt = header attempt + 1; attempt <= Tiers.size → RetryTopics(attempt - 1) with not_before = now + Tiers(attempt - 1), else DlqTopic
    // TODO: a ProducerRecord with the same key and value, headers attempt / error (/ not_before); send(...).get() before returning
  }

  def run(handler: (String, String) => Unit): Unit = {
    val waiting = mutable.Map.empty[TopicPartition, (Long, Long)] // partition -> (not_before, offset)
    while (true) {
      // TODO: resume (and seek back to the remembered offset) every paused partition whose not_before has passed
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val tp = new TopicPartition(record.topic(), record.partition())
        // TODO: not_before in the future → pause(tp), seek(tp, record.offset()), remember when it is due; skip the rest of a paused partition's batch
        // TODO: handler(key, value); NonFatal → forward(record, e); then commitSync this record's offset + 1
        handler(record.key(), record.value())
        consumer.commitSync(Map(tp -> new OffsetAndMetadata(record.offset() + 1)).asJava)
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.collection.mutable
import scala.jdk.CollectionConverters._
import scala.util.control.NonFatal

object TieredRetry {
  val Topic = "tasks"
  val Tiers = Seq(5000L, 30000L, 300000L) // ms, one per retry topic
  val RetryTopics = Seq("tasks.retry.5s", "tasks.retry.30s", "tasks.retry.5m")
  val DlqTopic = "tasks.dlq"
  val Group = "tasks-workers"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", Group)
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe((Topic +: RetryTopics).asJava)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** A header's value as text, None when absent. */
  private def header(record: ConsumerRecord[String, String], name: String): Option[String] =
    Option(record.headers().lastHeader(name)).map(h => new String(h.value()))

  /** Hand the record to the next tier — or the DLQ after the last — and wait for the acknowledgement. */
  def forward(record: ConsumerRecord[String, String], cause: Throwable): Unit = {
    val attempt = header(record, "attempt").map(_.toInt).getOrElse(0) + 1
    val target = if (attempt <= Tiers.size) RetryTopics(attempt - 1) else DlqTopic
    val out = new ProducerRecord[String, String](target, record.key(), record.value())
    out.headers().add("attempt", attempt.toString.getBytes)
    out.headers().add("error", String.valueOf(cause.getMessage).getBytes)
    if (attempt <= Tiers.size)
      out.headers().add("not_before", (System.currentTimeMillis() + Tiers(attempt - 1)).toString.getBytes)
    producer.send(out).get() // acknowledged before the caller commits the source offset
  }

  def run(handler: (String, String) => Unit): Unit = {
    val waiting = mutable.Map.empty[TopicPartition, (Long, Long)] // partition -> (not_before, offset)
    while (true) {
      val now = System.currentTimeMillis()
      waiting.toList.foreach { case (tp, (due, offset)) =>
        if (now >= due) {
          consumer.resume(Set(tp).asJava)
          consumer.seek(tp, offset) // the waiting record is read next
          waiting.remove(tp)
        }
      }
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val tp = new TopicPartition(record.topic(), record.partition())
        if (!waiting.contains(tp)) { // the rest of a paused partition's batch is dropped: the seek re-reads it
          val notBefore = header(record, "not_before").map(_.toLong).getOrElse(0L)
          if (notBefore > System.currentTimeMillis()) {
            consumer.pause(Set(tp).asJava) // nothing more from this partition; every other one keeps flowing
            consumer.seek(tp, record.offset()) // put the record back under the cursor
            waiting(tp) = (notBefore, record.offset()) // not committed: it was never handled
          } else {
            try handler(record.key(), record.value())
            catch { case NonFatal(e) => forward(record, e) }
            consumer.commitSync(Map(tp -> new OffsetAndMetadata(record.offset() + 1)).asJava)
          }
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

const std::string kTopic = "tasks";
const std::vector<long long> kTiers = {5000, 30000, 300000};  // ms, one per retry topic
const std::vector<std::string> kRetryTopics = {"tasks.retry.5s", "tasks.retry.30s", "tasks.retry.5m"};
const std::string kDlqTopic = "tasks.dlq";
const std::string kGroup = "tasks-workers";

using Handler = std::function<void(const std::string& key, const std::string& value)>;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  std::vector<std::string> topics{kTopic};  // TODO: the three retry topics too
  consumer->subscribe(topics);
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();

long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// A header's value as text, "" when absent.
std::string header(RdKafka::Message& msg, const std::string& name) {
  if (!msg.headers()) return "";
  const RdKafka::Headers::Header h = msg.headers()->get_last(name);
  if (h.err() != RdKafka::ERR_NO_ERROR) return "";
  return std::string(static_cast<const char*>(h.value()), h.value_size());
}

// Hand the record to the next tier — or the DLQ after the last — and wait for the acknowledgement.
void forward(RdKafka::Message& msg, const std::exception& cause) {
  // TODO: attempt = header attempt + 1; attempt <= kTiers.size() → kRetryTopics[attempt - 1] with not_before = now_ms() + kTiers[attempt - 1], else kDlqTopic
  // TODO: produce the same payload and key (RK_MSG_COPY) with headers attempt / error (/ not_before); flush before returning
  throw std::runtime_error("not implemented");
}

void run(const Handler& handler) {
  // (topic, partition) -> (not_before, offset)
  std::map<std::pair<std::string, int>, std::pair<long long, long long>> waiting;
  while (true) {
    // TODO: resume (and seek back to the remembered offset) every paused partition whose not_before has passed
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    // TODO: not_before in the future → pause the partition, seek back to msg->offset(), remember when it is due, continue
    // TODO: handler(key, value); catch std::exception → forward(*msg, e); then commitSync this message
    handler(msg->key() ? *msg->key() : "", std::string(static_cast<const char*>(msg->payload()), msg->len()));
    consumer->commitSync(msg.get());
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

const std::string kTopic = "tasks";
const std::vector<long long> kTiers = {5000, 30000, 300000};  // ms, one per retry topic
const std::vector<std::string> kRetryTopics = {"tasks.retry.5s", "tasks.retry.30s", "tasks.retry.5m"};
const std::string kDlqTopic = "tasks.dlq";
const std::string kGroup = "tasks-workers";

using Handler = std::function<void(const std::string& key, const std::string& value)>;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  std::vector<std::string> topics{kTopic};
  topics.insert(topics.end(), kRetryTopics.begin(), kRetryTopics.end());
  consumer->subscribe(topics);
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();

long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// A header's value as text, "" when absent.
std::string header(RdKafka::Message& msg, const std::string& name) {
  if (!msg.headers()) return "";
  const RdKafka::Headers::Header h = msg.headers()->get_last(name);
  if (h.err() != RdKafka::ERR_NO_ERROR) return "";
  return std::string(static_cast<const char*>(h.value()), h.value_size());
}

// Hand the record to the next tier — or the DLQ after the last — and wait for the acknowledgement.
void forward(RdKafka::Message& msg, const std::exception& cause) {
  const std::string previous = header(msg, "attempt");
  const int attempt = (previous.empty() ? 0 : std::stoi(previous)) + 1;
  auto headers = std::unique_ptr<RdKafka::Headers>(RdKafka::Headers::create());
  headers->add("attempt", std::to_string(attempt));
  headers->add("error", cause.what());
  std::string target = kDlqTopic;
  if (attempt <= static_cast<int>(kTiers.size())) {
    target = kRetryTopics[attempt - 1];
    headers->add("not_before", std::to_string(now_ms() + kTiers[attempt - 1]));
  }
  const RdKafka::ErrorCode err =
      producer->produce(target, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, msg.payload(), msg.len(),
                        msg.key_pointer(), msg.key_len(), 0, headers.get(), nullptr);
  if (err != RdKafka::ERR_NO_ERROR) throw std::runtime_error("hand-off failed: " + RdKafka::err2str(err));
  headers.release();      // owned by the producer once produce() accepted the message
  producer->flush(5000);  // acknowledged before the caller commits the source offset
}

void run(const Handler& handler) {
  // (topic, partition) -> (not_before, offset)
  std::map<std::pair<std::string, int>, std::pair<long long, long long>> waiting;
  while (true) {
    const long long now = now_ms();
    for (auto it = waiting.begin(); it != waiting.end();) {
      if (now >= it->second.first) {
        std::unique_ptr<RdKafka::TopicPartition> tp(
            RdKafka::TopicPartition::create(it->first.first, it->first.second, it->second.second));
        std::vector<RdKafka::TopicPartition*> one{tp.get()};
        consumer->resume(one);
        consumer->seek(*tp, 1000);  // the waiting record is read next
        it = waiting.erase(it);
      } else {
        ++it;
      }
    }
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string raw = header(*msg, "not_before");
    const long long not_before = raw.empty() ? 0 : std::stoll(raw);
    if (not_before > now_ms()) {
      std::unique_ptr<RdKafka::TopicPartition> tp(
          RdKafka::TopicPartition::create(msg->topic_name(), msg->partition(), msg->offset()));
      std::vector<RdKafka::TopicPartition*> one{tp.get()};
      consumer->pause(one);       // nothing more from this partition; every other one keeps flowing
      consumer->seek(*tp, 1000);  // put the record back under the cursor
      waiting[{msg->topic_name(), msg->partition()}] = {not_before, msg->offset()};
      continue;  // not committed: it was never handled
    }
    try {
      handler(msg->key() ? *msg->key() : "", std::string(static_cast<const char*>(msg->payload()), msg->len()));
    } catch (const std::exception& e) {
      forward(*msg, e);
    }
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `TIERS = [5000, 30000, 300000]
RETRY = ["tasks.retry.5s", "tasks.retry.30s", "tasks.retry.5m"]
GROUP = "tasks-workers"


def _now(ctx):
    return int(ctx.clock.time() * 1000)


def _header(record, name):
    for header, value in record.headers:
        if header == name:
            return value.decode()
    return None


def _seed(ctx, topic, key, value, attempt=None, not_before=None):
    headers = []
    if attempt is not None:
        headers.append(("attempt", str(attempt)))
    if not_before is not None:
        headers.append(("not_before", str(not_before)))
    return ctx.kafka.seed(topic, key=key, value=value, headers=headers or None, partition=0)


def _worker(ctx, fails=(), advance=None):
    """The module and a handler that records (key, value, clock ms), moves the clock by advance[key] seconds, and raises "boom" for keys in fails."""
    m = ctx.load("tiered_retry")
    calls = []
    advance = advance or {}

    def handler(key, value):
        calls.append((key, value, _now(ctx)))
        if key in advance:
            ctx.clock.advance(advance[key])
        if key in fails:
            raise RuntimeError("boom")

    return m, calls, handler


def _all_committed(ctx):
    for topic in ["tasks", *RETRY]:
        assert ctx.kafka.lag(GROUP, topic) == 0, f"{topic}: {ctx.kafka.lag(GROUP, topic)} handled record(s) left uncommitted"


def check_group(ctx):
    _seed(ctx, "tasks", "a", "job-a")
    m, calls, handler = _worker(ctx)
    ctx.drain(m.run, handler)
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer must subscribe to the topics"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == GROUP, f"group.id must be {GROUP}, got {group!r}"
    for topic in ["tasks", *RETRY]:
        assert topic in topics, f"the consumer must subscribe to {topic} as well; it subscribed to {topics}"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, before processing"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened"
    assert [(k, v) for k, v, _ in calls] == [("a", "job-a")], f"the handler must see (key, value) once per record, saw {[(k, v) for k, v, _ in calls]}"
    _all_committed(ctx)


def check_escalates(ctx):
    _seed(ctx, "tasks", "a", "job-a")
    for key in ("f1", "f2", "f3"):
        _seed(ctx, "tasks", key, "job-" + key)
    m, calls, handler = _worker(ctx, fails={"a"}, advance={"f1": 6, "f2": 40, "f3": 400})
    ctx.drain(m.run, handler)
    tries = [c for c in calls if c[0] == "a"]
    assert len(tries) == 4, f"a record that always fails is tried once on tasks and once per tier (4 times); the handler saw it {len(tries)} times"
    assert all(v == "job-a" for _, v, _ in tries), "every retry must hand the handler the original value"
    for i, topic in enumerate(RETRY):
        records = ctx.kafka.records(topic)
        assert len(records) == 1, f"{topic} must hold the failed record exactly once, holds {len(records)}"
        assert records[0].key == b"a" and records[0].value == b"job-a", f"{topic}: the hand-off must keep key a and value job-a, got {(records[0].key, records[0].value)}"
        assert _header(records[0], "attempt") == str(i + 1), f"{topic}: the attempt header must be {i + 1}, got {_header(records[0], 'attempt')!r}"
        raw = _header(records[0], "not_before")
        assert raw is not None and raw.isdigit(), f"{topic}: the hand-off needs a not_before header in epoch milliseconds, got {raw!r}"
        gap = int(raw) - tries[i][2]
        assert TIERS[i] - 5 <= gap <= TIERS[i] + 2000, f"{topic}: not_before must be the failure time + {TIERS[i]} ms, it is {gap} ms after the handler failed"
        assert tries[i + 1][2] >= int(raw) - 5, f"{topic}: the record was handled {int(raw) - tries[i + 1][2]} ms before its not_before"
    dlq = ctx.kafka.records("tasks.dlq")
    assert len(dlq) == 1, f"after the last tier the record is dead-lettered once, tasks.dlq holds {len(dlq)}"
    assert dlq[0].key == b"a" and dlq[0].value == b"job-a", "the dead letter must keep the key and value"
    assert _header(dlq[0], "attempt") == "4", f"the dead letter's attempt header must be 4, got {_header(dlq[0], 'attempt')!r}"
    assert _header(dlq[0], "error") == "boom", f"the dead letter's error header must carry the exception's message, got {_header(dlq[0], 'error')!r}"
    assert sorted(k for k, _, _ in calls if k != "a") == ["f1", "f2", "f3"], "the other tasks records must each be handled once"
    _all_committed(ctx)


def _waiting_world(ctx):
    """One retry record due in 5 s on tasks.retry.5s and six tasks records whose handlers each move the clock 1 s."""
    t0 = _now(ctx)
    _seed(ctx, "tasks.retry.5s", "x", "job-x", attempt=1, not_before=t0 + 5000)
    fillers = [f"f{i}" for i in range(1, 7)]
    for key in fillers:
        _seed(ctx, "tasks", key, "job-" + key)
    return t0, fillers


def check_not_before(ctx):
    t0, fillers = _waiting_world(ctx)
    commits = []
    ctx.kafka.on_commit(lambda group, offsets: commits.append((dict(offsets), _now(ctx))))
    m, calls, handler = _worker(ctx, advance={key: 1 for key in fillers})
    ctx.drain(m.run, handler)
    xs = [c for c in calls if c[0] == "x"]
    assert len(xs) == 1, f"the retry record must be handled exactly once, the handler saw it {len(xs)} times"
    assert xs[0][2] >= t0 + 5000 - 5, f"the retry record was handled {t0 + 5000 - xs[0][2]} ms before its not_before: a record that is not due is paused, not processed"
    early = [o for o, at in commits if any(t == "tasks.retry.5s" for t, _ in o) and at < xs[0][2]]
    assert not early, "tasks.retry.5s was committed before its record was handled: a record that is not due must not be skipped"
    assert ctx.kafka.records("tasks.retry.30s") == [] and ctx.kafka.records("tasks.dlq") == [], "a retry that succeeds is not forwarded"
    _all_committed(ctx)


def check_non_blocking(ctx):
    t0, fillers = _waiting_world(ctx)
    m, calls, handler = _worker(ctx, advance={key: 1 for key in fillers})
    ctx.drain(m.run, handler)
    xs = [c for c in calls if c[0] == "x"]
    assert len(xs) == 1 and xs[0][2] >= t0 + 5000 - 5, "the retry record must be handled exactly once, no earlier than its not_before"
    handled = [c for c in calls if c[0] != "x"]
    assert sorted(k for k, _, _ in handled) == fillers, f"every tasks record must be handled once, saw {sorted(k for k, _, _ in handled)}"
    before = [c for c in handled if c[2] < t0 + 5000]
    assert len(before) >= 3, f"only {len(before)} of the 6 tasks records were handled before the retry record was due: a paused retry partition must not block tasks"
    moved = _now(ctx) - t0
    assert moved <= 6000 + 2000, f"the clock moved {moved} ms while the handlers moved it 6000 ms: the worker slept the delay away instead of pausing the partition"
    _all_committed(ctx)


def check_flush_before_commit(ctx):
    t0 = _now(ctx)
    _seed(ctx, "tasks", "a", "job-a")
    ctx.kafka.stall("tasks.retry.5s", 2)
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((dict(offsets), len(ctx.kafka.records("tasks.retry.5s")), _now(ctx))))
    m, calls, handler = _worker(ctx, fails={"a"})
    ctx.drain(m.run, handler)
    assert ("produce-stalled", "tasks.retry.5s") in ctx.kafka.events, "the failure must be produced to tasks.retry.5s (it was stalled)"
    source = [(n, at) for offsets, n, at in at_commit if any(t == "tasks" for t, _ in offsets)]
    assert source, "the tasks offset was never committed"
    assert source[0][0] == 1, "the tasks offset was committed while the hand-off was still in flight: flush / await the send first"
    assert source[0][1] >= t0 + 2000, "the commit must wait out the stall (2 s of virtual time) for the broker's acknowledgement"
    assert ctx.kafka.lag(GROUP, "tasks") == 0, "the failed record's offset must be committed once the hand-off is acknowledged"


def check_retry_succeeds(ctx):
    _seed(ctx, "tasks.retry.5s", "b", "job-b", attempt=1, not_before=0)
    _seed(ctx, "tasks", "c", "job-c")
    m, calls, handler = _worker(ctx)
    ctx.drain(m.run, handler)
    assert sorted((k, v) for k, v, _ in calls) == [("b", "job-b"), ("c", "job-c")], f"a due retry record and a tasks record are each handled once, saw {[(k, v) for k, v, _ in calls]}"
    for topic in ("tasks.retry.30s", "tasks.retry.5m", "tasks.dlq"):
        assert ctx.kafka.records(topic) == [], f"a record whose handler succeeds is not forwarded, {topic} holds {len(ctx.kafka.records(topic))}"
    assert len(ctx.kafka.records("tasks.retry.5s")) == 1, "a record whose handler succeeds is not re-produced"
    _all_committed(ctx)
`,
    typescript: `const TIERS = [5000, 30000, 300000];
const RETRY = ['tasks.retry.5s', 'tasks.retry.30s', 'tasks.retry.5m'];
const GROUP = 'tasks-workers';

type Call = {key: string; value: string; at: number};

const header = (record, name: string): string | null => {
  const value = record.headers?.[name];
  return value === undefined ? null : Buffer.from(value).toString();
};

function seed(ctx, topic: string, key: string, value: string, attempt: number | null = null, notBefore: number | null = null) {
  const headers: Record<string, string> = {};
  if (attempt !== null) headers.attempt = String(attempt);
  if (notBefore !== null) headers.not_before = String(notBefore);
  return ctx.kafka.seed(topic, {key, value, headers, partition: 0});
}

/** The module and a handler that records (key, value, clock ms), moves the clock by advance[key] seconds, and throws "boom" for keys in fails. */
function worker(ctx, fails: string[] = [], advance: Record<string, number> = {}) {
  const m = ctx.load('tiered_retry');
  const calls: Call[] = [];
  const handler = async (key: string, value: string) => {
    calls.push({key, value, at: ctx.clock.now()});
    if (key in advance) ctx.clock.advance(advance[key]);
    if (fails.includes(key)) throw new Error('boom');
  };
  return {m, calls, handler};
}

function allCommitted(ctx) {
  for (const topic of ['tasks', ...RETRY])
    assert.equal(ctx.kafka.lag(GROUP, topic), 0, \`\${topic}: \${ctx.kafka.lag(GROUP, topic)} handled record(s) left uncommitted\`);
}

export async function check_group(ctx) {
  seed(ctx, 'tasks', 'a', 'job-a');
  const {m, calls, handler} = worker(ctx);
  await ctx.drain(m.run(handler));
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer must subscribe to the topics');
  const [, group, topics] = subscriptions[subscriptions.length - 1];
  assert.equal(group, GROUP, \`groupId must be \${GROUP}, got \${JSON.stringify(group)}\`);
  for (const topic of ['tasks', ...RETRY])
    assert(topics.includes(topic), \`the consumer must subscribe to \${topic} as well; it subscribed to \${JSON.stringify(topics)}\`);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, before processing');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened');
  assert.deepEqual(calls.map(c => [c.key, c.value]), [['a', 'job-a']], \`the handler must see (key, value) once per record, saw \${JSON.stringify(calls.map(c => [c.key, c.value]))}\`);
  allCommitted(ctx);
}

export async function check_escalates(ctx) {
  seed(ctx, 'tasks', 'a', 'job-a');
  for (const key of ['f1', 'f2', 'f3']) seed(ctx, 'tasks', key, 'job-' + key);
  const {m, calls, handler} = worker(ctx, ['a'], {f1: 6, f2: 40, f3: 400});
  await ctx.drain(m.run(handler));
  const tries = calls.filter(c => c.key === 'a');
  assert.equal(tries.length, 4, \`a record that always fails is tried once on tasks and once per tier (4 times); the handler saw it \${tries.length} times\`);
  assert(tries.every(c => c.value === 'job-a'), 'every retry must hand the handler the original value');
  RETRY.forEach((topic, i) => {
    const records = ctx.kafka.records(topic);
    assert.equal(records.length, 1, \`\${topic} must hold the failed record exactly once, holds \${records.length}\`);
    assert(ctx.kafka.keys(topic)[0] === 'a' && ctx.kafka.values(topic)[0] === 'job-a', \`\${topic}: the hand-off must keep key a and value job-a, got \${JSON.stringify([ctx.kafka.keys(topic)[0], ctx.kafka.values(topic)[0]])}\`);
    assert.equal(header(records[0], 'attempt'), String(i + 1), \`\${topic}: the attempt header must be \${i + 1}, got \${JSON.stringify(header(records[0], 'attempt'))}\`);
    const raw = header(records[0], 'not_before');
    assert(raw !== null && /^\\d+$/.test(raw), \`\${topic}: the hand-off needs a not_before header in epoch milliseconds, got \${JSON.stringify(raw)}\`);
    const gap = Number(raw) - tries[i].at;
    assert(gap >= TIERS[i] - 5 && gap <= TIERS[i] + 2000, \`\${topic}: not_before must be the failure time + \${TIERS[i]} ms, it is \${gap} ms after the handler failed\`);
    assert(tries[i + 1].at >= Number(raw) - 5, \`\${topic}: the record was handled \${Number(raw) - tries[i + 1].at} ms before its not_before\`);
  });
  const dlq = ctx.kafka.records('tasks.dlq');
  assert.equal(dlq.length, 1, \`after the last tier the record is dead-lettered once, tasks.dlq holds \${dlq.length}\`);
  assert(ctx.kafka.keys('tasks.dlq')[0] === 'a' && ctx.kafka.values('tasks.dlq')[0] === 'job-a', 'the dead letter must keep the key and value');
  assert.equal(header(dlq[0], 'attempt'), '4', \`the dead letter's attempt header must be 4, got \${JSON.stringify(header(dlq[0], 'attempt'))}\`);
  assert.equal(header(dlq[0], 'error'), 'boom', \`the dead letter's error header must carry the exception's message, got \${JSON.stringify(header(dlq[0], 'error'))}\`);
  assert.deepEqual(calls.filter(c => c.key !== 'a').map(c => c.key).sort(), ['f1', 'f2', 'f3'], 'the other tasks records must each be handled once');
  allCommitted(ctx);
}

/** One retry record due in 5 s on tasks.retry.5s and six tasks records whose handlers each move the clock 1 s. */
function waitingWorld(ctx): {t0: number; fillers: string[]; advance: Record<string, number>} {
  const t0 = ctx.clock.now();
  seed(ctx, 'tasks.retry.5s', 'x', 'job-x', 1, t0 + 5000);
  const fillers = [1, 2, 3, 4, 5, 6].map(i => \`f\${i}\`);
  for (const key of fillers) seed(ctx, 'tasks', key, 'job-' + key);
  return {t0, fillers, advance: Object.fromEntries(fillers.map(key => [key, 1]))};
}

export async function check_not_before(ctx) {
  const {t0, advance} = waitingWorld(ctx);
  const commits: {offsets: Map<string, number>; at: number}[] = [];
  ctx.kafka.onCommit((group, offsets) => commits.push({offsets, at: ctx.clock.now()}));
  const {m, calls, handler} = worker(ctx, [], advance);
  await ctx.drain(m.run(handler));
  const xs = calls.filter(c => c.key === 'x');
  assert.equal(xs.length, 1, \`the retry record must be handled exactly once, the handler saw it \${xs.length} times\`);
  assert(xs[0].at >= t0 + 5000 - 5, \`the retry record was handled \${t0 + 5000 - xs[0].at} ms before its not_before: a record that is not due is paused, not processed\`);
  const early = commits.filter(c => [...c.offsets.keys()].some(tp => tp.startsWith('tasks.retry.5s|')) && c.at < xs[0].at);
  assert.equal(early.length, 0, 'tasks.retry.5s was committed before its record was handled: a record that is not due must not be skipped');
  assert(ctx.kafka.records('tasks.retry.30s').length === 0 && ctx.kafka.records('tasks.dlq').length === 0, 'a retry that succeeds is not forwarded');
  allCommitted(ctx);
}

export async function check_non_blocking(ctx) {
  const {t0, fillers, advance} = waitingWorld(ctx);
  const {m, calls, handler} = worker(ctx, [], advance);
  await ctx.drain(m.run(handler));
  const xs = calls.filter(c => c.key === 'x');
  assert(xs.length === 1 && xs[0].at >= t0 + 5000 - 5, 'the retry record must be handled exactly once, no earlier than its not_before');
  const handled = calls.filter(c => c.key !== 'x');
  assert.deepEqual(handled.map(c => c.key).sort(), fillers, \`every tasks record must be handled once, saw \${JSON.stringify(handled.map(c => c.key).sort())}\`);
  const before = handled.filter(c => c.at < t0 + 5000);
  assert(before.length >= 3, \`only \${before.length} of the 6 tasks records were handled before the retry record was due: a paused retry partition must not block tasks\`);
  const moved = ctx.clock.now() - t0;
  assert(moved <= 6000 + 2000, \`the clock moved \${moved} ms while the handlers moved it 6000 ms: the worker slept the delay away instead of pausing the partition\`);
  allCommitted(ctx);
}

export async function check_flush_before_commit(ctx) {
  const t0 = ctx.clock.now();
  seed(ctx, 'tasks', 'a', 'job-a');
  ctx.kafka.stall('tasks.retry.5s', 2);
  const atCommit: {offsets: Map<string, number>; n: number; at: number}[] = [];
  ctx.kafka.onCommit((group, offsets) => atCommit.push({offsets, n: ctx.kafka.records('tasks.retry.5s').length, at: ctx.clock.now()}));
  const {m, handler} = worker(ctx, ['a']);
  await ctx.drain(m.run(handler));
  assert(ctx.kafka.events.some(e => e[0] === 'produce-stalled' && e[1] === 'tasks.retry.5s'), 'the failure must be produced to tasks.retry.5s (it was stalled)');
  const source = atCommit.filter(c => [...c.offsets.keys()].some(tp => tp.startsWith('tasks|')));
  assert(source.length > 0, 'the tasks offset was never committed');
  assert.equal(source[0].n, 1, 'the tasks offset was committed while the hand-off was still in flight: await the send first');
  assert(source[0].at >= t0 + 2000, 'the commit must wait out the stall (2 s of virtual time) for the broker\\'s acknowledgement');
  assert.equal(ctx.kafka.lag(GROUP, 'tasks'), 0, 'the failed record\\'s offset must be committed once the hand-off is acknowledged');
}

export async function check_retry_succeeds(ctx) {
  seed(ctx, 'tasks.retry.5s', 'b', 'job-b', 1, 0);
  seed(ctx, 'tasks', 'c', 'job-c');
  const {m, calls, handler} = worker(ctx);
  await ctx.drain(m.run(handler));
  assert.deepEqual(calls.map(c => [c.key, c.value]).sort(), [['b', 'job-b'], ['c', 'job-c']], \`a due retry record and a tasks record are each handled once, saw \${JSON.stringify(calls.map(c => [c.key, c.value]))}\`);
  for (const topic of ['tasks.retry.30s', 'tasks.retry.5m', 'tasks.dlq'])
    assert.equal(ctx.kafka.records(topic).length, 0, \`a record whose handler succeeds is not forwarded, \${topic} holds \${ctx.kafka.records(topic).length}\`);
  assert.equal(ctx.kafka.records('tasks.retry.5s').length, 1, 'a record whose handler succeeds is not re-produced');
  allCommitted(ctx);
}
`,
    go: `package main

import (
	"errors"
	"regexp"
	"sort"
	"strconv"

	"leetbuild/harness"
)

var (
	checkTiers       = []int64{5000, 30000, 300000}
	checkRetryTopics = []string{"tasks.retry.5s", "tasks.retry.30s", "tasks.retry.5m"}
	epochMillis      = regexp.MustCompile("^[0-9]+$")
)

const checkGroup = "tasks-workers"

type taskCall struct {
	key, value string
	at         int64
}

// recordHeader is a header's value as text, nil when absent.
func recordHeader(r harness.KafkaRecord, name string) any {
	if v, ok := r.Header(name); ok {
		return string(v)
	}
	return nil
}

// seedTask puts a record on partition 0 of topic, with the attempt and not_before headers when >= 0.
func seedTask(ctx *harness.Ctx, topic, key, value string, attempt, notBefore int64) {
	var headers []harness.KafkaHeader
	if attempt >= 0 {
		headers = append(headers, harness.KafkaHeader{Key: "attempt", Value: []byte(strconv.FormatInt(attempt, 10))})
	}
	if notBefore >= 0 {
		headers = append(headers, harness.KafkaHeader{Key: "not_before", Value: []byte(strconv.FormatInt(notBefore, 10))})
	}
	ctx.Kafka.SeedPartition(topic, 0, key, value, headers...)
}

// taskWorker runs the learner's loop with a handler that records (key, value, clock ms), moves the
// clock by advance[key] seconds, and fails with "boom" for keys in fails.
func taskWorker(ctx *harness.Ctx, fails []string, advance map[string]float64) []taskCall {
	var calls []taskCall
	handler := func(key, value string) error {
		calls = append(calls, taskCall{key, value, ctx.Clock.Now()})
		if s, ok := advance[key]; ok {
			ctx.Clock.Advance(s)
		}
		for _, f := range fails {
			if f == key {
				return errors.New("boom")
			}
		}
		return nil
	}
	ctx.Drain(func() { _ = run(handler) })
	return calls
}

func callsOf(calls []taskCall, key string) []taskCall {
	var out []taskCall
	for _, c := range calls {
		if c.key == key {
			out = append(out, c)
		}
	}
	return out
}

func touches(offsets harness.KafkaOffsets, topic string) bool {
	for tp := range offsets {
		if tp.Topic == topic {
			return true
		}
	}
	return false
}

func allCommitted(ctx *harness.Ctx) {
	for _, topic := range append([]string{"tasks"}, checkRetryTopics...) {
		ctx.Equal(ctx.Kafka.Lag(checkGroup, topic), 0, "%s: handled record(s) left uncommitted", topic)
	}
}

func CheckGroup(ctx *harness.Ctx) {
	seedTask(ctx, "tasks", "a", "job-a", -1, -1)
	calls := taskWorker(ctx, nil, nil)
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	ctx.Assert(len(subscriptions) > 0, "the consumer must subscribe to the topics")
	last := subscriptions[len(subscriptions)-1]
	ctx.Equal(last.Group, checkGroup, "group.id")
	for _, topic := range append([]string{"tasks"}, checkRetryTopics...) {
		found := false
		for _, t := range last.Topics {
			found = found || t == topic
		}
		ctx.Assert(found, "the consumer must subscribe to %s as well; it subscribed to %v", topic, last.Topics)
	}
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "auto-commit is on: offsets were committed on a timer, before processing")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened")
	var seen []string
	for _, c := range calls {
		seen = append(seen, c.key+"="+c.value)
	}
	ctx.Equal(seen, []string{"a=job-a"}, "the handler must see (key, value) once per record: key=value handled")
	allCommitted(ctx)
}

func CheckEscalates(ctx *harness.Ctx) {
	seedTask(ctx, "tasks", "a", "job-a", -1, -1)
	for _, key := range []string{"f1", "f2", "f3"} {
		seedTask(ctx, "tasks", key, "job-"+key, -1, -1)
	}
	calls := taskWorker(ctx, []string{"a"}, map[string]float64{"f1": 6, "f2": 40, "f3": 400})
	tries := callsOf(calls, "a")
	ctx.Equal(len(tries), 4, "a record that always fails is tried once on tasks and once per tier: the handler's calls for it")
	for _, c := range tries {
		ctx.Equal(c.value, "job-a", "every retry must hand the handler the original value")
	}
	for i, topic := range checkRetryTopics {
		records := ctx.Kafka.Records(topic)
		ctx.Equal(len(records), 1, "%s must hold the failed record exactly once: records", topic)
		ctx.Equal([]string{string(records[0].Key), string(records[0].Value)}, []string{"a", "job-a"}, "%s: the hand-off must keep key a and value job-a", topic)
		ctx.Equal(recordHeader(records[0], "attempt"), strconv.Itoa(i+1), "%s: the attempt header", topic)
		raw, _ := recordHeader(records[0], "not_before").(string)
		ctx.Assert(epochMillis.MatchString(raw), "%s: the hand-off needs a not_before header in epoch milliseconds, got %v", topic, recordHeader(records[0], "not_before"))
		notBefore, _ := strconv.ParseInt(raw, 10, 64)
		gap := notBefore - tries[i].at
		ctx.Assert(gap >= checkTiers[i]-5 && gap <= checkTiers[i]+2000, "%s: not_before must be the failure time + %d ms, it is %d ms after the handler failed", topic, checkTiers[i], gap)
		ctx.Assert(tries[i+1].at >= notBefore-5, "%s: the record was handled %d ms before its not_before", topic, notBefore-tries[i+1].at)
	}
	dlq := ctx.Kafka.Records("tasks.dlq")
	ctx.Equal(len(dlq), 1, "after the last tier the record is dead-lettered once: records on tasks.dlq")
	ctx.Assert(string(dlq[0].Key) == "a" && string(dlq[0].Value) == "job-a", "the dead letter must keep the key and value")
	ctx.Equal(recordHeader(dlq[0], "attempt"), "4", "the dead letter's attempt header")
	ctx.Equal(recordHeader(dlq[0], "error"), "boom", "the dead letter's error header must carry the handler error's message")
	var others []string
	for _, c := range calls {
		if c.key != "a" {
			others = append(others, c.key)
		}
	}
	sort.Strings(others)
	ctx.Equal(others, []string{"f1", "f2", "f3"}, "the other tasks records must each be handled once")
	allCommitted(ctx)
}

// waitingWorld seeds one retry record due in 5 s on tasks.retry.5s and six tasks records whose
// handlers each move the clock 1 s.
func waitingWorld(ctx *harness.Ctx) (t0 int64, fillers []string, advance map[string]float64) {
	t0 = ctx.Clock.Now()
	seedTask(ctx, "tasks.retry.5s", "x", "job-x", 1, t0+5000)
	advance = map[string]float64{}
	for i := 1; i <= 6; i++ {
		key := "f" + strconv.Itoa(i)
		fillers = append(fillers, key)
		seedTask(ctx, "tasks", key, "job-"+key, -1, -1)
		advance[key] = 1
	}
	return t0, fillers, advance
}

func CheckNotBefore(ctx *harness.Ctx) {
	t0, _, advance := waitingWorld(ctx)
	type commitAt struct {
		offsets harness.KafkaOffsets
		at      int64
	}
	var commits []commitAt
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		commits = append(commits, commitAt{offsets, ctx.Clock.Now()})
	})
	calls := taskWorker(ctx, nil, advance)
	xs := callsOf(calls, "x")
	ctx.Equal(len(xs), 1, "the retry record must be handled exactly once: the handler's calls for it")
	ctx.Assert(xs[0].at >= t0+5000-5, "the retry record was handled %d ms before its not_before: a record that is not due is paused, not processed", t0+5000-xs[0].at)
	for _, c := range commits {
		ctx.Assert(!(touches(c.offsets, "tasks.retry.5s") && c.at < xs[0].at), "tasks.retry.5s was committed before its record was handled: a record that is not due must not be skipped")
	}
	ctx.Assert(len(ctx.Kafka.Records("tasks.retry.30s")) == 0 && len(ctx.Kafka.Records("tasks.dlq")) == 0, "a retry that succeeds is not forwarded")
	allCommitted(ctx)
}

func CheckNonBlocking(ctx *harness.Ctx) {
	t0, fillers, advance := waitingWorld(ctx)
	calls := taskWorker(ctx, nil, advance)
	xs := callsOf(calls, "x")
	ctx.Assert(len(xs) == 1 && xs[0].at >= t0+5000-5, "the retry record must be handled exactly once, no earlier than its not_before")
	var handled []string
	before := 0
	for _, c := range calls {
		if c.key == "x" {
			continue
		}
		handled = append(handled, c.key)
		if c.at < t0+5000 {
			before++
		}
	}
	sort.Strings(handled)
	ctx.Equal(handled, fillers, "every tasks record must be handled once")
	ctx.Assert(before >= 3, "only %d of the 6 tasks records were handled before the retry record was due: a paused retry partition must not block tasks", before)
	// The clock when the last handler returned: a Poll(timeout) loop keeps waiting (and moving the
	// clock) after the work is done, which TypeScript's consumer.run does not.
	var finished int64
	for _, c := range calls {
		finished = max(finished, c.at+int64(advance[c.key]*1000))
	}
	moved := finished - t0
	ctx.Assert(moved <= 6000+2000, "the clock moved %d ms while the handlers moved it 6000 ms: the worker slept the delay away instead of pausing the partition", moved)
	allCommitted(ctx)
}

func CheckFlushBeforeCommit(ctx *harness.Ctx) {
	t0 := ctx.Clock.Now()
	seedTask(ctx, "tasks", "a", "job-a", -1, -1)
	ctx.Kafka.StallFor("tasks.retry.5s", 2)
	type commitAt struct {
		offsets harness.KafkaOffsets
		n       int
		at      int64
	}
	var commits []commitAt
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		commits = append(commits, commitAt{offsets, len(ctx.Kafka.Records("tasks.retry.5s")), ctx.Clock.Now()})
	})
	taskWorker(ctx, []string{"a"}, nil)
	stalled := false
	for _, e := range ctx.Kafka.EventsOf("produce-stalled") {
		stalled = stalled || e.Topic == "tasks.retry.5s"
	}
	ctx.Assert(stalled, "the failure must be produced to tasks.retry.5s (it was stalled)")
	var source []commitAt
	for _, c := range commits {
		if touches(c.offsets, "tasks") {
			source = append(source, c)
		}
	}
	ctx.Assert(len(source) > 0, "the tasks offset was never committed")
	ctx.Equal(source[0].n, 1, "the tasks offset was committed while the hand-off was still in flight (Flush and check the delivery report first): records on tasks.retry.5s at the commit")
	ctx.Assert(source[0].at >= t0+2000, "the commit must wait out the stall (2 s of virtual time) for the broker's acknowledgement")
	ctx.Equal(ctx.Kafka.Lag(checkGroup, "tasks"), 0, "the failed record's offset must be committed once the hand-off is acknowledged: lag on tasks")
}

func CheckRetrySucceeds(ctx *harness.Ctx) {
	seedTask(ctx, "tasks.retry.5s", "b", "job-b", 1, 0)
	seedTask(ctx, "tasks", "c", "job-c", -1, -1)
	calls := taskWorker(ctx, nil, nil)
	var seen []string
	for _, c := range calls {
		seen = append(seen, c.key+"="+c.value)
	}
	sort.Strings(seen)
	ctx.Equal(seen, []string{"b=job-b", "c=job-c"}, "a due retry record and a tasks record are each handled once: key=value handled")
	for _, topic := range []string{"tasks.retry.30s", "tasks.retry.5m", "tasks.dlq"} {
		ctx.Equal(len(ctx.Kafka.Records(topic)), 0, "a record whose handler succeeds is not forwarded: records on %s", topic)
	}
	ctx.Equal(len(ctx.Kafka.Records("tasks.retry.5s")), 1, "a record whose handler succeeds is not re-produced: records on tasks.retry.5s")
	allCommitted(ctx)
}
`,
  },
  debrief: `Two decisions carry the whole design. First, the delay is **data, not control flow**: a \`not_before\` header on a record in a topic named for its tier, so the delay survives a restart, is visible to anyone reading the topic, and costs the consumer no thread. Second, a record that is not due is handled by **\`pause\` + \`seek\`, never by \`sleep\` and never by committing past it**: pausing a partition tells the fetcher to stop asking for it while every other partition — the main topic above all — keeps flowing, and seeking back puts the record under the cursor so that \`resume\` delivers exactly it. Since the record is not committed while it waits, a crash replays it, which is correct — nothing was done. The tiers are the reason there is one topic per delay: a single retry topic with mixed \`not_before\` values would have a 5-minute record block a 5-second one behind it (head-of-line blocking inside the retry topic itself), whereas within one tier every record waits the same time, so the head is always the first due. Real systems add rebalance handling (a paused partition that is revoked must be forgotten, and the new owner pauses it again from the committed offset), a cap on how long a pause may last before the record is moved on anyway, per-tier consumer groups so a slow tier cannot starve the main loop's poll interval, and a dead-letter replayer that puts \`tasks.dlq\` records back on \`tasks\` once the dependency is healthy.`,
};
