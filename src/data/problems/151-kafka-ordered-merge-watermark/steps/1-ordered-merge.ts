import type {Step} from '@/lib/types';

export const orderedMergeStep: Step = {
  id: 'ordered-merge',
  title: 'Merge six partitions into one time-ordered stream',
  concept: 'kafka',
  file: 'merger',
  focus: ['merger', 'kafka'],
  task: `## Task

Implement \`run(emit)\` and \`stats()\` in \`merger\`: a member of consumer group **\`merger\`** that reads
**\`sensor-readings\`** (6 partitions, JSON \`{"sensor", "ts"}\` with the event time \`ts\` in ms, each
partition roughly in \`ts\` order) and calls \`emit(reading)\` with \`{sensor, ts, partition, offset}\` in
**global \`ts\` order**. Auto-commit is off; \`auto.offset.reset\` is \`earliest\`.

- **Per partition** keep a buffer of pending readings, the newest \`ts\` seen, the processing time
  (\`time.time()\` / \`Date.now()\`, ms) of the last delivery, and the offset after the last delivery.
- **Arrival**: a reading with \`ts\` **below the frontier** — the \`ts\` of the last emitted reading — can no
  longer be placed in order: drop it and count it. Otherwise buffer it. Either way it moves the
  partition's newest \`ts\` and last-delivery time.
- **Watermark** = the minimum newest \`ts\` over the partitions that delivered within the last
  \`IDLE_MS\` = 10 000 ms of processing time. A partition quiet for \`IDLE_MS\` is **idle** and stops
  holding the watermark back; when every partition is idle the watermark is the highest \`ts\` seen.
- **Flush** after every delivery and at least once a second while nothing arrives (idle partitions
  are released by time passing, not by records): every buffered reading with
  \`ts <= watermark - LATENESS_MS\` (\`LATENESS_MS\` = 2000), sorted by \`(ts, partition, offset)\`, goes to
  \`emit\`; the frontier becomes the last emitted \`ts\`.
- **Commit** after a flush that emitted, per partition: the **lowest offset still buffered**, or the
  offset after the last delivery when the buffer is empty — never an offset above a reading that
  has not been emitted. A partition's commit is sent only when that number changed.
- \`stats()\` returns \`{emitted, dropped, buffered}\`: readings emitted, readings dropped as late, readings
  sitting in the buffers right now.

:::widget kafka-partitions {"partitions": 6}

> The watermark is a promise — "no partition still has anything older than this" — and the lateness
> allowance is how much you distrust it. Everything the merger does follows from keeping that promise:
> hold until it is true, release idle partitions so it can become true, drop what arrives after it was
> made, and commit only what the promise has already let through.`,
  sequence: {
    participants: ['Kafka', 'merger', 'sink'],
    messages: [
      {from: 'Kafka', to: 'merger', label: 'poll → p0@0 ts 1000, p1@0 ts 3000, p0@1 ts 5000', kind: 'reply'},
      {from: 'merger', to: 'merger', label: 'watermark = min(5000, 3000) = 3000 → threshold 1000'},
      {from: 'merger', to: 'sink', label: 'emit ts 1000 (p0@0) · frontier 1000', kind: 'async'},
      {from: 'merger', to: 'Kafka', label: 'commit p0 → 1 (p0@1 still buffered), p1 → 0', kind: 'sync'},
      {from: 'Kafka', to: 'merger', label: 'poll → p0@2 ts 900', kind: 'reply'},
      {from: 'merger', to: 'merger', label: '900 < frontier 1000 → dropped (1)'},
      {
        from: 'Kafka',
        to: 'merger',
        label: '10 s of empty polls: p1 idle → watermark 5000 → threshold 3000',
        kind: 'reply',
      },
      {from: 'merger', to: 'sink', label: 'emit ts 3000 (p1@0)', kind: 'async'},
    ],
  },
  hints: [
    'Keep one struct per partition (buffer, newest ts, last-delivery time, next offset) and write `watermark()` as a pure function over them; then `flush()` is: threshold = watermark − LATENESS_MS, pull every buffered reading at or below it, sort by (ts, partition, offset), emit, remember the frontier, commit.',
    'Flush must run on empty polls too (poll with a 1 s timeout; in kafkajs, a 1 s `setInterval` beside `eachMessage`), or an idle partition is never released: nothing arrives to trigger the check.',
    'The commit offset for a partition is not "highest emitted + 1": a reading can be emitted while an older offset of the same partition is still buffered. Commit the lowest buffered offset, or the position after the last delivery when nothing is buffered.',
  ],
  checks: [
    {
      id: 'in-order',
      title: 'Emits in global ts order across six partitions',
      detail:
        'Readings interleaved across all six partitions must come out sorted by `ts`, ties by partition then offset — the buffered readings of a flush are sorted together, not emitted per partition.',
      match: {
        python: {all: [/sort(?:ed)?\([^\n]*"ts"[^\n]*"partition"[^\n]*"offset"/]},
        typescript: {all: [/\.sort\([^\n]*\.ts[^\n]*\.partition[^\n]*\.offset/]},
        go: {all: [/sort\.Slice\(/, /\.Partition\s*<\s*\w+\.Partition/]},
        scala: {all: [/sortBy\([^\n]*\.ts[^\n]*\.partition[^\n]*\.offset/]},
        cpp: {all: [/std::sort\(/, /std::tie\(\w+\.ts,\s*\w+\.partition,\s*\w+\.offset\)/]},
      },
    },
    {
      id: 'watermark-gates',
      title: 'Holds readings above watermark − LATENESS_MS',
      detail:
        'Only readings with `ts <= watermark - LATENESS_MS` leave the buffers; the newest readings of every partition stay until the slowest partition catches up — a partition far ahead does not pull the watermark forward.',
      match: {
        python: {all: [/-\s*LATENESS_MS/, /<=\s*threshold/]},
        typescript: {all: [/-\s*LATENESS_MS/, /<=\s*threshold/]},
        go: {all: [/-\s*LatenessMs/, /<=\s*threshold/]},
        scala: {all: [/-\s*LatenessMs/, /<=\s*threshold/]},
        cpp: {all: [/-\s*kLatenessMs/, /<=\s*threshold/]},
      },
    },
    {
      id: 'late-dropped',
      title: 'Drops and counts a reading below the frontier',
      detail:
        'A reading whose `ts` is below the last emitted `ts` arrives after its slot in the stream has passed: it is never emitted (order would break) and `stats().dropped` counts it.',
      match: {
        python: {all: [/\bdropped\s*\+=\s*1/]},
        typescript: {all: [/\bdropped\s*\+=\s*1/]},
        go: {all: [/\bdropped\+\+/]},
        scala: {all: [/\bdropped\s*\+=\s*1/]},
        cpp: {all: [/\+\+dropped|dropped\+\+/]},
      },
    },
    {
      id: 'within-lateness',
      title: 'Keeps a reading that is late but not below the frontier',
      detail:
        'A reading behind its partition and behind the watermark, but at or above the frontier — equal counts as in time — is buffered and emitted in its place, not dropped: only `ts < frontier` is late.',
      match: {
        python: {all: [/\bts\s*<\s*frontier\b/], none: [/<=\s*frontier\b/]},
        typescript: {all: [/\.ts\s*<\s*frontier\b/], none: [/<=\s*frontier\b/]},
        go: {all: [/\.Ts\s*<\s*frontier\b/], none: [/<=\s*frontier\b/]},
        scala: {all: [/\bts\s*<\s*frontier\b/], none: [/<=\s*frontier\b/]},
        cpp: {all: [/\bts\s*<\s*frontier\b/], none: [/<=\s*frontier\b/]},
      },
    },
    {
      id: 'idle-partition',
      title: 'Releases an idle partition after IDLE_MS',
      detail:
        'A partition that delivered nothing for `IDLE_MS` stops holding the watermark back: the readings it was blocking are emitted once the clock has moved, while a partition still delivering keeps its bound.',
      match: {
        python: {all: [/last_seen\s*(?:<|>=)\s*IDLE_MS/]},
        typescript: {all: [/lastSeen\s*(?:<|>=)\s*IDLE_MS/]},
        go: {all: [/lastSeen\s*(?:<|>=)\s*IdleMs/]},
        scala: {all: [/lastSeen\s*(?:<|>=)\s*IdleMs/]},
        cpp: {all: [/last_seen\s*(?:<|>=)\s*kIdleMs/]},
      },
    },
    {
      id: 'commit-after-emit',
      title: 'Commits never cover an unemitted reading',
      detail:
        'Auto-commit is off and every committed offset sits at or below every reading still buffered on that partition — the lowest buffered offset, not the highest emitted one plus one.',
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/, /consumer\.commit\(\s*offsets\s*=/]},
        typescript: {all: [/autoCommit:\s*false/, /consumer\.commitOffsets\(/]},
        go: {all: [/reader\.FetchMessage\(/, /reader\.CommitMessages\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"enable\.auto\.commit"\s*,\s*"false"/, /consumer\.commitSync\(/]},
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

from confluent_kafka import Consumer, TopicPartition

TOPIC = "sensor-readings"
GROUP = "merger"
LATENESS_MS = 2000
IDLE_MS = 10000

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC])


class Partition:
    """What the merger knows about one partition: pending readings and how far it has come."""

    def __init__(self) -> None:
        self.buffer: list[dict] = []
        self.max_ts = -1
        self.last_seen = 0.0  # processing time of the last delivery, ms
        self.next_offset = 0  # the offset after the last delivery
        self.committed = -1


partitions: dict[int, Partition] = {}
frontier = -1  # ts of the last emitted reading
emitted = 0
dropped = 0


def now_ms() -> float:
    return time.time() * 1000


def stats() -> dict:
    # TODO: emitted, dropped, and how many readings sit in the buffers right now
    return {"emitted": 0, "dropped": 0, "buffered": 0}


def watermark() -> int:
    # TODO: min newest ts over partitions delivered within IDLE_MS; all idle → the highest ts seen
    raise NotImplementedError


def flush(emit) -> None:
    # TODO: threshold = watermark() - LATENESS_MS; pull every buffered reading at or below it,
    # sort by (ts, partition, offset), emit, move the frontier, then commit()
    raise NotImplementedError


def commit() -> None:
    # TODO: per partition the lowest buffered offset (or next_offset when empty); send only changes
    raise NotImplementedError


def run(emit) -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is not None and not msg.error():
            reading = json.loads(msg.value())
            # TODO: update the partition (next_offset, last_seen, max_ts);
            # drop below the frontier (count it) or buffer {sensor, ts, partition, offset}
            raise NotImplementedError
        # TODO: flush(emit) — on empty polls too, or an idle partition is never released
`,
      solution: `import json
import time

from confluent_kafka import Consumer, TopicPartition

TOPIC = "sensor-readings"
GROUP = "merger"
LATENESS_MS = 2000
IDLE_MS = 10000

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC])


class Partition:
    """What the merger knows about one partition: pending readings and how far it has come."""

    def __init__(self) -> None:
        self.buffer: list[dict] = []
        self.max_ts = -1
        self.last_seen = 0.0  # processing time of the last delivery, ms
        self.next_offset = 0  # the offset after the last delivery
        self.committed = -1


partitions: dict[int, Partition] = {}
frontier = -1  # ts of the last emitted reading
emitted = 0
dropped = 0


def now_ms() -> float:
    return time.time() * 1000


def stats() -> dict:
    return {"emitted": emitted, "dropped": dropped, "buffered": sum(len(p.buffer) for p in partitions.values())}


def watermark() -> int:
    now = now_ms()
    active = [p.max_ts for p in partitions.values() if now - p.last_seen < IDLE_MS]
    if active:
        return min(active)
    return max((p.max_ts for p in partitions.values()), default=-1)


def flush(emit) -> None:
    global frontier, emitted
    threshold = watermark() - LATENESS_MS
    due = []
    for p in partitions.values():
        due.extend(r for r in p.buffer if r["ts"] <= threshold)
        p.buffer = [r for r in p.buffer if r["ts"] > threshold]
    if not due:
        return
    due.sort(key=lambda r: (r["ts"], r["partition"], r["offset"]))
    for reading in due:
        emit(reading)
        frontier = reading["ts"]
        emitted += 1
    commit()


def commit() -> None:
    offsets = []
    for partition, p in partitions.items():
        safe = min((r["offset"] for r in p.buffer), default=p.next_offset)
        if safe != p.committed:
            p.committed = safe
            offsets.append(TopicPartition(TOPIC, partition, safe))
    if offsets:
        consumer.commit(offsets=offsets, asynchronous=False)


def run(emit) -> None:
    global dropped
    while True:
        msg = consumer.poll(1.0)
        if msg is not None and not msg.error():
            reading = json.loads(msg.value())
            ts = int(reading["ts"])
            p = partitions.setdefault(msg.partition(), Partition())
            p.next_offset = msg.offset() + 1
            p.last_seen = now_ms()
            p.max_ts = max(p.max_ts, ts)
            if ts < frontier:
                dropped += 1
            else:
                p.buffer.append({"sensor": reading["sensor"], "ts": ts, "partition": msg.partition(), "offset": msg.offset()})
        flush(emit)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'sensor-readings';
export const GROUP = 'merger';
export const LATENESS_MS = 2000;
export const IDLE_MS = 10000;
const FLUSH_EVERY_MS = 1000;

const kafka = new Kafka({clientId: 'merger', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});

export interface Reading {
  sensor: string;
  ts: number;
  partition: number;
  offset: number;
}

/** What the merger knows about one partition: pending readings and how far it has come. */
interface PartitionState {
  buffer: Reading[];
  maxTs: number;
  /** Processing time of the last delivery, ms. */
  lastSeen: number;
  /** The offset after the last delivery. */
  nextOffset: number;
  committed: number;
}

const partitions = new Map<number, PartitionState>();
/** ts of the last emitted reading. */
let frontier = -1;
let emitted = 0;
let dropped = 0;

export function stats(): {emitted: number; dropped: number; buffered: number} {
  // TODO: emitted, dropped, and how many readings sit in the buffers right now
  return {emitted: 0, dropped: 0, buffered: 0};
}

function watermark(): number {
  // TODO: min newest ts over partitions delivered within IDLE_MS; all idle → the highest ts seen
  throw new Error('not implemented');
}

async function flush(emit: (reading: Reading) => void): Promise<void> {
  // TODO: threshold = watermark() - LATENESS_MS; pull every buffered reading at or below it,
  // sort by (ts, partition, offset), emit, move the frontier, then commit()
  throw new Error('not implemented');
}

async function commit(): Promise<void> {
  // TODO: per partition the lowest buffered offset (or nextOffset when empty); send only changes
  throw new Error('not implemented');
}

export async function run(emit: (reading: Reading) => void): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  // TODO: flush every FLUSH_EVERY_MS as well, or an idle partition is never released
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({partition, message}) => {
      const reading = JSON.parse(message.value?.toString() ?? '') as {sensor: string; ts: number};
      // TODO: update the partition (nextOffset, lastSeen, maxTs);
      // drop below the frontier (count it) or buffer {sensor, ts, partition, offset}; then flush
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const TOPIC = 'sensor-readings';
export const GROUP = 'merger';
export const LATENESS_MS = 2000;
export const IDLE_MS = 10000;
const FLUSH_EVERY_MS = 1000;

const kafka = new Kafka({clientId: 'merger', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});

export interface Reading {
  sensor: string;
  ts: number;
  partition: number;
  offset: number;
}

/** What the merger knows about one partition: pending readings and how far it has come. */
interface PartitionState {
  buffer: Reading[];
  maxTs: number;
  /** Processing time of the last delivery, ms. */
  lastSeen: number;
  /** The offset after the last delivery. */
  nextOffset: number;
  committed: number;
}

const partitions = new Map<number, PartitionState>();
/** ts of the last emitted reading. */
let frontier = -1;
let emitted = 0;
let dropped = 0;

export function stats(): {emitted: number; dropped: number; buffered: number} {
  let buffered = 0;
  for (const p of partitions.values()) buffered += p.buffer.length;
  return {emitted, dropped, buffered};
}

function watermark(): number {
  const now = Date.now();
  let active = -1;
  let newest = -1;
  let anyActive = false;
  for (const p of partitions.values()) {
    newest = Math.max(newest, p.maxTs);
    if (now - p.lastSeen >= IDLE_MS) continue;
    active = anyActive ? Math.min(active, p.maxTs) : p.maxTs;
    anyActive = true;
  }
  return anyActive ? active : newest;
}

async function flush(emit: (reading: Reading) => void): Promise<void> {
  const threshold = watermark() - LATENESS_MS;
  const due: Reading[] = [];
  for (const p of partitions.values()) {
    due.push(...p.buffer.filter(r => r.ts <= threshold));
    p.buffer = p.buffer.filter(r => r.ts > threshold);
  }
  if (due.length === 0) return;
  due.sort((a, b) => a.ts - b.ts || a.partition - b.partition || a.offset - b.offset);
  for (const reading of due) {
    emit(reading);
    frontier = reading.ts;
    emitted += 1;
  }
  await commit();
}

async function commit(): Promise<void> {
  const offsets: {topic: string; partition: number; offset: string}[] = [];
  for (const [partition, p] of partitions) {
    const safe = p.buffer.length === 0 ? p.nextOffset : Math.min(...p.buffer.map(r => r.offset));
    if (safe === p.committed) continue;
    p.committed = safe;
    offsets.push({topic: TOPIC, partition, offset: String(safe)});
  }
  if (offsets.length > 0) await consumer.commitOffsets(offsets);
}

export async function run(emit: (reading: Reading) => void): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  const timer = setInterval(() => void flush(emit), FLUSH_EVERY_MS);
  try {
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({partition, message}) => {
        const reading = JSON.parse(message.value?.toString() ?? '') as {sensor: string; ts: number};
        const offset = Number(message.offset);
        let p = partitions.get(partition);
        if (p === undefined) {
          p = {buffer: [], maxTs: -1, lastSeen: 0, nextOffset: 0, committed: -1};
          partitions.set(partition, p);
        }
        p.nextOffset = offset + 1;
        p.lastSeen = Date.now();
        p.maxTs = Math.max(p.maxTs, reading.ts);
        if (reading.ts < frontier) dropped += 1;
        else p.buffer.push({sensor: reading.sensor, ts: reading.ts, partition, offset});
        await flush(emit);
      },
    });
  } finally {
    clearInterval(timer);
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
	"sort"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	Topic      = "sensor-readings"
	Group      = "merger"
	LatenessMs = 2000
	IdleMs     = 10000
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: Group,
	Topic:   Topic,
})

type Reading struct {
	Sensor    string \`json:"sensor"\`
	Ts        int64  \`json:"ts"\`
	Partition int    \`json:"partition"\`
	Offset    int64  \`json:"offset"\`
}

type Stats struct {
	Emitted, Dropped, Buffered int
}

// partition is what the merger knows about one partition: pending readings and how far it has come.
type partition struct {
	buffer     []Reading
	maxTs      int64
	lastSeen   int64 // processing time of the last delivery, ms
	nextOffset int64 // the offset after the last delivery
	committed  int64
}

var (
	partitions       = map[int]*partition{}
	frontier   int64 = -1 // ts of the last emitted reading
	emitted    int
	dropped    int
)

func nowMs() int64 { return time.Now().UnixMilli() }

func GetStats() Stats {
	// TODO: emitted, dropped, and how many readings sit in the buffers right now
	return Stats{}
}

func watermark() int64 {
	// TODO: min newest ts over partitions delivered within IdleMs; all idle → the highest ts seen
	panic("not implemented")
}

func flush(ctx context.Context, emit func(Reading)) error {
	// TODO: threshold = watermark() - LatenessMs; pull every buffered reading at or below it,
	// sort by (ts, partition, offset), emit, move the frontier, then commit
	_ = sort.Slice
	panic("not implemented")
}

func commit(ctx context.Context) error {
	// TODO: per partition the lowest buffered offset (or nextOffset when empty); send only changes
	panic("not implemented")
}

func Run(ctx context.Context, emit func(Reading)) error {
	for {
		fetchCtx, cancel := context.WithTimeout(ctx, time.Second)
		msg, err := reader.FetchMessage(fetchCtx)
		cancel()
		if err == nil {
			var in struct {
				Sensor string \`json:"sensor"\`
				Ts     int64  \`json:"ts"\`
			}
			if err := json.Unmarshal(msg.Value, &in); err != nil {
				return err
			}
			// TODO: update the partition (nextOffset, lastSeen, maxTs);
			// drop below the frontier (count it) or buffer the reading
			panic("not implemented")
		} else if !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		// TODO: flush — on empty fetches too, or an idle partition is never released
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	Topic      = "sensor-readings"
	Group      = "merger"
	LatenessMs = 2000
	IdleMs     = 10000
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: Group,
	Topic:   Topic,
})

type Reading struct {
	Sensor    string \`json:"sensor"\`
	Ts        int64  \`json:"ts"\`
	Partition int    \`json:"partition"\`
	Offset    int64  \`json:"offset"\`
}

type Stats struct {
	Emitted, Dropped, Buffered int
}

// partition is what the merger knows about one partition: pending readings and how far it has come.
type partition struct {
	buffer     []Reading
	maxTs      int64
	lastSeen   int64 // processing time of the last delivery, ms
	nextOffset int64 // the offset after the last delivery
	committed  int64
}

var (
	partitions       = map[int]*partition{}
	frontier   int64 = -1 // ts of the last emitted reading
	emitted    int
	dropped    int
)

func nowMs() int64 { return time.Now().UnixMilli() }

func GetStats() Stats {
	buffered := 0
	for _, p := range partitions {
		buffered += len(p.buffer)
	}
	return Stats{Emitted: emitted, Dropped: dropped, Buffered: buffered}
}

func watermark() int64 {
	now := nowMs()
	var active, newest int64 = -1, -1
	anyActive := false
	for _, p := range partitions {
		if p.maxTs > newest {
			newest = p.maxTs
		}
		if now-p.lastSeen >= IdleMs {
			continue
		}
		if !anyActive || p.maxTs < active {
			active = p.maxTs
		}
		anyActive = true
	}
	if anyActive {
		return active
	}
	return newest
}

func flush(ctx context.Context, emit func(Reading)) error {
	threshold := watermark() - LatenessMs
	var due []Reading
	for _, p := range partitions {
		var kept []Reading
		for _, r := range p.buffer {
			if r.Ts <= threshold {
				due = append(due, r)
			} else {
				kept = append(kept, r)
			}
		}
		p.buffer = kept
	}
	if len(due) == 0 {
		return nil
	}
	sort.Slice(due, func(i, j int) bool {
		a, b := due[i], due[j]
		if a.Ts != b.Ts {
			return a.Ts < b.Ts
		}
		if a.Partition != b.Partition {
			return a.Partition < b.Partition
		}
		return a.Offset < b.Offset
	})
	for _, r := range due {
		emit(r)
		frontier = r.Ts
		emitted++
	}
	return commit(ctx)
}

func commit(ctx context.Context) error {
	var msgs []kafka.Message
	for part, p := range partitions {
		safe := p.nextOffset
		for _, r := range p.buffer {
			if r.Offset < safe {
				safe = r.Offset
			}
		}
		if safe == p.committed || safe == 0 {
			continue
		}
		p.committed = safe
		// kafka-go commits the offset after the message it is given: Offset safe-1 commits safe.
		msgs = append(msgs, kafka.Message{Topic: Topic, Partition: part, Offset: safe - 1})
	}
	if len(msgs) == 0 {
		return nil
	}
	return reader.CommitMessages(ctx, msgs...)
}

func Run(ctx context.Context, emit func(Reading)) error {
	for {
		fetchCtx, cancel := context.WithTimeout(ctx, time.Second)
		msg, err := reader.FetchMessage(fetchCtx)
		cancel()
		if err == nil {
			var in struct {
				Sensor string \`json:"sensor"\`
				Ts     int64  \`json:"ts"\`
			}
			if err := json.Unmarshal(msg.Value, &in); err != nil {
				return err
			}
			p := partitions[msg.Partition]
			if p == nil {
				p = &partition{maxTs: -1, committed: -1}
				partitions[msg.Partition] = p
			}
			p.nextOffset = msg.Offset + 1
			p.lastSeen = nowMs()
			if in.Ts > p.maxTs {
				p.maxTs = in.Ts
			}
			if in.Ts < frontier {
				dropped++
			} else {
				p.buffer = append(p.buffer, Reading{Sensor: in.Sensor, Ts: in.Ts, Partition: msg.Partition, Offset: msg.Offset})
			}
		} else if !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		if err := flush(ctx, emit); err != nil {
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
import scala.collection.mutable
import scala.jdk.CollectionConverters._

object Merger {
  val Topic = "sensor-readings"
  val Group = "merger"
  val LatenessMs = 2000L
  val IdleMs = 10000L

  case class Reading(sensor: String, ts: Long, partition: Int, offset: Long)
  case class Stats(emitted: Int, dropped: Int, buffered: Int)

  /** What the merger knows about one partition: pending readings and how far it has come. */
  private class Partition {
    var buffer = Vector.empty[Reading]
    var maxTs = -1L
    var lastSeen = 0L // processing time of the last delivery, ms
    var nextOffset = 0L // the offset after the last delivery
    var committed = -1L
  }

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", Group)
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  private val SensorField = """"sensor"\\s*:\\s*"([^"]+)"""".r
  private val TsField = """"ts"\\s*:\\s*(\\d+)""".r

  private val partitions = mutable.Map.empty[Int, Partition]
  private var frontier = -1L // ts of the last emitted reading
  private var emitted = 0
  private var dropped = 0

  def stats(): Stats = Stats(0, 0, 0) // TODO: emitted, dropped, readings in the buffers right now

  private def watermark(): Long =
    // TODO: min newest ts over partitions delivered within IdleMs; all idle → the highest ts seen
    throw new NotImplementedError

  private def flush(emit: Reading => Unit): Unit =
    // TODO: threshold = watermark() - LatenessMs; pull every buffered reading at or below it,
    // sort by (ts, partition, offset), emit, move the frontier, then commit()
    throw new NotImplementedError

  private def commit(): Unit =
    // TODO: per partition the lowest buffered offset (or nextOffset when empty); send only changes
    throw new NotImplementedError

  def run(emit: Reading => Unit): Unit =
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val sensor = SensorField.findFirstMatchIn(record.value()).map(_.group(1)).getOrElse("")
        val ts = TsField.findFirstMatchIn(record.value()).map(_.group(1).toLong).getOrElse(-1L)
        // TODO: update the partition (nextOffset, lastSeen, maxTs);
        // drop below the frontier (count it) or buffer the reading
        throw new NotImplementedError
      }
      // TODO: flush(emit) — on empty polls too, or an idle partition is never released
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

object Merger {
  val Topic = "sensor-readings"
  val Group = "merger"
  val LatenessMs = 2000L
  val IdleMs = 10000L

  case class Reading(sensor: String, ts: Long, partition: Int, offset: Long)
  case class Stats(emitted: Int, dropped: Int, buffered: Int)

  /** What the merger knows about one partition: pending readings and how far it has come. */
  private class Partition {
    var buffer = Vector.empty[Reading]
    var maxTs = -1L
    var lastSeen = 0L // processing time of the last delivery, ms
    var nextOffset = 0L // the offset after the last delivery
    var committed = -1L
  }

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", Group)
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  private val SensorField = """"sensor"\\s*:\\s*"([^"]+)"""".r
  private val TsField = """"ts"\\s*:\\s*(\\d+)""".r

  private val partitions = mutable.Map.empty[Int, Partition]
  private var frontier = -1L // ts of the last emitted reading
  private var emitted = 0
  private var dropped = 0

  def stats(): Stats = Stats(emitted, dropped, partitions.values.map(_.buffer.size).sum)

  private def watermark(): Long = {
    val now = System.currentTimeMillis()
    val active = partitions.values.filter(p => now - p.lastSeen < IdleMs).map(_.maxTs)
    if (active.nonEmpty) active.min else partitions.values.map(_.maxTs).maxOption.getOrElse(-1L)
  }

  private def flush(emit: Reading => Unit): Unit = {
    val threshold = watermark() - LatenessMs
    val due = mutable.ArrayBuffer.empty[Reading]
    partitions.values.foreach { p =>
      val (ready, kept) = p.buffer.partition(_.ts <= threshold)
      due ++= ready
      p.buffer = kept
    }
    if (due.isEmpty) return
    due.sortBy(r => (r.ts, r.partition, r.offset)).foreach { r =>
      emit(r)
      frontier = r.ts
      emitted += 1
    }
    commit()
  }

  private def commit(): Unit = {
    val offsets = partitions.flatMap { case (partition, p) =>
      val safe = if (p.buffer.isEmpty) p.nextOffset else p.buffer.map(_.offset).min
      if (safe == p.committed) None
      else {
        p.committed = safe
        Some(new TopicPartition(Topic, partition) -> new OffsetAndMetadata(safe))
      }
    }
    if (offsets.nonEmpty) consumer.commitSync(offsets.toMap.asJava)
  }

  def run(emit: Reading => Unit): Unit =
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val sensor = SensorField.findFirstMatchIn(record.value()).map(_.group(1)).getOrElse("")
        val ts = TsField.findFirstMatchIn(record.value()).map(_.group(1).toLong).getOrElse(-1L)
        val p = partitions.getOrElseUpdate(record.partition(), new Partition)
        p.nextOffset = record.offset() + 1
        p.lastSeen = System.currentTimeMillis()
        p.maxTs = math.max(p.maxTs, ts)
        if (ts < frontier) dropped += 1
        else p.buffer = p.buffer :+ Reading(sensor, ts, record.partition(), record.offset())
      }
      flush(emit)
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
#include <iostream>
#include <map>
#include <memory>
#include <regex>
#include <string>
#include <tuple>
#include <vector>

const std::string kTopic = "sensor-readings";
const std::string kGroup = "merger";
const int64_t kLatenessMs = 2000;
const int64_t kIdleMs = 10000;

struct Reading {
  std::string sensor;
  int64_t ts;
  int partition;
  int64_t offset;
};

struct Stats {
  int emitted;
  int dropped;
  int buffered;
};

// What the merger knows about one partition: pending readings and how far it has come.
struct Partition {
  std::vector<Reading> buffer;
  int64_t max_ts = -1;
  int64_t last_seen = 0;    // processing time of the last delivery, ms
  int64_t next_offset = 0;  // the offset after the last delivery
  int64_t committed = -1;
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
const std::regex kSensorField(R"re("sensor"\\s*:\\s*"([^"]+)")re");
const std::regex kTsField(R"("ts"\\s*:\\s*(\\d+))");

std::map<int, Partition> partitions;
int64_t frontier = -1;  // ts of the last emitted reading
int emitted = 0;
int dropped = 0;

int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

Stats stats() {
  // TODO: emitted, dropped, and how many readings sit in the buffers right now
  return Stats{0, 0, 0};
}

int64_t watermark() {
  // TODO: min newest ts over partitions delivered within kIdleMs; all idle → the highest ts seen
  throw std::logic_error("not implemented");
}

void commit() {
  // TODO: per partition the lowest buffered offset (or next_offset when empty); send only changes
  throw std::logic_error("not implemented");
}

void flush(const std::function<void(const Reading&)>& emit) {
  // TODO: threshold = watermark() - kLatenessMs; pull every buffered reading at or below it,
  // sort by (ts, partition, offset), emit, move the frontier, then commit()
  throw std::logic_error("not implemented");
}

void run(const std::function<void(const Reading&)>& emit) {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR_NO_ERROR) {
      const std::string value(static_cast<const char*>(msg->payload()), msg->len());
      std::smatch sensor, ts;
      std::regex_search(value, sensor, kSensorField);
      std::regex_search(value, ts, kTsField);
      // TODO: update the partition (next_offset, last_seen, max_ts);
      // drop below the frontier (count it) or buffer the reading
      throw std::logic_error("not implemented");
    } else if (msg->err() != RdKafka::ERR__TIMED_OUT) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
    }
    // TODO: flush(emit) — on timeouts too, or an idle partition is never released
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <regex>
#include <string>
#include <tuple>
#include <vector>

const std::string kTopic = "sensor-readings";
const std::string kGroup = "merger";
const int64_t kLatenessMs = 2000;
const int64_t kIdleMs = 10000;

struct Reading {
  std::string sensor;
  int64_t ts;
  int partition;
  int64_t offset;
};

struct Stats {
  int emitted;
  int dropped;
  int buffered;
};

// What the merger knows about one partition: pending readings and how far it has come.
struct Partition {
  std::vector<Reading> buffer;
  int64_t max_ts = -1;
  int64_t last_seen = 0;    // processing time of the last delivery, ms
  int64_t next_offset = 0;  // the offset after the last delivery
  int64_t committed = -1;
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
const std::regex kSensorField(R"re("sensor"\\s*:\\s*"([^"]+)")re");
const std::regex kTsField(R"("ts"\\s*:\\s*(\\d+))");

std::map<int, Partition> partitions;
int64_t frontier = -1;  // ts of the last emitted reading
int emitted = 0;
int dropped = 0;

int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

Stats stats() {
  int buffered = 0;
  for (const auto& [partition, p] : partitions) buffered += static_cast<int>(p.buffer.size());
  return Stats{emitted, dropped, buffered};
}

int64_t watermark() {
  const int64_t now = now_ms();
  int64_t active = -1;
  int64_t newest = -1;
  bool any_active = false;
  for (const auto& [partition, p] : partitions) {
    newest = std::max(newest, p.max_ts);
    if (now - p.last_seen >= kIdleMs) continue;
    active = any_active ? std::min(active, p.max_ts) : p.max_ts;
    any_active = true;
  }
  return any_active ? active : newest;
}

void commit() {
  std::vector<RdKafka::TopicPartition*> offsets;
  for (auto& [partition, p] : partitions) {
    int64_t safe = p.next_offset;
    for (const auto& r : p.buffer) safe = std::min(safe, r.offset);
    if (safe == p.committed) continue;
    p.committed = safe;
    offsets.push_back(RdKafka::TopicPartition::create(kTopic, partition, safe));
  }
  if (offsets.empty()) return;
  consumer->commitSync(offsets);
  RdKafka::TopicPartition::destroy(offsets);
}

void flush(const std::function<void(const Reading&)>& emit) {
  const int64_t threshold = watermark() - kLatenessMs;
  std::vector<Reading> due;
  for (auto& [partition, p] : partitions) {
    std::vector<Reading> kept;
    for (const auto& r : p.buffer) (r.ts <= threshold ? due : kept).push_back(r);
    p.buffer = std::move(kept);
  }
  if (due.empty()) return;
  std::sort(due.begin(), due.end(), [](const Reading& a, const Reading& b) {
    return std::tie(a.ts, a.partition, a.offset) < std::tie(b.ts, b.partition, b.offset);
  });
  for (const auto& r : due) {
    emit(r);
    frontier = r.ts;
    ++emitted;
  }
  commit();
}

void run(const std::function<void(const Reading&)>& emit) {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR_NO_ERROR) {
      const std::string value(static_cast<const char*>(msg->payload()), msg->len());
      std::smatch sensor, ts_match;
      std::regex_search(value, sensor, kSensorField);
      std::regex_search(value, ts_match, kTsField);
      const int64_t ts = std::stoll(ts_match[1].str());
      Partition& p = partitions[msg->partition()];
      p.next_offset = msg->offset() + 1;
      p.last_seen = now_ms();
      p.max_ts = std::max(p.max_ts, ts);
      if (ts < frontier) {
        ++dropped;
      } else {
        p.buffer.push_back(Reading{sensor[1].str(), ts, msg->partition(), msg->offset()});
      }
    } else if (msg->err() != RdKafka::ERR__TIMED_OUT) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
    }
    flush(emit);
  }
}
`,
    },
  },
  harness: {
    python: `import json
import time

TOPIC = "sensor-readings"
GROUP = "merger"


def seed(ctx, partition, *stamps):
    """Readings of sensor s{partition} on that partition, in this order (6 partitions, like production)."""
    ctx.kafka.create_topic(TOPIC, 6)
    for ts in stamps:
        ctx.kafka.seed(TOPIC, key=f"s{partition}", value=json.dumps({"sensor": f"s{partition}", "ts": ts}), partition=partition)


def reading(ctx, partition, ts):
    ctx.kafka.seed(TOPIC, key=f"s{partition}", value=json.dumps({"sensor": f"s{partition}", "ts": ts}), partition=partition)


def stamps(emitted):
    return [r["ts"] for r in emitted]


def check_in_order(ctx):
    order = [3, 0, 5, 1, 4, 2]
    seeded = []
    for partition in range(6):
        series = [1000 * (1 + order[partition] + 6 * i) for i in range(5)]
        if partition == 4:
            series[0] = 3000  # a tie with partition 5's first reading
        seed(ctx, partition, *series)
        seeded += [(ts, partition, i) for i, ts in enumerate(series)]
    m = ctx.load("merger")
    emitted = []
    ctx.drain(m.run, emitted.append)
    got = [(r["ts"], r["partition"], r["offset"]) for r in emitted]
    assert got, "nothing was emitted: 30 readings over six partitions, the slowest partition reaching 25000, must release everything up to 23000"
    assert stamps(emitted) == sorted(stamps(emitted)), f"the emitted ts must be non-decreasing; got {stamps(emitted)}"
    # partition 1 tops out at 25000: watermark 25000, threshold 23000
    want = sorted(t for t in seeded if t[0] <= 23000)
    assert got == want, f"emitted (ts, partition, offset) must be exactly the readings with ts <= 23000 in (ts, partition, offset) order; got {got}, expected {want}"
    assert all(r["sensor"] == f"s{r['partition']}" for r in emitted), "each emitted reading must carry the sensor from its payload"
    s = m.stats()
    assert s["emitted"] == 23 and s["buffered"] == 7 and s["dropped"] == 0, f"stats() must report emitted 23, buffered 7, dropped 0; got {s}"


def check_watermark_gates(ctx):
    seed(ctx, 0, 1000, 5000, 9000)
    seed(ctx, 1, 3000, 7000, 11000)
    seed(ctx, 2, 20000)
    m = ctx.load("merger")
    emitted = []
    ctx.drain(m.run, emitted.append)
    assert stamps(emitted) == [1000, 3000, 5000, 7000], f"the watermark is 9000 (partition 0's newest; partition 2 at 20000 does not pull it up) and the threshold 7000: expected emits [1000, 3000, 5000, 7000], got {stamps(emitted)}"
    s = m.stats()
    assert s["buffered"] == 3, f"9000, 11000 and 20000 must stay buffered until the slowest partition passes them: stats().buffered is {s['buffered']}, expected 3"
    assert s["emitted"] == 4 and s["dropped"] == 0, f"stats() must report emitted 4, dropped 0; got {s}"


def check_late_dropped(ctx):
    seed(ctx, 0, 1000, 5000, 9000)
    seed(ctx, 1, 3000, 7000, 11000)
    m = ctx.load("merger")
    emitted = []

    def emit(r):
        emitted.append(r)
        if r["ts"] == 5000:
            reading(ctx, 0, 2000)  # lands on partition 0 after the stream has passed 5000

    ctx.drain(m.run, emit)
    assert 2000 not in stamps(emitted), f"a reading with ts 2000 arriving after the frontier reached 5000 must never be emitted; got {stamps(emitted)}"
    assert stamps(emitted) == [1000, 3000, 5000, 7000], f"expected emits [1000, 3000, 5000, 7000], got {stamps(emitted)}"
    s = m.stats()
    assert s["dropped"] == 1, f"stats().dropped must count the late reading: got {s['dropped']}, expected 1"
    assert s["emitted"] == 4 and s["buffered"] == 2, f"stats() must report emitted 4, buffered 2; got {s}"


def check_within_lateness(ctx):
    seed(ctx, 0, 1000, 5000)
    seed(ctx, 1, 1000, 3000)
    m = ctx.load("merger")
    emitted = []

    def emit(r):
        emitted.append(r)
        if (r["ts"], r["partition"], r["offset"]) == (1000, 1, 0):
            # frontier 1000, watermark 3000: 1000 equals the frontier and 4000 is behind partition 0
            # (already at 5000) — both are still in time
            reading(ctx, 1, 1000)
            reading(ctx, 0, 4000)
            reading(ctx, 0, 9000)
            reading(ctx, 1, 11000)

    ctx.drain(m.run, emit)
    assert 4000 in stamps(emitted), f"a reading at 4000 arriving while the frontier is below it is within the lateness allowance and must be emitted, not dropped; got {stamps(emitted)}"
    assert stamps(emitted).count(1000) == 3, f"a reading whose ts equals the frontier (1000) is not late and must be emitted; got {stamps(emitted)}"
    assert stamps(emitted) == [1000, 1000, 1000, 3000, 4000, 5000], f"expected emits [1000, 1000, 1000, 3000, 4000, 5000] (4000 slotted before 5000), got {stamps(emitted)}"
    s = m.stats()
    assert s["dropped"] == 0, f"nothing was late: stats().dropped is {s['dropped']}, expected 0"
    assert s["buffered"] == 2, f"9000 and 11000 must still be buffered; stats().buffered is {s['buffered']}"


def check_idle_partition(ctx):
    seed(ctx, 0, 1000, 5000, 9000, 13000)
    seed(ctx, 1, 3000)
    ctx.kafka.stop_when_drained = False  # the loop keeps polling through the quiet period
    m = ctx.load("merger")
    emitted = []
    at = {}

    def emit(r):
        emitted.append(r)
        at[r["ts"]] = time.time()
        if r["ts"] == 1000:
            # partition 1 goes quiet; 6 s later partition 0 delivers again
            ctx.clock.advance(6)
            reading(ctx, 0, 17000)
        if r["ts"] == 13000:
            ctx.kafka.stop_when_drained = True  # the loop may stop once the topic is drained again

    armed = [True]

    def guard():
        if armed[0] and ctx.clock.offset > 60:
            ctx.kafka.stop_when_drained = True

    ctx.clock.on_advance(guard)
    try:
        ctx.drain(m.run, emit)
    finally:
        armed[0] = False
    assert stamps(emitted)[:1] == [1000], f"before any partition is idle only 1000 is below the threshold; got {stamps(emitted)}"
    assert stamps(emitted) == [1000, 3000, 5000, 9000, 13000], f"after partition 1 was quiet for IDLE_MS while partition 0 kept delivering (newest 17000), 3000, 5000, 9000 and 13000 must be released; got {stamps(emitted)}"
    assert at[3000] - at[1000] >= 9.5, f"3000 was emitted {at[3000] - at[1000]:.1f} s after 1000: an idle partition is released only after IDLE_MS (10 s) without deliveries"
    assert ctx.kafka.committed_offset(GROUP, TOPIC, 0) == 4, f"partition 0 must be committed at 4 (17000 at offset 4 still buffered); got {ctx.kafka.committed_offset(GROUP, TOPIC, 0)}"
    assert ctx.kafka.committed_offset(GROUP, TOPIC, 1) == 1, f"partition 1 must be committed at 1 after 3000 was emitted; got {ctx.kafka.committed_offset(GROUP, TOPIC, 1)}"
    assert m.stats()["buffered"] == 1, f"17000 (within LATENESS_MS of the watermark) must still be buffered; stats().buffered is {m.stats()['buffered']}"


def check_commit_after_emit(ctx):
    seed(ctx, 0, 1000, 5000, 12000, 8000, 13000)
    seed(ctx, 1, 3000, 7000, 11000)
    m = ctx.load("merger")
    emitted = []
    done = set()
    violations = []

    def on_commit(group, offsets):
        for (topic, partition), offset in offsets.items():
            missing = [o for o in range(offset) if (partition, o) not in done]
            if missing:
                violations.append((partition, offset, missing))

    ctx.kafka.on_commit(on_commit)

    def emit(r):
        emitted.append(r)
        done.add((r["partition"], r["offset"]))

    ctx.drain(m.run, emit)
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions and subscriptions[-1][1] == GROUP and TOPIC in subscriptions[-1][2], f"the consumer must join group {GROUP} on {TOPIC}; got {subscriptions}"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, ahead of the output"
    assert ctx.kafka.commits(GROUP), "nothing was ever committed: commit after each flush that emitted"
    assert stamps(emitted) == [1000, 3000, 5000, 7000, 8000], f"expected emits [1000, 3000, 5000, 7000, 8000] (8000 at offset 3 emitted while 12000 at offset 2 waits), got {stamps(emitted)}"
    assert not violations, f"a commit covered a reading that had not been emitted (partition, committed offset, unemitted offsets below it): {violations[0]} — commit the lowest buffered offset, not the highest emitted + 1"
    assert ctx.kafka.committed_offset(GROUP, TOPIC, 0) == 2, f"partition 0 must be committed at 2: 12000 at offset 2 is still buffered although offset 3 was emitted; got {ctx.kafka.committed_offset(GROUP, TOPIC, 0)}"
    assert ctx.kafka.committed_offset(GROUP, TOPIC, 1) == 2, f"partition 1 must be committed at 2 (11000 at offset 2 buffered); got {ctx.kafka.committed_offset(GROUP, TOPIC, 1)}"
`,
    typescript: `const TOPIC = 'sensor-readings';
const GROUP = 'merger';

type Reading = {sensor: string; ts: number; partition: number; offset: number};

/** Readings of sensor s{partition} on that partition, in this order (6 partitions, like production). */
function seed(ctx, partition: number, ...stamps: number[]) {
  ctx.kafka.createTopic(TOPIC, 6);
  for (const ts of stamps) reading(ctx, partition, ts);
}

function reading(ctx, partition: number, ts: number) {
  ctx.kafka.seed(TOPIC, {key: \`s\${partition}\`, value: JSON.stringify({sensor: \`s\${partition}\`, ts}), partition});
}

const stamps = (emitted: Reading[]) => emitted.map(r => r.ts);

export async function check_in_order(ctx) {
  const order = [3, 0, 5, 1, 4, 2];
  const seeded: [number, number, number][] = [];
  for (let partition = 0; partition < 6; partition++) {
    const series = Array.from({length: 5}, (_, i) => 1000 * (1 + order[partition] + 6 * i));
    if (partition === 4) series[0] = 3000; // a tie with partition 5's first reading
    seed(ctx, partition, ...series);
    series.forEach((ts, i) => seeded.push([ts, partition, i]));
  }
  const m = ctx.load('merger');
  const emitted: Reading[] = [];
  await ctx.drain(m.run((r: Reading) => emitted.push(r)));
  const got = emitted.map(r => [r.ts, r.partition, r.offset]);
  assert(got.length > 0, 'nothing was emitted: 30 readings over six partitions, the slowest partition reaching 25000, must release everything up to 23000');
  const ts = stamps(emitted);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), \`the emitted ts must be non-decreasing; got \${JSON.stringify(ts)}\`);
  // partition 1 tops out at 25000: watermark 25000, threshold 23000
  const want = seeded.filter(t => t[0] <= 23000).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  assert.deepEqual(got, want, \`emitted [ts, partition, offset] must be exactly the readings with ts <= 23000 in (ts, partition, offset) order; got \${JSON.stringify(got)}, expected \${JSON.stringify(want)}\`);
  assert(emitted.every(r => r.sensor === \`s\${r.partition}\`), 'each emitted reading must carry the sensor from its payload');
  const s = m.stats();
  assert(s.emitted === 23 && s.buffered === 7 && s.dropped === 0, \`stats() must report emitted 23, buffered 7, dropped 0; got \${JSON.stringify(s)}\`);
}

export async function check_watermark_gates(ctx) {
  seed(ctx, 0, 1000, 5000, 9000);
  seed(ctx, 1, 3000, 7000, 11000);
  seed(ctx, 2, 20000);
  const m = ctx.load('merger');
  const emitted: Reading[] = [];
  await ctx.drain(m.run((r: Reading) => emitted.push(r)));
  assert.deepEqual(stamps(emitted), [1000, 3000, 5000, 7000], \`the watermark is 9000 (partition 0's newest; partition 2 at 20000 does not pull it up) and the threshold 7000: expected emits [1000, 3000, 5000, 7000], got \${JSON.stringify(stamps(emitted))}\`);
  const s = m.stats();
  assert.equal(s.buffered, 3, \`9000, 11000 and 20000 must stay buffered until the slowest partition passes them: stats().buffered is \${s.buffered}, expected 3\`);
  assert(s.emitted === 4 && s.dropped === 0, \`stats() must report emitted 4, dropped 0; got \${JSON.stringify(s)}\`);
}

export async function check_late_dropped(ctx) {
  seed(ctx, 0, 1000, 5000, 9000);
  seed(ctx, 1, 3000, 7000, 11000);
  const m = ctx.load('merger');
  const emitted: Reading[] = [];
  await ctx.drain(
    m.run((r: Reading) => {
      emitted.push(r);
      if (r.ts === 5000) reading(ctx, 0, 2000); // lands on partition 0 after the stream has passed 5000
    }),
  );
  assert(!stamps(emitted).includes(2000), \`a reading with ts 2000 arriving after the frontier reached 5000 must never be emitted; got \${JSON.stringify(stamps(emitted))}\`);
  assert.deepEqual(stamps(emitted), [1000, 3000, 5000, 7000], \`expected emits [1000, 3000, 5000, 7000], got \${JSON.stringify(stamps(emitted))}\`);
  const s = m.stats();
  assert.equal(s.dropped, 1, \`stats().dropped must count the late reading: got \${s.dropped}, expected 1\`);
  assert(s.emitted === 4 && s.buffered === 2, \`stats() must report emitted 4, buffered 2; got \${JSON.stringify(s)}\`);
}

export async function check_within_lateness(ctx) {
  seed(ctx, 0, 1000, 5000);
  seed(ctx, 1, 1000, 3000);
  const m = ctx.load('merger');
  const emitted: Reading[] = [];
  await ctx.drain(
    m.run((r: Reading) => {
      emitted.push(r);
      if (r.ts === 1000 && r.partition === 1 && r.offset === 0) {
        // frontier 1000, watermark 3000: 1000 equals the frontier and 4000 is behind partition 0
        // (already at 5000) — both are still in time
        reading(ctx, 1, 1000);
        reading(ctx, 0, 4000);
        reading(ctx, 0, 9000);
        reading(ctx, 1, 11000);
      }
    }),
  );
  assert(stamps(emitted).includes(4000), \`a reading at 4000 arriving while the frontier is below it is within the lateness allowance and must be emitted, not dropped; got \${JSON.stringify(stamps(emitted))}\`);
  assert.equal(stamps(emitted).filter(ts => ts === 1000).length, 3, \`a reading whose ts equals the frontier (1000) is not late and must be emitted; got \${JSON.stringify(stamps(emitted))}\`);
  assert.deepEqual(stamps(emitted), [1000, 1000, 1000, 3000, 4000, 5000], \`expected emits [1000, 1000, 1000, 3000, 4000, 5000] (4000 slotted before 5000), got \${JSON.stringify(stamps(emitted))}\`);
  const s = m.stats();
  assert.equal(s.dropped, 0, \`nothing was late: stats().dropped is \${s.dropped}, expected 0\`);
  assert.equal(s.buffered, 2, \`9000 and 11000 must still be buffered; stats().buffered is \${s.buffered}\`);
}

export async function check_idle_partition(ctx) {
  seed(ctx, 0, 1000, 5000, 9000, 13000);
  seed(ctx, 1, 3000);
  ctx.kafka.stopWhenDrained = false; // the consumer keeps polling through the quiet period
  const m = ctx.load('merger');
  const emitted: Reading[] = [];
  const at = new Map<number, number>();
  await ctx.drain(
    m.run((r: Reading) => {
      emitted.push(r);
      at.set(r.ts, ctx.clock.now());
      // partition 1 goes quiet; 6 s later (virtual) partition 0 delivers again
      if (r.ts === 1000) setTimeout(() => reading(ctx, 0, 17000), 6000);
      if (r.ts === 13000) ctx.kafka.stopWhenDrained = true; // the loop may stop once the topic is drained again
    }),
  );
  assert.deepEqual(stamps(emitted).slice(0, 1), [1000], \`before any partition is idle only 1000 is below the threshold; got \${JSON.stringify(stamps(emitted))}\`);
  assert.deepEqual(stamps(emitted), [1000, 3000, 5000, 9000, 13000], \`after partition 1 was quiet for IDLE_MS while partition 0 kept delivering (newest 17000), 3000, 5000, 9000 and 13000 must be released; got \${JSON.stringify(stamps(emitted))}\`);
  const waited = (at.get(3000) ?? 0) - (at.get(1000) ?? 0);
  assert(waited >= 9500, \`3000 was emitted \${(waited / 1000).toFixed(1)} s after 1000: an idle partition is released only after IDLE_MS (10 s) without deliveries\`);
  assert.equal(ctx.kafka.committedOffset(GROUP, TOPIC, 0), 4, \`partition 0 must be committed at 4 (17000 at offset 4 still buffered); got \${ctx.kafka.committedOffset(GROUP, TOPIC, 0)}\`);
  assert.equal(ctx.kafka.committedOffset(GROUP, TOPIC, 1), 1, \`partition 1 must be committed at 1 after 3000 was emitted; got \${ctx.kafka.committedOffset(GROUP, TOPIC, 1)}\`);
  assert.equal(m.stats().buffered, 1, \`17000 (within LATENESS_MS of the watermark) must still be buffered; stats().buffered is \${m.stats().buffered}\`);
}

export async function check_commit_after_emit(ctx) {
  seed(ctx, 0, 1000, 5000, 12000, 8000, 13000);
  seed(ctx, 1, 3000, 7000, 11000);
  const m = ctx.load('merger');
  const emitted: Reading[] = [];
  const done = new Set<string>();
  const violations: [number, number, number[]][] = [];
  ctx.kafka.onCommit((group: string, offsets: Map<string, number>) => {
    for (const [tp, offset] of offsets) {
      const partition = Number(tp.split('|')[1]);
      const missing = Array.from({length: offset}, (_, o) => o).filter(o => !done.has(\`\${partition}|\${o}\`));
      if (missing.length > 0) violations.push([partition, offset, missing]);
    }
  });
  await ctx.drain(
    m.run((r: Reading) => {
      emitted.push(r);
      done.add(\`\${r.partition}|\${r.offset}\`);
    }),
  );
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0 && subscriptions[subscriptions.length - 1][1] === GROUP && subscriptions[subscriptions.length - 1][2].includes(TOPIC), \`the consumer must join group \${GROUP} on \${TOPIC}; got \${JSON.stringify(subscriptions)}\`);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, ahead of the output');
  assert(ctx.kafka.commits(GROUP).length > 0, 'nothing was ever committed: commit after each flush that emitted');
  assert.deepEqual(stamps(emitted), [1000, 3000, 5000, 7000, 8000], \`expected emits [1000, 3000, 5000, 7000, 8000] (8000 at offset 3 emitted while 12000 at offset 2 waits), got \${JSON.stringify(stamps(emitted))}\`);
  assert.equal(violations.length, 0, \`a commit covered a reading that had not been emitted (partition, committed offset, unemitted offsets below it): \${JSON.stringify(violations[0])} — commit the lowest buffered offset, not the highest emitted + 1\`);
  assert.equal(ctx.kafka.committedOffset(GROUP, TOPIC, 0), 2, \`partition 0 must be committed at 2: 12000 at offset 2 is still buffered although offset 3 was emitted; got \${ctx.kafka.committedOffset(GROUP, TOPIC, 0)}\`);
  assert.equal(ctx.kafka.committedOffset(GROUP, TOPIC, 1), 2, \`partition 1 must be committed at 2 (11000 at offset 2 buffered); got \${ctx.kafka.committedOffset(GROUP, TOPIC, 1)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"leetbuild/harness"
)

// omSeed puts readings of sensor s{part} on that partition, in this order (6 partitions, like production).
func omSeed(ctx *harness.Ctx, part int, stamps ...int64) {
	ctx.Kafka.CreateTopic(Topic, 6)
	for _, ts := range stamps {
		omReading(ctx, part, ts)
	}
}

func omReading(ctx *harness.Ctx, part int, ts int64) {
	value, _ := json.Marshal(map[string]any{"sensor": fmt.Sprintf("s%d", part), "ts": ts})
	ctx.Kafka.SeedPartition(Topic, part, fmt.Sprintf("s%d", part), string(value))
}

// omDrain runs the learner's loop with emit; the loop ends when stop is called, and by itself
// quiet after it started when quiet > 0 (the TypeScript consumer stops once the topic is drained).
func omDrain(ctx *harness.Ctx, quiet time.Duration, emit func(r Reading, stop func())) {
	runCtx, stop := context.WithCancel(context.Background())
	defer stop()
	if quiet > 0 {
		time.AfterFunc(quiet, stop)
	}
	ctx.Drain(func() { Run(runCtx, func(r Reading) { emit(r, stop) }) })
}

// omCollect drains the loop for 3 s of silence and returns what it emitted.
func omCollect(ctx *harness.Ctx, also func(r Reading)) []Reading {
	var emitted []Reading
	omDrain(ctx, 3*time.Second, func(r Reading, _ func()) {
		emitted = append(emitted, r)
		if also != nil {
			also(r)
		}
	})
	return emitted
}

func omStamps(emitted []Reading) []int64 {
	out := []int64{}
	for _, r := range emitted {
		out = append(out, r.Ts)
	}
	return out
}

func CheckInOrder(ctx *harness.Ctx) {
	order := []int64{3, 0, 5, 1, 4, 2}
	seeded := [][3]int64{}
	for part := 0; part < 6; part++ {
		series := []int64{}
		for i := int64(0); i < 5; i++ {
			series = append(series, 1000*(1+order[part]+6*i))
		}
		if part == 4 {
			series[0] = 3000 // a tie with partition 5's first reading
		}
		omSeed(ctx, part, series...)
		for i, ts := range series {
			seeded = append(seeded, [3]int64{ts, int64(part), int64(i)})
		}
	}
	emitted := omCollect(ctx, nil)
	got := [][3]int64{}
	for _, r := range emitted {
		got = append(got, [3]int64{r.Ts, int64(r.Partition), r.Offset})
	}
	ctx.Assert(len(got) > 0, "nothing was emitted: 30 readings over six partitions, the slowest partition reaching 25000, must release everything up to 23000")
	ts := omStamps(emitted)
	ctx.Assert(sort.SliceIsSorted(ts, func(i, j int) bool { return ts[i] < ts[j] }), "the emitted ts must be non-decreasing; got %v", ts)
	// partition 1 tops out at 25000: watermark 25000, threshold 23000
	want := [][3]int64{}
	for _, t := range seeded {
		if t[0] <= 23000 {
			want = append(want, t)
		}
	}
	sort.Slice(want, func(i, j int) bool {
		a, b := want[i], want[j]
		if a[0] != b[0] {
			return a[0] < b[0]
		}
		if a[1] != b[1] {
			return a[1] < b[1]
		}
		return a[2] < b[2]
	})
	ctx.Equal(got, want, "emitted [ts, partition, offset] must be exactly the readings with ts <= 23000 in (ts, partition, offset) order")
	for _, r := range emitted {
		ctx.Assert(r.Sensor == fmt.Sprintf("s%d", r.Partition), "each emitted reading must carry the sensor from its payload")
	}
	s := GetStats()
	ctx.Assert(s.Emitted == 23 && s.Buffered == 7 && s.Dropped == 0, "GetStats() must report emitted 23, buffered 7, dropped 0; got %+v", s)
}

func CheckWatermarkGates(ctx *harness.Ctx) {
	omSeed(ctx, 0, 1000, 5000, 9000)
	omSeed(ctx, 1, 3000, 7000, 11000)
	omSeed(ctx, 2, 20000)
	emitted := omCollect(ctx, nil)
	ctx.Equal(omStamps(emitted), []int64{1000, 3000, 5000, 7000}, "the watermark is 9000 (partition 0's newest; partition 2 at 20000 does not pull it up) and the threshold 7000: emitted ts")
	s := GetStats()
	ctx.Equal(s.Buffered, 3, "9000, 11000 and 20000 must stay buffered until the slowest partition passes them: GetStats().Buffered")
	ctx.Assert(s.Emitted == 4 && s.Dropped == 0, "GetStats() must report emitted 4, dropped 0; got %+v", s)
}

func CheckLateDropped(ctx *harness.Ctx) {
	omSeed(ctx, 0, 1000, 5000, 9000)
	omSeed(ctx, 1, 3000, 7000, 11000)
	emitted := omCollect(ctx, func(r Reading) {
		if r.Ts == 5000 {
			omReading(ctx, 0, 2000) // lands on partition 0 after the stream has passed 5000
		}
	})
	for _, ts := range omStamps(emitted) {
		ctx.Assert(ts != 2000, "a reading with ts 2000 arriving after the frontier reached 5000 must never be emitted; got %v", omStamps(emitted))
	}
	ctx.Equal(omStamps(emitted), []int64{1000, 3000, 5000, 7000}, "emitted ts")
	s := GetStats()
	ctx.Equal(s.Dropped, 1, "GetStats().Dropped must count the late reading")
	ctx.Assert(s.Emitted == 4 && s.Buffered == 2, "GetStats() must report emitted 4, buffered 2; got %+v", s)
}

func CheckWithinLateness(ctx *harness.Ctx) {
	omSeed(ctx, 0, 1000, 5000)
	omSeed(ctx, 1, 1000, 3000)
	emitted := omCollect(ctx, func(r Reading) {
		if r.Ts == 1000 && r.Partition == 1 && r.Offset == 0 {
			// frontier 1000, watermark 3000: 1000 equals the frontier and 4000 is behind partition 0
			// (already at 5000) — both are still in time
			omReading(ctx, 1, 1000)
			omReading(ctx, 0, 4000)
			omReading(ctx, 0, 9000)
			omReading(ctx, 1, 11000)
		}
	})
	stamps := omStamps(emitted)
	saw4000, at1000 := false, 0
	for _, ts := range stamps {
		saw4000 = saw4000 || ts == 4000
		if ts == 1000 {
			at1000++
		}
	}
	ctx.Assert(saw4000, "a reading at 4000 arriving while the frontier is below it is within the lateness allowance and must be emitted, not dropped; got %v", stamps)
	ctx.Equal(at1000, 3, "a reading whose ts equals the frontier (1000) is not late and must be emitted (emitted %v); readings at 1000", stamps)
	ctx.Equal(stamps, []int64{1000, 1000, 1000, 3000, 4000, 5000}, "emitted ts (4000 slotted before 5000)")
	s := GetStats()
	ctx.Equal(s.Dropped, 0, "nothing was late: GetStats().Dropped")
	ctx.Equal(s.Buffered, 2, "9000 and 11000 must still be buffered: GetStats().Buffered")
}

func CheckIdlePartition(ctx *harness.Ctx) {
	omSeed(ctx, 0, 1000, 5000, 9000, 13000)
	omSeed(ctx, 1, 3000)
	var emitted []Reading
	at := map[int64]int64{}
	// the consumer keeps polling through the quiet period; it may stop once 13000 is out
	omDrain(ctx, 0, func(r Reading, stop func()) {
		emitted = append(emitted, r)
		at[r.Ts] = ctx.Clock.Now()
		// partition 1 goes quiet; 6 s later (virtual) partition 0 delivers again
		if r.Ts == 1000 {
			time.AfterFunc(6*time.Second, func() { omReading(ctx, 0, 17000) })
		}
		if r.Ts == 13000 {
			time.AfterFunc(1500*time.Millisecond, stop) // the topic is drained again
		}
	})
	stamps := omStamps(emitted)
	first := stamps
	if len(first) > 1 {
		first = first[:1]
	}
	ctx.Equal(first, []int64{1000}, "before any partition is idle only 1000 is below the threshold (emitted %v); first emit", stamps)
	ctx.Equal(stamps, []int64{1000, 3000, 5000, 9000, 13000}, "after partition 1 was quiet for IdleMs while partition 0 kept delivering (newest 17000), 3000, 5000, 9000 and 13000 must be released; emitted ts")
	waited := at[3000] - at[1000]
	ctx.Assert(waited >= 9500, "3000 was emitted %.1f s after 1000: an idle partition is released only after IdleMs (10 s) without deliveries", float64(waited)/1000)
	ctx.Equal(ctx.Kafka.CommittedOffset(Group, Topic, 0), 4, "partition 0 must be committed at 4 (17000 at offset 4 still buffered)")
	ctx.Equal(ctx.Kafka.CommittedOffset(Group, Topic, 1), 1, "partition 1 must be committed at 1 after 3000 was emitted")
	ctx.Equal(GetStats().Buffered, 1, "17000 (within LatenessMs of the watermark) must still be buffered: GetStats().Buffered")
}

func CheckCommitAfterEmit(ctx *harness.Ctx) {
	omSeed(ctx, 0, 1000, 5000, 12000, 8000, 13000)
	omSeed(ctx, 1, 3000, 7000, 11000)
	var mu sync.Mutex
	done := map[string]bool{}
	violations := []string{}
	ctx.Kafka.OnCommit(func(group string, offsets harness.KafkaOffsets) {
		mu.Lock()
		defer mu.Unlock()
		for tp, offset := range offsets {
			missing := []int64{}
			for o := int64(0); o < offset; o++ {
				if !done[fmt.Sprintf("%d|%d", tp.Partition, o)] {
					missing = append(missing, o)
				}
			}
			if len(missing) > 0 {
				violations = append(violations, fmt.Sprintf("[%d, %d, %v]", tp.Partition, offset, missing))
			}
		}
	})
	emitted := omCollect(ctx, func(r Reading) {
		mu.Lock()
		done[fmt.Sprintf("%d|%d", r.Partition, r.Offset)] = true
		mu.Unlock()
	})
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	joined := false
	if n := len(subscriptions); n > 0 {
		last := subscriptions[n-1]
		joined = last.Group == Group && strings.Contains(fmt.Sprint(last.Topics), Topic)
	}
	ctx.Assert(joined, "the consumer must join group %s on %s; got %+v", Group, Topic, subscriptions)
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "auto-commit is on: offsets were committed on a timer, ahead of the output")
	ctx.Assert(len(ctx.Kafka.Commits(Group)) > 0, "nothing was ever committed: commit after each flush that emitted")
	ctx.Equal(omStamps(emitted), []int64{1000, 3000, 5000, 7000, 8000}, "emitted ts (8000 at offset 3 emitted while 12000 at offset 2 waits)")
	mu.Lock()
	seen := append([]string{}, violations...)
	mu.Unlock()
	first := ""
	if len(seen) > 0 {
		first = seen[0]
	}
	ctx.Equal(len(seen), 0, "a commit covered a reading that had not been emitted (partition, committed offset, unemitted offsets below it): %s — commit the lowest buffered offset, not the highest emitted + 1; violations", first)
	ctx.Equal(ctx.Kafka.CommittedOffset(Group, Topic, 0), 2, "partition 0 must be committed at 2: 12000 at offset 2 is still buffered although offset 3 was emitted")
	ctx.Equal(ctx.Kafka.CommittedOffset(Group, Topic, 1), 2, "partition 1 must be committed at 2 (11000 at offset 2 buffered)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace {

std::string showStats(const Stats& s) {
  return harness::Sprintf("{emitted:%d dropped:%d buffered:%d}", s.emitted, s.dropped, s.buffered);
}

void omReading(harness::Ctx& ctx, int part, int64_t ts) {
  const std::string sensor = "s" + std::to_string(part);
  ctx.Kafka.SeedPartition(kTopic, part, sensor, R"({"sensor":")" + sensor + R"(","ts":)" + std::to_string(ts) + "}");
}

// omSeed puts readings of sensor s{part} on that partition, in this order (6 partitions, like production).
void omSeed(harness::Ctx& ctx, int part, const std::vector<int64_t>& stamps) {
  ctx.Kafka.CreateTopic(kTopic, 6);
  for (const int64_t ts : stamps) omReading(ctx, part, ts);
}

// omDrain runs the learner's loop with emit; the loop is stopped (its waits end for good) when stop
// is called, a second of polling later, and by itself once it polled quietSeconds without
// anything new when quietSeconds > 0 (the TypeScript consumer stops once the topic is drained).
void omDrain(harness::Ctx& ctx, int quietSeconds, const std::function<void(const Reading&, const std::function<void()>&)>& emit) {
  if (quietSeconds > 0) ctx.Clock.SetSleepLimit(ctx.Clock.Sleeps() + quietSeconds);
  const std::function<void()> stop = [&ctx] { ctx.Clock.SetSleepLimit(ctx.Clock.Sleeps() + 2); };
  ctx.Drain([&] { run([&](const Reading& r) { emit(r, stop); }); });
}

// omCollect drains the loop for 3 s of silence and returns what it emitted.
std::vector<Reading> omCollect(harness::Ctx& ctx, const std::function<void(const Reading&)>& also) {
  std::vector<Reading> emitted;
  omDrain(ctx, 3, [&](const Reading& r, const std::function<void()>&) {
    emitted.push_back(r);
    if (also) also(r);
  });
  return emitted;
}

std::vector<int64_t> omStamps(const std::vector<Reading>& emitted) {
  std::vector<int64_t> out;
  for (const auto& r : emitted) out.push_back(r.ts);
  return out;
}

}  // namespace

void CheckInOrder(harness::Ctx& ctx) {
  const std::vector<int64_t> order = {3, 0, 5, 1, 4, 2};
  std::vector<std::array<int64_t, 3>> seeded;
  for (int part = 0; part < 6; part++) {
    std::vector<int64_t> series;
    for (int64_t i = 0; i < 5; i++) series.push_back(1000 * (1 + order[part] + 6 * i));
    if (part == 4) series[0] = 3000;  // a tie with partition 5's first reading
    omSeed(ctx, part, series);
    for (size_t i = 0; i < series.size(); i++) seeded.push_back({series[i], part, static_cast<int64_t>(i)});
  }
  const auto emitted = omCollect(ctx, nullptr);
  std::vector<std::array<int64_t, 3>> got;
  for (const auto& r : emitted) got.push_back({r.ts, r.partition, r.offset});
  ctx.Assert(!got.empty(),
             "nothing was emitted: 30 readings over six partitions, the slowest partition reaching 25000, must release everything up to 23000");
  const auto ts = omStamps(emitted);
  ctx.Assert(std::is_sorted(ts.begin(), ts.end()), "the emitted ts must be non-decreasing; got %v", ts);
  // partition 1 tops out at 25000: watermark 25000, threshold 23000
  std::vector<std::array<int64_t, 3>> want;
  for (const auto& t : seeded)
    if (t[0] <= 23000) want.push_back(t);
  std::sort(want.begin(), want.end());
  ctx.Equal(got, want, "emitted [ts, partition, offset] must be exactly the readings with ts <= 23000 in (ts, partition, offset) order");
  for (const auto& r : emitted)
    ctx.Assert(r.sensor == "s" + std::to_string(r.partition), "each emitted reading must carry the sensor from its payload");
  const Stats s = stats();
  ctx.Assert(s.emitted == 23 && s.buffered == 7 && s.dropped == 0, "stats() must report emitted 23, buffered 7, dropped 0; got %s",
             showStats(s));
}

void CheckWatermarkGates(harness::Ctx& ctx) {
  omSeed(ctx, 0, {1000, 5000, 9000});
  omSeed(ctx, 1, {3000, 7000, 11000});
  omSeed(ctx, 2, {20000});
  const auto emitted = omCollect(ctx, nullptr);
  ctx.Equal(omStamps(emitted), {1000, 3000, 5000, 7000},
            "the watermark is 9000 (partition 0's newest; partition 2 at 20000 does not pull it up) and the threshold 7000: emitted ts");
  const Stats s = stats();
  ctx.Equal(s.buffered, 3, "9000, 11000 and 20000 must stay buffered until the slowest partition passes them: stats().buffered");
  ctx.Assert(s.emitted == 4 && s.dropped == 0, "stats() must report emitted 4, dropped 0; got %s", showStats(s));
}

void CheckLateDropped(harness::Ctx& ctx) {
  omSeed(ctx, 0, {1000, 5000, 9000});
  omSeed(ctx, 1, {3000, 7000, 11000});
  const auto emitted = omCollect(ctx, [&](const Reading& r) {
    if (r.ts == 5000) omReading(ctx, 0, 2000);  // lands on partition 0 after the stream has passed 5000
  });
  for (const int64_t ts : omStamps(emitted))
    ctx.Assert(ts != 2000, "a reading with ts 2000 arriving after the frontier reached 5000 must never be emitted; got %v", omStamps(emitted));
  ctx.Equal(omStamps(emitted), {1000, 3000, 5000, 7000}, "emitted ts");
  const Stats s = stats();
  ctx.Equal(s.dropped, 1, "stats().dropped must count the late reading");
  ctx.Assert(s.emitted == 4 && s.buffered == 2, "stats() must report emitted 4, buffered 2; got %s", showStats(s));
}

void CheckWithinLateness(harness::Ctx& ctx) {
  omSeed(ctx, 0, {1000, 5000});
  omSeed(ctx, 1, {1000, 3000});
  const auto emitted = omCollect(ctx, [&](const Reading& r) {
    if (r.ts == 1000 && r.partition == 1 && r.offset == 0) {
      // frontier 1000, watermark 3000: 1000 equals the frontier and 4000 is behind partition 0
      // (already at 5000) — both are still in time
      omReading(ctx, 1, 1000);
      omReading(ctx, 0, 4000);
      omReading(ctx, 0, 9000);
      omReading(ctx, 1, 11000);
    }
  });
  const auto stamps = omStamps(emitted);
  const bool saw4000 = std::find(stamps.begin(), stamps.end(), 4000) != stamps.end();
  const auto at1000 = std::count(stamps.begin(), stamps.end(), 1000);
  ctx.Assert(saw4000,
             "a reading at 4000 arriving while the frontier is below it is within the lateness allowance and must be emitted, not dropped; got %v",
             stamps);
  ctx.Equal(at1000, 3, "a reading whose ts equals the frontier (1000) is not late and must be emitted (emitted %v); readings at 1000", stamps);
  ctx.Equal(stamps, {1000, 1000, 1000, 3000, 4000, 5000}, "emitted ts (4000 slotted before 5000)");
  const Stats s = stats();
  ctx.Equal(s.dropped, 0, "nothing was late: stats().dropped");
  ctx.Equal(s.buffered, 2, "9000 and 11000 must still be buffered: stats().buffered");
}

void CheckIdlePartition(harness::Ctx& ctx) {
  omSeed(ctx, 0, {1000, 5000, 9000, 13000});
  omSeed(ctx, 1, {3000});
  std::vector<Reading> emitted;
  std::map<int64_t, int64_t> at;
  // the consumer keeps polling through the quiet period; it may stop once 13000 is out
  omDrain(ctx, 0, [&](const Reading& r, const std::function<void()>& stop) {
    emitted.push_back(r);
    at[r.ts] = ctx.Clock.Now();
    // partition 1 goes quiet; 6 s later (virtual) partition 0 delivers again
    if (r.ts == 1000) {
      std::thread([&ctx] {
        std::this_thread::sleep_for(std::chrono::seconds(6));
        omReading(ctx, 0, 17000);
      }).detach();
    }
    if (r.ts == 13000) stop();  // the topic is drained again
  });
  const auto stamps = omStamps(emitted);
  const std::vector<int64_t> first(stamps.begin(), stamps.begin() + std::min<size_t>(1, stamps.size()));
  ctx.Equal(first, {1000}, "before any partition is idle only 1000 is below the threshold (emitted %v); first emit", stamps);
  ctx.Equal(stamps, {1000, 3000, 5000, 9000, 13000},
            "after partition 1 was quiet for kIdleMs while partition 0 kept delivering (newest 17000), 3000, 5000, 9000 and 13000 must be released; emitted ts");
  const int64_t waited = at[3000] - at[1000];
  ctx.Assert(waited >= 9500, "3000 was emitted %.1f s after 1000: an idle partition is released only after kIdleMs (10 s) without deliveries",
             static_cast<double>(waited) / 1000);
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, kTopic, 0), 4, "partition 0 must be committed at 4 (17000 at offset 4 still buffered)");
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, kTopic, 1), 1, "partition 1 must be committed at 1 after 3000 was emitted");
  ctx.Equal(stats().buffered, 1, "17000 (within kLatenessMs of the watermark) must still be buffered: stats().buffered");
}

void CheckCommitAfterEmit(harness::Ctx& ctx) {
  omSeed(ctx, 0, {1000, 5000, 12000, 8000, 13000});
  omSeed(ctx, 1, {3000, 7000, 11000});
  std::set<std::pair<int, int64_t>> done;
  std::vector<std::string> violations;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) {
    for (const auto& [tp, offset] : offsets) {
      std::vector<int64_t> missing;
      for (int64_t o = 0; o < offset; o++)
        if (!done.count({tp.Partition, o})) missing.push_back(o);
      if (!missing.empty()) violations.push_back(harness::Sprintf("[%d, %d, %v]", tp.Partition, offset, missing));
    }
  });
  const auto emitted = omCollect(ctx, [&](const Reading& r) { done.insert({r.partition, r.offset}); });
  const auto subscriptions = ctx.Kafka.EventsOf("subscribe");
  bool joined = false;
  if (!subscriptions.empty()) {
    const auto& last = subscriptions.back();
    joined = last.Group == kGroup && std::find(last.Topics.begin(), last.Topics.end(), kTopic) != last.Topics.end();
  }
  ctx.Assert(joined, "the consumer must join group %s on %s; got %v", kGroup, kTopic, subscriptions);
  ctx.Assert(ctx.Kafka.EventsOf("auto-commit").empty(), "auto-commit is on: offsets were committed on a timer, ahead of the output");
  ctx.Assert(!ctx.Kafka.Commits(kGroup).empty(), "nothing was ever committed: commit after each flush that emitted");
  ctx.Equal(omStamps(emitted), {1000, 3000, 5000, 7000, 8000}, "emitted ts (8000 at offset 3 emitted while 12000 at offset 2 waits)");
  ctx.Equal(violations.size(), 0,
            "a commit covered a reading that had not been emitted (partition, committed offset, unemitted offsets below it): %s — commit the lowest buffered offset, not the highest emitted + 1; violations",
            violations.empty() ? std::string() : violations[0]);
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, kTopic, 0), 2,
            "partition 0 must be committed at 2: 12000 at offset 2 is still buffered although offset 3 was emitted");
  ctx.Equal(ctx.Kafka.CommittedOffset(kGroup, kTopic, 1), 2, "partition 1 must be committed at 2 (11000 at offset 2 buffered)");
}
`,
  },
  debrief: `The merger is a watermark operator with nothing around it, and every rule in it is one consequence of the watermark being a promise about the input. The buffer per partition exists because the promise is only as good as the slowest partition; the lateness allowance is the distance you keep from it; the idle release exists because a silent partition makes no promise at all and would otherwise freeze the stream (Flink's \`withIdleness\`, Kafka Streams' \`max.task.idle.ms\`); the drop-below-frontier rule is what "in order" costs once the promise was acted on. The commit rule is the least obvious: the stream processor's state is the buffers, Kafka's is the offsets, and the only offset that is safe to publish is the one from which a restart would rebuild the buffers — the lowest unemitted offset, not the highest emitted one. Real systems checkpoint the buffers so they can commit further ahead, bound the buffer per partition and spill or drop when it fills, send late readings to a side output instead of counting them, and take \`ts\` from the record timestamp a producer set rather than from the payload.`,
};
