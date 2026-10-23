import type {Step} from '@/lib/types';

export const gracefulShutdownStep: Step = {
  id: 'graceful-shutdown',
  title: 'Graceful shutdown: drain, commit, close under a deadline',
  concept: 'kafka',
  file: 'forwarder',
  focus: ['forwarder', 'kafka'],
  task: `## Task

A forwarding worker reads \`inbox\`, hands every record to a handler and writes the result to \`outbox\`.
Implement its two entry points so that a stop — a deploy, a scale-down, a SIGTERM — loses nothing and
never hangs.

- \`run(handler)\`: consume \`inbox\` in consumer group **\`forwarder\`** with **auto-commit off** and
  \`auto.offset.reset=earliest\`. For every record call \`handler(record)\` (it may take time) and produce
  what it returns to \`outbox\` with the **same key**. Commit the record's offset (\`offset + 1\`) only
  **after the broker acknowledged the forward** — never before, and never past a record whose forward
  is still unacknowledged.
- \`shutdown(deadline_s)\` returns a report and takes **at most \`deadline_s\`** of clock time, whatever
  the broker does. In order: stop taking records (the one in hand finishes, bounded by the deadline);
  wait for the outstanding forwards with the time left (a timed flush); commit **synchronously** every
  offset that is safe; close the consumer and the producer; return
  \`{"forwarded", "committed_offsets", "undelivered", "uncommitted"}\` — forwards acknowledged since
  \`run\` started, the committed offset per \`inbox\` partition, forwards still unacknowledged, records
  taken from \`inbox\` whose offset is not committed.
- A restart (\`run\` again in a fresh process) resumes from the committed offsets: a record forwarded but
  not committed is handled and forwarded again — at-least-once, and the report said how many. A record
  committed is never handled twice.

:::widget delivery-semantics {}

> A stop is a deadline, not an event: everything you still owe the broker — the forward in flight, the
> commit behind it, the sockets — gets the time that is left, and what does not fit is reported, not
> lost.`,
  sequence: {
    participants: ['supervisor', 'forwarder', 'Kafka'],
    messages: [
      {from: 'Kafka', to: 'forwarder', label: 'poll → inbox[0]@7', kind: 'reply'},
      {from: 'forwarder', to: 'forwarder', label: 'handler(record)', kind: 'sync'},
      {from: 'forwarder', to: 'Kafka', label: 'produce outbox key=k7', kind: 'async'},
      {from: 'supervisor', to: 'forwarder', label: 'shutdown(5)', kind: 'sync'},
      {from: 'Kafka', to: 'forwarder', label: 'ack outbox (flush, ≤ time left)', kind: 'async'},
      {from: 'forwarder', to: 'Kafka', label: 'commit inbox[0] → 8 (sync)', kind: 'sync'},
      {from: 'forwarder', to: 'Kafka', label: 'close consumer · close producer', kind: 'sync'},
      {
        from: 'forwarder',
        to: 'supervisor',
        label: '{forwarded, committed_offsets, undelivered: 0, uncommitted: 0}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Keep, per inbox partition, the records you took in offset order with a flag the delivery callback (or the resolved send) sets. The offset you may commit is one past the last record of the leading run of acknowledged ones — a stalled forward blocks the commit of everything behind it.',
    'Shutdown is a budget: note the clock when it starts and give each wait the time left — the handler in hand, then the producer flush — so the whole call returns within `deadline_s` even if the broker never answers. A forward that did not make it stays uncommitted; that is the restart’s job.',
    'Commit synchronously at the very end, then close the consumer and the producer: an async commit queued behind a closed socket is a commit that never happened.',
  ],
  checks: [
    {
      id: 'drain',
      title: 'A clean shutdown forwards and commits everything in hand',
      detail:
        'With a healthy broker, `shutdown(5)` lets the running handler finish, forwards its record to `outbox` with the inbox key, commits the offset after the ack (never before), closes, and reports `undelivered: 0`, `uncommitted: 0`.',
      match: {
        python: {
          all: [
            /producer\.produce\(\s*(OUTBOX|"outbox")\s*,[\s\S]{0,200}?key\s*=\s*msg\.key\(\)/,
            /"enable\.auto\.commit"\s*:\s*False/,
          ],
        },
        typescript: {
          all: [
            /\.send\(\s*\{[\s\S]{0,120}?topic:\s*(OUTBOX|'outbox')[\s\S]{0,200}?key:\s*message\.key/,
            /autoCommit:\s*false/,
          ],
        },
        go: {all: [/Key:\s*msg\.Key/, /reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {
          all: [
            /new ProducerRecord(\[[^\]]*\])?\(\s*(Outbox|"outbox")\s*,\s*record\.key\(\)/,
            /"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/,
          ],
        },
        cpp: {
          all: [/producer->produce\(\s*(kOutbox|"outbox")\s*,/, /msg->key\(\)/, /"enable\.auto\.commit"\s*,\s*"false"/],
        },
      },
    },
    {
      id: 'stalled',
      title:
        'Under a stalled outbox, shutdown returns within the deadline and commits nothing past the unacked forward',
      detail:
        'With `outbox` not acknowledging, `shutdown(5)` returns within 5 s of clock time, reports the forwards still in flight as `undelivered` and the records taken but not committed as `uncommitted`, and the committed offset stays at the last acknowledged forward.',
      match: {
        python: {
          all: [
            /def shutdown(?:(?!\ndef )[\s\S])*?producer\.flush\(\s*(?!\s*\))/,
            /"undelivered"\s*:/,
            /"uncommitted"\s*:/,
          ],
        },
        typescript: {
          all: [/function shutdown(?:(?!\nexport )[\s\S])*?Promise\.allSettled\(/, /undelivered/, /uncommitted/],
        },
        go: {
          all: [/func shutdown(?:(?!\n\})[\s\S])*?time\.After\(|context\.WithTimeout\(/, /Undelivered/, /Uncommitted/],
        },
        scala: {
          all: [
            /def shutdown(?:(?!\n {2}def )[\s\S])*?producer\.close\(\s*(remaining|Duration)/,
            /undelivered/,
            /uncommitted/,
          ],
        },
        cpp: {all: [/void shutdown|Report shutdown/, /producer->flush\(\s*(?!\s*\))/, /undelivered/, /uncommitted/]},
      },
    },
    {
      id: 'restart',
      title: 'A restart resumes from the committed offset and loses nothing',
      detail:
        'After a shutdown under a stall, `run` in a fresh process picks up at the committed offset: `outbox` ends up holding every inbox record at least once, and only records reported uncommitted may appear twice.',
      match: {
        python: {all: [/"auto\.offset\.reset"\s*:\s*"earliest"/, /"group\.id"\s*:\s*(GROUP|"forwarder")/]},
        typescript: {all: [/fromBeginning:\s*true/, /groupId:\s*(GROUP|'forwarder')/]},
        go: {all: [/StartOffset:\s*kafka\.FirstOffset/, /GroupID:\s*(groupID|"forwarder")/]},
        scala: {
          all: [
            /"auto\.offset\.reset"\s*,\s*"earliest"|AUTO_OFFSET_RESET_CONFIG\s*,\s*"earliest"/,
            /"group\.id"\s*,\s*(Group|"forwarder")|GROUP_ID_CONFIG\s*,\s*(Group|"forwarder")/,
          ],
        },
        cpp: {all: [/"auto\.offset\.reset"\s*,\s*"earliest"/, /"group\.id"\s*,\s*(kGroup|"forwarder")/]},
      },
    },
    {
      id: 'once',
      title: 'No record is handled twice across a clean shutdown and restart',
      detail:
        'Every offset is committed after its forward is acknowledged, so a restart after a clean shutdown handles only the records that arrived since; across both processes each record reaches the handler once and `outbox` once.',
      match: {
        python: {all: [/producer\.produce\([\s\S]{0,500}?producer\.poll\(\s*0\s*\)[\s\S]{0,300}?commit\(/]},
        typescript: {all: [/await\s+(send|producer\.send\()[\s\S]{0,400}?commit\(/]},
        go: {order: [/writer\.WriteMessages\(/, /reader\.CommitMessages\(/]},
        scala: {all: [/producer\.send\([\s\S]{0,600}?commit\(\)/]},
        cpp: {all: [/producer->produce\([\s\S]{0,500}?producer->poll\(\s*0\s*\)[\s\S]{0,300}?commit\(\)/]},
      },
    },
    {
      id: 'deadline',
      title: 'The deadline is honoured on the clock, and not waited out when the work is done',
      detail:
        '`shutdown(deadline_s)` returns as soon as every forward is acknowledged and committed, waits for a late broker up to the deadline, and returns at the deadline — not after it — when the broker or the handler in hand never finishes.',
      match: {
        python: {all: [/def shutdown\(\s*deadline_s/, /producer\.flush\(\s*[^)\n]*deadline_s/]},
        typescript: {all: [/function shutdown\(\s*deadlineS/, /Date\.now\(\)/, /clearTimeout\(/]},
        go: {all: [/func shutdown\(\s*deadline\s+time\.Duration/, /time\.Until\(|time\.Since\(/]},
        scala: {all: [/def shutdown\(\s*deadline:\s*Duration/, /System\.nanoTime\(\)|Instant\.now\(\)/]},
        cpp: {all: [/shutdown\(\s*int\s+deadline_ms/, /steady_clock::now\(\)/]},
      },
    },
    {
      id: 'closed',
      title: 'The consumer and the producer are closed after a synchronous commit',
      detail:
        'The final commit is synchronous and happens before the consumer is closed; both clients are closed by the time `shutdown` returns, so a restart starts from what the broker holds.',
      match: {
        python: {
          all: [/asynchronous\s*=\s*False/],
          order: [/def shutdown\(/, /asynchronous\s*=\s*False/, /consumer\.close\(\)/],
        },
        typescript: {
          order: [
            /await consumer\.commitOffsets\(/,
            /await consumer\.disconnect\(\)/,
            /await producer\.disconnect\(\)/,
          ],
        },
        go: {order: [/reader\.CommitMessages\(/, /reader\.Close\(\)/, /writer\.Close\(\)/]},
        scala: {order: [/consumer\.commitSync\(/, /consumer\.close\(\)/]},
        cpp: {order: [/consumer->commitSync\(/, /consumer->close\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Forwarder: inbox → handler → outbox, committed after the forward's ack; shutdown drains, commits and closes under a deadline."""
import logging
import time
from collections import deque

from confluent_kafka import Consumer, Producer, TopicPartition

INBOX = "inbox"
OUTBOX = "outbox"
GROUP = "forwarder"
log = logging.getLogger("forwarder")

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        # TODO: start at the earliest offset when the group has none; commit by hand, never on a timer
    }
)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})
consumer.subscribe([INBOX])

stopping = False
forwarded = 0  # forwards the broker acknowledged since run() started
# Per inbox partition: the records taken and not yet committed, in offset order, each with whether its forward was acknowledged.
pending: dict[int, deque] = {}
# Per inbox partition: the next offset that is safe to commit (every earlier forward acknowledged).
watermark: dict[int, int] = {}
committed: dict[int, int] = {}


def run(handler) -> None:
    """Consume inbox until shutdown() stops it: handler → produce to outbox (same key) → commit after the ack."""
    global stopping
    stopping = False
    while not stopping:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        # TODO: remember the record as pending, produce handler(msg) to OUTBOX keyed by msg.key() with a delivery
        #       callback that marks it acknowledged, serve the callbacks, then commit the partition's watermark
        raise NotImplementedError


def shutdown(deadline_s: float) -> dict:
    """Stop taking records, flush with the time left, commit synchronously what is safe, close both clients; back within deadline_s."""
    # TODO
    raise NotImplementedError
`,
      solution: `"""Forwarder: inbox → handler → outbox, committed after the forward's ack; shutdown drains, commits and closes under a deadline."""
import logging
import time
from collections import deque

from confluent_kafka import Consumer, Producer, TopicPartition

INBOX = "inbox"
OUTBOX = "outbox"
GROUP = "forwarder"
log = logging.getLogger("forwarder")

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})
consumer.subscribe([INBOX])

stopping = False
forwarded = 0  # forwards the broker acknowledged since run() started
# Per inbox partition: the records taken and not yet committed, in offset order, each with whether its forward was acknowledged.
pending: dict[int, deque] = {}
# Per inbox partition: the next offset that is safe to commit (every earlier forward acknowledged).
watermark: dict[int, int] = {}
committed: dict[int, int] = {}


def _delivered(err, entry: dict) -> None:
    """Delivery report of one forward: acknowledged, or not — an unacknowledged forward keeps its offset uncommitted."""
    global forwarded
    if err is not None:
        log.warning("inbox[%d]@%d not forwarded: %s", entry["partition"], entry["offset"], err)
        return
    entry["acked"] = True
    forwarded += 1


def _advance(partition: int) -> None:
    """Move the partition's watermark over the leading run of acknowledged records; the first unacked one blocks it."""
    queue = pending[partition]
    while queue and queue[0]["acked"]:
        watermark[partition] = queue.popleft()["offset"] + 1


def _offsets(partitions) -> list[TopicPartition]:
    return [TopicPartition(INBOX, p, watermark[p]) for p in partitions]


def _commit() -> None:
    """Commit, asynchronously, the partitions whose watermark moved since their last commit."""
    due = [p for p, off in watermark.items() if committed.get(p) != off]
    if due:
        consumer.commit(offsets=_offsets(due), asynchronous=True)
        committed.update((p, watermark[p]) for p in due)


def run(handler) -> None:
    """Consume inbox until shutdown() stops it: handler → produce to outbox (same key) → commit after the ack."""
    global stopping
    stopping = False
    while not stopping:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        entry = {"partition": msg.partition(), "offset": msg.offset(), "acked": False}
        pending.setdefault(msg.partition(), deque()).append(entry)
        out = handler(msg)
        producer.produce(OUTBOX, key=msg.key(), value=out, on_delivery=lambda err, _m, e=entry: _delivered(err, e))
        producer.poll(0)  # serve the delivery reports that are in: acknowledged forwards move the watermark
        _advance(msg.partition())
        _commit()


def shutdown(deadline_s: float) -> dict:
    """Stop taking records, flush with the time left, commit synchronously what is safe, close both clients; back within deadline_s."""
    global stopping
    stopping = True
    started = time.monotonic()
    left = producer.flush(max(0.0, deadline_s - (time.monotonic() - started)))  # a dead broker costs the deadline, not message.timeout.ms
    for partition in pending:
        _advance(partition)
    if watermark:  # the loop's commits were asynchronous: this one is confirmed before the consumer goes away
        consumer.commit(offsets=_offsets(watermark), asynchronous=False)
    uncommitted = sum(len(queue) for queue in pending.values())
    consumer.close()
    if left or uncommitted:
        log.warning("shutdown: %d forwards undelivered, %d records uncommitted — a restart forwards them again", left, uncommitted)
    return {"forwarded": forwarded, "committed_offsets": dict(watermark), "undelivered": left, "uncommitted": uncommitted}
`,
    },
    typescript: {
      starter: `/** Forwarder: inbox → handler → outbox, committed after the forward's ack; shutdown drains, commits and closes under a deadline. */
import {type KafkaMessage, Kafka} from 'kafkajs';

export const INBOX = 'inbox';
export const OUTBOX = 'outbox';
export const GROUP = 'forwarder';

export type Handler = (message: KafkaMessage) => Promise<string | Buffer> | string | Buffer;
export interface Report {
  forwarded: number;
  committed_offsets: Record<number, number>;
  undelivered: number;
  uncommitted: number;
}

const kafka = new Kafka({clientId: 'forwarder', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});
const producer = kafka.producer({idempotent: true});

let stopping = false;
let forwarded = 0; // forwards the broker acknowledged since run() started
/** The record in hand: its handler running, its forward in flight or its commit pending. */
let inFlight: Promise<void> | null = null;
/** Forwards handed to the producer and not yet settled. */
const sends = new Set<Promise<unknown>>();
/** Per inbox partition: the records taken and not yet committed, in offset order, each with whether its forward was acknowledged. */
const pending = new Map<number, {offset: number; acked: boolean}[]>();
/** Per inbox partition: the next offset that is safe to commit (every earlier forward acknowledged). */
const watermark = new Map<number, number>();
const committed = new Map<number, number>();

/** Consume inbox until shutdown() stops it: handler → send to outbox (same key) → commit after the ack. */
export async function run(handler: Handler): Promise<void> {
  stopping = false;
  await consumer.connect();
  await producer.connect();
  // TODO: subscribe to INBOX from the beginning and run with auto-commit off; for each message, keep it as
  //       pending, await the handler, await the send to OUTBOX keyed by message.key, then commit the watermark
  throw new Error('not implemented');
}

/** Stop taking records, flush with the time left, commit synchronously what is safe, close both clients; back within deadlineS. */
export async function shutdown(deadlineS: number): Promise<Report> {
  // TODO
  throw new Error('not implemented');
}
`,
      solution: `/** Forwarder: inbox → handler → outbox, committed after the forward's ack; shutdown drains, commits and closes under a deadline. */
import {type KafkaMessage, Kafka} from 'kafkajs';

export const INBOX = 'inbox';
export const OUTBOX = 'outbox';
export const GROUP = 'forwarder';

export type Handler = (message: KafkaMessage) => Promise<string | Buffer> | string | Buffer;
export interface Report {
  forwarded: number;
  committed_offsets: Record<number, number>;
  undelivered: number;
  uncommitted: number;
}

const kafka = new Kafka({clientId: 'forwarder', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});
const producer = kafka.producer({idempotent: true});

let stopping = false;
let forwarded = 0; // forwards the broker acknowledged since run() started
/** The record in hand: its handler running, its forward in flight or its commit pending. */
let inFlight: Promise<void> | null = null;
/** Forwards handed to the producer and not yet settled. */
const sends = new Set<Promise<unknown>>();
/** Per inbox partition: the records taken and not yet committed, in offset order, each with whether its forward was acknowledged. */
const pending = new Map<number, {offset: number; acked: boolean}[]>();
/** Per inbox partition: the next offset that is safe to commit (every earlier forward acknowledged). */
const watermark = new Map<number, number>();
const committed = new Map<number, number>();

/** Move the partition's watermark over the leading run of acknowledged records; the first unacked one blocks it. */
function advance(partition: number): void {
  const queue = pending.get(partition) ?? [];
  while (queue.length > 0 && queue[0].acked) watermark.set(partition, queue.shift()!.offset + 1);
}

async function commit(): Promise<void> {
  const due = [...watermark].filter(([p, offset]) => committed.get(p) !== offset);
  if (due.length === 0) return;
  await consumer.commitOffsets(due.map(([partition, offset]) => ({topic: INBOX, partition, offset: String(offset)})));
  for (const [p, offset] of due) committed.set(p, offset);
}

/** \`promise\`, or undefined once \`ms\` have passed; the timer is cleared so a stop that finishes early leaves nothing ticking. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return Promise.resolve(undefined);
  const {promise: bounded, resolve} = Promise.withResolvers<T | undefined>();
  const timer = setTimeout(() => resolve(undefined), ms);
  const settle = (value?: T): void => {
    clearTimeout(timer);
    resolve(value);
  };
  promise.then(settle, () => settle());
  return bounded;
}

/** One record: handler → forward keyed as the inbox record → commit once acknowledged. A failure keeps its offset uncommitted. */
async function forward(partition: number, message: KafkaMessage, handler: Handler): Promise<void> {
  const entry = {offset: Number(message.offset), acked: false};
  let queue = pending.get(partition);
  if (queue === undefined) pending.set(partition, (queue = []));
  queue.push(entry);
  try {
    const value = await handler(message);
    const send = producer.send({topic: OUTBOX, messages: [{key: message.key, value}]});
    sends.add(send);
    try {
      await send;
    } finally {
      sends.delete(send);
    }
    entry.acked = true;
    forwarded += 1;
    advance(partition);
    await commit();
  } catch (err) {
    console.warn(\`inbox[\${partition}]@\${entry.offset} not forwarded: \${(err as Error).message}\`); // uncommitted: a restart forwards it again
  }
}

/** Consume inbox until shutdown() stops it: handler → send to outbox (same key) → commit after the ack. */
export async function run(handler: Handler): Promise<void> {
  stopping = false;
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({topic: INBOX, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({partition, message}) => {
      if (stopping) return;
      inFlight = forward(partition, message, handler);
      await inFlight;
      inFlight = null;
    },
  });
}

/** Stop taking records, flush with the time left, commit synchronously what is safe, close both clients; back within deadlineS. */
export async function shutdown(deadlineS: number): Promise<Report> {
  stopping = true;
  const deadlineAt = Date.now() + deadlineS * 1000;
  const remaining = (): number => deadlineAt - Date.now();
  await consumer.stop(); // no more records; the one in hand runs on
  if (inFlight !== null) await within(inFlight, remaining());
  if (sends.size > 0) await within(Promise.allSettled([...sends]), remaining()); // the timed flush
  for (const partition of pending.keys()) advance(partition);
  await commit();
  const undelivered = sends.size;
  const uncommitted = [...pending.values()].reduce((n, queue) => n + queue.length, 0);
  await consumer.disconnect();
  await producer.disconnect();
  if (undelivered > 0 || uncommitted > 0)
    console.warn(\`shutdown: \${undelivered} forwards undelivered, \${uncommitted} records uncommitted — a restart forwards them again\`);
  return {forwarded, committed_offsets: Object.fromEntries(watermark), undelivered, uncommitted};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	inbox   = "inbox"
	outbox  = "outbox"
	groupID = "forwarder"
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: groupID,
	Topic:   inbox,
	// TODO: StartOffset kafka.FirstOffset — a new group begins at the earliest record
})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        outbox,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

// Report is what shutdown returns.
type Report struct {
	Forwarded        int
	CommittedOffsets map[int]int64
	Undelivered      int
	Uncommitted      int
}

type Handler func(msg kafka.Message) ([]byte, error)

var (
	mu          sync.Mutex
	forwarded   int             // forwards the broker acknowledged since run started
	committed   = map[int]int64{} // per inbox partition: the offset committed
	inHand      *kafka.Message  // the record being handled or forwarded
	done        = make(chan struct{})
	pollCtx, stopPolling = context.WithCancel(context.Background())
	workCtx, abortWork   = context.WithCancel(context.Background()) // ends the forward or commit in hand at the deadline
)

// run consumes inbox until shutdown stops it: handler → write to outbox (same key) → commit after the ack.
func run(handler Handler) {
	defer close(done)
	for {
		msg, err := reader.FetchMessage(pollCtx)
		if err != nil {
			return // stopped
		}
		// TODO: remember msg as in hand, write handler(msg) to outbox keyed by msg.Key (WriteMessages returns on the ack),
		//       then CommitMessages(msg); on a failed write leave the offset uncommitted
		_ = msg
		panic("not implemented")
	}
}

// shutdown stops polling, gives the record in hand the time left, commits what is safe, closes both clients; back within deadline.
func shutdown(deadline time.Duration) Report {
	// TODO
	panic("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	inbox   = "inbox"
	outbox  = "outbox"
	groupID = "forwarder"
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     groupID,
	Topic:       inbox,
	StartOffset: kafka.FirstOffset, // a new group begins at the earliest record
})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        outbox,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

// Report is what shutdown returns.
type Report struct {
	Forwarded        int
	CommittedOffsets map[int]int64
	Undelivered      int
	Uncommitted      int
}

type Handler func(msg kafka.Message) ([]byte, error)

var (
	mu          sync.Mutex
	forwarded   int             // forwards the broker acknowledged since run started
	committed   = map[int]int64{} // per inbox partition: the offset committed
	inHand      *kafka.Message  // the record being handled or forwarded
	handling    bool            // the handler of the record in hand is running: nothing can interrupt it
	done        = make(chan struct{})
	pollCtx, stopPolling = context.WithCancel(context.Background())
	workCtx, abortWork   = context.WithCancel(context.Background()) // ends the forward or commit in hand at the deadline
)

// run consumes inbox until shutdown stops it: handler → write to outbox (same key) → commit after the ack.
func run(handler Handler) {
	defer close(done)
	for {
		msg, err := reader.FetchMessage(pollCtx)
		if err != nil {
			return // stopped
		}
		mu.Lock()
		inHand = &msg
		handling = true
		mu.Unlock()
		value, err := handler(msg)
		mu.Lock()
		handling = false
		mu.Unlock()
		if err == nil {
			// WriteMessages returns once the broker acknowledged (RequireAll); workCtx ends it at the deadline.
			err = writer.WriteMessages(workCtx, kafka.Message{Key: msg.Key, Value: value})
		}
		if err != nil {
			log.Printf("inbox[%d]@%d not forwarded: %v", msg.Partition, msg.Offset, err) // uncommitted: a restart forwards it again
			mu.Lock()
			inHand = nil
			mu.Unlock()
			continue
		}
		if err := reader.CommitMessages(workCtx, msg); err != nil {
			log.Printf("inbox[%d]@%d forwarded but not committed: %v", msg.Partition, msg.Offset, err)
		} else {
			mu.Lock()
			committed[msg.Partition] = msg.Offset + 1
			mu.Unlock()
		}
		mu.Lock()
		forwarded++
		inHand = nil
		mu.Unlock()
	}
}

// shutdown stops polling, gives the record in hand the time left, commits what is safe, closes both clients; back within deadline.
func shutdown(deadline time.Duration) Report {
	deadlineAt := time.Now().Add(deadline)
	stopPolling() // no more records; the one in hand runs on
	report := Report{CommittedOffsets: map[int]int64{}}
	select {
	case <-done:
	case <-time.After(time.Until(deadlineAt)):
		abortWork() // the forward or commit in hand gets no more time: it stays uncommitted
		mu.Lock()
		stuck, abandoned := handling, inHand != nil
		mu.Unlock()
		if abandoned {
			report.Uncommitted = 1
			if !stuck {
				report.Undelivered = 1 // its forward never got an ack
			}
		}
		if !stuck { // an aborted forward or commit returns at once; a handler that is still running is not waited for
			<-done
		}
	}
	mu.Lock()
	report.Forwarded = forwarded
	for p, off := range committed {
		report.CommittedOffsets[p] = off
	}
	mu.Unlock()
	_ = reader.Close() // commits nothing on its own: every offset was committed synchronously after its ack
	writerClosed := make(chan struct{})
	go func() {
		_ = writer.Close() // flushes: waits for every batch still in flight
		close(writerClosed)
	}()
	select {
	case <-writerClosed:
	case <-time.After(time.Until(deadlineAt)): // a batch still retrying on a dead broker is abandoned at the deadline
	}
	if report.Undelivered > 0 || report.Uncommitted > 0 {
		log.Printf("shutdown: %d forwards undelivered, %d records uncommitted — a restart forwards them again", report.Undelivered, report.Uncommitted)
	}
	return report
}
`,
    },
    scala: {
      starter: `import java.time.{Duration, Instant}
import java.util.Properties
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.errors.WakeupException
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.collection.mutable
import scala.jdk.CollectionConverters._

/** Forwarder: inbox → handler → outbox, committed after the forward's ack; shutdown drains, commits and closes under a deadline. */
object Forwarder {
  val Inbox = "inbox"
  val Outbox = "outbox"
  val Group = "forwarder"

  case class Report(forwarded: Int, committedOffsets: Map[Int, Long], undelivered: Int, uncommitted: Int)

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", Group)
  // TODO: start at the earliest offset when the group has none; commit by hand, never on a timer
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)
  consumer.subscribe(List(Inbox).asJava)

  private final class Entry(val partition: Int, val offset: Long) { @volatile var acked = false }

  @volatile private var stopping = false
  @volatile var forwarded = 0 // forwards the broker acknowledged since run() started
  private val stopped = new CountDownLatch(1)
  /** Per inbox partition: the records taken and not yet committed, in offset order. */
  private val pending = mutable.Map[Int, mutable.Queue[Entry]]()
  /** Per inbox partition: the next offset that is safe to commit (every earlier forward acknowledged). */
  private val watermark = mutable.Map[Int, Long]()
  private val committed = mutable.Map[Int, Long]()

  /** Consume inbox until shutdown() stops it: handler → send to outbox (same key) → commit after the ack. */
  def run(handler: ConsumerRecord[String, String] => String): Unit = {
    stopping = false
    try while (!stopping) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        // TODO: remember the record as pending, send handler(record) to Outbox keyed by record.key() with a callback that
        //       marks it acknowledged, then commit the partition's watermark
      }
    } catch { case _: WakeupException => } // shutdown() woke the poll
    finally stopped.countDown()
  }

  /** Stop taking records, flush with the time left, commit synchronously what is safe, close both clients; back within deadline. */
  def shutdown(deadline: Duration): Report = {
    ??? // TODO
  }
}
`,
      solution: `import java.time.{Duration, Instant}
import java.util.Properties
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.errors.WakeupException
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.collection.mutable
import scala.jdk.CollectionConverters._

/** Forwarder: inbox → handler → outbox, committed after the forward's ack; shutdown drains, commits and closes under a deadline. */
object Forwarder {
  val Inbox = "inbox"
  val Outbox = "outbox"
  val Group = "forwarder"

  case class Report(forwarded: Int, committedOffsets: Map[Int, Long], undelivered: Int, uncommitted: Int)

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", Group)
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)
  consumer.subscribe(List(Inbox).asJava)

  private final class Entry(val partition: Int, val offset: Long) { @volatile var acked = false }

  @volatile private var stopping = false
  @volatile var forwarded = 0 // forwards the broker acknowledged since run() started
  private val stopped = new CountDownLatch(1)
  /** Per inbox partition: the records taken and not yet committed, in offset order. */
  private val pending = mutable.Map[Int, mutable.Queue[Entry]]()
  /** Per inbox partition: the next offset that is safe to commit (every earlier forward acknowledged). */
  private val watermark = mutable.Map[Int, Long]()
  private val committed = mutable.Map[Int, Long]()

  /** Move the partition's watermark over the leading run of acknowledged records; the first unacked one blocks it. */
  private def advance(partition: Int): Unit = pending.synchronized {
    val queue = pending(partition)
    while (queue.nonEmpty && queue.head.acked) watermark(partition) = queue.dequeue().offset + 1
  }

  private def commit(): Unit = {
    val due = watermark.filter { case (p, off) => !committed.get(p).contains(off) }
    if (due.nonEmpty) {
      consumer.commitSync(due.map { case (p, off) => new TopicPartition(Inbox, p) -> new OffsetAndMetadata(off) }.asJava)
      committed ++= due
    }
  }

  /** Consume inbox until shutdown() stops it: handler → send to outbox (same key) → commit after the ack. */
  def run(handler: ConsumerRecord[String, String] => String): Unit = {
    stopping = false
    try while (!stopping) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val entry = new Entry(record.partition(), record.offset())
        pending.synchronized(pending.getOrElseUpdate(entry.partition, mutable.Queue()).enqueue(entry))
        val value = handler(record)
        producer.send(new ProducerRecord[String, String](Outbox, record.key(), value), new Callback {
          override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
            if (exception == null) { entry.acked = true; forwarded += 1 }
            else System.err.println(s"inbox[\${entry.partition}]@\${entry.offset} not forwarded: \${exception.getMessage}")
        })
        advance(entry.partition)
        commit()
      }
    } catch { case _: WakeupException => } // shutdown() woke the poll
    finally stopped.countDown()
  }

  /** Stop taking records, flush with the time left, commit synchronously what is safe, close both clients; back within deadline. */
  def shutdown(deadline: Duration): Report = {
    val deadlineAt = Instant.now().plus(deadline)
    def remaining: Duration = { val left = Duration.between(Instant.now(), deadlineAt); if (left.isNegative) Duration.ZERO else left }
    stopping = true
    consumer.wakeup() // no more records; the one in hand runs on
    stopped.await(remaining.toMillis, TimeUnit.MILLISECONDS)
    producer.close(remaining) // the timed flush: a dead broker costs the deadline, not delivery.timeout.ms
    pending.keys.foreach(advance)
    commit()
    val undelivered = pending.synchronized(pending.values.map(_.count(!_.acked)).sum)
    val uncommitted = pending.synchronized(pending.values.map(_.size).sum)
    consumer.close()
    if (undelivered > 0 || uncommitted > 0)
      System.err.println(s"shutdown: $undelivered forwards undelivered, $uncommitted records uncommitted — a restart forwards them again")
    Report(forwarded, watermark.toMap, undelivered, uncommitted)
  }
}
`,
    },
    cpp: {
      starter: `// Forwarder: inbox → handler → outbox, committed after the forward's ack; shutdown drains, commits and closes under a deadline.
#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <deque>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <vector>

const std::string kInbox = "inbox";
const std::string kOutbox = "outbox";
const std::string kGroup = "forwarder";

struct Report {
  int forwarded = 0;
  std::map<int, int64_t> committed_offsets;
  int undelivered = 0;
  int uncommitted = 0;
};

struct Entry {
  int partition;
  int64_t offset;
  bool acked = false;
};

using Handler = std::function<std::string(const RdKafka::Message&)>;

// Delivery report of one forward: acknowledged, or not — an unacknowledged forward keeps its offset uncommitted.
class OnDelivery : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    auto* entry = static_cast<Entry*>(message.msg_opaque());
    // TODO: mark the entry acknowledged (and count it) unless message.err() says otherwise
  }
};

OnDelivery delivery_report;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  // TODO: start at the earliest offset when the group has none; commit by hand, never on a timer
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kInbox});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();

bool stopping = false;
int forwarded = 0;  // forwards the broker acknowledged since run() started
// Per inbox partition: the records taken and not yet committed, in offset order (owned here; the producer holds a pointer).
std::map<int, std::deque<std::unique_ptr<Entry>>> pending;
// Per inbox partition: the next offset that is safe to commit (every earlier forward acknowledged).
std::map<int, int64_t> watermark;
std::map<int, int64_t> committed;

// Consume inbox until shutdown() stops it: handler → produce to outbox (same key) → commit after the ack.
void run(const Handler& handler) {
  stopping = false;
  while (!stopping) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    // TODO: remember the record as pending, produce handler(*msg) to kOutbox keyed by *msg->key() with the entry as
    //       msg_opaque, poll(0) for delivery reports, then commit the partition's watermark
    throw std::logic_error("not implemented");
  }
}

// Stop taking records, flush with the time left, commit synchronously what is safe, close both clients; back within deadline_ms.
Report shutdown(int deadline_ms) {
  // TODO
  throw std::logic_error("not implemented");
}
`,
      solution: `// Forwarder: inbox → handler → outbox, committed after the forward's ack; shutdown drains, commits and closes under a deadline.
#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <deque>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <vector>

const std::string kInbox = "inbox";
const std::string kOutbox = "outbox";
const std::string kGroup = "forwarder";

struct Report {
  int forwarded = 0;
  std::map<int, int64_t> committed_offsets;
  int undelivered = 0;
  int uncommitted = 0;
};

struct Entry {
  int partition;
  int64_t offset;
  bool acked = false;
};

using Handler = std::function<std::string(const RdKafka::Message&)>;

bool stopping = false;
int forwarded = 0;  // forwards the broker acknowledged since run() started
// Per inbox partition: the records taken and not yet committed, in offset order (owned here; the producer holds a pointer).
std::map<int, std::deque<std::unique_ptr<Entry>>> pending;
// Per inbox partition: the next offset that is safe to commit (every earlier forward acknowledged).
std::map<int, int64_t> watermark;
std::map<int, int64_t> committed;

// Delivery report of one forward: acknowledged, or not — an unacknowledged forward keeps its offset uncommitted.
class OnDelivery : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    auto* entry = static_cast<Entry*>(message.msg_opaque());
    if (message.err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "inbox[" << entry->partition << "]@" << entry->offset << " not forwarded: " << message.errstr() << "\\n";
      return;
    }
    entry->acked = true;
    ++forwarded;
  }
};

OnDelivery delivery_report;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kInbox});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();

// Move the partition's watermark over the leading run of acknowledged records; the first unacked one blocks it.
void advance(int partition) {
  auto& queue = pending[partition];
  while (!queue.empty() && queue.front()->acked) {
    watermark[partition] = queue.front()->offset + 1;
    queue.pop_front();
  }
}

void commit() {
  std::vector<RdKafka::TopicPartition*> due;
  for (const auto& [partition, offset] : watermark) {
    auto it = committed.find(partition);
    if (it == committed.end() || it->second != offset) due.push_back(RdKafka::TopicPartition::create(kInbox, partition, offset));
  }
  if (due.empty()) return;
  if (consumer->commitSync(due) == RdKafka::ERR_NO_ERROR)
    for (const auto* tp : due) committed[tp->partition()] = tp->offset();
  RdKafka::TopicPartition::destroy(due);
}

// Consume inbox until shutdown() stops it: handler → produce to outbox (same key) → commit after the ack.
void run(const Handler& handler) {
  stopping = false;
  while (!stopping) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    auto entry = std::make_unique<Entry>(Entry{msg->partition(), msg->offset()});
    Entry* raw = entry.get();
    pending[msg->partition()].push_back(std::move(entry));
    std::string value = handler(*msg);
    const std::string* key = msg->key();
    producer->produce(kOutbox, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, value.data(), value.size(),
                      key ? key->data() : nullptr, key ? key->size() : 0, 0, nullptr, raw);
    producer->poll(0);  // serve the delivery reports that are in: acknowledged forwards move the watermark
    advance(msg->partition());
    commit();
  }
}

// Stop taking records, flush with the time left, commit synchronously what is safe, close both clients; back within deadline_ms.
Report shutdown(int deadline_ms) {
  const auto deadline_at = std::chrono::steady_clock::now() + std::chrono::milliseconds(deadline_ms);
  stopping = true;
  const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline_at - std::chrono::steady_clock::now()).count();
  producer->flush(static_cast<int>(left > 0 ? left : 0));  // the timed flush: a dead broker costs the deadline, not message.timeout.ms
  for (const auto& [partition, _] : pending) advance(partition);
  commit();
  Report report;
  report.forwarded = forwarded;
  report.committed_offsets = watermark;
  report.undelivered = producer->outq_len();
  for (const auto& [_, queue] : pending) report.uncommitted += static_cast<int>(queue.size());
  consumer->close();
  if (report.undelivered > 0 || report.uncommitted > 0)
    std::cerr << "shutdown: " << report.undelivered << " forwards undelivered, " << report.uncommitted
              << " records uncommitted — a restart forwards them again\\n";
  return report;
}
`,
    },
  },
  harness: {
    python: `import time

INBOX = "inbox"
OUTBOX = "outbox"
GROUP = "forwarder"


def seed(ctx, *keys):
    """Inbox records on one partition, so offsets and order are known."""
    for key in keys:
        ctx.kafka.seed(INBOX, key=key, value=f"v-{key}", partition=0)


def make_handler(ctx, calls, slow=(), stall_on=None):
    """Records every key it sees; sleeps 2 s (virtual) on the slow keys; stalls outbox when it sees stall_on."""

    def handler(msg):
        key = msg.key().decode()
        calls.append(key)
        if key in slow:
            time.sleep(2)
        if key == stall_on:
            ctx.kafka.stall(OUTBOX)
        return msg.value().decode().upper()

    return handler


def outbox(ctx):
    return [(r.key.decode(), r.value.decode()) for r in ctx.kafka.records(OUTBOX)]


def delivered(ctx):
    return sum(1 for e in ctx.kafka.events if e[0] == "deliver" and e[1] == GROUP and e[2] == INBOX)


def stalled_forwards(ctx):
    return sum(1 for e in ctx.kafka.events if e[0] == "produce-stalled" and e[1] == OUTBOX)


def check_drain(ctx):
    seed(ctx, "a", "slow", "b")
    calls = []
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((dict(offsets), len(ctx.kafka.records(OUTBOX)))))
    m = ctx.load("forwarder")
    ctx.drain(m.run, make_handler(ctx, calls, slow=("slow",)))
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, before the forward was acknowledged"
    before = ctx.clock.time()
    report = m.shutdown(5)
    took = ctx.clock.time() - before
    assert took <= 5.5, f"shutdown(5) with a healthy broker took {took:.1f} s of clock time"
    assert outbox(ctx) == [("a", "V-A"), ("slow", "V-SLOW"), ("b", "V-B")], f"outbox must hold every forward with the inbox key and the handler's value, in order; it holds {outbox(ctx)}"
    assert calls == ["a", "slow", "b"], f"the handler saw {calls}, expected a, slow, b once each"
    assert ctx.kafka.committed_offset(GROUP, INBOX, 0) == 3, f"after a clean shutdown every forwarded record is committed: the committed offset is {ctx.kafka.committed_offset(GROUP, INBOX, 0)}, expected 3"
    for offsets, held in at_commit:
        for (topic, partition), offset in offsets.items():
            assert held >= offset, f"inbox[{partition}] was committed to {offset} when outbox held only {held} records: commit after the forward's ack, never before"
    assert isinstance(report, dict), f"shutdown must return the report dict, got {report!r}"
    assert report.get("undelivered") == 0 and report.get("uncommitted") == 0, f"a clean stop reports undelivered 0 and uncommitted 0, got {report}"
    assert report.get("forwarded") == 3, f"forwarded must count the acknowledged forwards (3), got {report.get('forwarded')!r}"
    assert dict(report.get("committed_offsets") or {}).get(0) == 3, f"committed_offsets must say inbox partition 0 is committed to 3, got {report.get('committed_offsets')!r}"


def check_stalled(ctx):
    seed(ctx, "a", "b", "c", "d")
    calls = []
    m = ctx.load("forwarder")
    ctx.drain(m.run, make_handler(ctx, calls, stall_on="c"))  # the broker stops acknowledging outbox from c on
    assert outbox(ctx) == [("a", "V-A"), ("b", "V-B")], f"with outbox stalled from c on, only a and b can be there; it holds {outbox(ctx)}"
    before = ctx.clock.time()
    report = m.shutdown(5)
    took = ctx.clock.time() - before
    assert took <= 5.5, f"shutdown(5) took {took:.1f} s with outbox stalled: flush with the time left, not message.timeout.ms"
    assert ctx.kafka.committed_offset(GROUP, INBOX, 0) == 2, f"c's forward was never acknowledged, so nothing past it may be committed: the committed offset is {ctx.kafka.committed_offset(GROUP, INBOX, 0)}, expected 2"
    assert outbox(ctx) == [("a", "V-A"), ("b", "V-B")], "nothing can reach outbox while it is stalled"
    want_undelivered = stalled_forwards(ctx)
    want_uncommitted = delivered(ctx) - 2
    assert want_undelivered >= 1 and want_uncommitted >= 1, "the handler stalled outbox on c: at least c must be in flight"
    assert report.get("undelivered") == want_undelivered, f"undelivered must count the forwards the broker never acknowledged ({want_undelivered}), got {report.get('undelivered')!r}"
    assert report.get("uncommitted") == want_uncommitted, f"uncommitted must count the records taken from inbox whose offset is not committed ({want_uncommitted}), got {report.get('uncommitted')!r}"
    assert report.get("forwarded") == 2, f"forwarded counts acknowledged forwards only (a, b), got {report.get('forwarded')!r}"
    assert dict(report.get("committed_offsets") or {}).get(0) == 2, f"committed_offsets must say inbox partition 0 is committed to 2, got {report.get('committed_offsets')!r}"
    assert any(e[0] == "close" and e[1] == GROUP for e in ctx.kafka.events), "the consumer must be closed by the time shutdown returns"


def check_restart(ctx):
    seed(ctx, "a", "b", "c", "d")
    calls = []
    m = ctx.load("forwarder")
    ctx.drain(m.run, make_handler(ctx, calls, stall_on="c"))
    report = m.shutdown(5)
    resumable = {"c", "d"}  # taken past the committed offset 2: a restart may handle these again
    ctx.kafka.resume(OUTBOX)
    m2 = ctx.load("forwarder")  # a fresh process over the same broker
    calls2 = []
    ctx.drain(m2.run, make_handler(ctx, calls2))
    report2 = m2.shutdown(5)
    assert "a" not in calls2 and "b" not in calls2, f"the restart handled {calls2}: it must resume from the committed offset (2), not from the beginning"
    assert set(calls2) >= resumable, f"the restart handled {calls2}: the records taken but not committed (c, d) must be handled again"
    held = outbox(ctx)
    for key in "abcd":
        assert (key, f"V-{key.upper()}") in held, f"after the restart outbox must hold every inbox record at least once; {key} is missing from {held}"
    keys = [k for k, _ in held]
    dup = {k for k in keys if keys.count(k) > 1}
    assert dup <= resumable, f"{sorted(dup - resumable)} reached outbox twice although they were committed: duplicates may only be the records reported uncommitted"
    assert ctx.kafka.lag(GROUP, INBOX) == 0, f"after the restart's clean shutdown nothing may be left uncommitted: lag is {ctx.kafka.lag(GROUP, INBOX)}"
    assert report2.get("undelivered") == 0 and report2.get("uncommitted") == 0, f"the restart's clean stop must report zeros, got {report2}"


def check_once(ctx):
    seed(ctx, "a", "b", "c")
    calls = []
    m = ctx.load("forwarder")
    ctx.drain(m.run, make_handler(ctx, calls))
    m.shutdown(5)
    seed(ctx, "d", "e")
    m2 = ctx.load("forwarder")  # a fresh process over the same broker
    ctx.drain(m2.run, make_handler(ctx, calls))
    m2.shutdown(5)
    assert calls == ["a", "b", "c", "d", "e"], f"across a clean shutdown and a restart each record reaches the handler once: it saw {calls}"
    assert [k for k, _ in outbox(ctx)] == ["a", "b", "c", "d", "e"], f"outbox must hold each record once, in order; it holds {[k for k, _ in outbox(ctx)]}"
    assert ctx.kafka.committed_offset(GROUP, INBOX, 0) == 5, f"the committed offset is {ctx.kafka.committed_offset(GROUP, INBOX, 0)}, expected 5"
    closes = [e for e in ctx.kafka.events if e[0] == "close" and e[1] == GROUP]
    assert len(closes) == 2, f"each process must close its consumer on shutdown: {len(closes)} close(s) seen for group {GROUP}"


def check_deadline(ctx):
    seed(ctx, "a", "b")
    calls = []
    m = ctx.load("forwarder")
    ctx.kafka.stall(OUTBOX, seconds=2)  # the broker is slow at the moment of the stop: it answers 2 s later
    ctx.drain(m.run, make_handler(ctx, calls))
    before = ctx.clock.time()
    report = m.shutdown(5)
    took = ctx.clock.time() - before
    assert outbox(ctx) == [("a", "V-A"), ("b", "V-B")], f"the broker answered after 2 s, within the deadline: shutdown must wait for the forwards, outbox holds {outbox(ctx)}"
    assert took <= 2.5, f"the broker answered after 2 s yet shutdown(5) took {took:.1f} s: wait for the forwards, not for the whole deadline"
    assert report.get("undelivered") == 0 and report.get("uncommitted") == 0, f"everything was acknowledged and committed, the report must say so: {report}"
    assert ctx.kafka.committed_offset(GROUP, INBOX, 0) == 2, "both forwards were acknowledged: both offsets must be committed"
    seed(ctx, "c")
    ctx.kafka.stall(OUTBOX)  # now the broker is down for good
    m2 = ctx.load("forwarder")
    ctx.drain(m2.run, make_handler(ctx, calls))
    before = ctx.clock.time()
    report = m2.shutdown(3)
    took = ctx.clock.time() - before
    assert took <= 3.5, f"with outbox down, shutdown(3) took {took:.1f} s of clock time: the deadline is the bound"
    assert took >= 2.5, f"with outbox down, shutdown(3) gave up after {took:.1f} s: the broker may still answer within the deadline, flush with the time left"
    assert report.get("undelivered") == 1 and report.get("uncommitted") == 1, f"c's forward never got an ack: expected undelivered 1, uncommitted 1, got {report}"
    assert ctx.kafka.committed_offset(GROUP, INBOX, 0) == 2, "c was not acknowledged: its offset must not be committed"


def check_closed(ctx):
    seed(ctx, "a", "b")
    calls = []
    m = ctx.load("forwarder")
    ctx.drain(m.run, make_handler(ctx, calls))
    m.shutdown(5)
    events = [e for e in ctx.kafka.events if e[0] in ("manual-commit", "close") and e[1] == GROUP]
    assert any(e[0] == "close" for e in events), "the consumer must be closed by the time shutdown returns"
    commits = [e for e in events if e[0] == "manual-commit"]
    assert commits, "no explicit commit happened"
    last_commit = max(i for i, e in enumerate(events) if e[0] == "manual-commit")
    close = next(i for i, e in enumerate(events) if e[0] == "close")
    assert last_commit < close, "the final commit must happen before the consumer is closed"
    assert commits[-1][2] is False, "the final commit must be synchronous (asynchronous=False): an async commit behind a closing client may never land"
    assert ctx.kafka.committed_offset(GROUP, INBOX, 0) == 2, f"the committed offset is {ctx.kafka.committed_offset(GROUP, INBOX, 0)}, expected 2"
    try:
        m.consumer.poll(0)
        raise AssertionError("the consumer still polls after shutdown: close it")
    except RuntimeError:
        pass
`,
    typescript: `const INBOX = 'inbox';
const OUTBOX = 'outbox';
const GROUP = 'forwarder';

/** Inbox records on one partition, so offsets and order are known. */
function seed(ctx, ...keys: string[]) {
  for (const key of keys) ctx.kafka.seed(INBOX, {key, value: \`v-\${key}\`, partition: 0});
}

/**
 * Records every key it sees; sleeps (virtual) on the slow keys; stalls outbox when it sees stallOn; resolves \`inHand\`
 * the moment the handler of \`watch\` is entered — before any clock moves — so a shutdown can be issued with that record in hand.
 */
function makeHandler(ctx, calls: string[], options: {slow?: Record<string, number>; stallOn?: string; watch?: string} = {}) {
  const {promise: inHand, resolve} = Promise.withResolvers<void>();
  const handler = async (message) => {
    const key = message.key.toString();
    calls.push(key);
    if (key === options.stallOn) ctx.kafka.stall(OUTBOX);
    if (key === options.watch) resolve();
    const ms = options.slow?.[key];
    if (ms !== undefined) {
      const {promise, resolve: wake} = Promise.withResolvers<void>();
      setTimeout(wake, ms);
      await promise;
    }
    return message.value.toString().toUpperCase();
  };
  return {handler, inHand};
}

const outbox = (ctx): [string, string][] => ctx.kafka.records(OUTBOX).map(r => [r.key.toString(), r.value.toString()]);
const delivered = (ctx): number => ctx.kafka.events.filter(e => e[0] === 'deliver' && e[1] === GROUP && e[2] === INBOX).length;
const stalledForwards = (ctx): number => ctx.kafka.events.filter(e => e[0] === 'produce-stalled' && e[1] === OUTBOX).length;
const seconds = (ctx, before: number): number => (ctx.clock.now() - before) / 1000;

export async function check_drain(ctx) {
  seed(ctx, 'a', 'slow', 'b');
  const calls: string[] = [];
  const atCommit: [Map<string, number>, number][] = [];
  ctx.kafka.onCommit((group, offsets) => atCommit.push([new Map(offsets), ctx.kafka.records(OUTBOX).length]));
  const m = ctx.load('forwarder');
  const {handler, inHand} = makeHandler(ctx, calls, {slow: {slow: 2000}, watch: 'slow'});
  const running = ctx.drain(m.run(handler));
  await Promise.race([inHand, running]); // the handler of 'slow' is in hand, sleeping 2 s (or the loop died first)
  const before = ctx.clock.now();
  const report = await m.shutdown(5);
  const took = seconds(ctx, before);
  await running;
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, before the forward was acknowledged');
  assert(took <= 5.5, \`shutdown(5) with a healthy broker took \${took.toFixed(1)} s of clock time\`);
  assert.deepStrictEqual(outbox(ctx), [['a', 'V-A'], ['slow', 'V-SLOW']], \`shutdown must let the handler in hand finish and forward its record with the inbox key, then take no more: outbox holds \${JSON.stringify(outbox(ctx))}\`);
  assert.deepStrictEqual(calls, ['a', 'slow'], \`the handler saw \${JSON.stringify(calls)}: after shutdown no further record may be taken (b stays for the next process)\`);
  assert.equal(ctx.kafka.committedOffset(GROUP, INBOX, 0), 2, \`after a clean shutdown every forwarded record is committed: the committed offset is \${ctx.kafka.committedOffset(GROUP, INBOX, 0)}, expected 2\`);
  for (const [offsets, held] of atCommit)
    for (const [tp, offset] of offsets) assert(held >= offset, \`\${tp} was committed to \${offset} when outbox held only \${held} records: commit after the forward's ack, never before\`);
  assert(report && typeof report === 'object', \`shutdown must return the report, got \${JSON.stringify(report)}\`);
  assert(report.undelivered === 0 && report.uncommitted === 0, \`a clean stop reports undelivered 0 and uncommitted 0, got \${JSON.stringify(report)}\`);
  assert.equal(report.forwarded, 2, \`forwarded must count the acknowledged forwards (2), got \${JSON.stringify(report.forwarded)}\`);
  assert.equal(report.committed_offsets?.[0], 2, \`committed_offsets must say inbox partition 0 is committed to 2, got \${JSON.stringify(report.committed_offsets)}\`);
}

export async function check_stalled(ctx) {
  seed(ctx, 'a', 'b', 'c', 'd');
  const calls: string[] = [];
  const m = ctx.load('forwarder');
  const {handler, inHand} = makeHandler(ctx, calls, {stallOn: 'c', watch: 'c'});
  const running = ctx.drain(m.run(handler)); // the broker stops acknowledging outbox from c on
  await Promise.race([inHand, running]);
  const before = ctx.clock.now();
  const report = await m.shutdown(5);
  const took = seconds(ctx, before);
  await running;
  assert(took <= 5.5, \`shutdown(5) took \${took.toFixed(1)} s with outbox stalled: give the forwards the time left, not the send's whole timeout\`);
  assert.equal(ctx.kafka.committedOffset(GROUP, INBOX, 0), 2, \`c's forward was never acknowledged, so nothing past it may be committed: the committed offset is \${ctx.kafka.committedOffset(GROUP, INBOX, 0)}, expected 2\`);
  assert.deepStrictEqual(outbox(ctx), [['a', 'V-A'], ['b', 'V-B']], 'nothing can reach outbox while it is stalled');
  const wantUndelivered = stalledForwards(ctx);
  const wantUncommitted = delivered(ctx) - 2;
  assert(wantUndelivered >= 1 && wantUncommitted >= 1, 'the handler stalled outbox on c: at least c must be in flight');
  assert.equal(report.undelivered, wantUndelivered, \`undelivered must count the forwards the broker never acknowledged (\${wantUndelivered}), got \${JSON.stringify(report.undelivered)}\`);
  assert.equal(report.uncommitted, wantUncommitted, \`uncommitted must count the records taken from inbox whose offset is not committed (\${wantUncommitted}), got \${JSON.stringify(report.uncommitted)}\`);
  assert.equal(report.forwarded, 2, \`forwarded counts acknowledged forwards only (a, b), got \${JSON.stringify(report.forwarded)}\`);
  assert.equal(report.committed_offsets?.[0], 2, \`committed_offsets must say inbox partition 0 is committed to 2, got \${JSON.stringify(report.committed_offsets)}\`);
  assert(ctx.kafka.events.some(e => e[0] === 'close' && e[1] === GROUP), 'the consumer must be disconnected by the time shutdown returns');
}

export async function check_restart(ctx) {
  seed(ctx, 'a', 'b', 'c', 'd');
  const calls: string[] = [];
  const m = ctx.load('forwarder');
  const {handler, inHand} = makeHandler(ctx, calls, {stallOn: 'c', watch: 'c'});
  const running = ctx.drain(m.run(handler));
  await Promise.race([inHand, running]);
  await m.shutdown(5);
  await running;
  const resumable = new Set(['c', 'd']); // taken past the committed offset 2: a restart may handle these again
  ctx.kafka.resume(OUTBOX);
  const m2 = ctx.reload('forwarder'); // a fresh process over the same broker
  const calls2: string[] = [];
  await ctx.drain(m2.run(makeHandler(ctx, calls2).handler));
  const report2 = await m2.shutdown(5);
  assert(!calls2.includes('a') && !calls2.includes('b'), \`the restart handled \${JSON.stringify(calls2)}: it must resume from the committed offset (2), not from the beginning\`);
  assert(calls2.includes('c') && calls2.includes('d'), \`the restart handled \${JSON.stringify(calls2)}: the records taken but not committed (c, d) must be handled again\`);
  const held = outbox(ctx);
  for (const key of ['a', 'b', 'c', 'd'])
    assert(held.some(([k, v]) => k === key && v === \`V-\${key.toUpperCase()}\`), \`after the restart outbox must hold every inbox record at least once; \${key} is missing from \${JSON.stringify(held)}\`);
  const keys = held.map(([k]) => k);
  const dup = [...new Set(keys.filter(k => keys.filter(x => x === k).length > 1))];
  assert(dup.every(k => resumable.has(k)), \`\${JSON.stringify(dup.filter(k => !resumable.has(k)))} reached outbox twice although they were committed: duplicates may only be the records reported uncommitted\`);
  assert.equal(ctx.kafka.lag(GROUP, INBOX), 0, \`after the restart's clean shutdown nothing may be left uncommitted: lag is \${ctx.kafka.lag(GROUP, INBOX)}\`);
  assert(report2.undelivered === 0 && report2.uncommitted === 0, \`the restart's clean stop must report zeros, got \${JSON.stringify(report2)}\`);
}

export async function check_once(ctx) {
  seed(ctx, 'a', 'b', 'c');
  const calls: string[] = [];
  const m = ctx.load('forwarder');
  await ctx.drain(m.run(makeHandler(ctx, calls).handler));
  await m.shutdown(5);
  seed(ctx, 'd', 'e');
  const m2 = ctx.reload('forwarder'); // a fresh process over the same broker
  await ctx.drain(m2.run(makeHandler(ctx, calls).handler));
  await m2.shutdown(5);
  assert.deepStrictEqual(calls, ['a', 'b', 'c', 'd', 'e'], \`across a clean shutdown and a restart each record reaches the handler once: it saw \${JSON.stringify(calls)}\`);
  assert.deepStrictEqual(outbox(ctx).map(([k]) => k), ['a', 'b', 'c', 'd', 'e'], \`outbox must hold each record once, in order; it holds \${JSON.stringify(outbox(ctx).map(([k]) => k))}\`);
  assert.equal(ctx.kafka.committedOffset(GROUP, INBOX, 0), 5, \`the committed offset is \${ctx.kafka.committedOffset(GROUP, INBOX, 0)}, expected 5\`);
  const closes = ctx.kafka.events.filter(e => e[0] === 'close' && e[1] === GROUP);
  assert.equal(closes.length, 2, \`each process must disconnect its consumer on shutdown: \${closes.length} close(s) seen for group \${GROUP}\`);
}

export async function check_deadline(ctx) {
  seed(ctx, 'a', 'b');
  const calls: string[] = [];
  const m = ctx.load('forwarder');
  ctx.kafka.stall(OUTBOX, 2); // the broker is slow at the moment of the stop: it answers 2 s later
  const {handler, inHand} = makeHandler(ctx, calls, {watch: 'a'});
  const running = ctx.drain(m.run(handler));
  await Promise.race([inHand, running]); // a is in hand, its forward about to wait for the slow broker
  let before = ctx.clock.now();
  let report = await m.shutdown(5);
  let took = seconds(ctx, before);
  await running;
  assert.deepStrictEqual(outbox(ctx), [['a', 'V-A']], \`the broker answered after 2 s, within the deadline: shutdown must wait for the forward in hand, outbox holds \${JSON.stringify(outbox(ctx))}\`);
  assert(took <= 2.5, \`the broker answered after 2 s yet shutdown(5) took \${took.toFixed(1)} s: wait for the forward, not for the whole deadline\`);
  assert(report.undelivered === 0 && report.uncommitted === 0, \`everything in hand was acknowledged and committed, the report must say so: \${JSON.stringify(report)}\`);
  assert.equal(ctx.kafka.committedOffset(GROUP, INBOX, 0), 1, "a's forward was acknowledged: its offset must be committed");

  ctx.kafka.stall(OUTBOX); // now the broker is down for good
  const m2 = ctx.reload('forwarder');
  const {handler: handler2, inHand: inHand2} = makeHandler(ctx, calls, {watch: 'b'});
  const running2 = ctx.drain(m2.run(handler2));
  await Promise.race([inHand2, running2]); // b is in hand, its forward about to stall
  before = ctx.clock.now();
  report = await m2.shutdown(3);
  took = seconds(ctx, before);
  await running2;
  assert(took <= 3.5, \`with outbox down, shutdown(3) took \${took.toFixed(1)} s of clock time: the deadline is the bound\`);
  assert(took >= 2.5, \`with outbox down, shutdown(3) gave up after \${took.toFixed(1)} s: the broker may still answer within the deadline, wait with the time left\`);
  assert(report.undelivered === 1 && report.uncommitted === 1, \`b's forward never got an ack: expected undelivered 1, uncommitted 1, got \${JSON.stringify(report)}\`);
  assert.equal(ctx.kafka.committedOffset(GROUP, INBOX, 0), 1, 'b was not acknowledged: its offset must not be committed');

  ctx.kafka.resume(OUTBOX);
  seed(ctx, 'stuck');
  const m3 = ctx.reload('forwarder');
  const {handler: handler3, inHand: inHand3} = makeHandler(ctx, calls, {slow: {stuck: 10_000}, watch: 'stuck'});
  const running3 = ctx.drain(m3.run(handler3));
  await Promise.race([inHand3, running3]); // stuck is in hand, its handler sleeping 10 s
  before = ctx.clock.now();
  report = await m3.shutdown(3);
  took = seconds(ctx, before);
  assert(took <= 3.5 && took >= 2.5, \`the handler in hand takes 10 s: shutdown(3) must give it the time left and return at the deadline, it took \${took.toFixed(1)} s\`);
  assert.equal(report.uncommitted, 1, \`the record whose handler did not finish is uncommitted: expected 1, got \${JSON.stringify(report.uncommitted)}\`);
  assert(!outbox(ctx).some(([k]) => k === 'stuck'), 'the handler of stuck had not finished: its record cannot have been forwarded');
  assert.equal(ctx.kafka.committedOffset(GROUP, INBOX, 0), 2, \`stuck (offset 2) was not forwarded: its offset must not be committed, the committed offset is \${ctx.kafka.committedOffset(GROUP, INBOX, 0)}\`);
  await running3;
}

export async function check_closed(ctx) {
  seed(ctx, 'a', 'b');
  const calls: string[] = [];
  const m = ctx.load('forwarder');
  await ctx.drain(m.run(makeHandler(ctx, calls).handler));
  await m.shutdown(5);
  const events = ctx.kafka.events.filter(e => (e[0] === 'manual-commit' || e[0] === 'close') && e[1] === GROUP);
  assert(events.some(e => e[0] === 'close'), 'the consumer must be disconnected by the time shutdown returns');
  const commits = events.map((e, i) => [e, i] as const).filter(([e]) => e[0] === 'manual-commit');
  assert(commits.length > 0, 'no explicit commit happened');
  const lastCommit = commits[commits.length - 1][1];
  const close = events.findIndex(e => e[0] === 'close');
  assert(lastCommit < close, 'the final commit must happen before the consumer is disconnected');
  assert.equal(ctx.kafka.committedOffset(GROUP, INBOX, 0), 2, \`the committed offset is \${ctx.kafka.committedOffset(GROUP, INBOX, 0)}, expected 2\`);
  await assert.rejects(ctx.kafka.consumers.at(-1).commitOffsets([{topic: INBOX, partition: 0, offset: '2'}]), 'the consumer still commits after shutdown: disconnect it');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
	"leetbuild/harness"
)

// gsSeed puts inbox records on one partition, so offsets and order are known.
func gsSeed(ctx *harness.Ctx, keys ...string) {
	for _, key := range keys {
		ctx.Kafka.SeedPartition(inbox, 0, key, "v-"+key)
	}
}

// gsCalls records every key the handlers saw.
type gsCalls struct {
	mu   sync.Mutex
	keys []string
}

func (c *gsCalls) add(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.keys = append(c.keys, key)
}

func (c *gsCalls) list() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string{}, c.keys...)
}

func (c *gsCalls) has(key string) bool {
	for _, k := range c.list() {
		if k == key {
			return true
		}
	}
	return false
}

// gsHandler records every key it sees, sleeps (virtual) on the slow keys, stalls outbox when it sees
// stallOn, and closes the returned channel the moment the handler of watch is entered — before any
// clock moves — so a shutdown can be issued with that record in hand.
func gsHandler(ctx *harness.Ctx, calls *gsCalls, slow map[string]time.Duration, stallOn, watch string) (Handler, chan struct{}) {
	inHandNow := make(chan struct{})
	var once sync.Once
	return func(msg kafka.Message) ([]byte, error) {
		key := string(msg.Key)
		calls.add(key)
		if key == stallOn {
			ctx.Kafka.Stall(outbox)
		}
		if key == watch {
			once.Do(func() { close(inHandNow) })
		}
		if d, ok := slow[key]; ok {
			time.Sleep(d)
		}
		return bytes.ToUpper(msg.Value), nil
	}, inHandNow
}

// gsStart runs the learner's loop in the background; it returns once the watched record is in hand
// (or the loop died first), with a channel closed when the loop ends.
func gsStart(handler Handler, watched chan struct{}) chan struct{} {
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		run(handler)
	}()
	select {
	case <-watched:
	case <-finished:
	}
	return finished
}

// gsRestart is a fresh process over the same broker: the package state as the program starts it,
// with the learner's reader and writer configuration.
func gsRestart() {
	reader = kafka.NewReader(reader.Config())
	old := writer
	writer = &kafka.Writer{Addr: old.Addr, Topic: old.Topic, Balancer: old.Balancer, MaxAttempts: old.MaxAttempts,
		WriteBackoffMin: old.WriteBackoffMin, WriteBackoffMax: old.WriteBackoffMax, BatchSize: old.BatchSize,
		BatchBytes: old.BatchBytes, BatchTimeout: old.BatchTimeout, ReadTimeout: old.ReadTimeout,
		WriteTimeout: old.WriteTimeout, RequiredAcks: old.RequiredAcks, Async: old.Async, Completion: old.Completion,
		Compression: old.Compression, Logger: old.Logger, ErrorLogger: old.ErrorLogger,
		AllowAutoTopicCreation: old.AllowAutoTopicCreation}
	forwarded = 0
	committed = map[int]int64{}
	inHand = nil
	done = make(chan struct{})
	pollCtx, stopPolling = context.WithCancel(context.Background())
	workCtx, abortWork = context.WithCancel(context.Background())
}

func gsOutbox(ctx *harness.Ctx) [][2]string {
	out := [][2]string{}
	for _, r := range ctx.Kafka.Records(outbox) {
		out = append(out, [2]string{string(r.Key), string(r.Value)})
	}
	return out
}

func gsDelivered(ctx *harness.Ctx) int {
	n := 0
	for _, e := range ctx.Kafka.EventsOf("deliver") {
		if e.Group == groupID && e.Topic == inbox {
			n++
		}
	}
	return n
}

func gsStalledForwards(ctx *harness.Ctx) int {
	n := 0
	for _, e := range ctx.Kafka.EventsOf("produce-stalled") {
		if e.Topic == outbox {
			n++
		}
	}
	return n
}

func gsCloses(ctx *harness.Ctx) int {
	n := 0
	for _, e := range ctx.Kafka.EventsOf("close") {
		if e.Group == groupID {
			n++
		}
	}
	return n
}

func gsSeconds(ctx *harness.Ctx, before int64) float64 { return float64(ctx.Clock.Now()-before) / 1000 }

func CheckDrain(ctx *harness.Ctx) {
	gsSeed(ctx, "a", "slow", "b")
	calls := &gsCalls{}
	type commitSeen struct {
		offsets map[harness.KafkaTopicPartition]int64
		held    int
	}
	var commitsMu sync.Mutex
	atCommit := []commitSeen{}
	ctx.Kafka.OnCommit(func(group string, offsets harness.KafkaOffsets) {
		copied := map[harness.KafkaTopicPartition]int64{}
		for tp, offset := range offsets {
			copied[tp] = offset
		}
		held := len(ctx.Kafka.Records(outbox))
		commitsMu.Lock()
		atCommit = append(atCommit, commitSeen{copied, held})
		commitsMu.Unlock()
	})
	handler, watched := gsHandler(ctx, calls, map[string]time.Duration{"slow": 2 * time.Second}, "", "slow")
	running := gsStart(handler, watched) // the handler of slow is in hand, sleeping 2 s (or the loop died first)
	before := ctx.Clock.Now()
	report := shutdown(5 * time.Second)
	took := gsSeconds(ctx, before)
	ctx.Drain(func() { <-running })
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "auto-commit is on: offsets were committed on a timer, before the forward was acknowledged; auto-commits")
	ctx.Assert(took <= 5.5, "shutdown(5s) with a healthy broker took %.1f s of clock time", took)
	ctx.Equal(gsOutbox(ctx), [][2]string{{"a", "V-A"}, {"slow", "V-SLOW"}}, "shutdown must let the handler in hand finish and forward its record with the inbox key, then take no more: outbox")
	ctx.Equal(calls.list(), []string{"a", "slow"}, "after shutdown no further record may be taken (b stays for the next process): keys the handler saw")
	ctx.Equal(ctx.Kafka.CommittedOffset(groupID, inbox, 0), 2, "after a clean shutdown every forwarded record is committed: the committed offset")
	commitsMu.Lock()
	seen := append([]commitSeen{}, atCommit...)
	commitsMu.Unlock()
	for _, c := range seen {
		for tp, offset := range c.offsets {
			ctx.Assert(int64(c.held) >= offset, "%s was committed to %d when outbox held only %d records: commit after the forward's ack, never before", tp.String(), offset, c.held)
		}
	}
	ctx.Assert(report.Undelivered == 0 && report.Uncommitted == 0, "a clean stop reports Undelivered 0 and Uncommitted 0, got %+v", report)
	ctx.Equal(report.Forwarded, 2, "Forwarded must count the acknowledged forwards")
	ctx.Equal(report.CommittedOffsets[0], 2, "CommittedOffsets must say inbox partition 0 is committed to 2 (%v)", report.CommittedOffsets)
}

func CheckStalled(ctx *harness.Ctx) {
	gsSeed(ctx, "a", "b", "c", "d")
	handler, watched := gsHandler(ctx, &gsCalls{}, nil, "c", "c")
	running := gsStart(handler, watched) // the broker stops acknowledging outbox from c on
	before := ctx.Clock.Now()
	report := shutdown(5 * time.Second)
	took := gsSeconds(ctx, before)
	ctx.Drain(func() { <-running })
	ctx.Assert(took <= 5.5, "shutdown(5s) took %.1f s with outbox stalled: give the forwards the time left, not the write's whole timeout", took)
	ctx.Equal(ctx.Kafka.CommittedOffset(groupID, inbox, 0), 2, "c's forward was never acknowledged, so nothing past it may be committed: the committed offset")
	ctx.Equal(gsOutbox(ctx), [][2]string{{"a", "V-A"}, {"b", "V-B"}}, "nothing can reach outbox while it is stalled: outbox")
	wantUndelivered := gsStalledForwards(ctx)
	wantUncommitted := gsDelivered(ctx) - 2
	ctx.Assert(wantUndelivered >= 1 && wantUncommitted >= 1, "the handler stalled outbox on c: at least c must be in flight")
	ctx.Equal(report.Undelivered, wantUndelivered, "Undelivered must count the forwards the broker never acknowledged")
	ctx.Equal(report.Uncommitted, wantUncommitted, "Uncommitted must count the records taken from inbox whose offset is not committed")
	ctx.Equal(report.Forwarded, 2, "Forwarded counts acknowledged forwards only (a, b)")
	ctx.Equal(report.CommittedOffsets[0], 2, "CommittedOffsets must say inbox partition 0 is committed to 2 (%v)", report.CommittedOffsets)
	ctx.Assert(gsCloses(ctx) > 0, "the reader must be closed by the time shutdown returns")
}

func CheckRestart(ctx *harness.Ctx) {
	gsSeed(ctx, "a", "b", "c", "d")
	handler, watched := gsHandler(ctx, &gsCalls{}, nil, "c", "c")
	running := gsStart(handler, watched)
	shutdown(5 * time.Second)
	ctx.Drain(func() { <-running })
	resumable := map[string]bool{"c": true, "d": true} // taken past the committed offset 2: a restart may handle these again
	ctx.Kafka.Resume(outbox)
	gsRestart() // a fresh process over the same broker
	calls2 := &gsCalls{}
	handler2, _ := gsHandler(ctx, calls2, nil, "", "")
	ctx.Drain(func() { run(handler2) })
	report2 := shutdown(5 * time.Second)
	ctx.Assert(!calls2.has("a") && !calls2.has("b"), "the restart handled %v: it must resume from the committed offset (2), not from the beginning", calls2.list())
	ctx.Assert(calls2.has("c") && calls2.has("d"), "the restart handled %v: the records taken but not committed (c, d) must be handled again", calls2.list())
	held := gsOutbox(ctx)
	counts := map[string]int{}
	for _, kv := range held {
		counts[kv[0]]++
	}
	for _, key := range []string{"a", "b", "c", "d"} {
		found := false
		for _, kv := range held {
			found = found || (kv[0] == key && kv[1] == "V-"+string(bytes.ToUpper([]byte(key))))
		}
		ctx.Assert(found, "after the restart outbox must hold every inbox record at least once; %s is missing from %v", key, held)
	}
	for key, n := range counts {
		ctx.Assert(n == 1 || resumable[key], "%s reached outbox twice although it was committed: duplicates may only be the records reported uncommitted", key)
	}
	ctx.Equal(ctx.Kafka.Lag(groupID, inbox), 0, "after the restart's clean shutdown nothing may be left uncommitted: lag")
	ctx.Assert(report2.Undelivered == 0 && report2.Uncommitted == 0, "the restart's clean stop must report zeros, got %+v", report2)
}

func CheckOnce(ctx *harness.Ctx) {
	gsSeed(ctx, "a", "b", "c")
	calls := &gsCalls{}
	handler, _ := gsHandler(ctx, calls, nil, "", "")
	ctx.Drain(func() { run(handler) })
	shutdown(5 * time.Second)
	gsSeed(ctx, "d", "e")
	gsRestart() // a fresh process over the same broker
	handler2, _ := gsHandler(ctx, calls, nil, "", "")
	ctx.Drain(func() { run(handler2) })
	shutdown(5 * time.Second)
	ctx.Equal(calls.list(), []string{"a", "b", "c", "d", "e"}, "across a clean shutdown and a restart each record reaches the handler once: keys the handler saw")
	keys := []string{}
	for _, kv := range gsOutbox(ctx) {
		keys = append(keys, kv[0])
	}
	ctx.Equal(keys, []string{"a", "b", "c", "d", "e"}, "outbox must hold each record once, in order")
	ctx.Equal(ctx.Kafka.CommittedOffset(groupID, inbox, 0), 5, "the committed offset")
	ctx.Equal(gsCloses(ctx), 2, "each process must close its reader on shutdown: closes seen for group forwarder")
}

func CheckDeadline(ctx *harness.Ctx) {
	gsSeed(ctx, "a", "b")
	calls := &gsCalls{}
	ctx.Kafka.StallFor(outbox, 2) // the broker is slow at the moment of the stop: it answers 2 s later
	handler, watched := gsHandler(ctx, calls, nil, "", "a")
	running := gsStart(handler, watched) // a is in hand, its forward about to wait for the slow broker
	before := ctx.Clock.Now()
	report := shutdown(5 * time.Second)
	took := gsSeconds(ctx, before)
	ctx.Drain(func() { <-running })
	ctx.Equal(gsOutbox(ctx), [][2]string{{"a", "V-A"}}, "the broker answered after 2 s, within the deadline: shutdown must wait for the forward in hand; outbox")
	ctx.Assert(took <= 2.5, "the broker answered after 2 s yet shutdown(5s) took %.1f s: wait for the forward, not for the whole deadline", took)
	ctx.Assert(report.Undelivered == 0 && report.Uncommitted == 0, "everything in hand was acknowledged and committed, the report must say so: %+v", report)
	ctx.Equal(ctx.Kafka.CommittedOffset(groupID, inbox, 0), 1, "a's forward was acknowledged: its offset must be committed")

	ctx.Kafka.Stall(outbox) // now the broker is down for good
	gsRestart()
	handler2, watched2 := gsHandler(ctx, calls, nil, "", "b")
	running2 := gsStart(handler2, watched2) // b is in hand, its forward about to stall
	before = ctx.Clock.Now()
	report = shutdown(3 * time.Second)
	took = gsSeconds(ctx, before)
	ctx.Drain(func() { <-running2 })
	ctx.Assert(took <= 3.5, "with outbox down, shutdown(3s) took %.1f s of clock time: the deadline is the bound", took)
	ctx.Assert(took >= 2.5, "with outbox down, shutdown(3s) gave up after %.1f s: the broker may still answer within the deadline, wait with the time left", took)
	ctx.Assert(report.Undelivered == 1 && report.Uncommitted == 1, "b's forward never got an ack: expected Undelivered 1, Uncommitted 1, got %+v", report)
	ctx.Equal(ctx.Kafka.CommittedOffset(groupID, inbox, 0), 1, "b was not acknowledged: its offset must not be committed")

	ctx.Kafka.Resume(outbox)
	gsSeed(ctx, "stuck")
	gsRestart()
	handler3, watched3 := gsHandler(ctx, calls, map[string]time.Duration{"stuck": 10 * time.Second}, "", "stuck")
	running3 := gsStart(handler3, watched3) // stuck is in hand, its handler sleeping 10 s
	before = ctx.Clock.Now()
	report = shutdown(3 * time.Second)
	took = gsSeconds(ctx, before)
	ctx.Assert(took <= 3.5 && took >= 2.5, "the handler in hand takes 10 s: shutdown(3s) must give it the time left and return at the deadline, it took %.1f s", took)
	ctx.Equal(report.Uncommitted, 1, "the record whose handler did not finish is uncommitted")
	for _, kv := range gsOutbox(ctx) {
		ctx.Assert(kv[0] != "stuck", "the handler of stuck had not finished: its record cannot have been forwarded")
	}
	ctx.Equal(ctx.Kafka.CommittedOffset(groupID, inbox, 0), 2, "stuck (offset 2) was not forwarded: its offset must not be committed; the committed offset")
	ctx.Drain(func() { <-running3 })
}

func CheckClosed(ctx *harness.Ctx) {
	gsSeed(ctx, "a", "b")
	handler, _ := gsHandler(ctx, &gsCalls{}, nil, "", "")
	ctx.Drain(func() { run(handler) })
	shutdown(5 * time.Second)
	lastCommit, closeAt := -1, -1
	for i, e := range ctx.Kafka.EventsOf("manual-commit", "close") {
		if e.Group != groupID {
			continue
		}
		if e.Kind == "manual-commit" {
			lastCommit = i
		} else if closeAt == -1 {
			closeAt = i
		}
	}
	ctx.Assert(closeAt != -1, "the reader must be closed by the time shutdown returns")
	ctx.Assert(lastCommit != -1, "no explicit commit happened")
	ctx.Assert(lastCommit < closeAt, "the final commit must happen before the reader is closed")
	ctx.Equal(ctx.Kafka.CommittedOffset(groupID, inbox, 0), 2, "the committed offset")
	err := reader.CommitMessages(context.Background(), kafka.Message{Topic: inbox, Partition: 0, Offset: 1})
	ctx.Assert(err != nil, "the reader still commits after shutdown: close it")
}
`,
  },
  debrief: `A graceful shutdown is the same loop in reverse, run against a clock. The order is forced by what each step owes the previous one: stop taking records first (anything taken now is a promise to forward), let the record in hand finish because its offset is the next commit, flush because a commit before the ack would acknowledge a record the outbox never got, commit synchronously because an async commit behind a closing socket is a commit that did not happen, and only then close. Every wait gets the time left rather than its own timeout, so the whole call — not each step — fits the deadline a supervisor gives before SIGKILL. What does not fit is not retried into the deadline; it is left uncommitted and reported, and the restart's at-least-once redelivery is the recovery path. Real workers add the same discipline on rebalance (the \`on_revoke\` callback is a shutdown of one partition), make the downstream write idempotent so the redelivery is harmless, and run the forward as a Kafka transaction when the outbox and the commit must move together.`,
};
