import type {Step} from '@/lib/types';

export const changelogRestoreStep: Step = {
  id: 'changelog-restore',
  title: 'Replay kv-changelog to its captured ends, then serve',
  concept: 'kafka',
  file: 'kv_view',
  focus: ['view', 'kafka'],
  task: `## Task

Implement a key-value view over the changelog topic **\`kv-changelog\`** (3 partitions, \`PARTITIONS = 3\`).
A record's key is the kv key; its value is a JSON document, or \`null\` — a **tombstone** that deletes
the key. The module keeps the view in memory and exposes three functions:

- \`start(on_restored=None)\`: restore, then go live. In this order: ask the broker for the **end
  offset of every partition** (\`get_watermark_offsets\` / \`fetchTopicOffsets\` / \`endOffsets\`) and
  keep them; **assign all \`PARTITIONS\` partitions** at the beginning (\`OFFSET_BEGINNING\`,
  \`fromBeginning\`, \`seekToBeginning\`) — no group subscription, auto-commit off, never a commit;
  then poll forever, applying every record **last write wins** (a \`null\` value removes the key, a
  later value brings it back). A record whose offset is **below its partition's captured end** is
  *restored*; any other record is *live*. The view becomes \`ready\` the moment **every** partition
  has reached its captured end — a partition whose captured end is \`0\` is caught up before the first
  poll. \`on_restored(partition, offset)\`, when given, is called after each restored record is
  applied (a restore listener, for progress reporting and the harness's probes).
- \`get(key)\`: raises \`NotReadyError\` while the view is not \`ready\` — a half-restored view must not
  answer; afterwards returns the value, or \`None\`/\`null\` for a key that is absent or tombstoned.
- \`stats()\`: \`{ready, restored, applied_live}\` — \`restored\` counts replayed records,
  \`applied_live\` the live ones.

Rules the checks pin:

- The ends are captured **before** the first record is read. A record written after the capture is
  live even when it is delivered while another partition is still restoring — it never counts as
  restored and never moves the capture.
- Readiness is per partition, judged by offsets, not by "nothing more arrived": an empty partition
  does not block it, a busy one is not done until its captured end.
- The consumer owns its partitions and commits nothing: a restart replays from the beginning again.

:::widget kafka-partitions {"partitions": 3}

> The end offset is a snapshot of "how much there is to replay", taken once. Everything up to it is
> the restore; everything after it is the present.`,
  sequence: {
    participants: ['kv view', 'Kafka'],
    messages: [
      {from: 'kv view', to: 'Kafka', label: 'end offsets of kv-changelog[0..2]', kind: 'sync'},
      {
        from: 'Kafka',
        to: 'kv view',
        label: '{0: 4, 1: 0, 2: 7} (captured; partition 1 is caught up already)',
        kind: 'reply',
      },
      {
        from: 'kv view',
        to: 'Kafka',
        label: 'assign [0, 1, 2] at OFFSET_BEGINNING · no group · no commits',
        kind: 'sync',
      },
      {from: 'Kafka', to: 'kv view', label: 'p0@0 … p0@3, p2@0 … p2@6 → apply, restored += 1', kind: 'reply'},
      {from: 'kv view', to: 'kv view', label: 'p2@6 was the last captured end → ready = true', kind: 'sync'},
      {
        from: 'Kafka',
        to: 'kv view',
        label: 'p0@4 (written after the capture) → apply, applied_live += 1',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Capture the ends into a map before assigning or polling; then classify every record with one comparison, `offset < ends[partition]`, instead of a global "restoring" flag — a live record can arrive before the restore is complete.',
    'Keep a per-partition `caught_up` flag initialised to `end == 0`; set it when a restored record has `offset + 1 >= end`, and recompute `ready` as "all caught up" right there. Never wait for a record from every partition.',
    'Tombstones: a `None`/`null` value is a delete (`pop`/`delete`/`erase`), not a stored null. Apply before counting so the listener sees the applied state; call the listener outside any lock `get` takes.',
  ],
  checks: [
    {
      id: 'last-write-wins',
      title: 'The restored view is the last value per key',
      detail:
        'Every record of every partition is applied in offset order, the latest write of a key replacing the earlier one, and after the replay `get` answers the last value and `stats()` counts each record as restored.',
      match: {
        python: {all: [/_view\[key\] = json\.loads\(value\)/, /_restored \+= 1/]},
        typescript: {all: [/view\.set\(key, JSON\.parse\(/, /restored \+= 1/]},
        go: {all: [/view\[key\] = v/, /restored\+\+/]},
        scala: {all: [/view\.put\(key, value\)/, /restored \+= 1/]},
        cpp: {all: [/view\[key\] = std::string\(/, /\+\+restored/]},
      },
    },
    {
      id: 'not-ready-mid-restore',
      title: 'get refuses to answer until every partition reached its end',
      detail:
        'While any partition is still below its captured end `get` raises `NotReadyError`; two small partitions finish early and the view must stay not ready until the big one is drained.',
      match: {
        python: {all: [/if not _ready:/, /raise NotReadyError\(/]},
        typescript: {all: [/if \(!ready\) throw new NotReadyError\(/]},
        go: {all: [/if !ready \{/, /return nil, ErrNotReady/]},
        scala: {all: [/if \(!ready\) throw new NotReadyException/]},
        cpp: {all: [/if \(!ready\) throw NotReadyError\(\)/]},
      },
    },
    {
      id: 'live-after-capture',
      title: 'Records written after the capture are live, not restored',
      detail:
        'The ends are asked for before the first poll; a record the writer appends during the restore is applied and counted in `applied_live` even though it is delivered before the view is ready, and `restored` equals the number of records that existed at the capture.',
      match: {
        python: {
          all: [/get_watermark_offsets\(/, /msg\.offset\(\) < ends\[p\]/],
          order: [/get_watermark_offsets\(/, /consumer\.poll\(/],
        },
        typescript: {
          all: [/fetchTopicOffsets\(TOPIC\)/, /offset < end\b/],
          order: [/fetchTopicOffsets\(/, /consumer\.run\(/],
        },
        go: {all: [/ReadLastOffset\(\)/, /msg\.Offset < ends\[p\]/], order: [/ReadLastOffset\(\)/, /ReadMessage\(/]},
        scala: {
          all: [/consumer\.endOffsets\(/, /record\.offset < ends\(p\)/],
          order: [/consumer\.endOffsets\(/, /consumer\.poll\(/],
        },
        cpp: {
          all: [/query_watermark_offsets\(/, /msg->offset\(\) < ends\[p\]/],
          order: [/query_watermark_offsets\(/, /consumer->consume\(/],
        },
      },
    },
    {
      id: 'tombstone-resurrect',
      title: 'A tombstone deletes; a later write brings the key back',
      detail:
        'A `null` value removes the key from the view (replayed or live); a value written after the tombstone is served again; a tombstone for a key the view never held is a no-op.',
      match: {
        python: {all: [/value is None/, /_view\.pop\(key, None\)/]},
        typescript: {all: [/value === null/, /view\.delete\(key\)/]},
        go: {all: [/value == nil/, /delete\(view, key\)/]},
        scala: {all: [/value == null/, /view\.remove\(key\)/]},
        cpp: {all: [/payload\(\) == nullptr/, /view\.erase\(key\)/]},
      },
    },
    {
      id: 'all-partitions',
      title: 'Every partition is assigned; an empty one does not block readiness',
      detail:
        'All three partitions are assigned from the beginning and replayed; a partition whose captured end is 0 counts as caught up at once, so the view is ready after the others are drained and serves records from each of them.',
      match: {
        python: {all: [/range\(PARTITIONS\)/, /OFFSET_BEGINNING/, /consumer\.assign\(/, /ends\[p\] == 0/]},
        typescript: {all: [/fromBeginning: true/, /end === 0/, /every\(Boolean\)/]},
        go: {all: [/Partition:\s*p\b/, /StartOffset:\s*kafka\.FirstOffset/, /end == 0/]},
        scala: {all: [/consumer\.assign\(/, /seekToBeginning\(/, /ends\(p\) == 0L/]},
        cpp: {all: [/consumer->assign\(/, /OFFSET_BEGINNING/, /high == 0/]},
      },
    },
    {
      id: 'no-commits',
      title: 'No consumer group commits',
      detail:
        'The restore consumer assigns its partitions and never commits an offset — not manually, not on a timer: a restart must replay from the beginning again, whatever the broker remembers.',
      match: {
        python: {
          all: [/"enable\.auto\.commit":\s*False/],
          none: [/"group\.id"/, /consumer\.subscribe\(/, /consumer\.commit\(/],
        },
        typescript: {all: [/autoCommit: false/], none: [/commitOffsets\(/]},
        go: {all: [/kafka\.NewReader\(/], none: [/GroupID:/, /CommitMessages\(/]},
        scala: {
          all: [/"enable\.auto\.commit", "false"/],
          none: [/"group\.id"/, /consumer\.subscribe\(/, /commitSync\(|commitAsync\(/],
        },
        cpp: {all: [/"enable\.auto\.commit", "false"/], none: [/subscribe\(/, /commitSync\(|commitAsync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""A key-value view restored from the kv-changelog topic before it serves a single read."""
import json
from typing import Any, Callable

from confluent_kafka import Consumer

TOPIC = "kv-changelog"
PARTITIONS = 3


class NotReadyError(RuntimeError):
    """The view is still replaying the changelog: a read now would see a half-restored state."""


# TODO: no group, auto-commit off — a restore consumer owns its partitions and commits nothing
consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "kv-view"})

_view: dict[str, Any] = {}
_ready = False
_restored = 0
_applied_live = 0


def _apply(key: str, value: bytes | None) -> None:
    # TODO: a None value is a tombstone: remove the key
    _view[key] = json.loads(value)


def start(on_restored: Callable[[int, int], None] | None = None) -> None:
    """Replay every partition to the end it had when we started, then keep applying live records."""
    global _ready, _restored, _applied_live
    # TODO: capture the end offset of every partition (get_watermark_offsets) before reading anything
    # TODO: assign all PARTITIONS partitions at OFFSET_BEGINNING
    # TODO: poll forever; apply each record; offset < captured end → restored (call on_restored),
    #       otherwise live; _ready once every partition has reached its captured end
    raise NotImplementedError


def get(key: str) -> Any:
    # TODO: raise NotReadyError while the restore is not complete
    return _view.get(key)


def stats() -> dict:
    return {"ready": _ready, "restored": _restored, "applied_live": _applied_live}
`,
      solution: `"""A key-value view restored from the kv-changelog topic before it serves a single read."""
import json
from typing import Any, Callable

from confluent_kafka import OFFSET_BEGINNING, Consumer, TopicPartition

TOPIC = "kv-changelog"
PARTITIONS = 3


class NotReadyError(RuntimeError):
    """The view is still replaying the changelog: a read now would see a half-restored state."""


# No group: the partitions are assigned by hand and nothing is ever committed.
consumer = Consumer({"bootstrap.servers": "kafka:9092", "enable.auto.commit": False})

_view: dict[str, Any] = {}
_ready = False
_restored = 0
_applied_live = 0


def _apply(key: str, value: bytes | None) -> None:
    if value is None:
        _view.pop(key, None)
    else:
        _view[key] = json.loads(value)


def start(on_restored: Callable[[int, int], None] | None = None) -> None:
    """Replay every partition to the end it had when we started, then keep applying live records."""
    global _ready, _restored, _applied_live
    # The ends are captured first: everything below them is the restore, everything after is live.
    ends = {p: consumer.get_watermark_offsets(TopicPartition(TOPIC, p))[1] for p in range(PARTITIONS)}
    caught_up = {p: ends[p] == 0 for p in range(PARTITIONS)}
    _ready = all(caught_up.values())
    consumer.assign([TopicPartition(TOPIC, p, OFFSET_BEGINNING) for p in range(PARTITIONS)])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        p = msg.partition()
        _apply(msg.key().decode(), msg.value())
        if msg.offset() < ends[p]:
            _restored += 1
            if msg.offset() + 1 >= ends[p]:
                caught_up[p] = True
                _ready = all(caught_up.values())
            if on_restored is not None:
                on_restored(p, msg.offset())
        else:
            _applied_live += 1


def get(key: str) -> Any:
    if not _ready:
        raise NotReadyError("the view is still restoring kv-changelog")
    return _view.get(key)


def stats() -> dict:
    return {"ready": _ready, "restored": _restored, "applied_live": _applied_live}
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'kv-changelog';
export const PARTITIONS = 3;

/** The view is still replaying the changelog: a read now would see a half-restored state. */
export class NotReadyError extends Error {}

const kafka = new Kafka({clientId: 'kv-view', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'kv-view'});

const view = new Map<string, unknown>();
let ready = false;
let restored = 0;
let appliedLive = 0;

function apply(key: string, value: Buffer | null): void {
  // TODO: a null value is a tombstone: remove the key
  view.set(key, JSON.parse(String(value)));
}

/** Replay every partition to the end it had when we started, then keep applying live records. */
export async function start(onRestored?: (partition: number, offset: number) => void): Promise<void> {
  // TODO: capture the end offset of every partition (admin.fetchTopicOffsets) before reading anything
  await consumer.connect();
  // TODO: subscribe from the beginning; run with auto-commit off
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    eachMessage: async ({partition, message}) => {
      // TODO: apply; offset < captured end → restored (call onRestored), otherwise live;
      //       ready once every partition has reached its captured end
      throw new Error('not implemented');
    },
  });
}

export function get(key: string): unknown {
  // TODO: throw NotReadyError while the restore is not complete
  return view.get(key) ?? null;
}

export function stats(): {ready: boolean; restored: number; applied_live: number} {
  return {ready, restored, applied_live: appliedLive};
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const TOPIC = 'kv-changelog';
export const PARTITIONS = 3;

/** The view is still replaying the changelog: a read now would see a half-restored state. */
export class NotReadyError extends Error {}

const kafka = new Kafka({clientId: 'kv-view', brokers: ['kafka:9092']});
// kafkajs insists on a group id; with autoCommit off and no commitOffsets it never records a position.
const consumer = kafka.consumer({groupId: 'kv-view'});

const view = new Map<string, unknown>();
let ready = false;
let restored = 0;
let appliedLive = 0;

function apply(key: string, value: Buffer | null): void {
  if (value === null) view.delete(key);
  else view.set(key, JSON.parse(value.toString()));
}

/** Replay every partition to the end it had when we started, then keep applying live records. */
export async function start(onRestored?: (partition: number, offset: number) => void): Promise<void> {
  // The ends are captured first: everything below them is the restore, everything after is live.
  const admin = kafka.admin();
  await admin.connect();
  const ends = new Map<number, number>();
  for (const o of await admin.fetchTopicOffsets(TOPIC)) ends.set(o.partition, Number(o.offset));
  await admin.disconnect();
  const caughtUp = new Map<number, boolean>();
  for (const [p, end] of ends) caughtUp.set(p, end === 0);
  ready = [...caughtUp.values()].every(Boolean);

  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({partition, message}) => {
      const offset = Number(message.offset);
      const end = ends.get(partition) ?? 0;
      apply(String(message.key), message.value);
      if (offset < end) {
        restored += 1;
        if (offset + 1 >= end) {
          caughtUp.set(partition, true);
          ready = [...caughtUp.values()].every(Boolean);
        }
        onRestored?.(partition, offset);
      } else {
        appliedLive += 1;
      }
    },
  });
}

export function get(key: string): unknown {
  if (!ready) throw new NotReadyError('the view is still restoring kv-changelog');
  return view.get(key) ?? null;
}

export function stats(): {ready: boolean; restored: number; applied_live: number} {
  return {ready, restored, applied_live: appliedLive};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/segmentio/kafka-go"
)

const (
	topic      = "kv-changelog"
	partitions = 3
	broker     = "kafka:9092"
)

// ErrNotReady: the view is still replaying the changelog; a read now would see a half-restored state.
var ErrNotReady = errors.New("kv-view: still restoring the changelog")

type Stats struct {
	Ready       bool \`json:"ready"\`
	Restored    int  \`json:"restored"\`
	AppliedLive int  \`json:"applied_live"\`
}

var (
	mu          sync.Mutex
	view        = map[string]any{}
	ready       bool
	restored    int
	appliedLive int
)

func apply(key string, value []byte) error {
	// TODO: a nil value is a tombstone: delete the key
	var v any
	if err := json.Unmarshal(value, &v); err != nil {
		return err
	}
	view[key] = v
	return nil
}

// Start replays every partition to the end it had when we started, then keeps applying live records.
func Start(ctx context.Context, onRestored func(partition int, offset int64)) error {
	// TODO: capture the end offset of every partition (DialLeader + ReadLastOffset) before reading anything
	// TODO: no group — one partition reader per partition from kafka.FirstOffset; nothing is committed
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{broker}, Topic: topic, GroupID: "kv-view"})
	defer reader.Close()
	for {
		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			return err
		}
		// TODO: apply; offset < captured end → restored (call onRestored), otherwise live;
		//       ready once every partition has reached its captured end
		_ = msg
		return errors.New("not implemented")
	}
}

func Get(key string) (any, error) {
	// TODO: ErrNotReady while the restore is not complete
	mu.Lock()
	defer mu.Unlock()
	return view[key], nil
}

func GetStats() Stats {
	mu.Lock()
	defer mu.Unlock()
	return Stats{Ready: ready, Restored: restored, AppliedLive: appliedLive}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/segmentio/kafka-go"
)

const (
	topic      = "kv-changelog"
	partitions = 3
	broker     = "kafka:9092"
)

// ErrNotReady: the view is still replaying the changelog; a read now would see a half-restored state.
var ErrNotReady = errors.New("kv-view: still restoring the changelog")

type Stats struct {
	Ready       bool \`json:"ready"\`
	Restored    int  \`json:"restored"\`
	AppliedLive int  \`json:"applied_live"\`
}

var (
	mu          sync.Mutex
	view        = map[string]any{}
	ready       bool
	restored    int
	appliedLive int
)

func apply(key string, value []byte) error {
	if value == nil {
		delete(view, key)
		return nil
	}
	var v any
	if err := json.Unmarshal(value, &v); err != nil {
		return err
	}
	view[key] = v
	return nil
}

// endOffsets asks each partition's leader for its end offset: the restore target, captured before any read.
func endOffsets(ctx context.Context) ([]int64, error) {
	ends := make([]int64, partitions)
	for p := 0; p < partitions; p++ {
		conn, err := kafka.DialLeader(ctx, "tcp", broker, topic, p)
		if err != nil {
			return nil, err
		}
		end, err := conn.ReadLastOffset()
		conn.Close()
		if err != nil {
			return nil, err
		}
		ends[p] = end
	}
	return ends, nil
}

func allTrue(flags []bool) bool {
	for _, f := range flags {
		if !f {
			return false
		}
	}
	return true
}

// Start replays every partition to the end it had when we started, then keeps applying live records.
func Start(ctx context.Context, onRestored func(partition int, offset int64)) error {
	// The ends are captured first: everything below them is the restore, everything after is live.
	ends, err := endOffsets(ctx)
	if err != nil {
		return err
	}
	caughtUp := make([]bool, partitions)
	for p, end := range ends {
		caughtUp[p] = end == 0
	}
	mu.Lock()
	ready = allTrue(caughtUp)
	mu.Unlock()

	// No group: one plain partition reader per partition, from the first offset, committing nothing.
	var wg sync.WaitGroup
	for p := 0; p < partitions; p++ {
		reader := kafka.NewReader(kafka.ReaderConfig{
			Brokers:     []string{broker},
			Topic:       topic,
			Partition:   p,
			StartOffset: kafka.FirstOffset,
		})
		wg.Add(1)
		go func(p int, reader *kafka.Reader) {
			defer wg.Done()
			defer reader.Close()
			for {
				msg, err := reader.ReadMessage(ctx)
				if err != nil {
					return
				}
				mu.Lock()
				if err := apply(string(msg.Key), msg.Value); err != nil {
					mu.Unlock()
					continue
				}
				wasRestored := msg.Offset < ends[p]
				if wasRestored {
					restored++
					if msg.Offset+1 >= ends[p] {
						caughtUp[p] = true
						ready = allTrue(caughtUp)
					}
				} else {
					appliedLive++
				}
				mu.Unlock()
				if wasRestored && onRestored != nil {
					onRestored(p, msg.Offset)
				}
			}
		}(p, reader)
	}
	wg.Wait()
	return ctx.Err()
}

func Get(key string) (any, error) {
	mu.Lock()
	defer mu.Unlock()
	if !ready {
		return nil, ErrNotReady
	}
	return view[key], nil
}

func GetStats() Stats {
	mu.Lock()
	defer mu.Unlock()
	return Stats{Ready: ready, Restored: restored, AppliedLive: appliedLive}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.collection.mutable
import scala.jdk.CollectionConverters._

/** The view is still replaying the changelog: a read now would see a half-restored state. */
class NotReadyException extends RuntimeException("kv-view: still restoring the changelog")

object KvView {
  val Topic = "kv-changelog"
  val Partitions = 3

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // TODO: no group, auto-commit off — a restore consumer owns its partitions and commits nothing
  props.put("group.id", "kv-view")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)

  private val view = mutable.Map.empty[String, String]
  @volatile private var ready = false
  @volatile private var restored = 0
  @volatile private var appliedLive = 0

  private def apply(key: String, value: String): Unit = view.synchronized {
    // TODO: a null value is a tombstone: remove the key
    view.put(key, value)
  }

  /** Replay every partition to the end it had when we started, then keep applying live records. */
  def start(onRestored: (Int, Long) => Unit = (_, _) => ()): Unit = {
    // TODO: capture the end offset of every partition (endOffsets) before reading anything
    // TODO: assign all Partitions partitions and seekToBeginning
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        // TODO: apply; offset < captured end → restored (call onRestored), otherwise live;
        //       ready once every partition has reached its captured end
        throw new NotImplementedError("not implemented")
      }
    }
  }

  def get(key: String): Option[String] = {
    // TODO: throw NotReadyException while the restore is not complete
    view.synchronized(view.get(key))
  }

  def stats(): Map[String, Any] = Map("ready" -> ready, "restored" -> restored, "applied_live" -> appliedLive)
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.collection.mutable
import scala.jdk.CollectionConverters._

/** The view is still replaying the changelog: a read now would see a half-restored state. */
class NotReadyException extends RuntimeException("kv-view: still restoring the changelog")

object KvView {
  val Topic = "kv-changelog"
  val Partitions = 3

  // No group: the partitions are assigned by hand and nothing is ever committed.
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)

  private val view = mutable.Map.empty[String, String]
  @volatile private var ready = false
  @volatile private var restored = 0
  @volatile private var appliedLive = 0

  private def apply(key: String, value: String): Unit = view.synchronized {
    if (value == null) view.remove(key) else view.put(key, value)
  }

  /** Replay every partition to the end it had when we started, then keep applying live records. */
  def start(onRestored: (Int, Long) => Unit = (_, _) => ()): Unit = {
    val tps = (0 until Partitions).map(p => new TopicPartition(Topic, p))
    // The ends are captured first: everything below them is the restore, everything after is live.
    val ends = consumer.endOffsets(tps.asJava).asScala.map { case (tp, end) => tp.partition -> end.longValue }.toMap
    val caughtUp = Array.tabulate(Partitions)(p => ends(p) == 0L)
    ready = caughtUp.forall(identity)
    consumer.assign(tps.asJava)
    consumer.seekToBeginning(tps.asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val p = record.partition
        apply(record.key, record.value)
        if (record.offset < ends(p)) {
          restored += 1
          if (record.offset + 1 >= ends(p)) {
            caughtUp(p) = true
            ready = caughtUp.forall(identity)
          }
          onRestored(p, record.offset)
        } else appliedLive += 1
      }
    }
  }

  def get(key: String): Option[String] = {
    if (!ready) throw new NotReadyException
    view.synchronized(view.get(key))
  }

  def stats(): Map[String, Any] = Map("ready" -> ready, "restored" -> restored, "applied_live" -> appliedLive)
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

const std::string kTopic = "kv-changelog";
const int kPartitions = 3;

// The view is still replaying the changelog: a read now would see a half-restored state.
struct NotReadyError : std::runtime_error {
  NotReadyError() : std::runtime_error("kv-view: still restoring the changelog") {}
};

struct Stats {
  bool ready;
  long restored;
  long applied_live;
};

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "kv-view", err);
  // TODO: auto-commit off — a restore consumer owns its partitions and commits nothing
  return std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
}

auto consumer = make_consumer();
std::mutex mu;
std::unordered_map<std::string, std::string> view;
bool ready = false;
long restored = 0;
long applied_live = 0;

void apply(const std::string& key, const RdKafka::Message& msg) {
  // TODO: a null payload is a tombstone: erase the key
  view[key] = std::string(static_cast<const char*>(msg.payload()), msg.len());
}

// Replay every partition to the end it had when we started, then keep applying live records.
void start(std::function<void(int, long)> on_restored = nullptr) {
  // TODO: capture the end offset of every partition (query_watermark_offsets) before reading anything
  // TODO: assign all kPartitions partitions at OFFSET_BEGINNING — no subscribe
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    // TODO: apply; offset < captured end → restored (call on_restored), otherwise live;
    //       ready once every partition has reached its captured end
    throw std::logic_error("not implemented");
  }
}

std::optional<std::string> get(const std::string& key) {
  std::lock_guard<std::mutex> lock(mu);
  // TODO: throw NotReadyError while the restore is not complete
  auto it = view.find(key);
  if (it == view.end()) return std::nullopt;
  return it->second;
}

Stats stats() {
  std::lock_guard<std::mutex> lock(mu);
  return {ready, restored, applied_live};
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

const std::string kTopic = "kv-changelog";
const int kPartitions = 3;

// The view is still replaying the changelog: a read now would see a half-restored state.
struct NotReadyError : std::runtime_error {
  NotReadyError() : std::runtime_error("kv-view: still restoring the changelog") {}
};

struct Stats {
  bool ready;
  long restored;
  long applied_live;
};

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // librdkafka insists on a group id; with auto-commit off and no commit call it never records a position.
  conf->set("group.id", "kv-view", err);
  conf->set("enable.auto.commit", "false", err);
  return std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
}

auto consumer = make_consumer();
std::mutex mu;
std::unordered_map<std::string, std::string> view;
bool ready = false;
long restored = 0;
long applied_live = 0;

void apply(const std::string& key, const RdKafka::Message& msg) {
  if (msg.payload() == nullptr) {
    view.erase(key);
    return;
  }
  view[key] = std::string(static_cast<const char*>(msg.payload()), msg.len());
}

bool all_caught_up(const std::vector<bool>& caught_up) {
  for (bool c : caught_up)
    if (!c) return false;
  return true;
}

// Replay every partition to the end it had when we started, then keep applying live records.
void start(std::function<void(int, long)> on_restored = nullptr) {
  // The ends are captured first: everything below them is the restore, everything after is live.
  std::vector<int64_t> ends(kPartitions);
  std::vector<bool> caught_up(kPartitions);
  for (int p = 0; p < kPartitions; ++p) {
    int64_t low = 0, high = 0;
    consumer->query_watermark_offsets(kTopic, p, &low, &high, 5000);
    ends[p] = high;
    caught_up[p] = high == 0;
  }
  {
    std::lock_guard<std::mutex> lock(mu);
    ready = all_caught_up(caught_up);
  }
  std::vector<RdKafka::TopicPartition*> tps;
  for (int p = 0; p < kPartitions; ++p)
    tps.push_back(RdKafka::TopicPartition::create(kTopic, p, RdKafka::Topic::OFFSET_BEGINNING));
  consumer->assign(tps);
  RdKafka::TopicPartition::destroy(tps);

  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const int p = msg->partition();
    bool was_restored = false;
    {
      std::lock_guard<std::mutex> lock(mu);
      apply(msg->key() ? *msg->key() : std::string(), *msg);
      was_restored = msg->offset() < ends[p];
      if (was_restored) {
        ++restored;
        if (msg->offset() + 1 >= ends[p]) {
          caught_up[p] = true;
          ready = all_caught_up(caught_up);
        }
      } else {
        ++applied_live;
      }
    }
    if (was_restored && on_restored) on_restored(p, msg->offset());  // outside the lock: the listener may call get()
  }
}

std::optional<std::string> get(const std::string& key) {
  std::lock_guard<std::mutex> lock(mu);
  if (!ready) throw NotReadyError();
  auto it = view.find(key);
  if (it == view.end()) return std::nullopt;
  return it->second;
}

Stats stats() {
  std::lock_guard<std::mutex> lock(mu);
  return {ready, restored, applied_live};
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "kv-changelog"


def _seed(ctx, partition, key, value):
    """A record from the changelog's writer: a JSON value, or a tombstone (None) for a delete."""
    return ctx.kafka.seed(TOPIC, key=key, value=None if value is None else json.dumps(value), partition=partition)


def _raises_not_ready(m, key):
    try:
        m.get(key)
    except m.NotReadyError:
        return True
    except Exception:
        return False
    return False


def check_last_write_wins(ctx):
    _seed(ctx, 0, "a", 1)
    _seed(ctx, 1, "b", {"n": 2})
    _seed(ctx, 0, "a", 3)
    _seed(ctx, 1, "b", None)
    _seed(ctx, 2, "c", "four")
    m = ctx.load("kv_view")
    ctx.drain(m.start)
    s = m.stats()
    assert s["ready"] is True, f"every partition was replayed to its end: the view must be ready, stats {s}"
    assert m.get("a") == 3, f"a was written as 1 then 3 on one partition: the last write wins, got {m.get('a')!r}"
    assert m.get("c") == "four", f"c was written once, got {m.get('c')!r}"
    assert m.get("b") is None, f"b was tombstoned after its write: it must be absent, got {m.get('b')!r}"
    assert m.get("nope") is None, "a key the changelog never held answers None"
    assert s["restored"] == 5, f"5 records were replayed, restored is {s['restored']}"
    assert s["applied_live"] == 0, f"nothing was written after start(), applied_live is {s['applied_live']}"


def check_not_ready_mid_restore(ctx):
    sizes = {0: 2, 1: 3, 2: 25}
    total = sum(sizes.values())
    for p, n in sizes.items():
        for i in range(n):
            _seed(ctx, p, f"p{p}k{i}", i)
    m = ctx.load("kv_view")
    seen = 0
    served_early = []

    def probe(partition, offset):
        nonlocal seen
        seen += 1
        if seen < total and (not _raises_not_ready(m, "p0k0") or m.stats()["ready"]):
            served_early.append((seen, partition, offset))

    ctx.drain(m.start, on_restored=probe)
    assert seen == total, f"on_restored must be called once per replayed record: {seen} calls for {total} records"
    assert not served_early, (
        f"get must raise NotReadyError (and ready stay false) until every partition reached its captured end: "
        f"the view answered after {served_early[0][0]} of {total} records (partition {served_early[0][1]} offset {served_early[0][2]}) — "
        "partitions 0 and 1 were done, partition 2 was not"
    )
    assert m.stats()["ready"] is True, "once partition 2 reached its end the view must be ready"
    assert m.get("p2k24") == 24


def check_live_after_capture(ctx):
    _seed(ctx, 0, "a", "old")
    _seed(ctx, 1, "b", "old")
    for i in range(3):
        _seed(ctx, 2, f"c{i}", i)
    m = ctx.load("kv_view")
    written = []

    def on_restored(partition, offset):
        if not written:  # the writer keeps writing while we restore: these land after the capture
            written.append(_seed(ctx, 0, "a", "new"))
            written.append(_seed(ctx, 1, "d", "new"))

    ctx.drain(m.start, on_restored=on_restored)
    s = m.stats()
    assert s["ready"] is True, f"the view must be ready once the 5 captured records are replayed, stats {s}"
    assert s["restored"] == 5, (
        f"5 records existed when start() captured the ends, restored is {s['restored']}: a record written after the "
        "capture is live even when it is delivered before the restore is complete"
    )
    assert s["applied_live"] == 2, f"2 records were written after the capture, applied_live is {s['applied_live']}"
    assert m.get("a") == "new", f"the live write to a must be applied, got {m.get('a')!r}"
    assert m.get("d") == "new", f"the live write to d must be applied, got {m.get('d')!r}"


def check_tombstone_resurrect(ctx):
    _seed(ctx, 0, "a", 1)
    _seed(ctx, 0, "a", None)
    _seed(ctx, 0, "a", 2)
    _seed(ctx, 1, "b", 1)
    m = ctx.load("kv_view")

    def on_restored(partition, offset):
        if (partition, offset) == (1, 0):  # live: delete b, write it again, delete a key never held
            _seed(ctx, 1, "b", None)
            _seed(ctx, 1, "b", "back")
            _seed(ctx, 2, "c", None)

    ctx.drain(m.start, on_restored=on_restored)
    s = m.stats()
    assert s["ready"] is True, f"stats {s}"
    assert m.get("a") == 2, f"a was written, tombstoned, written again during the restore: it must be 2, got {m.get('a')!r}"
    assert m.get("b") == "back", f"b was tombstoned then written again live: it must be back, got {m.get('b')!r}"
    assert m.get("c") is None, "a tombstone for a key the view never held is a no-op"
    assert s["restored"] == 4, f"restored is {s['restored']}, expected 4"
    assert s["applied_live"] == 3, f"applied_live is {s['applied_live']}, expected 3 (partition 2 was empty at the capture)"


def check_all_partitions(ctx):
    for i in range(3):
        _seed(ctx, 0, f"x{i}", i)
    for i in range(2):
        _seed(ctx, 2, f"z{i}", i)
    m = ctx.load("kv_view")
    ctx.drain(m.start)
    assigned = {tp.partition for c in ctx.kafka.consumers for tp in c.assignment() if tp.topic == TOPIC}
    assert assigned == {0, 1, 2}, f"all three partitions must be assigned, including the empty one; assigned {sorted(assigned)}"
    s = m.stats()
    assert s["ready"] is True, (
        "partition 1 is empty: its captured end is 0, so it is caught up from the start and must not block readiness"
    )
    assert m.get("x2") == 2 and m.get("z1") == 1, "records from partitions 0 and 2 must both be in the view"
    assert s["restored"] == 5, f"restored is {s['restored']}, expected 5"


def check_no_commits(ctx):
    _seed(ctx, 0, "a", 1)
    _seed(ctx, 1, "b", 2)
    m = ctx.load("kv_view")
    ctx.drain(m.start)
    ctx.clock.advance(10)  # long enough for any auto-commit timer
    assert ctx.kafka.commits() == [], (
        f"a restore consumer commits nothing: {len(ctx.kafka.commits())} commit(s) happened (auto-commit must be off)"
    )
    assert not any(e[0] == "subscribe" for e in ctx.kafka.events), (
        "assign the partitions yourself: a group subscription is a position the broker remembers, and the next restart must replay from the beginning"
    )
    assert m.stats()["ready"] is True and m.get("b") == 2
`,
    typescript: `const TOPIC = 'kv-changelog';

/** A record from the changelog's writer: a JSON value, or a tombstone (null) for a delete. */
function seed(ctx, partition: number, key: string, value: unknown) {
  return ctx.kafka.seed(TOPIC, {key, value: value === null ? null : JSON.stringify(value), partition});
}

function raisesNotReady(m, key: string): boolean {
  try {
    m.get(key);
  } catch (e) {
    return e instanceof m.NotReadyError;
  }
  return false;
}

const show = (v: unknown): string => JSON.stringify(v);

export async function check_last_write_wins(ctx) {
  seed(ctx, 0, 'a', 1);
  seed(ctx, 1, 'b', {n: 2});
  seed(ctx, 0, 'a', 3);
  seed(ctx, 1, 'b', null);
  seed(ctx, 2, 'c', 'four');
  const m = ctx.load('kv_view');
  await ctx.drain(m.start());
  const s = m.stats();
  assert.equal(s.ready, true, 'every partition was replayed to its end: the view must be ready, stats ' + show(s));
  assert.equal(m.get('a'), 3, 'a was written as 1 then 3 on one partition: the last write wins, got ' + show(m.get('a')));
  assert.equal(m.get('c'), 'four', 'c was written once, got ' + show(m.get('c')));
  assert.equal(m.get('b'), null, 'b was tombstoned after its write: it must be absent, got ' + show(m.get('b')));
  assert.equal(m.get('nope'), null, 'a key the changelog never held answers null');
  assert.equal(s.restored, 5, '5 records were replayed, restored is ' + s.restored);
  assert.equal(s.applied_live, 0, 'nothing was written after start(), applied_live is ' + s.applied_live);
}

export async function check_not_ready_mid_restore(ctx) {
  const sizes = [2, 3, 25];
  const total = sizes.reduce((a, b) => a + b, 0);
  sizes.forEach((n, p) => {
    for (let i = 0; i < n; i++) seed(ctx, p, 'p' + p + 'k' + i, i);
  });
  const m = ctx.load('kv_view');
  let seen = 0;
  const servedEarly: [number, number, number][] = [];
  await ctx.drain(
    m.start((partition: number, offset: number) => {
      seen += 1;
      if (seen < total && (!raisesNotReady(m, 'p0k0') || m.stats().ready)) servedEarly.push([seen, partition, offset]);
    }),
  );
  assert.equal(seen, total, 'onRestored must be called once per replayed record: ' + seen + ' calls for ' + total + ' records');
  assert(
    servedEarly.length === 0,
    'get must throw NotReadyError (and ready stay false) until every partition reached its captured end: the view answered after ' +
      servedEarly[0]?.[0] + ' of ' + total + ' records (partition ' + servedEarly[0]?.[1] + ' offset ' + servedEarly[0]?.[2] +
      ') — partitions 0 and 1 were done, partition 2 was not',
  );
  assert.equal(m.stats().ready, true, 'once partition 2 reached its end the view must be ready');
  assert.equal(m.get('p2k24'), 24);
}

export async function check_live_after_capture(ctx) {
  seed(ctx, 0, 'a', 'old');
  seed(ctx, 1, 'b', 'old');
  for (let i = 0; i < 3; i++) seed(ctx, 2, 'c' + i, i);
  const m = ctx.load('kv_view');
  let written = 0;
  await ctx.drain(
    m.start(() => {
      if (written === 0) {
        // the writer keeps writing while we restore: these land after the capture
        seed(ctx, 0, 'a', 'new');
        seed(ctx, 1, 'd', 'new');
        written = 2;
      }
    }),
  );
  const s = m.stats();
  assert.equal(s.ready, true, 'the view must be ready once the 5 captured records are replayed, stats ' + show(s));
  assert.equal(
    s.restored,
    5,
    '5 records existed when start() captured the ends, restored is ' + s.restored +
      ': a record written after the capture is live even when it is delivered before the restore is complete',
  );
  assert.equal(s.applied_live, 2, '2 records were written after the capture, applied_live is ' + s.applied_live);
  assert.equal(m.get('a'), 'new', 'the live write to a must be applied, got ' + show(m.get('a')));
  assert.equal(m.get('d'), 'new', 'the live write to d must be applied, got ' + show(m.get('d')));
}

export async function check_tombstone_resurrect(ctx) {
  seed(ctx, 0, 'a', 1);
  seed(ctx, 0, 'a', null);
  seed(ctx, 0, 'a', 2);
  seed(ctx, 1, 'b', 1);
  const m = ctx.load('kv_view');
  await ctx.drain(
    m.start((partition: number, offset: number) => {
      if (partition === 1 && offset === 0) {
        // live: delete b, write it again, delete a key never held
        seed(ctx, 1, 'b', null);
        seed(ctx, 1, 'b', 'back');
        seed(ctx, 2, 'c', null);
      }
    }),
  );
  const s = m.stats();
  assert.equal(s.ready, true, 'stats ' + show(s));
  assert.equal(m.get('a'), 2, 'a was written, tombstoned, written again during the restore: it must be 2, got ' + show(m.get('a')));
  assert.equal(m.get('b'), 'back', 'b was tombstoned then written again live: it must be back, got ' + show(m.get('b')));
  assert.equal(m.get('c'), null, 'a tombstone for a key the view never held is a no-op');
  assert.equal(s.restored, 4, 'restored is ' + s.restored + ', expected 4');
  assert.equal(s.applied_live, 3, 'applied_live is ' + s.applied_live + ', expected 3 (partition 2 was empty at the capture)');
}

export async function check_all_partitions(ctx) {
  for (let i = 0; i < 3; i++) seed(ctx, 0, 'x' + i, i);
  for (let i = 0; i < 2; i++) seed(ctx, 2, 'z' + i, i);
  const m = ctx.load('kv_view');
  await ctx.drain(m.start());
  assert(
    ctx.kafka.events.some(e => e[0] === 'subscribe' && e[2].includes(TOPIC)),
    'the consumer must subscribe to kv-changelog, which assigns all three partitions, the empty one included',
  );
  const s = m.stats();
  assert.equal(
    s.ready,
    true,
    'partition 1 is empty: its captured end is 0, so it is caught up from the start and must not block readiness',
  );
  assert(m.get('x2') === 2 && m.get('z1') === 1, 'records from partitions 0 and 2 must both be in the view');
  assert.equal(s.restored, 5, 'restored is ' + s.restored + ', expected 5');
}

export async function check_no_commits(ctx) {
  seed(ctx, 0, 'a', 1);
  seed(ctx, 1, 'b', 2);
  const m = ctx.load('kv_view');
  await ctx.drain(m.start());
  ctx.clock.advance(10); // long enough for any auto-commit timer
  assert.equal(
    ctx.kafka.commits().length,
    0,
    'a restore consumer commits nothing: ' + ctx.kafka.commits().length + ' commit(s) happened (autoCommit must be off, commitOffsets never called)',
  );
  assert(m.stats().ready === true && m.get('b') === 2);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"leetbuild/harness"
)

const kvTopic = "kv-changelog"

// seedKV is a record from the changelog's writer: a JSON value, or a tombstone (nil) for a delete.
func seedKV(ctx *harness.Ctx, partition int, key string, value any) {
	var raw []byte
	if value != nil {
		raw, _ = json.Marshal(value)
	}
	ctx.Kafka.SeedPartition(kvTopic, partition, key, raw)
}

func drainStart(ctx *harness.Ctx, onRestored func(partition int, offset int64)) {
	ctx.Drain(func() { _ = Start(context.Background(), onRestored) })
}

func getKV(ctx *harness.Ctx, key string) any {
	v, err := Get(key)
	ctx.NoError(err, "Get(%q)", key)
	return v
}

func kvNotReady(key string) bool {
	_, err := Get(key)
	return errors.Is(err, ErrNotReady)
}

func CheckLastWriteWins(ctx *harness.Ctx) {
	seedKV(ctx, 0, "a", 1)
	seedKV(ctx, 1, "b", map[string]any{"n": 2})
	seedKV(ctx, 0, "a", 3)
	seedKV(ctx, 1, "b", nil)
	seedKV(ctx, 2, "c", "four")
	drainStart(ctx, nil)
	s := GetStats()
	ctx.Equal(s.Ready, true, "every partition was replayed to its end: the view must be ready (stats %+v)", s)
	ctx.Equal(getKV(ctx, "a"), 3, "a was written as 1 then 3 on one partition: the last write wins")
	ctx.Equal(getKV(ctx, "c"), "four", "c was written once")
	ctx.Equal(getKV(ctx, "b"), nil, "b was tombstoned after its write: it must be absent")
	ctx.Equal(getKV(ctx, "nope"), nil, "a key the changelog never held answers nil")
	ctx.Equal(s.Restored, 5, "5 records were replayed: Restored")
	ctx.Equal(s.AppliedLive, 0, "nothing was written after Start: AppliedLive")
}

func CheckNotReadyMidRestore(ctx *harness.Ctx) {
	sizes := []int{2, 3, 25}
	total := 0
	for p, n := range sizes {
		for i := range n {
			seedKV(ctx, p, fmt.Sprintf("p%dk%d", p, i), i)
		}
		total += n
	}
	seen := 0
	var servedEarly [][3]int64
	drainStart(ctx, func(partition int, offset int64) {
		seen++
		if seen < total && (!kvNotReady("p0k0") || GetStats().Ready) {
			servedEarly = append(servedEarly, [3]int64{int64(seen), int64(partition), offset})
		}
	})
	ctx.Equal(seen, total, "onRestored must be called once per replayed record: calls")
	if len(servedEarly) > 0 {
		ctx.Fatalf("Get must return ErrNotReady (and Ready stay false) until every partition reached its captured end: the view answered after %d of %d records (partition %d offset %d), partitions 0 and 1 were done, partition 2 was not", servedEarly[0][0], total, servedEarly[0][1], servedEarly[0][2])
	}
	ctx.Equal(GetStats().Ready, true, "once partition 2 reached its end the view must be ready")
	ctx.Equal(getKV(ctx, "p2k24"), 24, "p2k24")
}

func CheckLiveAfterCapture(ctx *harness.Ctx) {
	seedKV(ctx, 0, "a", "old")
	seedKV(ctx, 1, "b", "old")
	for i := range 3 {
		seedKV(ctx, 2, fmt.Sprintf("c%d", i), i)
	}
	written := 0
	drainStart(ctx, func(int, int64) {
		if written == 0 {
			// the writer keeps writing while we restore: these land after the capture
			seedKV(ctx, 0, "a", "new")
			seedKV(ctx, 1, "d", "new")
			written = 2
		}
	})
	s := GetStats()
	ctx.Equal(s.Ready, true, "the view must be ready once the 5 captured records are replayed (stats %+v)", s)
	ctx.Equal(s.Restored, 5, "5 records existed when Start captured the ends (a record written after the capture is live even when it is delivered before the restore is complete): Restored")
	ctx.Equal(s.AppliedLive, 2, "2 records were written after the capture: AppliedLive")
	ctx.Equal(getKV(ctx, "a"), "new", "the live write to a must be applied")
	ctx.Equal(getKV(ctx, "d"), "new", "the live write to d must be applied")
}

func CheckTombstoneResurrect(ctx *harness.Ctx) {
	seedKV(ctx, 0, "a", 1)
	seedKV(ctx, 0, "a", nil)
	seedKV(ctx, 0, "a", 2)
	seedKV(ctx, 1, "b", 1)
	drainStart(ctx, func(partition int, offset int64) {
		if partition == 1 && offset == 0 {
			// live: delete b, write it again, delete a key never held
			seedKV(ctx, 1, "b", nil)
			seedKV(ctx, 1, "b", "back")
			seedKV(ctx, 2, "c", nil)
		}
	})
	s := GetStats()
	ctx.Equal(s.Ready, true, "stats %+v", s)
	ctx.Equal(getKV(ctx, "a"), 2, "a was written, tombstoned, written again during the restore")
	ctx.Equal(getKV(ctx, "b"), "back", "b was tombstoned then written again live")
	ctx.Equal(getKV(ctx, "c"), nil, "a tombstone for a key the view never held is a no-op")
	ctx.Equal(s.Restored, 4, "Restored")
	ctx.Equal(s.AppliedLive, 3, "AppliedLive (partition 2 was empty at the capture)")
}

func CheckAllPartitions(ctx *harness.Ctx) {
	for i := range 3 {
		seedKV(ctx, 0, fmt.Sprintf("x%d", i), i)
	}
	for i := range 2 {
		seedKV(ctx, 2, fmt.Sprintf("z%d", i), i)
	}
	drainStart(ctx, nil)
	assigned := map[int]bool{}
	for _, c := range ctx.Kafka.Consumers() {
		for _, tp := range c.Assignment {
			if tp.Topic == kvTopic {
				assigned[tp.Partition] = true
			}
		}
	}
	var partitionsAssigned []int
	for p := range assigned {
		partitionsAssigned = append(partitionsAssigned, p)
	}
	sort.Ints(partitionsAssigned)
	ctx.Equal(partitionsAssigned, []int{0, 1, 2}, "all three partitions of kv-changelog must be assigned, the empty one included: partitions assigned")
	s := GetStats()
	ctx.Equal(s.Ready, true, "partition 1 is empty: its captured end is 0, so it is caught up from the start and must not block readiness")
	ctx.Assert(getKV(ctx, "x2") == 2.0 && getKV(ctx, "z1") == 1.0, "records from partitions 0 and 2 must both be in the view")
	ctx.Equal(s.Restored, 5, "Restored")
}

func CheckNoCommits(ctx *harness.Ctx) {
	seedKV(ctx, 0, "a", 1)
	seedKV(ctx, 1, "b", 2)
	drainStart(ctx, nil)
	ctx.Clock.Advance(10) // long enough for any auto-commit timer
	ctx.Equal(len(ctx.Kafka.Commits("")), 0, "a restore consumer commits nothing (no GroupID, never CommitMessages): commits")
	ctx.Assert(GetStats().Ready && getKV(ctx, "b") == 2.0, "after the restore the view must be ready and serve b = 2")
}
`,
  },
  debrief: `The protocol has exactly one moving part: the **captured end offsets**. Taken before the first read, they split the changelog into "the restore" (every offset below) and "the present" (everything from there on), and that split is what makes \`ready\` a fact about offsets rather than a guess about silence. The obvious version — a global \`restoring\` flag flipped when the last partition catches up — miscounts a record the writer appended to an already-finished partition while a slow one was still draining, and the other obvious version — "ready when a poll comes back empty" — is wrong in both directions: a lagging fetch looks like the end, and a busy topic never looks empty. Per-partition \`caught_up\` flags seeded with \`end == 0\` are also why an empty partition cannot wedge the restore. Not joining a group is a feature: the view's durable state *is* the topic, so a restart that replays from offset 0 is the recovery path, and a remembered position would only let a restart skip the records it needs. Kafka Streams does the same with a \`StateRestoreListener\` for progress, standby replicas so a restore is a short catch-up rather than a full replay, and a RocksDB checkpoint with the offset it corresponds to so the replay can start from there.`,
};
