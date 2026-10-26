import type {Step} from '@/lib/types';

export const asyncAckTrackingStep: Step = {
  id: 'async-ack-tracking',
  title: 'Out-of-order completion, in-order commits',
  concept: 'kafka',
  file: 'async_consumer',
  focus: ['workers', 'kafka'],
  task: `## Task

Implement \`async_consumer\`: a member of consumer group **\`async-workers\`** on topic **\`requests\`** that runs
handlers concurrently but commits exactly what a serial consumer would.

- \`run(handler)\` — \`handler(value)\` is an async function given the record's value as text. **Auto-commit off.**
  Poll and start one handler task per record, never more than **\`CONCURRENCY = 8\`** at a time: at the limit,
  wait for one to finish before polling again. The loop runs until \`shutdown()\`; with nothing to deliver it
  sleeps briefly (\`poll(0)\` + a short \`asyncio.sleep\` in Python; kafkajs's \`eachMessage\` is the loop in
  TypeScript, so block there while at the limit).
- The **ack tracker**, one per partition, created at the first offset delivered from it. \`complete(offset)\`
  marks the offset finished and advances the **frontier** — the lowest offset not yet finished — over every
  finished offset above it. Whenever the frontier moves, commit it: the frontier is the next offset to read,
  Kafka's commit convention. Nothing else is ever committed — not \`offset + 1\` of the record that just
  finished, not the poll position.
- A handler that raises is logged and counts as finished (retries are another drill): the frontier must not
  stall on it.
- \`shutdown()\` — stop polling, wait for the in-flight handlers at most **5 s** (\`SHUTDOWN_TIMEOUT_S = 5\` /
  \`SHUTDOWN_TIMEOUT_MS = 5000\`), commit every partition's frontier synchronously, close the consumer.
- \`stats()\` → \`{"in_flight": n, "committed": {partition: offset}}\` (\`inFlight\` in TypeScript): handlers
  running now, and the last offset committed per partition.

:::widget delivery-semantics {}

> Concurrency changes who finishes first; the commit must still mean "everything below this is done". Track
> completions per partition and commit the lowest contiguous frontier: a slow record holds the commit, it is
> never skipped.`,
  sequence: {
    participants: ['Kafka', 'async-workers', 'handlers'],
    messages: [
      {from: 'Kafka', to: 'async-workers', label: 'poll → offsets 40, 41, 42 (partition 0)', kind: 'reply'},
      {from: 'async-workers', to: 'handlers', label: 'handler(40) · handler(41) · handler(42)', kind: 'async'},
      {from: 'handlers', to: 'async-workers', label: '42 done · 41 done', kind: 'reply'},
      {from: 'async-workers', to: 'async-workers', label: 'frontier still 40: nothing to commit', kind: 'sync'},
      {from: 'handlers', to: 'async-workers', label: '40 done → frontier 43', kind: 'reply'},
      {from: 'async-workers', to: 'Kafka', label: 'commit offset 43 (partition 0)', kind: 'sync'},
      {
        from: 'async-workers',
        to: 'async-workers',
        label: 'shutdown: wait ≤ 5 s · commit frontiers · close',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'Two things per partition: the frontier (next offset to commit) and a set of finished offsets above it. `complete` adds to the set, then `while frontier in finished: remove it, frontier += 1`; commit only when the frontier moved.',
    'The loop needs two waits: `asyncio.wait(inflight, return_when=FIRST_COMPLETED)` / `Promise.race(inflight)` at the limit, and an idle sleep when poll returns nothing. Never `commit(message=msg)`: the commit comes from the tracker, after `complete`.',
    'shutdown is the same wait with a deadline — `asyncio.wait(inflight, timeout=5)` / `Promise.race([Promise.all(inflight), timeout])` — then a synchronous commit of each frontier, then close, in that order.',
  ],
  checks: [
    {
      id: 'concurrency',
      title: 'Never more than CONCURRENCY handlers in flight',
      detail:
        'With 20 records waiting and every handler still running, exactly 8 have been started; one completion lets exactly one more in. No offset is ever auto-committed.',
      match: {
        python: {
          all: [
            /len\(inflight\)\s*>=\s*CONCURRENCY/,
            /asyncio\.wait\(\s*inflight\s*,\s*return_when\s*=\s*asyncio\.FIRST_COMPLETED\s*\)/,
          ],
        },
        typescript: {all: [/inflight\.size\s*>=\s*CONCURRENCY/, /Promise\.race\(\s*inflight\s*\)/]},
        go: {all: [/slots\s*=\s*make\(chan struct\{\}, concurrency\)/, /case slots <- struct\{\}\{\}:/]},
        scala: {all: [/new Semaphore\(\s*Concurrency\s*\)/, /slots\.tryAcquire\(/]},
        cpp: {all: [/in_flight\s*<\s*kConcurrency/, /cv\.wait_for\(/]},
      },
    },
    {
      id: 'frontier',
      title: 'The committed offset never passes an unfinished record',
      detail:
        'Twelve records finish in a scrambled order; at every commit the committed offset is at most the lowest offset still running, and once all twelve are done it is 12.',
      match: {
        python: {all: [/while self\.frontier in self\.finished:/]},
        typescript: {all: [/while\s*\(\s*this\.finished\.has\(\s*this\.frontier\s*\)\s*\)/]},
        go: {all: [/for t\.finished\[t\.frontier\]/]},
        scala: {all: [/while\s*\(\s*finished\.contains\(\s*frontier\s*\)\s*\)/]},
        cpp: {all: [/while\s*\(\s*finished\.erase\(\s*frontier\s*\)\s*\)/]},
      },
    },
    {
      id: 'gap',
      title: 'A slow record holds its partition, and only its partition',
      detail:
        'Offsets 1–4 of partition 0 finish while offset 0 still runs: partition 0 gets no commit at all, partition 1 (fully done) is committed to its end; when offset 0 finishes, partition 0 is committed to 5 in one step.',
      match: {
        python: {
          all: [/TopicPartition\(\s*TOPIC\s*,\s*partition\s*,\s*offset\s*\)/, /if tracker\.complete\(/],
          none: [/commit\(\s*message\s*=/, /store_offsets\(/],
        },
        typescript: {
          all: [
            /commitOffsets\(\s*\[\s*\{\s*topic:\s*TOPIC\s*,\s*partition\s*,\s*offset:\s*String\(\s*offset\s*\)/,
            /if\s*\(\s*tracker\.complete\(/,
          ],
          none: [/Number\(\s*message\.offset\s*\)\s*\+\s*1/],
        },
        go: {
          all: [/Offset:\s*kafka\.Offset\(\s*offset\s*\)/, /t\.complete\(/],
          none: [/CommitMessage\(/, /StoreOffsets\(/],
        },
        scala: {all: [/new OffsetAndMetadata\(\s*t\.frontier\s*\)/], none: [/commitSync\(\s*\)/]},
        cpp: {
          all: [
            /TopicPartition::create\(\s*kTopic\s*,\s*partition\s*,\s*t\.frontier\s*\)/,
            /commitSync\(\s*moved\s*\)/,
          ],
          none: [/commitSync\(\s*msg/],
        },
      },
    },
    {
      id: 'shutdown',
      title: 'shutdown() waits for running handlers, then commits the frontier and closes',
      detail:
        'Called with one handler still running, shutdown() does not return and does not close the consumer until that handler finishes; then the committed offset equals the frontier (the end of the partition), the consumer is closed and nothing is in flight.',
      match: {
        python: {
          all: [/asyncio\.wait\(\s*inflight\s*,\s*timeout\s*=\s*SHUTDOWN_TIMEOUT_S\s*\)/],
          order: [/timeout\s*=\s*SHUTDOWN_TIMEOUT_S/, /consumer\.close\(\)/],
        },
        typescript: {
          all: [/setTimeout\([^\n]*SHUTDOWN_TIMEOUT_MS/],
          order: [/Promise\.all\(\s*inflight\s*\)/, /consumer\.disconnect\(\)/],
        },
        go: {all: [/time\.After\(\s*shutdownTimeout\s*\)/], order: [/wg\.Wait\(\)/, /consumer\.Close\(\)/]},
        scala: {all: [/ShutdownMillis/], order: [/inFlight\.get\s*>\s*0/, /consumer\.close\(\)/]},
        cpp: {order: [/wait_for\(\s*lock\s*,\s*kShutdownTimeout/, /consumer->close\(\)/]},
      },
    },
    {
      id: 'complete',
      title: 'Every record is handled once and every partition is committed to its end',
      detail:
        'Thirty keyed records across three partitions, finished last-started-first: each value reaches the handler exactly once, each partition ends committed at its end offset, and stats() reports those offsets with nothing in flight.',
      match: {
        python: {
          all: [
            /"enable\.auto\.commit"\s*:\s*False/,
            /trackers\.setdefault\(\s*msg\.partition\(\)\s*,\s*AckTracker\(\s*msg\.offset\(\)\s*\)\s*\)/,
          ],
        },
        typescript: {
          all: [/autoCommit:\s*false/, /trackers\.set\(\s*partition\s*,\s*new AckTracker\(\s*offset\s*\)\s*\)/],
        },
        go: {all: [/"enable\.auto\.commit":\s*false/, /trackers\[p\]\s*=\s*&ackTracker\{frontier:\s*offset/]},
        scala: {
          all: [
            /"enable\.auto\.commit"\s*,\s*"false"/,
            /trackers\.getOrElseUpdate\(\s*record\.partition\(\)\s*,\s*new AckTracker\(\s*record\.offset\(\)\s*\)\s*\)/,
          ],
        },
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/, /trackers\.try_emplace\(\s*partition\s*,\s*offset\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import logging
from typing import Awaitable, Callable

from confluent_kafka import Consumer, TopicPartition

log = logging.getLogger("async-workers")

TOPIC = "requests"
GROUP = "async-workers"
CONCURRENCY = 8
SHUTDOWN_TIMEOUT_S = 5.0
IDLE_S = 0.05

Handler = Callable[[str], Awaitable[None]]

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit; only a tracker's frontier is ever committed
    }
)
consumer.subscribe([TOPIC])


class AckTracker:
    """One partition's acks. \`frontier\` is the next offset to commit: every offset below it has finished."""

    def __init__(self, first: int) -> None:
        self.frontier = first
        self.finished: set[int] = set()  # finished offsets above a still-running one

    def complete(self, offset: int) -> bool:
        """Mark \`offset\` finished; True when the frontier moved."""
        # TODO: add the offset; advance the frontier while the offset at the frontier is finished
        return False


trackers: dict[int, AckTracker] = {}
inflight: set[asyncio.Task] = set()
committed: dict[int, int] = {}
stopping = False
closed = False


def stats() -> dict:
    return {"in_flight": len(inflight), "committed": dict(committed)}


async def _handle(handler: Handler, msg) -> None:
    try:
        await handler(msg.value().decode())
    except Exception:
        log.exception("handler failed at %s[%d]@%d", msg.topic(), msg.partition(), msg.offset())
    # TODO: tracker.complete(offset); when the frontier moved, commit TopicPartition(TOPIC, partition, frontier)


async def run(handler: Handler) -> None:
    """Poll and hand every record to \`handler\` as a task, at most CONCURRENCY at a time, until shutdown()."""
    # TODO: while not stopping — at CONCURRENCY in flight wait for one task to finish (FIRST_COMPLETED);
    # otherwise poll(0): None → sleep IDLE_S; a record → its partition's tracker, then _handle as a task
    raise NotImplementedError


async def shutdown() -> None:
    """Stop polling, wait at most SHUTDOWN_TIMEOUT_S for running handlers, commit the frontiers, close."""
    # TODO: stopping = True; wait for inflight with a timeout; commit every tracker's frontier; close
    raise NotImplementedError
`,
      solution: `import asyncio
import logging
from typing import Awaitable, Callable

from confluent_kafka import Consumer, TopicPartition

log = logging.getLogger("async-workers")

TOPIC = "requests"
GROUP = "async-workers"
CONCURRENCY = 8
SHUTDOWN_TIMEOUT_S = 5.0
IDLE_S = 0.05

Handler = Callable[[str], Awaitable[None]]

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC])


class AckTracker:
    """One partition's acks. \`frontier\` is the next offset to commit: every offset below it has finished."""

    def __init__(self, first: int) -> None:
        self.frontier = first
        self.finished: set[int] = set()  # finished offsets above a still-running one

    def complete(self, offset: int) -> bool:
        """Mark \`offset\` finished; True when the frontier moved."""
        self.finished.add(offset)
        before = self.frontier
        while self.frontier in self.finished:
            self.finished.discard(self.frontier)
            self.frontier += 1
        return self.frontier != before


trackers: dict[int, AckTracker] = {}
inflight: set[asyncio.Task] = set()
committed: dict[int, int] = {}
stopping = False
closed = False


def stats() -> dict:
    return {"in_flight": len(inflight), "committed": dict(committed)}


def _commit(partition: int, offset: int, asynchronous: bool = True) -> None:
    if closed:
        return
    consumer.commit(offsets=[TopicPartition(TOPIC, partition, offset)], asynchronous=asynchronous)
    committed[partition] = offset


async def _handle(handler: Handler, msg) -> None:
    try:
        await handler(msg.value().decode())
    except Exception:
        log.exception("handler failed at %s[%d]@%d", msg.topic(), msg.partition(), msg.offset())
    tracker = trackers[msg.partition()]
    if tracker.complete(msg.offset()):
        _commit(msg.partition(), tracker.frontier)


async def run(handler: Handler) -> None:
    """Poll and hand every record to \`handler\` as a task, at most CONCURRENCY at a time, until shutdown()."""
    while not stopping:
        if len(inflight) >= CONCURRENCY:
            await asyncio.wait(inflight, return_when=asyncio.FIRST_COMPLETED)
            continue
        msg = consumer.poll(0)
        if msg is None:
            await asyncio.sleep(IDLE_S)
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        trackers.setdefault(msg.partition(), AckTracker(msg.offset()))
        task = asyncio.create_task(_handle(handler, msg))
        inflight.add(task)
        task.add_done_callback(inflight.discard)


async def shutdown() -> None:
    """Stop polling, wait at most SHUTDOWN_TIMEOUT_S for running handlers, commit the frontiers, close."""
    global stopping, closed
    stopping = True
    if inflight:
        await asyncio.wait(inflight, timeout=SHUTDOWN_TIMEOUT_S)
    for partition, tracker in trackers.items():
        if committed.get(partition) != tracker.frontier:
            _commit(partition, tracker.frontier, asynchronous=False)
    closed = True
    consumer.close()
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'requests';
export const GROUP = 'async-workers';
export const CONCURRENCY = 8;
export const SHUTDOWN_TIMEOUT_MS = 5000;

export type Handler = (value: string) => Promise<void>;

const kafka = new Kafka({clientId: 'async-workers', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});

/** One partition's acks. \`frontier\` is the next offset to commit: every offset below it has finished. */
class AckTracker {
  frontier: number;
  readonly finished = new Set<number>(); // finished offsets above a still-running one

  constructor(first: number) {
    this.frontier = first;
  }

  /** Mark \`offset\` finished; true when the frontier moved. */
  complete(offset: number): boolean {
    // TODO: add the offset; advance the frontier while the offset at the frontier is finished
    return false;
  }
}

const trackers = new Map<number, AckTracker>();
const inflight = new Set<Promise<void>>();
const committed: Record<number, number> = {};
let closed = false;

export function stats(): {inFlight: number; committed: Record<number, number>} {
  return {inFlight: inflight.size, committed: {...committed}};
}

async function handle(handler: Handler, value: string, partition: number, offset: number): Promise<void> {
  try {
    await handler(value);
  } catch (e) {
    console.error(\`handler failed at \${TOPIC}[\${partition}]@\${offset}:\`, e);
  }
  // TODO: tracker.complete(offset); when the frontier moved, commitOffsets({topic, partition, offset: frontier})
}

export async function run(handler: Handler): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    // TODO: autoCommit off
    eachMessage: async ({partition, message}) => {
      // TODO: the partition's tracker (first offset seen); start handle() and keep its promise in inflight;
      // at CONCURRENCY in flight, wait for one to finish before returning
      throw new Error('not implemented');
    },
  });
}

export async function shutdown(): Promise<void> {
  // TODO: stop the consumer; wait for inflight at most SHUTDOWN_TIMEOUT_MS; commit every frontier; disconnect
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const TOPIC = 'requests';
export const GROUP = 'async-workers';
export const CONCURRENCY = 8;
export const SHUTDOWN_TIMEOUT_MS = 5000;

export type Handler = (value: string) => Promise<void>;

const kafka = new Kafka({clientId: 'async-workers', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});

/** One partition's acks. \`frontier\` is the next offset to commit: every offset below it has finished. */
class AckTracker {
  frontier: number;
  readonly finished = new Set<number>(); // finished offsets above a still-running one

  constructor(first: number) {
    this.frontier = first;
  }

  /** Mark \`offset\` finished; true when the frontier moved. */
  complete(offset: number): boolean {
    this.finished.add(offset);
    const before = this.frontier;
    while (this.finished.has(this.frontier)) {
      this.finished.delete(this.frontier);
      this.frontier += 1;
    }
    return this.frontier !== before;
  }
}

const trackers = new Map<number, AckTracker>();
const inflight = new Set<Promise<void>>();
const committed: Record<number, number> = {};
let closed = false;

export function stats(): {inFlight: number; committed: Record<number, number>} {
  return {inFlight: inflight.size, committed: {...committed}};
}

async function commit(partition: number, offset: number): Promise<void> {
  if (closed) return;
  await consumer.commitOffsets([{topic: TOPIC, partition, offset: String(offset)}]);
  committed[partition] = offset;
}

async function handle(handler: Handler, value: string, partition: number, offset: number): Promise<void> {
  try {
    await handler(value);
  } catch (e) {
    console.error(\`handler failed at \${TOPIC}[\${partition}]@\${offset}:\`, e);
  }
  const tracker = trackers.get(partition)!;
  if (tracker.complete(offset)) await commit(partition, tracker.frontier);
}

/** Deliver every record to \`handler\`, at most CONCURRENCY running at once; eachMessage blocks at the limit. */
export async function run(handler: Handler): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({partition, message}) => {
      const offset = Number(message.offset);
      if (!trackers.has(partition)) trackers.set(partition, new AckTracker(offset));
      const task = handle(handler, message.value?.toString() ?? '', partition, offset);
      inflight.add(task);
      void task.then(() => inflight.delete(task));
      if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
    },
  });
}

/** Stop polling, wait at most SHUTDOWN_TIMEOUT_MS for running handlers, commit the frontiers, disconnect. */
export async function shutdown(): Promise<void> {
  await consumer.stop();
  await Promise.race([Promise.all(inflight), new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))]);
  for (const [partition, tracker] of trackers)
    if (committed[partition] !== tracker.frontier) await commit(partition, tracker.frontier);
  closed = true;
  await consumer.disconnect();
}
`,
    },
    go: {
      starter: `package main

import (
	"log"
	"sync"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

const (
	topic           = "requests"
	group           = "async-workers"
	concurrency     = 8
	shutdownTimeout = 5 * time.Second
)

type Handler func(value string) error

// ackTracker is one partition's acks: frontier is the next offset to commit — every offset below it has finished.
type ackTracker struct {
	frontier int64
	finished map[int64]bool // finished offsets above a still-running one
}

// complete marks offset finished and reports whether the frontier moved.
func (t *ackTracker) complete(offset int64) bool {
	// TODO: record the offset; advance the frontier while the offset at the frontier is finished
	return false
}

var (
	consumer  = newConsumer()
	mu        sync.Mutex // guards trackers, committed, inFlight, closed
	trackers  = map[int32]*ackTracker{}
	committed = map[int32]int64{}
	inFlight  int
	wg        sync.WaitGroup
	slots     = make(chan struct{}, concurrency) // one token per running handler
	stopping  = make(chan struct{})
	closed    bool
)

func newConsumer() *kafka.Consumer {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers": "kafka:9092",
		"group.id":          group,
		"auto.offset.reset": "earliest",
		// TODO: disable auto-commit; only a tracker's frontier is ever committed
	})
	if err != nil {
		panic(err)
	}
	if err := c.Subscribe(topic, nil); err != nil {
		panic(err)
	}
	return c
}

func stats() (int, map[int32]int64) {
	mu.Lock()
	defer mu.Unlock()
	snapshot := make(map[int32]int64, len(committed))
	for p, o := range committed {
		snapshot[p] = o
	}
	return inFlight, snapshot
}

func handle(handler Handler, msg *kafka.Message) {
	defer wg.Done()
	defer func() { <-slots }()
	if err := handler(string(msg.Value)); err != nil {
		log.Printf("handler failed at %s[%d]@%d: %v", *msg.TopicPartition.Topic, msg.TopicPartition.Partition, msg.TopicPartition.Offset, err)
	}
	mu.Lock()
	defer mu.Unlock()
	inFlight--
	// TODO: tracker.complete(offset); when the frontier moved, CommitOffsets the frontier of this partition
}

// run polls and hands every record to handler on its own goroutine, at most concurrency at a time, until shutdown().
func run(handler Handler) {
	// TODO: take a slot (blocks at the limit) or return on stopping; Poll(100); a record → its partition's
	// tracker, inFlight++, wg.Add(1), go handle(handler, msg); no record → give the slot back
	log.Println("not implemented")
}

// shutdown stops polling, waits at most shutdownTimeout for running handlers, commits the frontiers and closes.
func shutdown() {
	// TODO: close(stopping); wg.Wait with a time.After bound; commit every tracker's frontier; then close
	consumer.Close()
}
`,
      solution: `package main

import (
	"log"
	"sync"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

const (
	topic           = "requests"
	group           = "async-workers"
	concurrency     = 8
	shutdownTimeout = 5 * time.Second
)

type Handler func(value string) error

// ackTracker is one partition's acks: frontier is the next offset to commit — every offset below it has finished.
type ackTracker struct {
	frontier int64
	finished map[int64]bool // finished offsets above a still-running one
}

// complete marks offset finished and reports whether the frontier moved.
func (t *ackTracker) complete(offset int64) bool {
	t.finished[offset] = true
	before := t.frontier
	for t.finished[t.frontier] {
		delete(t.finished, t.frontier)
		t.frontier++
	}
	return t.frontier != before
}

var (
	consumer  = newConsumer()
	mu        sync.Mutex // guards trackers, committed, inFlight, closed
	trackers  = map[int32]*ackTracker{}
	committed = map[int32]int64{}
	inFlight  int
	wg        sync.WaitGroup
	slots     = make(chan struct{}, concurrency) // one token per running handler
	stopping  = make(chan struct{})
	closed    bool
)

func newConsumer() *kafka.Consumer {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"group.id":           group,
		"auto.offset.reset":  "earliest",
		"enable.auto.commit": false,
	})
	if err != nil {
		panic(err)
	}
	if err := c.Subscribe(topic, nil); err != nil {
		panic(err)
	}
	return c
}

func stats() (int, map[int32]int64) {
	mu.Lock()
	defer mu.Unlock()
	snapshot := make(map[int32]int64, len(committed))
	for p, o := range committed {
		snapshot[p] = o
	}
	return inFlight, snapshot
}

// commit one partition's frontier; the caller holds mu.
func commit(partition int32, offset int64) {
	if closed {
		return
	}
	t := topic
	if _, err := consumer.CommitOffsets([]kafka.TopicPartition{{Topic: &t, Partition: partition, Offset: kafka.Offset(offset)}}); err != nil {
		log.Printf("commit failed: %v", err)
		return
	}
	committed[partition] = offset
}

func handle(handler Handler, msg *kafka.Message) {
	defer wg.Done()
	defer func() { <-slots }()
	if err := handler(string(msg.Value)); err != nil {
		log.Printf("handler failed at %s[%d]@%d: %v", *msg.TopicPartition.Topic, msg.TopicPartition.Partition, msg.TopicPartition.Offset, err)
	}
	mu.Lock()
	defer mu.Unlock()
	inFlight--
	p := msg.TopicPartition.Partition
	if t := trackers[p]; t.complete(int64(msg.TopicPartition.Offset)) {
		commit(p, t.frontier)
	}
}

// run polls and hands every record to handler on its own goroutine, at most concurrency at a time, until shutdown().
func run(handler Handler) {
	for {
		select {
		case <-stopping:
			return
		case slots <- struct{}{}: // a free slot; with every slot taken this blocks until a handler finishes
		}
		ev := consumer.Poll(100)
		msg, ok := ev.(*kafka.Message)
		if !ok {
			<-slots
			if e, isErr := ev.(kafka.Error); isErr {
				log.Printf("consumer error: %v", e)
			}
			continue
		}
		p, offset := msg.TopicPartition.Partition, int64(msg.TopicPartition.Offset)
		mu.Lock()
		if _, seen := trackers[p]; !seen {
			trackers[p] = &ackTracker{frontier: offset, finished: map[int64]bool{}}
		}
		inFlight++
		mu.Unlock()
		wg.Add(1)
		go handle(handler, msg)
	}
}

// shutdown stops polling, waits at most shutdownTimeout for running handlers, commits the frontiers and closes.
func shutdown() {
	close(stopping)
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(shutdownTimeout):
		log.Printf("shutdown: handlers still running after %s; committing what is contiguous", shutdownTimeout)
	}
	mu.Lock()
	for p, t := range trackers {
		if committed[p] != t.frontier {
			commit(p, t.frontier)
		}
	}
	closed = true
	mu.Unlock()
	consumer.Close()
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.{ConcurrentLinkedQueue, CountDownLatch, Semaphore, TimeUnit}
import java.util.concurrent.atomic.{AtomicBoolean, AtomicInteger}

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.collection.mutable
import scala.concurrent.{ExecutionContext, Future}
import scala.jdk.CollectionConverters._

object AsyncConsumer {
  val Topic = "requests"
  val Group = "async-workers"
  val Concurrency = 8
  /** How long shutdown() waits for running handlers. */
  val ShutdownMillis = 5000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", Group)
  props.put("auto.offset.reset", "earliest")
  props.put("max.poll.records", "1") // one record per poll: a slot is taken before each poll
  // TODO: disable auto-commit; only a tracker's frontier is ever committed
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  /** One partition's acks: \`frontier\` is the next offset to commit — every offset below it has finished. */
  final class AckTracker(first: Long) {
    var frontier: Long = first
    private val finished = mutable.Set.empty[Long] // finished offsets above a still-running one

    /** Mark \`offset\` finished; true when the frontier moved. */
    def complete(offset: Long): Boolean = {
      // TODO: add the offset; advance the frontier while the offset at the frontier is finished
      false
    }
  }

  private implicit val ec: ExecutionContext = ExecutionContext.global
  private val slots = new Semaphore(Concurrency)
  private val trackers = mutable.Map.empty[Int, AckTracker]
  private val committed = mutable.Map.empty[Int, Long]
  private val acks = new ConcurrentLinkedQueue[(Int, Long)] // completions, applied on the poll thread
  private val inFlight = new AtomicInteger(0)
  private val stopping = new AtomicBoolean(false)
  private val loopDone = new CountDownLatch(1)

  def stats(): (Int, Map[Int, Long]) = (inFlight.get, trackers.synchronized(committed.toMap))

  /** Apply every completion since the last pass; commit each partition whose frontier moved. Poll thread only. */
  private def commitFinished(): Unit = {
    // TODO: drain acks into the trackers; commitSync the frontier of every partition that moved
    acks.clear()
  }

  /** Poll and hand every record to \`handler\` as a Future, at most Concurrency at a time, until shutdown(). */
  def run(handler: String => Future[Unit]): Unit = {
    // TODO: while not stopping: commitFinished(); take a slot (tryAcquire with a wait) or loop; poll one record;
    // its partition's tracker; inFlight++; handler(value) → onComplete: enqueue the ack, inFlight--, release
    loopDone.countDown()
  }

  /** Stop polling, wait at most ShutdownMillis for running handlers, commit the frontiers, close. */
  def shutdown(): Unit = {
    // TODO: stopping; wait for the loop to exit; wait for inFlight to reach 0 within ShutdownMillis; commitFinished(); close
    consumer.close()
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.{ConcurrentLinkedQueue, CountDownLatch, Semaphore, TimeUnit}
import java.util.concurrent.atomic.{AtomicBoolean, AtomicInteger}

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.collection.mutable
import scala.concurrent.{ExecutionContext, Future}
import scala.jdk.CollectionConverters._

object AsyncConsumer {
  val Topic = "requests"
  val Group = "async-workers"
  val Concurrency = 8
  /** How long shutdown() waits for running handlers. */
  val ShutdownMillis = 5000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", Group)
  props.put("auto.offset.reset", "earliest")
  props.put("max.poll.records", "1") // one record per poll: a slot is taken before each poll
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  /** One partition's acks: \`frontier\` is the next offset to commit — every offset below it has finished. */
  final class AckTracker(first: Long) {
    var frontier: Long = first
    private val finished = mutable.Set.empty[Long] // finished offsets above a still-running one

    /** Mark \`offset\` finished; true when the frontier moved. */
    def complete(offset: Long): Boolean = {
      finished += offset
      val before = frontier
      while (finished.contains(frontier)) {
        finished -= frontier
        frontier += 1
      }
      frontier != before
    }
  }

  private implicit val ec: ExecutionContext = ExecutionContext.global
  private val slots = new Semaphore(Concurrency)
  private val trackers = mutable.Map.empty[Int, AckTracker]
  private val committed = mutable.Map.empty[Int, Long]
  private val acks = new ConcurrentLinkedQueue[(Int, Long)] // completions, applied on the poll thread
  private val inFlight = new AtomicInteger(0)
  private val stopping = new AtomicBoolean(false)
  private val loopDone = new CountDownLatch(1)

  def stats(): (Int, Map[Int, Long]) = (inFlight.get, trackers.synchronized(committed.toMap))

  /** Apply every completion since the last pass; commit each partition whose frontier moved. Poll thread only. */
  private def commitFinished(): Unit = {
    val moved = mutable.Map.empty[TopicPartition, OffsetAndMetadata]
    var ack = acks.poll()
    while (ack != null) {
      val (partition, offset) = ack
      val t = trackers.synchronized(trackers(partition))
      if (t.complete(offset)) moved.put(new TopicPartition(Topic, partition), new OffsetAndMetadata(t.frontier))
      ack = acks.poll()
    }
    if (moved.nonEmpty) {
      consumer.commitSync(moved.asJava)
      trackers.synchronized { moved.foreach { case (tp, om) => committed(tp.partition()) = om.offset() } }
    }
  }

  /** Poll and hand every record to \`handler\` as a Future, at most Concurrency at a time, until shutdown(). */
  def run(handler: String => Future[Unit]): Unit = {
    while (!stopping.get) {
      commitFinished()
      // Every slot taken: wait for a completion instead of polling.
      if (slots.tryAcquire(100, TimeUnit.MILLISECONDS)) {
        val records = consumer.poll(Duration.ofMillis(100))
        if (records.isEmpty) slots.release()
        else {
          val record = records.iterator().next()
          trackers.synchronized { trackers.getOrElseUpdate(record.partition(), new AckTracker(record.offset())) }
          inFlight.incrementAndGet()
          handler(record.value())
            .recover { case e => System.err.println("handler failed at " + record.partition() + "@" + record.offset() + ": " + e) }
            .onComplete { _ =>
              acks.add((record.partition(), record.offset()))
              inFlight.decrementAndGet()
              slots.release()
            }
        }
      }
    }
    loopDone.countDown()
  }

  /** Stop polling, wait at most ShutdownMillis for running handlers, commit the frontiers, close. */
  def shutdown(): Unit = {
    stopping.set(true)
    loopDone.await(ShutdownMillis, TimeUnit.MILLISECONDS) // the poll thread owns the consumer: let it exit first
    val deadline = System.nanoTime() + ShutdownMillis * 1000000L
    while (inFlight.get > 0 && System.nanoTime() < deadline) Thread.sleep(10)
    commitFinished()
    consumer.close()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <utility>
#include <vector>

const std::string kTopic = "requests";
const std::string kGroup = "async-workers";
constexpr int kConcurrency = 8;
constexpr auto kShutdownTimeout = std::chrono::seconds(5);

using Handler = std::function<void(const std::string&)>;

// One partition's acks: frontier is the next offset to commit — every offset below it has finished.
struct AckTracker {
  int64_t frontier;
  std::set<int64_t> finished;  // finished offsets above a still-running one

  explicit AckTracker(int64_t first) : frontier(first) {}

  // Mark offset finished; true when the frontier moved.
  bool complete(int64_t offset) {
    // TODO: insert the offset; advance the frontier while the offset at the frontier is finished
    return false;
  }
};

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit; only a tracker's frontier is ever committed
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto consumer = make_consumer();

std::mutex mu;  // guards everything below
std::condition_variable cv;
std::map<int32_t, AckTracker> trackers;
std::map<int32_t, int64_t> committed;
std::vector<std::pair<int32_t, int64_t>> acks;  // completions, applied on the poll thread
int in_flight = 0;
bool stopping = false;
bool loop_done = false;

struct Stats {
  int in_flight;
  std::map<int32_t, int64_t> committed;
};

Stats stats() {
  std::lock_guard<std::mutex> lock(mu);
  return {in_flight, committed};
}

// Apply every completion since the last pass; commit each partition whose frontier moved. Caller holds mu.
void commit_finished() {
  // TODO: feed acks into the trackers; commitSync the frontier of every partition that moved
  acks.clear();
}

// Poll and hand every record to handler on its own thread, at most kConcurrency at a time, until shutdown().
void run(Handler handler) {
  // TODO: while not stopping: wait on cv until in_flight < kConcurrency; commit_finished(); consume(100);
  // a record → its partition's tracker, in_flight++, a detached thread that runs handler(value) then
  // pushes (partition, offset) onto acks, in_flight--, cv.notify_all()
  std::cerr << "not implemented\\n";
  std::lock_guard<std::mutex> lock(mu);
  loop_done = true;
}

// Stop polling, wait at most kShutdownTimeout for running handlers, commit the frontiers, close.
void shutdown() {
  // TODO: stopping = true; wait on cv (bounded by kShutdownTimeout) for the loop to exit and in_flight == 0;
  // commit_finished(); close
  consumer->close();
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <utility>
#include <vector>

const std::string kTopic = "requests";
const std::string kGroup = "async-workers";
constexpr int kConcurrency = 8;
constexpr auto kShutdownTimeout = std::chrono::seconds(5);

using Handler = std::function<void(const std::string&)>;

// One partition's acks: frontier is the next offset to commit — every offset below it has finished.
struct AckTracker {
  int64_t frontier;
  std::set<int64_t> finished;  // finished offsets above a still-running one

  explicit AckTracker(int64_t first) : frontier(first) {}

  // Mark offset finished; true when the frontier moved.
  bool complete(int64_t offset) {
    finished.insert(offset);
    const int64_t before = frontier;
    while (finished.erase(frontier)) frontier += 1;
    return frontier != before;
  }
};

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
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

auto consumer = make_consumer();

std::mutex mu;  // guards everything below
std::condition_variable cv;
std::map<int32_t, AckTracker> trackers;
std::map<int32_t, int64_t> committed;
std::vector<std::pair<int32_t, int64_t>> acks;  // completions, applied on the poll thread
int in_flight = 0;
bool stopping = false;
bool loop_done = false;

struct Stats {
  int in_flight;
  std::map<int32_t, int64_t> committed;
};

Stats stats() {
  std::lock_guard<std::mutex> lock(mu);
  return {in_flight, committed};
}

// Apply every completion since the last pass; commit each partition whose frontier moved. Caller holds mu.
void commit_finished() {
  std::vector<RdKafka::TopicPartition*> moved;
  for (const auto& [partition, offset] : acks) {
    AckTracker& t = trackers.at(partition);
    if (t.complete(offset)) moved.push_back(RdKafka::TopicPartition::create(kTopic, partition, t.frontier));
  }
  acks.clear();
  if (moved.empty()) return;
  if (consumer->commitSync(moved) == RdKafka::ERR_NO_ERROR)
    for (const auto* tp : moved) committed[tp->partition()] = tp->offset();
  RdKafka::TopicPartition::destroy(moved);
}

// Poll and hand every record to handler on its own thread, at most kConcurrency at a time, until shutdown().
void run(Handler handler) {
  std::unique_lock<std::mutex> lock(mu);
  while (!stopping) {
    // Every slot taken: wait for a completion instead of polling.
    if (!cv.wait_for(lock, std::chrono::milliseconds(100), [] { return in_flight < kConcurrency || stopping; })) continue;
    commit_finished();
    if (stopping) break;
    lock.unlock();
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(100));
    lock.lock();
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const int32_t partition = msg->partition();
    const int64_t offset = msg->offset();
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    trackers.try_emplace(partition, offset);
    in_flight += 1;
    std::thread([handler, value, partition, offset] {
      try {
        handler(value);
      } catch (const std::exception& e) {
        std::cerr << "handler failed at " << partition << "@" << offset << ": " << e.what() << "\\n";
      }
      {
        std::lock_guard<std::mutex> done(mu);
        acks.emplace_back(partition, offset);
        in_flight -= 1;
      }
      cv.notify_all();
    }).detach();
  }
  loop_done = true;
  cv.notify_all();
}

// Stop polling, wait at most kShutdownTimeout for running handlers, commit the frontiers, close.
void shutdown() {
  std::unique_lock<std::mutex> lock(mu);
  stopping = true;
  cv.notify_all();
  cv.wait_for(lock, kShutdownTimeout, [] { return loop_done && in_flight == 0; });
  commit_finished();
  consumer->close();
}
`,
    },
  },
  harness: {
    python: `import asyncio

TOPIC = "requests"
GROUP = "async-workers"


class Gates:
    """The harness's handler: every record waits on its own gate, so the harness decides the completion order."""

    def __init__(self) -> None:
        self.gates: dict[str, asyncio.Future] = {}
        self.started: list[str] = []
        self.completed: list[str] = []

    def _gate(self, value: str) -> asyncio.Future:
        if value not in self.gates:
            self.gates[value] = asyncio.get_running_loop().create_future()
        return self.gates[value]

    async def handler(self, value: str) -> None:
        self.started.append(value)
        await self._gate(value)
        self.completed.append(value)

    def open(self, *values: str) -> None:
        for value in values:
            gate = self._gate(value)
            if not gate.done():
                gate.set_result(None)

    @property
    def in_flight(self) -> int:
        return len(self.started) - len(self.completed)


async def tick(rounds: int = 200) -> None:
    """Let the learner's loop and tasks run: each round is one turn of the event loop (no clock time passes)."""
    for _ in range(rounds):
        await asyncio.sleep(0)


def seed(ctx, n: int, partition: int = 0, prefix: str = "r") -> list[str]:
    values = [f"{prefix}{i}" for i in range(n)]
    for value in values:
        ctx.kafka.seed(TOPIC, value=value, partition=partition)
    return values


def committed(ctx, partition: int = 0):
    return ctx.kafka.committed_offset(GROUP, TOPIC, partition)


async def start(ctx, gates):
    ctx.kafka.stop_when_drained = False  # the loop runs until shutdown(), as in production
    m = ctx.load("async_consumer")
    task = asyncio.create_task(m.run(gates.handler))
    await tick()
    if task.done():
        task.result()  # surfaces the learner's error; a loop that returned early fails below
    assert not task.done(), "run() must keep polling until shutdown(), not return on its own"
    return m, task


async def stop(ctx, m, task):
    await m.shutdown()
    await tick()
    assert task.done(), "run() must return once shutdown() has stopped it"
    task.result()
    assert any(e[0] == "close" for e in ctx.kafka.events), "shutdown() must close the consumer"


async def check_concurrency(ctx):
    values = seed(ctx, 20)
    gates = Gates()
    m, task = await start(ctx, gates)
    assert gates.started == values[:8], f"with every handler still running exactly CONCURRENCY = 8 records may be started, got {gates.started}"
    assert m.stats()["in_flight"] == 8, f"stats()['in_flight'] must be 8 while 8 handlers run, got {m.stats()}"
    gates.open("r0")
    await tick()
    assert gates.started == values[:9], f"one completion frees exactly one slot: the 9th record starts, no more; got {gates.started}"
    assert gates.in_flight == 8, f"8 handlers must be running after one finished and one started, got {gates.in_flight}"
    gates.open(*values)
    await tick()
    assert gates.in_flight == 0 and len(gates.completed) == 20, f"every record must be handled once the gates open: {len(gates.completed)} of 20 completed, {gates.in_flight} running"
    await stop(ctx, m, task)
    assert committed(ctx) == 20, f"with everything finished the committed offset must be 20, got {committed(ctx)}"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, not by the tracker"


async def check_frontier(ctx):
    values = seed(ctx, 12)
    gates = Gates()
    violations = []

    def lowest_unfinished() -> int:
        return next((i for i in range(12) if f"r{i}" not in gates.completed), 12)

    def on_commit(group, offsets):
        for (topic, partition), offset in offsets.items():
            if partition == 0 and offset > lowest_unfinished():
                violations.append((offset, lowest_unfinished()))

    ctx.kafka.on_commit(on_commit)
    m, task = await start(ctx, gates)
    for value in ["r3", "r1", "r0", "r6", "r5", "r2", "r4", "r9", "r7", "r11", "r8", "r10"]:
        gates.open(value)
        await tick()
        assert not violations, f"offset {violations[0][0]} was committed while offset {violations[0][1]} was still running: the commit passed an unfinished record"
        assert (committed(ctx) or 0) <= lowest_unfinished(), f"committed {committed(ctx)} but offset {lowest_unfinished()} is still running"
    assert committed(ctx) == 12, f"once every record has finished the committed offset must reach 12, got {committed(ctx)}"
    await stop(ctx, m, task)
    assert sorted(gates.completed) == sorted(values), f"each record must be handled exactly once, got {sorted(gates.completed)}"


async def check_gap(ctx):
    seed(ctx, 5, partition=0, prefix="a")
    seed(ctx, 3, partition=1, prefix="b")
    gates = Gates()
    m, task = await start(ctx, gates)
    gates.open("a1", "a2", "a3", "a4", "b0", "b1", "b2")
    await tick()
    assert committed(ctx, 1) == 3, f"partition 1 is fully done: it must be committed to 3 while partition 0 waits, got {committed(ctx, 1)}"
    assert committed(ctx, 0) in (None, 0), f"a0 is still running: partition 0 must not be committed past 0, got {committed(ctx, 0)}"
    assert m.stats()["in_flight"] == 1, f"only a0 should be running, stats() says {m.stats()}"
    gates.open("a0")
    await tick()
    assert committed(ctx, 0) == 5, f"a1..a4 were already done when a0 finished: partition 0 must jump to 5, got {committed(ctx, 0)}"
    on_p0 = [c[(TOPIC, 0)] for c in ctx.kafka.commits(GROUP) if (TOPIC, 0) in c]
    assert on_p0 == [5], f"partition 0 must be committed exactly once, straight to 5 — never 1, 2, 3 or 4 while a0 ran; commits were {on_p0}"
    assert m.stats()["committed"] == {0: 5, 1: 3}, f"stats()['committed'] must be {{0: 5, 1: 3}}, got {m.stats()['committed']}"
    await stop(ctx, m, task)


async def check_shutdown(ctx):
    seed(ctx, 6)
    gates = Gates()
    m, task = await start(ctx, gates)
    gates.open("r0", "r1", "r3", "r4", "r5")
    await tick()
    assert committed(ctx) == 2, f"r2 still runs: the frontier is 2, got {committed(ctx)}"
    stopping = asyncio.create_task(m.shutdown())
    await tick()
    assert not stopping.done(), "shutdown() must wait for the handler still running (r2), not return under it"
    assert not any(e[0] == "close" for e in ctx.kafka.events), "the consumer was closed while a handler was still running"
    assert committed(ctx) == 2, f"shutdown() must not commit past the frontier while r2 runs, got {committed(ctx)}"
    gates.open("r2")
    await tick()
    assert stopping.done(), "shutdown() must return once the last in-flight handler has finished"
    stopping.result()
    assert committed(ctx) == 6, f"after shutdown the committed offset must equal the contiguous frontier, 6; got {committed(ctx)}"
    assert any(e[0] == "close" for e in ctx.kafka.events), "shutdown() must close the consumer"
    assert m.stats()["in_flight"] == 0, f"nothing may be in flight after shutdown, stats() says {m.stats()}"
    await tick()
    assert task.done(), "run() must return once shutdown() has stopped it"


async def check_complete(ctx):
    values = [f"req-{i}" for i in range(30)]
    for value in values:
        ctx.kafka.seed(TOPIC, key=value, value=value)
    gates = Gates()
    m, task = await start(ctx, gates)
    gates.open(*reversed(values))
    await tick()
    assert sorted(gates.started) == sorted(values), f"each record must reach the handler exactly once, got {sorted(gates.started)}"
    assert sorted(gates.completed) == sorted(values), f"each record must finish exactly once, got {sorted(gates.completed)}"
    ends = {p: ctx.kafka.end_offset(TOPIC, p) for p in range(3) if ctx.kafka.end_offset(TOPIC, p) > 0}
    for p, end in ends.items():
        assert committed(ctx, p) == end, f"partition {p} must be committed to its end {end}, got {committed(ctx, p)}"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, f"nothing may be left uncommitted, lag is {ctx.kafka.lag(GROUP, TOPIC)}"
    assert m.stats()["committed"] == ends, f"stats()['committed'] must be {ends}, got {m.stats()['committed']}"
    assert m.stats()["in_flight"] == 0
    await stop(ctx, m, task)
`,
    typescript: `const TOPIC = 'requests';
const GROUP = 'async-workers';

/** The harness's handler: every record waits on its own gate, so the harness decides the completion order. */
class Gates {
  readonly started: string[] = [];
  readonly completed: string[] = [];
  private readonly gates = new Map<string, {promise: Promise<void>; open: () => void}>();

  private gate(value: string) {
    let gate = this.gates.get(value);
    if (gate === undefined) {
      let open: () => void = () => undefined;
      const promise = new Promise<void>(resolve => {
        open = resolve;
      });
      gate = {promise, open};
      this.gates.set(value, gate);
    }
    return gate;
  }

  handler = async (value: string): Promise<void> => {
    this.started.push(value);
    await this.gate(value).promise;
    this.completed.push(value);
  };

  open(...values: string[]): void {
    for (const value of values) this.gate(value).open();
  }

  get inFlight(): number {
    return this.started.length - this.completed.length;
  }
}

/** Let the learner's loop and promises settle: microtasks only, so no virtual timer (shutdown's bound) fires. */
async function settle(rounds = 3000): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function seed(ctx, n: number, partition = 0, prefix = 'r'): string[] {
  const values = Array.from({length: n}, (_, i) => \`\${prefix}\${i}\`);
  for (const value of values) ctx.kafka.seed(TOPIC, {value, partition});
  return values;
}

const committed = (ctx, partition = 0): number | null => ctx.kafka.committedOffset(GROUP, TOPIC, partition);

async function start(ctx, gates: Gates) {
  const m = ctx.load('async_consumer');
  let failure: unknown;
  const running = (m.run(gates.handler) as Promise<void>).catch((e: unknown) => {
    failure = e;
  });
  await settle();
  if (failure !== undefined) throw failure;
  return {m, running, failed: () => failure};
}

async function stop(ctx, world) {
  await world.m.shutdown();
  await settle();
  await world.running;
  if (world.failed() !== undefined) throw world.failed();
  assert(ctx.kafka.events.some(e => e[0] === 'close'), 'shutdown() must disconnect the consumer');
}

export async function check_concurrency(ctx) {
  const values = seed(ctx, 20);
  const gates = new Gates();
  const world = await start(ctx, gates);
  assert.deepEqual(gates.started, values.slice(0, 8), \`with every handler still running exactly CONCURRENCY = 8 records may be started, got \${JSON.stringify(gates.started)}\`);
  assert.equal(world.m.stats().inFlight, 8, \`stats().inFlight must be 8 while 8 handlers run, got \${JSON.stringify(world.m.stats())}\`);
  gates.open('r0');
  await settle();
  assert.deepEqual(gates.started, values.slice(0, 9), \`one completion frees exactly one slot: the 9th record starts, no more; got \${JSON.stringify(gates.started)}\`);
  assert.equal(gates.inFlight, 8, \`8 handlers must be running after one finished and one started, got \${gates.inFlight}\`);
  gates.open(...values);
  await settle();
  assert(gates.inFlight === 0 && gates.completed.length === 20, \`every record must be handled once the gates open: \${gates.completed.length} of 20 completed, \${gates.inFlight} running\`);
  await stop(ctx, world);
  assert.equal(committed(ctx), 20, \`with everything finished the committed offset must be 20, got \${committed(ctx)}\`);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, not by the tracker');
}

export async function check_frontier(ctx) {
  const values = seed(ctx, 12);
  const gates = new Gates();
  const violations: [number, number][] = [];
  const lowestUnfinished = (): number => {
    for (let i = 0; i < 12; i++) if (!gates.completed.includes(\`r\${i}\`)) return i;
    return 12;
  };
  ctx.kafka.onCommit((group, offsets: Map<string, number>) => {
    const offset = offsets.get(\`\${TOPIC}|0\`);
    if (offset !== undefined && offset > lowestUnfinished()) violations.push([offset, lowestUnfinished()]);
  });
  const world = await start(ctx, gates);
  for (const value of ['r3', 'r1', 'r0', 'r6', 'r5', 'r2', 'r4', 'r9', 'r7', 'r11', 'r8', 'r10']) {
    gates.open(value);
    await settle();
    assert.equal(violations.length, 0, \`offset \${violations[0]?.[0]} was committed while offset \${violations[0]?.[1]} was still running: the commit passed an unfinished record\`);
    assert((committed(ctx) ?? 0) <= lowestUnfinished(), \`committed \${committed(ctx)} but offset \${lowestUnfinished()} is still running\`);
  }
  assert.equal(committed(ctx), 12, \`once every record has finished the committed offset must reach 12, got \${committed(ctx)}\`);
  await stop(ctx, world);
  assert.deepEqual([...gates.completed].sort(), [...values].sort(), \`each record must be handled exactly once, got \${JSON.stringify([...gates.completed].sort())}\`);
}

export async function check_gap(ctx) {
  seed(ctx, 5, 0, 'a');
  seed(ctx, 3, 1, 'b');
  const gates = new Gates();
  const world = await start(ctx, gates);
  gates.open('a1', 'a2', 'a3', 'a4', 'b0', 'b1', 'b2');
  await settle();
  assert.equal(committed(ctx, 1), 3, \`partition 1 is fully done: it must be committed to 3 while partition 0 waits, got \${committed(ctx, 1)}\`);
  assert(committed(ctx, 0) === null || committed(ctx, 0) === 0, \`a0 is still running: partition 0 must not be committed past 0, got \${committed(ctx, 0)}\`);
  assert.equal(world.m.stats().inFlight, 1, \`only a0 should be running, stats() says \${JSON.stringify(world.m.stats())}\`);
  gates.open('a0');
  await settle();
  assert.equal(committed(ctx, 0), 5, \`a1..a4 were already done when a0 finished: partition 0 must jump to 5, got \${committed(ctx, 0)}\`);
  const onP0 = ctx.kafka.commits(GROUP).filter(c => \`\${TOPIC}|0\` in c).map(c => c[\`\${TOPIC}|0\`]);
  assert.deepEqual(onP0, [5], \`partition 0 must be committed exactly once, straight to 5 — never 1, 2, 3 or 4 while a0 ran; commits were \${JSON.stringify(onP0)}\`);
  assert.deepEqual(world.m.stats().committed, {0: 5, 1: 3}, \`stats().committed must be {0: 5, 1: 3}, got \${JSON.stringify(world.m.stats().committed)}\`);
  await stop(ctx, world);
}

export async function check_shutdown(ctx) {
  seed(ctx, 6);
  const gates = new Gates();
  const world = await start(ctx, gates);
  gates.open('r0', 'r1', 'r3', 'r4', 'r5');
  await settle();
  assert.equal(committed(ctx), 2, \`r2 still runs: the frontier is 2, got \${committed(ctx)}\`);
  let outcome: 'pending' | 'done' | 'failed' = 'pending';
  let error: unknown;
  const stopping = (world.m.shutdown() as Promise<void>).then(
    () => {
      outcome = 'done';
    },
    (e: unknown) => {
      outcome = 'failed';
      error = e;
    },
  );
  await settle();
  if (outcome === 'failed') throw error;
  assert.equal(outcome, 'pending', 'shutdown() must wait for the handler still running (r2), not return under it');
  assert(!ctx.kafka.events.some(e => e[0] === 'close'), 'the consumer was disconnected while a handler was still running');
  assert.equal(committed(ctx), 2, \`shutdown() must not commit past the frontier while r2 runs, got \${committed(ctx)}\`);
  gates.open('r2');
  await settle();
  await stopping;
  if (outcome === 'failed') throw error;
  assert.equal(outcome, 'done', 'shutdown() must return once the last in-flight handler has finished');
  assert.equal(committed(ctx), 6, \`after shutdown the committed offset must equal the contiguous frontier, 6; got \${committed(ctx)}\`);
  assert(ctx.kafka.events.some(e => e[0] === 'close'), 'shutdown() must disconnect the consumer');
  assert.equal(world.m.stats().inFlight, 0, \`nothing may be in flight after shutdown, stats() says \${JSON.stringify(world.m.stats())}\`);
  await world.running;
  if (world.failed() !== undefined) throw world.failed();
}

export async function check_complete(ctx) {
  const values = Array.from({length: 30}, (_, i) => \`req-\${i}\`);
  for (const value of values) ctx.kafka.seed(TOPIC, {key: value, value});
  const gates = new Gates();
  const world = await start(ctx, gates);
  gates.open(...[...values].reverse());
  await settle();
  assert.deepEqual([...gates.started].sort(), [...values].sort(), \`each record must reach the handler exactly once, got \${JSON.stringify([...gates.started].sort())}\`);
  assert.deepEqual([...gates.completed].sort(), [...values].sort(), \`each record must finish exactly once, got \${JSON.stringify([...gates.completed].sort())}\`);
  const ends: Record<number, number> = {};
  for (let p = 0; p < 3; p++) if (ctx.kafka.endOffset(TOPIC, p) > 0) ends[p] = ctx.kafka.endOffset(TOPIC, p);
  for (const [p, end] of Object.entries(ends))
    assert.equal(committed(ctx, Number(p)), end, \`partition \${p} must be committed to its end \${end}, got \${committed(ctx, Number(p))}\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, \`nothing may be left uncommitted, lag is \${ctx.kafka.lag(GROUP, TOPIC)}\`);
  assert.deepEqual(world.m.stats().committed, ends, \`stats().committed must be \${JSON.stringify(ends)}, got \${JSON.stringify(world.m.stats().committed)}\`);
  assert.equal(world.m.stats().inFlight, 0);
  await stop(ctx, world);
}
`,
    go: `package main

import (
	"fmt"
	"sort"
	"sync"

	"leetbuild/harness"
)

// ackGates is the harness's handler: every record waits on its own gate, so the harness decides the
// completion order. Each handler runs on its own goroutine, so records start in any order.
type ackGates struct {
	mu        sync.Mutex
	gates     map[string]chan struct{}
	opened    map[string]bool
	started   []string
	completed []string
}

func newAckGates() *ackGates {
	return &ackGates{gates: map[string]chan struct{}{}, opened: map[string]bool{}}
}

func (g *ackGates) gate(value string) chan struct{} {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.gates[value] == nil {
		g.gates[value] = make(chan struct{})
	}
	return g.gates[value]
}

func (g *ackGates) handler(value string) error {
	g.mu.Lock()
	g.started = append(g.started, value)
	g.mu.Unlock()
	<-g.gate(value)
	g.mu.Lock()
	g.completed = append(g.completed, value)
	g.mu.Unlock()
	return nil
}

func (g *ackGates) open(values ...string) {
	for _, value := range values {
		gate := g.gate(value)
		g.mu.Lock()
		if !g.opened[value] {
			g.opened[value] = true
			close(gate)
		}
		g.mu.Unlock()
	}
}

// snapshot is what started and completed so far, each sorted.
func (g *ackGates) snapshot() (started, completed []string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	started = append([]string{}, g.started...)
	completed = append([]string{}, g.completed...)
	sort.Strings(started)
	sort.Strings(completed)
	return started, completed
}

func (g *ackGates) running() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.started) - len(g.completed)
}

func seedRequests(ctx *harness.Ctx, n, partition int, prefix string) []string {
	var values []string
	for i := range n {
		value := fmt.Sprintf("%s%d", prefix, i)
		values = append(values, value)
		ctx.Kafka.SeedPartition("requests", partition, nil, value)
	}
	return values
}

func sortedCopy(values []string) []string {
	out := append([]string{}, values...)
	sort.Strings(out)
	return out
}

// startConsumer runs the learner's loop and lets it settle with the clock held; the channel closes when run returns.
func startConsumer(ctx *harness.Ctx, g *ackGates) chan struct{} {
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		run(g.handler)
	}()
	ctx.Tick()
	return runDone
}

func stopConsumer(ctx *harness.Ctx, runDone chan struct{}) {
	ctx.Drain(func() { shutdown() })
	ctx.Tick()
	ctx.Drain(func() { <-runDone })
	ctx.Assert(len(ctx.Kafka.EventsOf("close")) > 0, "shutdown() must close the consumer")
}

func CheckConcurrency(ctx *harness.Ctx) {
	values := seedRequests(ctx, 20, 0, "r")
	g := newAckGates()
	runDone := startConsumer(ctx, g)
	started, _ := g.snapshot()
	ctx.Equal(started, sortedCopy(values[:8]), "with every handler still running exactly concurrency = 8 records may be started")
	running, _ := stats()
	ctx.Equal(running, 8, "stats() must count 8 in flight while 8 handlers run")
	g.open("r0")
	ctx.Tick()
	started, _ = g.snapshot()
	ctx.Equal(started, sortedCopy(values[:9]), "one completion frees exactly one slot: the 9th record starts, no more")
	ctx.Equal(g.running(), 8, "handlers running after one finished and one started")
	g.open(values...)
	ctx.Tick()
	_, completed := g.snapshot()
	ctx.Assert(g.running() == 0 && len(completed) == 20, "every record must be handled once the gates open: %d of 20 completed, %d running", len(completed), g.running())
	stopConsumer(ctx, runDone)
	ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", 0), 20, "with everything finished the committed offset")
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "auto-commit is on: offsets were committed on a timer, not by the tracker")
}

func CheckFrontier(ctx *harness.Ctx) {
	values := seedRequests(ctx, 12, 0, "r")
	g := newAckGates()
	lowestUnfinished := func() int64 {
		_, completed := g.snapshot()
		done := map[string]bool{}
		for _, value := range completed {
			done[value] = true
		}
		for i := range 12 {
			if !done[fmt.Sprintf("r%d", i)] {
				return int64(i)
			}
		}
		return 12
	}
	var violations [][2]int64
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		offset, ok := offsets[harness.KafkaTopicPartition{Topic: "requests", Partition: 0}]
		if lowest := lowestUnfinished(); ok && offset > lowest {
			violations = append(violations, [2]int64{offset, lowest})
		}
	})
	runDone := startConsumer(ctx, g)
	for _, value := range []string{"r3", "r1", "r0", "r6", "r5", "r2", "r4", "r9", "r7", "r11", "r8", "r10"} {
		g.open(value)
		ctx.Tick()
		if len(violations) > 0 {
			ctx.Fatalf("offset %d was committed while offset %d was still running: the commit passed an unfinished record", violations[0][0], violations[0][1])
		}
		committedNow := ctx.Kafka.CommittedOffset(group, "requests", 0)
		ctx.Assert(max(committedNow, 0) <= lowestUnfinished(), "committed %d but offset %d is still running", committedNow, lowestUnfinished())
	}
	ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", 0), 12, "once every record has finished the committed offset must reach 12")
	stopConsumer(ctx, runDone)
	_, completed := g.snapshot()
	ctx.Equal(completed, sortedCopy(values), "each record must be handled exactly once")
}

func CheckGap(ctx *harness.Ctx) {
	seedRequests(ctx, 5, 0, "a")
	seedRequests(ctx, 3, 1, "b")
	g := newAckGates()
	runDone := startConsumer(ctx, g)
	g.open("a1", "a2", "a3", "a4", "b0", "b1", "b2")
	ctx.Tick()
	ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", 1), 3, "partition 1 is fully done: it must be committed to 3 while partition 0 waits")
	p0 := ctx.Kafka.CommittedOffset(group, "requests", 0)
	ctx.Assert(p0 == -1 || p0 == 0, "a0 is still running: partition 0 must not be committed past 0, got %d", p0)
	running, _ := stats()
	ctx.Equal(running, 1, "only a0 should be running: stats() in flight")
	g.open("a0")
	ctx.Tick()
	ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", 0), 5, "a1..a4 were already done when a0 finished: partition 0 must jump to 5")
	var onP0 []int64
	for _, commit := range ctx.Kafka.Commits(group) {
		if offset, ok := commit[harness.KafkaTopicPartition{Topic: "requests", Partition: 0}]; ok {
			onP0 = append(onP0, offset)
		}
	}
	ctx.Equal(onP0, []int64{5}, "partition 0 must be committed exactly once, straight to 5 — never 1, 2, 3 or 4 while a0 ran: its commits")
	_, committedNow := stats()
	ctx.Equal(committedNow, map[int32]int64{0: 5, 1: 3}, "stats() committed")
	stopConsumer(ctx, runDone)
}

func CheckShutdown(ctx *harness.Ctx) {
	seedRequests(ctx, 6, 0, "r")
	g := newAckGates()
	runDone := startConsumer(ctx, g)
	g.open("r0", "r1", "r3", "r4", "r5")
	ctx.Tick()
	ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", 0), 2, "r2 still runs: the frontier")
	shutDone := make(chan struct{})
	go func() {
		defer close(shutDone)
		shutdown()
	}()
	ctx.Tick()
	select {
	case <-shutDone:
		ctx.Fatalf("shutdown() must wait for the handler still running (r2), not return under it")
	default:
	}
	ctx.Assert(len(ctx.Kafka.EventsOf("close")) == 0, "the consumer was closed while a handler was still running")
	ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", 0), 2, "shutdown() must not commit past the frontier while r2 runs")
	g.open("r2")
	ctx.Tick()
	returned := ctx.Drain(func() { <-shutDone })
	ctx.Assert(returned, "shutdown() must return once the last in-flight handler has finished")
	ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", 0), 6, "after shutdown the committed offset must equal the contiguous frontier")
	ctx.Assert(len(ctx.Kafka.EventsOf("close")) > 0, "shutdown() must close the consumer")
	running, _ := stats()
	ctx.Equal(running, 0, "nothing may be in flight after shutdown: stats() in flight")
	ctx.Drain(func() { <-runDone })
}

func CheckComplete(ctx *harness.Ctx) {
	var values []string
	for i := range 30 {
		value := fmt.Sprintf("req-%d", i)
		values = append(values, value)
		ctx.Kafka.Seed("requests", value, value)
	}
	g := newAckGates()
	runDone := startConsumer(ctx, g)
	for i := len(values) - 1; i >= 0; i-- {
		g.open(values[i])
	}
	ctx.Tick()
	started, completed := g.snapshot()
	ctx.Equal(started, sortedCopy(values), "each record must reach the handler exactly once")
	ctx.Equal(completed, sortedCopy(values), "each record must finish exactly once")
	ends := map[int32]int64{}
	for p := range 3 {
		if end := ctx.Kafka.EndOffset("requests", p); end > 0 {
			ends[int32(p)] = end
		}
	}
	for p, end := range ends {
		ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", int(p)), end, "partition %d must be committed to its end %d", p, end)
	}
	ctx.Equal(ctx.Kafka.Lag(group, "requests"), 0, "nothing may be left uncommitted: lag")
	running, committedNow := stats()
	ctx.Equal(committedNow, ends, "stats() committed")
	ctx.Equal(running, 0, "stats() in flight")
	stopConsumer(ctx, runDone)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <condition_variable>
#include <cstdint>
#include <initializer_list>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace {

// ackGates is the harness's handler: every record waits on its own gate, so the harness decides the
// completion order. Each handler runs on its own thread, so records start in any order.
struct ackGates {
  std::mutex mu;
  std::condition_variable cv;
  std::set<std::string> opened;
  std::vector<std::string> started;
  std::vector<std::string> completed;

  void handler(const std::string& value) {
    std::unique_lock<std::mutex> lock(mu);
    started.push_back(value);
    cv.wait(lock, [&] { return opened.count(value) > 0; });
    completed.push_back(value);
  }

  void open(const std::vector<std::string>& values) {
    std::lock_guard<std::mutex> lock(mu);
    for (const auto& v : values) opened.insert(v);
    cv.notify_all();
  }

  // snapshot is what started and completed so far, each sorted.
  std::pair<std::vector<std::string>, std::vector<std::string>> snapshot() {
    std::lock_guard<std::mutex> lock(mu);
    auto s = started;
    auto c = completed;
    std::sort(s.begin(), s.end());
    std::sort(c.begin(), c.end());
    return {s, c};
  }

  int running() {
    std::lock_guard<std::mutex> lock(mu);
    return static_cast<int>(started.size() - completed.size());
  }
};

std::vector<std::string> seedRequests(harness::Ctx& ctx, int n, int partition, const std::string& prefix) {
  std::vector<std::string> values;
  for (int i = 0; i < n; i++) {
    const std::string value = prefix + std::to_string(i);
    values.push_back(value);
    ctx.Kafka.SeedPartition("requests", partition, nullptr, value);
  }
  return values;
}

std::vector<std::string> sortedCopy(std::vector<std::string> values) {
  std::sort(values.begin(), values.end());
  return values;
}

// A thread still running when the check ends (a failed assertion) is left behind, not joined.
struct detachOnExit {
  std::thread& thread;
  ~detachOnExit() {
    if (thread.joinable()) thread.detach();
  }
};

// The learner's loop on a thread of its own, started and settled with the clock held.
struct consumerRun {
  std::thread thread;
  ~consumerRun() {
    if (thread.joinable()) thread.detach();
  }
};

std::unique_ptr<consumerRun> startConsumer(harness::Ctx& ctx, ackGates& g) {
  auto r = std::make_unique<consumerRun>();
  r->thread = std::thread([&g] { run([&g](const std::string& value) { g.handler(value); }); });
  ctx.Tick();
  return r;
}

void stopConsumer(harness::Ctx& ctx, consumerRun& r) {
  ctx.Drain([] { shutdown(); });
  ctx.Tick();
  if (!ctx.Drain([&r] { r.thread.join(); })) r.thread.detach();
  ctx.Assert(!ctx.Kafka.EventsOf("close").empty(), "shutdown() must close the consumer");
}

// After gates open: every thread runs with the clock held, then the poll loop comes round — its
// consume(100) times out, it applies the completions and commits — and runs again.
void passAcks(harness::Ctx& ctx) {
  ctx.Tick();
  ctx.Clock.Advance(0.2);
  ctx.Tick();
}

}  // namespace

void CheckConcurrency(harness::Ctx& ctx) {
  const auto values = seedRequests(ctx, 20, 0, "r");
  ackGates g;
  auto runDone = startConsumer(ctx, g);
  ctx.Equal(g.snapshot().first, sortedCopy({values.begin(), values.begin() + 8}),
            "with every handler still running exactly concurrency = 8 records may be started");
  ctx.Equal(stats().in_flight, 8, "stats() must count 8 in flight while 8 handlers run");
  g.open({"r0"});
  passAcks(ctx);
  ctx.Equal(g.snapshot().first, sortedCopy({values.begin(), values.begin() + 9}),
            "one completion frees exactly one slot: the 9th record starts, no more");
  ctx.Equal(g.running(), 8, "handlers running after one finished and one started");
  g.open(values);
  passAcks(ctx);
  const auto completed = g.snapshot().second;
  ctx.Assert(g.running() == 0 && completed.size() == 20,
             "every record must be handled once the gates open: %d of 20 completed, %d running", completed.size(), g.running());
  stopConsumer(ctx, *runDone);
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, "requests", 0), 20, "with everything finished the committed offset");
  ctx.Assert(ctx.Kafka.EventsOf("auto-commit").empty(), "auto-commit is on: offsets were committed on a timer, not by the tracker");
}

void CheckFrontier(harness::Ctx& ctx) {
  const auto values = seedRequests(ctx, 12, 0, "r");
  ackGates g;
  const auto lowestUnfinished = [&g]() -> int64_t {
    const auto completed = g.snapshot().second;
    const std::set<std::string> done(completed.begin(), completed.end());
    for (int i = 0; i < 12; i++)
      if (!done.count("r" + std::to_string(i))) return i;
    return 12;
  };
  std::vector<std::pair<int64_t, int64_t>> violations;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) {
    const auto it = offsets.find({"requests", 0});
    const int64_t lowest = lowestUnfinished();
    if (it != offsets.end() && it->second > lowest) violations.emplace_back(it->second, lowest);
  });
  auto runDone = startConsumer(ctx, g);
  for (const std::string value : {"r3", "r1", "r0", "r6", "r5", "r2", "r4", "r9", "r7", "r11", "r8", "r10"}) {
    g.open({value});
    passAcks(ctx);
    if (!violations.empty())
      ctx.Fatalf("offset %d was committed while offset %d was still running: the commit passed an unfinished record",
                 violations[0].first, violations[0].second);
    const int64_t committedNow = ctx.Kafka.CommittedOffset(kGroup, "requests", 0);
    ctx.Assert(std::max<int64_t>(committedNow, 0) <= lowestUnfinished(), "committed %d but offset %d is still running", committedNow,
               lowestUnfinished());
  }
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, "requests", 0), 12, "once every record has finished the committed offset must reach 12");
  stopConsumer(ctx, *runDone);
  ctx.Equal(g.snapshot().second, sortedCopy(values), "each record must be handled exactly once");
}

void CheckGap(harness::Ctx& ctx) {
  seedRequests(ctx, 5, 0, "a");
  seedRequests(ctx, 3, 1, "b");
  ackGates g;
  auto runDone = startConsumer(ctx, g);
  g.open({"a1", "a2", "a3", "a4", "b0", "b1", "b2"});
  passAcks(ctx);
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, "requests", 1), 3, "partition 1 is fully done: it must be committed to 3 while partition 0 waits");
  const int64_t p0 = ctx.Kafka.CommittedOffset(kGroup, "requests", 0);
  ctx.Assert(p0 == -1 || p0 == 0, "a0 is still running: partition 0 must not be committed past 0, got %d", p0);
  ctx.Equal(stats().in_flight, 1, "only a0 should be running: stats() in flight");
  g.open({"a0"});
  passAcks(ctx);
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, "requests", 0), 5, "a1..a4 were already done when a0 finished: partition 0 must jump to 5");
  std::vector<int64_t> onP0;
  for (const auto& commit : ctx.Kafka.Commits(kGroup)) {
    const auto it = commit.find({"requests", 0});
    if (it != commit.end()) onP0.push_back(it->second);
  }
  ctx.Equal(onP0, {5}, "partition 0 must be committed exactly once, straight to 5 — never 1, 2, 3 or 4 while a0 ran: its commits");
  ctx.Equal(stats().committed, std::map<int32_t, int64_t>{{0, 5}, {1, 3}}, "stats() committed");
  stopConsumer(ctx, *runDone);
}

void CheckShutdown(harness::Ctx& ctx) {
  seedRequests(ctx, 6, 0, "r");
  ackGates g;
  auto runDone = startConsumer(ctx, g);
  g.open({"r0", "r1", "r3", "r4", "r5"});
  passAcks(ctx);
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, "requests", 0), 2, "r2 still runs: the frontier");
  bool shutDone = false;
  std::thread shutter([&shutDone] {
    shutdown();
    shutDone = true;
  });
  detachOnExit shutterGuard{shutter};
  ctx.Tick();
  if (shutDone) ctx.Fatalf("shutdown() must wait for the handler still running (r2), not return under it");
  ctx.Assert(ctx.Kafka.EventsOf("close").empty(), "the consumer was closed while a handler was still running");
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, "requests", 0), 2, "shutdown() must not commit past the frontier while r2 runs");
  g.open({"r2"});
  passAcks(ctx);
  const bool returned = ctx.Drain([&shutter] { shutter.join(); });
  if (!returned) shutter.detach();
  ctx.Assert(returned, "shutdown() must return once the last in-flight handler has finished");
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, "requests", 0), 6, "after shutdown the committed offset must equal the contiguous frontier");
  ctx.Assert(!ctx.Kafka.EventsOf("close").empty(), "shutdown() must close the consumer");
  ctx.Equal(stats().in_flight, 0, "nothing may be in flight after shutdown: stats() in flight");
  if (!ctx.Drain([&runDone] { runDone->thread.join(); })) runDone->thread.detach();
}

void CheckComplete(harness::Ctx& ctx) {
  std::vector<std::string> values;
  for (int i = 0; i < 30; i++) {
    const std::string value = "req-" + std::to_string(i);
    values.push_back(value);
    ctx.Kafka.Seed("requests", value, value);
  }
  ackGates g;
  auto runDone = startConsumer(ctx, g);
  g.open(std::vector<std::string>(values.rbegin(), values.rend()));
  passAcks(ctx);
  const auto [started, completed] = g.snapshot();
  ctx.Equal(started, sortedCopy(values), "each record must reach the handler exactly once");
  ctx.Equal(completed, sortedCopy(values), "each record must finish exactly once");
  std::map<int32_t, int64_t> ends;
  for (int p = 0; p < 3; p++) {
    const int64_t end = ctx.Kafka.EndOffset("requests", p);
    if (end > 0) ends[p] = end;
  }
  for (const auto& [p, end] : ends)
    ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, "requests", p), end, "partition %d must be committed to its end %d", p, end);
  ctx.Equal(ctx.Kafka.Lag(kGroup, "requests"), 0, "nothing may be left uncommitted: lag");
  const Stats s = stats();
  ctx.Equal(s.committed, ends, "stats() committed");
  ctx.Equal(s.in_flight, 0, "stats() in flight");
  stopConsumer(ctx, *runDone);
}
`,
  },
  debrief: `Kafka has no per-record acknowledgement: a partition's committed offset is one number that promises "everything below this is done". Serial consumers keep that promise by construction; the moment handlers overlap, completion order and delivery order part ways, and a consumer that commits \`offset + 1\` whenever something finishes will, sooner or later, commit past a record that is still running — a crash then replays nothing and the record is gone. The tracker turns a set of completions back into that one number: the frontier only moves across finished offsets, so a slow record pins it and the finished offsets above it wait in the set until it clears, then the commit jumps in one step. The bound on in-flight handlers is what keeps that set small and the replay-after-crash window bounded; the shutdown waits so that work already done is committed rather than redone. Real systems add what this drill leaves out: Confluent's Parallel Consumer encodes the finished-above-the-frontier set into the commit metadata so a restart skips what was already done, orders work by key inside a partition, and keeps heartbeating (or pauses partitions) while the loop waits at the limit so the group coordinator does not evict a consumer that is merely busy.`,
};
