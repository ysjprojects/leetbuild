import type {Step} from '@/lib/types';

export const consumeTransformProduceStep: Step = {
  id: 'consume-transform-produce',
  title: 'Produce, flush, then commit',
  concept: 'kafka',
  file: 'cleaner',
  focus: ['raw', 'cleaner', 'clean'],
  task: `## Task

Implement \`run(transform)\`, one member of consumer group **\`cleaner\`** reading **\`raw\`** and producing to
**\`clean\`**, and \`restart()\`, which gives a crashed process fresh clients that resume from the group's
committed offsets.

- The consumer has **auto-commit off** (\`auto.offset.reset=earliest\`). The producer is **idempotent with
  \`acks=all\`** (\`enable.idempotence\`; kafkajs \`idempotent: true\`): a lost acknowledgement is retried by the
  producer and written **once**.
- For every record of \`raw\`: produce \`transform(value)\` (value as text in, text out) to \`clean\` under the
  **same key**, with two headers — \`src_partition\` and \`src_offset\`, the source record's partition and
  offset as decimal strings. Produce in consume order: a key's records stay on one partition of \`clean\`, in
  their \`raw\` order.
- Records are committed in **batches of at most \`BATCH = 20\`**. A batch ends at \`BATCH\` records, when the
  consumer goes idle (a poll returns nothing) or when it stops (\`KeyboardInterrupt\`; the kafkajs \`run\`
  resolving) — the open batch is finished before \`run\` returns.
- Finishing a batch: **flush first** — wait for every delivery report / every \`send\` to resolve, at most
  **\`FLUSH_TIMEOUT_MS = 2000\`** ms — **then commit** the batch's offsets (next offset per partition, synchronously).
- A delivery report with an error, or a flush that has not completed within \`FLUSH_TIMEOUT_MS\`, **fails the
  batch**: \`run\` raises \`BatchFailed\` and commits **nothing** of it. The process is gone; \`restart()\` and a new
  \`run\` re-read the batch from the committed offsets, and the records that had landed appear on \`clean\` a
  second time with the **same \`src_*\` headers** — that is what a downstream consumer deduplicates on.

:::widget delivery-semantics {}

> Where the commit sits is the guarantee: after every ack, the output is at-least-once and never lost;
> with the idempotent producer and the source headers, the duplicates are the broker's to swallow and the
> reader's to recognise.`,
  sequence: {
    participants: ['raw', 'cleaner', 'clean'],
    messages: [
      {from: 'raw', to: 'cleaner', label: 'poll → raw[1]@7 key=ana', kind: 'reply'},
      {from: 'cleaner', to: 'clean', label: 'produce key=ana, src_partition=1, src_offset=7', kind: 'async'},
      {from: 'raw', to: 'cleaner', label: 'poll → … (up to 20)', kind: 'reply'},
      {from: 'cleaner', to: 'clean', label: 'flush: wait for every ack (≤ 2 s)', kind: 'sync'},
      {from: 'clean', to: 'cleaner', label: 'acknowledged (idempotent: once per record)', kind: 'reply'},
      {from: 'cleaner', to: 'raw', label: 'commit raw[1] → 8, … (after the acks)', kind: 'sync'},
      {from: 'clean', to: 'cleaner', label: 'flush timed out / delivery error', kind: 'reply'},
      {from: 'cleaner', to: 'cleaner', label: 'BatchFailed — no commit; restart() re-reads the batch', kind: 'sync'},
    ],
  },
  hints: [
    'Two configs carry half the guarantee: `enable.auto.commit=false` on the consumer, `acks=all` + `enable.idempotence=true` on the producer (kafkajs: `autoCommit: false`, `producer({idempotent: true})` with `acks: -1`).',
    'Keep the batch as a list of consumed messages; finishing it is one function: flush with the timeout (collect the `send` promises and `Promise.all` them, each `send` with `timeout: FLUSH_TIMEOUT_MS`), check that nothing is unacknowledged or failed, then commit `offset + 1` per partition. Call it at `BATCH`, on an empty poll, and once more after the loop.',
    'A failed delivery report arrives through the callback (serve it with `poll(0)` after each produce) — a flag the batch checks before committing. Raise `BatchFailed` instead of committing: a restart re-reads the batch, and the headers make the second copies recognisable.',
  ],
  checks: [
    {
      id: 'transform-order',
      title: 'Every raw record lands on clean once, transformed, under its key, in order',
      detail:
        'Each record of `raw` becomes exactly one record of `clean` with `transform(value)` as value and the source key as key, so a key stays on one partition in its source order; all offsets end up committed.',
      match: {
        python: {all: [/producer\.produce\(/, /key\s*=\s*msg\.key\(\)/]},
        typescript: {all: [/producer\s*\.send\(/, /key:\s*message\.key/]},
        go: {all: [/writer\.WriteMessages\(/, /Key:\s*msg\.Key/]},
        scala: {all: [/producer\.send\(/, /record\.key\(\)/]},
        cpp: {all: [/producer->produce\(/, /msg->key_pointer\(\)/]},
      },
    },
    {
      id: 'source-headers',
      title: 'Headers src_partition and src_offset name the source record',
      detail:
        'Every record of `clean` carries `src_partition` and `src_offset` (decimal strings) pointing at the exact `raw` record it was made from — the identity a downstream consumer deduplicates on.',
      match: {
        python: {all: [/"src_partition"/, /"src_offset"/]},
        typescript: {all: [/src_partition/, /src_offset/]},
        go: {all: [/"src_partition"/, /"src_offset"/]},
        scala: {all: [/"src_partition"/, /"src_offset"/]},
        cpp: {all: [/"src_partition"/, /"src_offset"/]},
      },
    },
    {
      id: 'commit-after-acks',
      title: 'Commits a batch only after every record of it is acknowledged',
      detail:
        'Auto-commit is off; with the broker acknowledging `clean` one second late, every commit of `cleaner` happens after that second, and at commit time every record the commit covers is already on `clean`.',
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/], order: [/producer\.flush\(/, /consumer\.commit\(/]},
        typescript: {all: [/autoCommit:\s*false/], order: [/await Promise\.all\(/, /consumer\.commitOffsets\(/]},
        go: {
          all: [/reader\.FetchMessage\(/],
          none: [/ReadMessage\(/],
          order: [/writer\.WriteMessages\(/, /reader\.CommitMessages\(/],
        },
        scala: {
          all: [/"enable\.auto\.commit"\s*,\s*"false"/],
          order: [/\.get\([^\n]*TimeUnit\.MILLISECONDS\)/, /consumer\.commitSync\(/],
        },
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/], order: [/producer->flush\(/, /consumer->commitSync\(/]},
      },
    },
    {
      id: 'idempotent',
      title: 'A lost acknowledgement does not duplicate a record',
      detail:
        'The producer is idempotent with `acks=all`: when the broker writes a record but its ack is lost, the producer’s retry is recognised and `clean` holds the record once. (kafka-go has no idempotent mode: `RequireAll` with a hash balancer is what it can promise.)',
      match: {
        python: {all: [/"enable\.idempotence"\s*:\s*True/, /"acks"\s*:\s*"all"/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/"enable\.idempotence"\s*,\s*"true"/, /"acks"\s*,\s*"all"/]},
        cpp: {all: [/"enable\.idempotence"\s*,\s*"true"/, /"acks"\s*,\s*"all"/]},
      },
    },
    {
      id: 'flush-timeout',
      title: 'A flush that does not complete in FLUSH_TIMEOUT_MS fails the batch without a commit',
      detail:
        'With the broker never acknowledging `clean`, `run` raises `BatchFailed` about 2 s later, nothing is committed and nothing is on `clean`; after `restart()` with the broker back, every record is re-read, lands and is committed.',
      match: {
        python: {all: [/producer\.flush\(\s*FLUSH_TIMEOUT_MS\s*\/\s*1000\s*\)/, /raise BatchFailed\(/]},
        typescript: {all: [/timeout:\s*FLUSH_TIMEOUT_MS/, /throw new BatchFailed\(/]},
        go: {all: [/context\.WithTimeout\([^\n]*flushTimeout/, /fmt\.Errorf\("%w[^\n]*ErrBatchFailed/]},
        scala: {all: [/TimeUnit\.MILLISECONDS\)/, /throw new BatchFailed\(/]},
        cpp: {all: [/producer->flush\(\s*kFlushTimeoutMs\s*\)/, /throw BatchFailed\(/]},
      },
    },
    {
      id: 'replay-dedupable',
      title: 'A delivery error fails the batch; the replay after restart is deduplicable by the headers',
      detail:
        'One produce fails with a delivery error: nothing is committed although the other records landed. After `restart()` the batch is re-read, every `raw` record is on `clean` at least once, and the duplicates carry the same `src_partition`/`src_offset`, key and value as their first copies — grouped by the headers, exactly one record per source record remains.',
      match: {
        python: {all: [/len\(batch\)\s*>=\s*BATCH/, /on_delivery\s*=\s*on_delivery|callback\s*=\s*on_delivery/]},
        typescript: {all: [/>=\s*BATCH\b/, /\.catch\(/]},
        go: {all: [/>=\s*batchSize\b/, /if err := writer\.WriteMessages\(/]},
        scala: {all: [/>=\s*Batch\b/, /acks \+= producer\.send\(/]},
        cpp: {all: [/>=\s*kBatch\b/, /reports\.failed/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Consume raw, transform, produce clean: commit a batch only once every record of it is acknowledged."""
import logging
from typing import Callable

from confluent_kafka import Consumer, Producer, TopicPartition

log = logging.getLogger("cleaner")

RAW = "raw"
CLEAN = "clean"
GROUP = "cleaner"
BATCH = 20
FLUSH_TIMEOUT_MS = 2000


class BatchFailed(Exception):
    """A record of the batch was not acknowledged in time: nothing of the batch is committed."""


def _make_consumer() -> Consumer:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": GROUP,
            "auto.offset.reset": "earliest",
            # TODO: disable auto-commit
        }
    )
    consumer.subscribe([RAW])
    return consumer


def _make_producer() -> Producer:
    # TODO: acks=all and enable.idempotence: a lost ack must not duplicate a record
    return Producer({"bootstrap.servers": "kafka:9092"})


consumer = _make_consumer()
producer = _make_producer()


def restart() -> None:
    """A crashed process comes back: fresh clients, the consumer resuming from the group's committed offsets."""
    global consumer, producer
    consumer = _make_consumer()
    producer = _make_producer()
    # TODO: forget the failed delivery reports of the crashed process


def commit_batch(batch: list) -> None:
    # TODO: flush with FLUSH_TIMEOUT_MS; anything unacknowledged or failed → raise BatchFailed (no commit)
    # TODO: commit offset + 1 per partition of the batch, synchronously
    raise NotImplementedError


def run(transform: Callable[[str], str]) -> None:
    batch: list = []
    try:
        while True:
            msg = consumer.poll(1.0)
            if msg is None:
                # TODO: idle: finish the open batch
                continue
            if msg.error():
                log.error("consumer error: %s", msg.error())
                continue
            # TODO: produce transform(value) to CLEAN under msg's key, headers src_partition / src_offset,
            #       with a delivery callback that records failures; poll(0) to serve the reports
            # TODO: append msg to the batch; at BATCH records, commit_batch and start a new one
            raise NotImplementedError
    except KeyboardInterrupt:
        pass  # shutdown: the open batch is finished below
    # TODO: finish the open batch
`,
      solution: `"""Consume raw, transform, produce clean: commit a batch only once every record of it is acknowledged."""
import logging
from typing import Callable

from confluent_kafka import Consumer, Producer, TopicPartition

log = logging.getLogger("cleaner")

RAW = "raw"
CLEAN = "clean"
GROUP = "cleaner"
BATCH = 20
FLUSH_TIMEOUT_MS = 2000


class BatchFailed(Exception):
    """A record of the batch was not acknowledged in time: nothing of the batch is committed."""


def _make_consumer() -> Consumer:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": GROUP,
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
        }
    )
    consumer.subscribe([RAW])
    return consumer


def _make_producer() -> Producer:
    return Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


consumer = _make_consumer()
producer = _make_producer()
# Delivery reports that carried an error, served by poll()/flush(): one of them fails the whole batch.
failed: list = []


def restart() -> None:
    """A crashed process comes back: fresh clients, the consumer resuming from the group's committed offsets."""
    global consumer, producer
    consumer = _make_consumer()
    producer = _make_producer()
    failed.clear()


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("clean record for %s not delivered: %s", msg.key(), err)
        failed.append(err)


def commit_batch(batch: list) -> None:
    remaining = producer.flush(FLUSH_TIMEOUT_MS / 1000)  # every ack, or give up
    if remaining or failed:
        raise BatchFailed(f"{remaining} record(s) unacknowledged after {FLUSH_TIMEOUT_MS} ms, {len(failed)} failed")
    offsets: dict[tuple[str, int], int] = {}
    for msg in batch:  # delivered in order per partition: the last one is the batch's end
        offsets[(msg.topic(), msg.partition())] = msg.offset() + 1
    consumer.commit(offsets=[TopicPartition(t, p, o) for (t, p), o in offsets.items()], asynchronous=False)


def run(transform: Callable[[str], str]) -> None:
    batch: list = []
    try:
        while True:
            msg = consumer.poll(1.0)
            if msg is None:
                if batch:  # idle: finish the open batch
                    commit_batch(batch)
                    batch = []
                continue
            if msg.error():
                log.error("consumer error: %s", msg.error())
                continue
            producer.produce(
                CLEAN,
                key=msg.key(),
                value=transform(msg.value().decode()),
                headers={"src_partition": str(msg.partition()), "src_offset": str(msg.offset())},
                on_delivery=on_delivery,
            )
            producer.poll(0)  # serve delivery reports
            batch.append(msg)
            if len(batch) >= BATCH:
                commit_batch(batch)
                batch = []
    except KeyboardInterrupt:
        pass  # shutdown: the open batch is finished below
    if batch:
        commit_batch(batch)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const RAW = 'raw';
export const CLEAN = 'clean';
export const GROUP = 'cleaner';
export const BATCH = 20;
export const FLUSH_TIMEOUT_MS = 2000;

/** A record of the batch was not acknowledged in time: nothing of the batch is committed. */
export class BatchFailed extends Error {}

const kafka = new Kafka({clientId: 'cleaner', brokers: ['kafka:9092']});
let consumer = kafka.consumer({groupId: GROUP});
// TODO: an idempotent producer (requires acks: -1 on every send): a lost ack must not duplicate a record
let producer = kafka.producer();

/** A crashed process comes back: fresh clients, the consumer resuming from the group's committed offsets. */
export function restart(): void {
  consumer = kafka.consumer({groupId: GROUP});
  producer = kafka.producer();
}

interface Batch {
  /** Next offset to read, per partition, once the batch is committed. */
  offsets: Map<string, {topic: string; partition: number; offset: string}>;
  /** One per record: settles once the broker acknowledged it, or once the send gave up. */
  acks: Promise<void>[];
  failed: Error[];
}

const newBatch = (): Batch => ({offsets: new Map(), acks: [], failed: []});

async function commitBatch(batch: Batch): Promise<void> {
  // TODO: wait for every ack; anything failed → throw BatchFailed (no commit)
  // TODO: commitOffsets for the batch's partitions
  throw new Error('not implemented');
}

export async function run(transform: (value: string) => string): Promise<void> {
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({topic: RAW, fromBeginning: true});
  let batch = newBatch();
  await consumer.run({
    // TODO: disable auto-commit
    eachMessage: async ({topic, partition, message}) => {
      // TODO: send transform(value) to CLEAN under message.key with headers src_partition / src_offset,
      //       acks -1 and timeout FLUSH_TIMEOUT_MS; keep the promise in the batch, record a rejection as failed
      // TODO: record offset + 1 for this partition; at BATCH records, commitBatch and start a new one
      throw new Error('not implemented');
    },
  });
  // TODO: the consumer stopped: finish the open batch
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const RAW = 'raw';
export const CLEAN = 'clean';
export const GROUP = 'cleaner';
export const BATCH = 20;
export const FLUSH_TIMEOUT_MS = 2000;

/** A record of the batch was not acknowledged in time: nothing of the batch is committed. */
export class BatchFailed extends Error {}

const kafka = new Kafka({clientId: 'cleaner', brokers: ['kafka:9092']});
let consumer = kafka.consumer({groupId: GROUP});
let producer = kafka.producer({idempotent: true}); // requires acks: -1 (all) on every send

/** A crashed process comes back: fresh clients, the consumer resuming from the group's committed offsets. */
export function restart(): void {
  consumer = kafka.consumer({groupId: GROUP});
  producer = kafka.producer({idempotent: true});
}

interface Batch {
  /** Next offset to read, per partition, once the batch is committed. */
  offsets: Map<string, {topic: string; partition: number; offset: string}>;
  /** One per record: settles once the broker acknowledged it, or once the send gave up. */
  acks: Promise<void>[];
  failed: Error[];
}

const newBatch = (): Batch => ({offsets: new Map(), acks: [], failed: []});

async function commitBatch(batch: Batch): Promise<void> {
  await Promise.all(batch.acks); // every ack — each send gives up after FLUSH_TIMEOUT_MS
  if (batch.failed.length > 0)
    throw new BatchFailed(\`\${batch.failed.length} record(s) not acknowledged: \${batch.failed[0].message}\`);
  await consumer.commitOffsets([...batch.offsets.values()]);
}

export async function run(transform: (value: string) => string): Promise<void> {
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({topic: RAW, fromBeginning: true});
  let batch = newBatch();
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const current = batch;
      current.acks.push(
        producer
          .send({
            topic: CLEAN,
            acks: -1,
            timeout: FLUSH_TIMEOUT_MS,
            messages: [
              {
                key: message.key,
                value: transform(message.value?.toString() ?? ''),
                headers: {src_partition: String(partition), src_offset: message.offset},
              },
            ],
          })
          .then(() => undefined)
          .catch((err: Error) => {
            current.failed.push(err);
          }),
      );
      current.offsets.set(\`\${topic}|\${partition}\`, {topic, partition, offset: String(Number(message.offset) + 1)});
      if (current.acks.length >= BATCH) {
        batch = newBatch();
        await commitBatch(current);
      }
    },
  });
  if (batch.acks.length > 0) await commitBatch(batch); // the consumer stopped: finish the open batch
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	rawTopic     = "raw"
	cleanTopic   = "clean"
	group        = "cleaner"
	batchSize    = 20
	flushTimeout = 2000 * time.Millisecond
)

// ErrBatchFailed: a record of the batch was not acknowledged in time; nothing of the batch is committed.
var ErrBatchFailed = errors.New("batch not acknowledged")

func newReader() *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers:     []string{"kafka:9092"},
		GroupID:     group,
		Topic:       rawTopic,
		StartOffset: kafka.FirstOffset,
	})
}

func newWriter() *kafka.Writer {
	return &kafka.Writer{
		Addr:  kafka.TCP("kafka:9092"),
		Topic: cleanTopic,
		// TODO: RequireAll acks and a Hash balancer (kafka-go has no idempotent mode: this is what it can promise)
	}
}

var (
	reader = newReader()
	writer = newWriter()
)

// restart: a crashed process comes back with fresh clients; the reader resumes from the group's committed offsets.
func restart() {
	reader = newReader()
	writer = newWriter()
}

func commitBatch(ctx context.Context, batch []kafka.Message, out []kafka.Message) error {
	// TODO: WriteMessages under a context bounded by flushTimeout (synchronous: returns once every record is acknowledged);
	//       an error wraps ErrBatchFailed and nothing is committed
	// TODO: CommitMessages for the batch
	return fmt.Errorf("%w: not implemented", ErrBatchFailed)
}

func run(ctx context.Context, transform func(string) string) error {
	var batch, out []kafka.Message
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want); context cancelled → shutdown: finish the open batch
		// TODO: append the transformed record (same Key, headers src_partition / src_offset) to out and msg to batch
		// TODO: at batchSize records, commitBatch and start a new one
		_ = strconv.Itoa
		return errors.New("not implemented")
	}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	rawTopic     = "raw"
	cleanTopic   = "clean"
	group        = "cleaner"
	batchSize    = 20
	flushTimeout = 2000 * time.Millisecond
)

// ErrBatchFailed: a record of the batch was not acknowledged in time; nothing of the batch is committed.
var ErrBatchFailed = errors.New("batch not acknowledged")

func newReader() *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers:     []string{"kafka:9092"},
		GroupID:     group,
		Topic:       rawTopic,
		StartOffset: kafka.FirstOffset,
	})
}

func newWriter() *kafka.Writer {
	return &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Topic:        cleanTopic,
		Balancer:     &kafka.Hash{},    // same key → same partition, as on raw
		RequiredAcks: kafka.RequireAll, // kafka-go has no idempotent mode: RequireAll plus the src_* headers is what it can promise
	}
}

var (
	reader = newReader()
	writer = newWriter()
)

// restart: a crashed process comes back with fresh clients; the reader resumes from the group's committed offsets.
func restart() {
	reader = newReader()
	writer = newWriter()
}

func commitBatch(ctx context.Context, batch []kafka.Message, out []kafka.Message) error {
	flushCtx, cancel := context.WithTimeout(ctx, flushTimeout)
	defer cancel()
	// Synchronous: returns once every record is acknowledged, or with the first error / the deadline.
	if err := writer.WriteMessages(flushCtx, out...); err != nil {
		return fmt.Errorf("%w: %v", ErrBatchFailed, err)
	}
	return reader.CommitMessages(ctx, batch...)
}

func run(ctx context.Context, transform func(string) string) error {
	var batch, out []kafka.Message
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				break // shutdown: the open batch is finished below
			}
			return err
		}
		out = append(out, kafka.Message{
			Key:   msg.Key,
			Value: []byte(transform(string(msg.Value))),
			Headers: []kafka.Header{
				{Key: "src_partition", Value: []byte(strconv.Itoa(msg.Partition))},
				{Key: "src_offset", Value: []byte(strconv.FormatInt(msg.Offset, 10))},
			},
		})
		batch = append(batch, msg)
		if len(batch) >= batchSize {
			if err := commitBatch(context.Background(), batch, out); err != nil {
				return err
			}
			batch, out = nil, nil
		}
	}
	if len(batch) > 0 {
		return commitBatch(context.Background(), batch, out)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.{Future, TimeUnit}

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.errors.WakeupException
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.collection.mutable
import scala.jdk.CollectionConverters._

object Cleaner {
  val RawTopic = "raw"
  val CleanTopic = "clean"
  val Group = "cleaner"
  val Batch = 20
  val FlushTimeoutMs = 2000L

  /** A record of the batch was not acknowledged in time: nothing of the batch is committed. */
  final class BatchFailed(message: String) extends RuntimeException(message)

  private def makeConsumer(): KafkaConsumer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    // TODO: disable auto-commit
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(RawTopic).asJava)
    consumer
  }

  private def makeProducer(): KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    // TODO: acks=all and enable.idempotence: a lost ack must not duplicate a record
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  private var consumer = makeConsumer()
  private var producer = makeProducer()

  /** A crashed process comes back: fresh clients, the consumer resuming from the group's committed offsets. */
  def restart(): Unit = {
    consumer = makeConsumer()
    producer = makeProducer()
  }

  private def commitBatch(batch: Seq[ConsumerRecord[String, String]], acks: Seq[Future[RecordMetadata]]): Unit = {
    // TODO: wait for every ack within FlushTimeoutMs in total; a timeout or an error → throw BatchFailed (no commit)
    // TODO: commitSync offset + 1 per partition of the batch
    throw new BatchFailed("not implemented")
  }

  def run(transform: String => String): Unit = {
    val batch = mutable.ArrayBuffer.empty[ConsumerRecord[String, String]]
    val acks = mutable.ArrayBuffer.empty[Future[RecordMetadata]]
    try
      while (true) {
        val records = consumer.poll(Duration.ofSeconds(1))
        // TODO: no records (idle) → finish the open batch
        records.asScala.foreach { record =>
          // TODO: send transform(value) to CleanTopic under record's key with headers src_partition / src_offset; keep the Future
          // TODO: append record to the batch; at Batch records, commitBatch and start a new one
        }
      }
    catch { case _: WakeupException => () } // shutdown: the open batch is finished below
    // TODO: finish the open batch
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.{Future, TimeUnit}

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.errors.WakeupException
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.collection.mutable
import scala.jdk.CollectionConverters._

object Cleaner {
  val RawTopic = "raw"
  val CleanTopic = "clean"
  val Group = "cleaner"
  val Batch = 20
  val FlushTimeoutMs = 2000L

  /** A record of the batch was not acknowledged in time: nothing of the batch is committed. */
  final class BatchFailed(message: String) extends RuntimeException(message)

  private def makeConsumer(): KafkaConsumer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(RawTopic).asJava)
    consumer
  }

  private def makeProducer(): KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all")
    props.put("enable.idempotence", "true")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  private var consumer = makeConsumer()
  private var producer = makeProducer()

  /** A crashed process comes back: fresh clients, the consumer resuming from the group's committed offsets. */
  def restart(): Unit = {
    consumer = makeConsumer()
    producer = makeProducer()
  }

  private def commitBatch(batch: Seq[ConsumerRecord[String, String]], acks: Seq[Future[RecordMetadata]]): Unit = {
    val deadline = System.currentTimeMillis() + FlushTimeoutMs
    try acks.foreach(_.get(math.max(0L, deadline - System.currentTimeMillis()), TimeUnit.MILLISECONDS)) // every ack, or give up
    catch { case e: Exception => throw new BatchFailed(s"batch not acknowledged: \${e.getMessage}") }
    val offsets = batch
      .groupBy(r => new TopicPartition(r.topic(), r.partition()))
      .map { case (tp, rs) => tp -> new OffsetAndMetadata(rs.map(_.offset()).max + 1) }
    consumer.commitSync(offsets.asJava)
  }

  def run(transform: String => String): Unit = {
    val batch = mutable.ArrayBuffer.empty[ConsumerRecord[String, String]]
    val acks = mutable.ArrayBuffer.empty[Future[RecordMetadata]]
    def finish(): Unit = {
      commitBatch(batch.toSeq, acks.toSeq)
      batch.clear()
      acks.clear()
    }
    try
      while (true) {
        val records = consumer.poll(Duration.ofSeconds(1))
        if (records.isEmpty && batch.nonEmpty) finish() // idle: finish the open batch
        records.asScala.foreach { record =>
          val out = new ProducerRecord[String, String](CleanTopic, record.key(), transform(record.value()))
          out.headers().add("src_partition", record.partition().toString.getBytes)
          out.headers().add("src_offset", record.offset().toString.getBytes)
          acks += producer.send(out)
          batch += record
          if (batch.size >= Batch) finish()
        }
      }
    catch { case _: WakeupException => () } // shutdown: the open batch is finished below
    if (batch.nonEmpty) finish()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

const std::string kRawTopic = "raw";
const std::string kCleanTopic = "clean";
const std::string kGroup = "cleaner";
constexpr int kBatch = 20;
constexpr int kFlushTimeoutMs = 2000;

// A record of the batch was not acknowledged in time: nothing of the batch is committed.
struct BatchFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// TODO: a DeliveryReportCb that counts the reports that carried an error

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kRawTopic});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // TODO: acks=all, enable.idempotence=true, dr_cb: a lost ack must not duplicate a record
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();

// A crashed process comes back: fresh clients, the consumer resuming from the group's committed offsets.
void restart() {
  consumer = make_consumer();
  producer = make_producer();
  // TODO: forget the failed delivery reports of the crashed process
}

void commit_batch() {
  // TODO: flush with kFlushTimeoutMs; a timeout or a failed delivery report → throw BatchFailed (no commit)
  // TODO: commitSync the consumed positions (the batch's offsets)
  throw BatchFailed("not implemented");
}

void run(const std::function<std::string(const std::string&)>& transform) {
  int in_batch = 0;
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) {
      // TODO: idle: finish the open batch
      continue;
    }
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    // TODO: produce transform(value) to kCleanTopic under msg's key (RK_MSG_COPY) with headers src_partition / src_offset;
    //       poll(0) to serve delivery reports
    // TODO: count the record; at kBatch records, commit_batch and start a new one
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

const std::string kRawTopic = "raw";
const std::string kCleanTopic = "clean";
const std::string kGroup = "cleaner";
constexpr int kBatch = 20;
constexpr int kFlushTimeoutMs = 2000;

// A record of the batch was not acknowledged in time: nothing of the batch is committed.
struct BatchFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Delivery reports, served by poll()/flush(): one that carries an error fails the whole batch.
class DeliveryReports : public RdKafka::DeliveryReportCb {
 public:
  int failed = 0;
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "clean record not delivered: " << message.errstr() << "\\n";
      ++failed;
    }
  }
};

DeliveryReports reports;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kRawTopic});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("dr_cb", &reports, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();

// A crashed process comes back: fresh clients, the consumer resuming from the group's committed offsets.
void restart() {
  consumer = make_consumer();
  producer = make_producer();
  reports.failed = 0;
}

void commit_batch() {
  const RdKafka::ErrorCode flushed = producer->flush(kFlushTimeoutMs);  // every ack, or give up
  if (flushed != RdKafka::ERR_NO_ERROR || reports.failed > 0) {
    throw BatchFailed("batch not acknowledged: " + std::to_string(producer->outq_len()) + " in flight, " +
                      std::to_string(reports.failed) + " failed");
  }
  consumer->commitSync();  // the consumed positions: exactly the batch's offsets, the earlier ones being committed
}

void run(const std::function<std::string(const std::string&)>& transform) {
  int in_batch = 0;
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) {
      if (in_batch > 0) {  // idle: finish the open batch
        commit_batch();
        in_batch = 0;
      }
      continue;
    }
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    const std::string out = transform(value);
    auto headers = std::unique_ptr<RdKafka::Headers>(RdKafka::Headers::create());
    headers->add("src_partition", std::to_string(msg->partition()));
    headers->add("src_offset", std::to_string(msg->offset()));
    const RdKafka::ErrorCode err =
        producer->produce(kCleanTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                          const_cast<char*>(out.data()), out.size(), msg->key_pointer(), msg->key_len(), 0,
                          headers.get(), nullptr);
    if (err != RdKafka::ERR_NO_ERROR) throw BatchFailed("produce failed: " + RdKafka::err2str(err));
    headers.release();  // owned by the producer now
    producer->poll(0);  // serve delivery reports
    if (++in_batch >= kBatch) {
      commit_batch();
      in_batch = 0;
    }
  }
}
`,
    },
  },
  harness: {
    python: `RAW = "raw"
CLEAN = "clean"
GROUP = "cleaner"
# Seven records over four keys: ana's three must stay in this order on one partition of clean.
EVENTS = [("ana", " hello "), ("bo", "x"), ("ana", "world"), ("cy", "ok"), ("bo", "y"), ("ana", "!"), ("dee", "z")]


def _transform(value: str) -> str:
    return value.strip().upper()


def _seed(ctx):
    return [ctx.kafka.seed(RAW, key=key, value=value) for key, value in EVENTS]


def _header(record, name: str):
    return next((value.decode() for n, value in (record.headers or []) if n == name), None)


def _source(record):
    """(src_partition, src_offset) of a clean record, as ints; asserts the headers are there."""
    partition, offset = _header(record, "src_partition"), _header(record, "src_offset")
    assert partition is not None and offset is not None, f"clean record {record.value!r} has headers {record.headers!r}: every record needs src_partition and src_offset"
    assert partition.isdigit() and offset.isdigit(), f"src_partition/src_offset must be decimal strings, got {partition!r}/{offset!r}"
    return int(partition), int(offset)


def _run_fails(ctx, m):
    """run(transform) must raise BatchFailed; anything else is a verdict."""
    try:
        ctx.drain(m.run, _transform)
    except m.BatchFailed:
        return
    raise AssertionError("run returned although a record of the batch was never acknowledged: the batch must fail (BatchFailed) and nothing of it be committed")


def check_transform_order(ctx):
    seeded = _seed(ctx)
    m = ctx.load("cleaner")
    ctx.drain(m.run, _transform)
    clean = ctx.kafka.records(CLEAN)
    assert len(clean) == len(seeded), f"clean holds {len(clean)} records for {len(seeded)} raw ones: each raw record becomes exactly one clean record"
    for key in sorted({k for k, _ in EVENTS}):
        expected = [_transform(v) for k, v in EVENTS if k == key]
        mine = sorted((r for r in clean if r.key == key.encode()), key=lambda r: r.offset)
        assert [r.value.decode() for r in mine] == expected, f"clean records keyed {key!r} are {[r.value for r in mine]}, expected {expected} (transform(value), in raw order)"
        partitions = {r.partition for r in mine}
        assert partitions == {ctx.kafka.partition_for(CLEAN, key.encode())}, f"records keyed {key!r} are spread over partitions {sorted(partitions)} of clean: produce under the source key so a key stays on one partition"
    assert ctx.kafka.lag(GROUP, RAW) == 0, f"{ctx.kafka.lag(GROUP, RAW)} raw record(s) were never committed: finish the open batch before run returns"


def check_source_headers(ctx):
    seeded = _seed(ctx)
    m = ctx.load("cleaner")
    ctx.drain(m.run, _transform)
    clean = ctx.kafka.records(CLEAN)
    assert clean, "nothing reached clean"
    by_source = {(r.partition, r.offset): r for r in seeded}
    for r in clean:
        src = by_source.get(_source(r))
        assert src is not None, f"clean record {r.value!r} points at raw{list(_source(r))}, which does not exist"
        assert r.value.decode() == _transform(src.value.decode()) and r.key == src.key, f"clean record {r.value!r} (key {r.key!r}) points at raw{list(_source(r))}, whose transform is {_transform(src.value.decode())!r} (key {src.key!r})"
    assert {_source(r) for r in clean} == set(by_source), f"the headers of clean name the raw records {sorted(_source(r) for r in clean)}, expected every one of {sorted(by_source)}"


def check_commit_after_acks(ctx):
    seeded = _seed(ctx)
    ctx.kafka.stall(CLEAN, 1)  # the broker acknowledges produces to clean one second from now
    started = ctx.clock.time()
    commits = []

    def snapshot(group, offsets):
        on_clean = ctx.kafka.records(CLEAN)
        # clean is keyed like raw (same hash, same partition count): partition p of clean must already hold
        # at least as many records as the commit covers of raw's partition p.
        short = {p: upto - sum(1 for r in on_clean if r.partition == p) for (topic, p), upto in offsets.items() if topic == RAW}
        commits.append((group, {p: n for p, n in short.items() if n > 0}, ctx.clock.time() - started))

    ctx.kafka.on_commit(snapshot)
    m = ctx.load("cleaner")
    ctx.drain(m.run, _transform)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, before the records were acknowledged"
    assert commits, "no offset was ever committed"
    for group, short, at in commits:
        assert group == GROUP, f"offsets were committed for group {group!r}, expected {GROUP!r}"
        assert not short, f"at commit time clean was still missing {short} record(s) (per partition) the commit covers: flush and wait for every ack before committing"
        assert at >= 1.0, f"committed {at:.1f} s in, before the broker acknowledged anything (it answers after 1 s): the commit must wait for the acks"
    assert len(ctx.kafka.records(CLEAN)) == len(seeded)
    assert ctx.kafka.lag(GROUP, RAW) == 0, f"{ctx.kafka.lag(GROUP, RAW)} raw record(s) were never committed"


def check_idempotent(ctx):
    seeded = _seed(ctx)
    ctx.kafka.lose_acks(CLEAN, 2)  # two records are written but their acks never arrive: the producer retries
    m = ctx.load("cleaner")
    ctx.drain(m.run, _transform)
    clean = ctx.kafka.records(CLEAN)
    assert len(clean) == len(seeded), f"clean holds {len(clean)} records for {len(seeded)} raw ones: a produce whose ack was lost was retried and written twice — enable.idempotence with acks=all lets the broker recognise the retry"
    assert ctx.kafka.lag(GROUP, RAW) == 0, f"{ctx.kafka.lag(GROUP, RAW)} raw record(s) were never committed"


def check_flush_timeout(ctx):
    seeded = _seed(ctx)
    ctx.kafka.stall(CLEAN)  # the broker never acknowledges produces to clean
    started = ctx.clock.time()
    m = ctx.load("cleaner")
    _run_fails(ctx, m)
    waited = ctx.clock.time() - started
    assert waited <= 2.5, f"run gave up after {waited:.1f} s: a flush waits at most FLUSH_TIMEOUT_MS (2 s)"
    assert ctx.kafka.commits(GROUP) == [], f"offsets were committed ({ctx.kafka.commits(GROUP)}) although no record of the batch was acknowledged: the batch would be lost"
    assert ctx.kafka.lag(GROUP, RAW) == len(seeded)
    assert ctx.kafka.records(CLEAN) == []
    ctx.kafka.resume(CLEAN)
    m.restart()
    ctx.drain(m.run, _transform)
    got = sorted(v.decode() for v in ctx.kafka.values(CLEAN))
    assert got == sorted(_transform(v) for _, v in EVENTS), f"after restart() clean holds {got}: the failed batch must be re-read from the committed offsets and land"
    assert ctx.kafka.lag(GROUP, RAW) == 0, f"{ctx.kafka.lag(GROUP, RAW)} raw record(s) were never committed after the restart"


def check_replay_dedupable(ctx):
    seeded = _seed(ctx)
    ctx.kafka.fail_next(CLEAN)  # the first produce fails with a retriable delivery error; the others land
    m = ctx.load("cleaner")
    _run_fails(ctx, m)
    landed = len(ctx.kafka.records(CLEAN))
    assert ctx.kafka.commits(GROUP) == [], f"offsets were committed ({ctx.kafka.commits(GROUP)}) although a record of the batch failed: it would be lost"
    assert landed == len(seeded) - 1, f"{landed} records reached clean on the failed attempt, expected the {len(seeded) - 1} whose produce did not fail"
    m.restart()
    ctx.drain(m.run, _transform)
    clean = ctx.kafka.records(CLEAN)
    assert ctx.kafka.lag(GROUP, RAW) == 0, f"{ctx.kafka.lag(GROUP, RAW)} raw record(s) were never committed after the restart"
    assert len(clean) == landed + len(seeded), f"clean holds {len(clean)} records after the replay, expected {landed} from the failed attempt plus {len(seeded)} re-read"
    sources = {(r.partition, r.offset) for r in seeded}
    by_source = {}
    for r in clean:
        by_source.setdefault(_source(r), []).append(r)
    assert set(by_source) == sources, f"deduplicated by src_partition/src_offset, clean names the raw records {sorted(by_source)}, expected exactly {sorted(sources)}"
    for src, copies in by_source.items():
        assert len({(r.key, r.value) for r in copies}) == 1, f"the copies of raw{list(src)} on clean differ: {[(r.key, r.value) for r in copies]} — a replay must produce the same key and value"
    assert sum(len(c) > 1 for c in by_source.values()) == landed, "the records that landed on the failed attempt must appear twice, with the same headers both times"
`,
    typescript: `const RAW = 'raw';
const CLEAN = 'clean';
const GROUP = 'cleaner';
/** Seven records over four keys: ana's three must stay in this order on one partition of clean. */
const EVENTS: [string, string][] = [['ana', ' hello '], ['bo', 'x'], ['ana', 'world'], ['cy', 'ok'], ['bo', 'y'], ['ana', '!'], ['dee', 'z']];

const transform = (value: string): string => value.trim().toUpperCase();

const seed = ctx => EVENTS.map(([key, value]) => ctx.kafka.seed(RAW, {key, value}));

/** 'src_partition/src_offset' of a clean record; asserts the headers are there. */
function source(record): string {
  const partition = record.headers.src_partition === undefined ? null : String(record.headers.src_partition);
  const offset = record.headers.src_offset === undefined ? null : String(record.headers.src_offset);
  assert(partition !== null && offset !== null, \`clean record \${JSON.stringify(String(record.value))} has headers \${JSON.stringify(Object.keys(record.headers))}: every record needs src_partition and src_offset\`);
  assert(/^\\d+$/.test(partition) && /^\\d+$/.test(offset), \`src_partition/src_offset must be decimal strings, got \${JSON.stringify(partition)}/\${JSON.stringify(offset)}\`);
  return \`\${partition}/\${offset}\`;
}

/** run(transform) must reject with BatchFailed; anything else is a verdict. */
async function runFails(ctx, m): Promise<void> {
  let failure: unknown = null;
  try {
    await ctx.drain(m.run(transform));
  } catch (e) {
    failure = e;
  }
  assert(failure !== null, 'run resolved although a record of the batch was never acknowledged: the batch must fail (BatchFailed) and nothing of it be committed');
  assert(failure instanceof m.BatchFailed, \`run failed with \${String(failure)}, expected BatchFailed\`);
}

export async function check_transform_order(ctx) {
  const seeded = seed(ctx);
  const m = ctx.load('cleaner');
  await ctx.drain(m.run(transform));
  const clean = ctx.kafka.records(CLEAN);
  assert.equal(clean.length, seeded.length, \`clean holds \${clean.length} records for \${seeded.length} raw ones: each raw record becomes exactly one clean record\`);
  for (const key of [...new Set(EVENTS.map(([k]) => k))].sort()) {
    const expected = EVENTS.filter(([k]) => k === key).map(([, v]) => transform(v));
    const mine = clean.filter(r => String(r.key) === key).sort((a, b) => a.offset - b.offset);
    assert.deepEqual(mine.map(r => String(r.value)), expected, \`clean records keyed \${key} are \${JSON.stringify(mine.map(r => String(r.value)))}, expected \${JSON.stringify(expected)} (transform(value), in raw order)\`);
    const partitions = [...new Set(mine.map(r => r.partition))];
    const home = ctx.kafka.partitionFor(CLEAN, seeded.find(r => String(r.key) === key).key);
    assert.deepEqual(partitions, [home], \`records keyed \${key} are on partitions \${JSON.stringify(partitions)} of clean, expected all on \${home}: produce under the source key so a key stays on one partition\`);
  }
  assert.equal(ctx.kafka.lag(GROUP, RAW), 0, \`\${ctx.kafka.lag(GROUP, RAW)} raw record(s) were never committed: finish the open batch before run resolves\`);
}

export async function check_source_headers(ctx) {
  const seeded = seed(ctx);
  const m = ctx.load('cleaner');
  await ctx.drain(m.run(transform));
  const clean = ctx.kafka.records(CLEAN);
  assert(clean.length > 0, 'nothing reached clean');
  const bySource = new Map(seeded.map(r => [\`\${r.partition}/\${r.offset}\`, r]));
  for (const r of clean) {
    const src = bySource.get(source(r));
    assert(src !== undefined, \`clean record \${JSON.stringify(String(r.value))} points at raw[\${source(r)}], which does not exist\`);
    assert(String(r.value) === transform(String(src.value)) && String(r.key) === String(src.key), \`clean record \${JSON.stringify(String(r.value))} (key \${String(r.key)}) points at raw[\${source(r)}], whose transform is \${JSON.stringify(transform(String(src.value)))} (key \${String(src.key)})\`);
  }
  assert.deepEqual([...new Set(clean.map(source))].sort(), [...bySource.keys()].sort(), \`the headers of clean name the raw records \${JSON.stringify([...new Set(clean.map(source))].sort())}, expected every one of \${JSON.stringify([...bySource.keys()].sort())}\`);
}

export async function check_commit_after_acks(ctx) {
  const seeded = seed(ctx);
  ctx.kafka.stall(CLEAN, 1); // the broker acknowledges produces to clean one second from now
  const started = ctx.clock.now();
  const commits: {group: string; short: Record<string, number>; at: number}[] = [];
  ctx.kafka.onCommit((group, offsets) => {
    const onClean = ctx.kafka.records(CLEAN);
    // clean is keyed like raw (same hash, same partition count): partition p of clean must already hold
    // at least as many records as the commit covers of raw's partition p.
    const short: Record<string, number> = {};
    for (const [tp, upto] of offsets) {
      const [topic, p] = tp.split('|');
      if (topic !== RAW) continue;
      const missing = upto - onClean.filter(r => r.partition === Number(p)).length;
      if (missing > 0) short[p] = missing;
    }
    commits.push({group, short, at: (ctx.clock.now() - started) / 1000});
  });
  const m = ctx.load('cleaner');
  await ctx.drain(m.run(transform));
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, before the records were acknowledged');
  assert(commits.length > 0, 'no offset was ever committed');
  for (const {group, short, at} of commits) {
    assert.equal(group, GROUP, \`offsets were committed for group \${JSON.stringify(group)}, expected \${JSON.stringify(GROUP)}\`);
    assert.deepEqual(short, {}, \`at commit time clean was still missing \${JSON.stringify(short)} record(s) (per partition) the commit covers: await every send before committing\`);
    assert(at >= 1, \`committed \${at.toFixed(1)} s in, before the broker acknowledged anything (it answers after 1 s): the commit must wait for the acks\`);
  }
  assert.equal(ctx.kafka.records(CLEAN).length, seeded.length);
  assert.equal(ctx.kafka.lag(GROUP, RAW), 0, \`\${ctx.kafka.lag(GROUP, RAW)} raw record(s) were never committed\`);
}

export async function check_idempotent(ctx) {
  const seeded = seed(ctx);
  ctx.kafka.loseAcks(CLEAN, 2); // two records are written but their acks never arrive: the producer retries
  const m = ctx.load('cleaner');
  await ctx.drain(m.run(transform));
  const clean = ctx.kafka.records(CLEAN);
  assert.equal(clean.length, seeded.length, \`clean holds \${clean.length} records for \${seeded.length} raw ones: a send whose ack was lost was retried and written twice — an idempotent producer (acks -1) lets the broker recognise the retry\`);
  assert.equal(ctx.kafka.lag(GROUP, RAW), 0, \`\${ctx.kafka.lag(GROUP, RAW)} raw record(s) were never committed\`);
}

export async function check_flush_timeout(ctx) {
  const seeded = seed(ctx);
  ctx.kafka.stall(CLEAN); // the broker never acknowledges produces to clean
  const started = ctx.clock.now();
  const m = ctx.load('cleaner');
  await runFails(ctx, m);
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 2.5, \`run gave up after \${waited.toFixed(1)} s: a send waits at most FLUSH_TIMEOUT_MS (2 s)\`);
  assert.deepEqual(ctx.kafka.commits(GROUP), [], \`offsets were committed (\${JSON.stringify(ctx.kafka.commits(GROUP))}) although no record of the batch was acknowledged: the batch would be lost\`);
  assert.equal(ctx.kafka.lag(GROUP, RAW), seeded.length);
  assert.equal(ctx.kafka.records(CLEAN).length, 0);
  ctx.kafka.resume(CLEAN);
  m.restart();
  await ctx.drain(m.run(transform));
  const got = ctx.kafka.values(CLEAN).sort();
  assert.deepEqual(got, EVENTS.map(([, v]) => transform(v)).sort(), \`after restart() clean holds \${JSON.stringify(got)}: the failed batch must be re-read from the committed offsets and land\`);
  assert.equal(ctx.kafka.lag(GROUP, RAW), 0, \`\${ctx.kafka.lag(GROUP, RAW)} raw record(s) were never committed after the restart\`);
}

export async function check_replay_dedupable(ctx) {
  const seeded = seed(ctx);
  ctx.kafka.failNext(CLEAN); // the first send fails with a retriable error; the others land
  const m = ctx.load('cleaner');
  await runFails(ctx, m);
  const landed = ctx.kafka.records(CLEAN).length;
  assert.deepEqual(ctx.kafka.commits(GROUP), [], \`offsets were committed (\${JSON.stringify(ctx.kafka.commits(GROUP))}) although a record of the batch failed: it would be lost\`);
  assert.equal(landed, seeded.length - 1, \`\${landed} records reached clean on the failed attempt, expected the \${seeded.length - 1} whose send did not fail\`);
  m.restart();
  await ctx.drain(m.run(transform));
  const clean = ctx.kafka.records(CLEAN);
  assert.equal(ctx.kafka.lag(GROUP, RAW), 0, \`\${ctx.kafka.lag(GROUP, RAW)} raw record(s) were never committed after the restart\`);
  assert.equal(clean.length, landed + seeded.length, \`clean holds \${clean.length} records after the replay, expected \${landed} from the failed attempt plus \${seeded.length} re-read\`);
  const sources = seeded.map(r => \`\${r.partition}/\${r.offset}\`).sort();
  const bySource = new Map<string, unknown[]>();
  for (const r of clean) bySource.set(source(r), [...(bySource.get(source(r)) ?? []), r]);
  assert.deepEqual([...bySource.keys()].sort(), sources, \`deduplicated by src_partition/src_offset, clean names the raw records \${JSON.stringify([...bySource.keys()].sort())}, expected exactly \${JSON.stringify(sources)}\`);
  for (const [src, copies] of bySource) {
    const distinct = new Set(copies.map(r => \`\${String(r.key)}=\${String(r.value)}\`));
    assert.equal(distinct.size, 1, \`the copies of raw[\${src}] on clean differ: \${JSON.stringify([...distinct])} — a replay must produce the same key and value\`);
  }
  assert.equal([...bySource.values()].filter(c => c.length > 1).length, landed, 'the records that landed on the failed attempt must appear twice, with the same headers both times');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/segmentio/kafka-go"

	"leetbuild/harness"
)

// cleanEvents are seven records over four keys: ana's three must stay in this order on one partition of clean.
var cleanEvents = [][2]string{{"ana", " hello "}, {"bo", "x"}, {"ana", "world"}, {"cy", "ok"}, {"bo", "y"}, {"ana", "!"}, {"dee", "z"}}

var decimalRe = regexp.MustCompile("^[0-9]+$")

func cleanTransform(value string) string { return strings.ToUpper(strings.TrimSpace(value)) }

func seedRaw(ctx *harness.Ctx) []harness.KafkaRecord {
	var seeded []harness.KafkaRecord
	for _, e := range cleanEvents {
		seeded = append(seeded, ctx.Kafka.Seed(rawTopic, e[0], e[1]))
	}
	return seeded
}

// runCleaner runs the learner's loop until it waits for input, then stops it (cancels its context):
// the open batch is finished before run returns.
func runCleaner(ctx *harness.Ctx) error {
	stop, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(stop, cleanTransform) }()
	ctx.Settle()
	cancel()
	var err error
	ctx.Drain(func() {
		e := <-done
		err = e
	})
	return err
}

// runFails: run must fail with ErrBatchFailed; anything else is a verdict.
func runFails(ctx *harness.Ctx) {
	err := runCleaner(ctx)
	ctx.Assert(err != nil, "run returned nil although a record of the batch was never acknowledged: the batch must fail (ErrBatchFailed) and nothing of it be committed")
	ctx.ErrorIs(err, ErrBatchFailed, "run failed with another error than ErrBatchFailed")
}

// cleanHome is the partition of clean the writer's Hash balancer puts key on.
func cleanHome(ctx *harness.Ctx, key []byte) int {
	partitions := make([]int, ctx.Kafka.Partitions(cleanTopic))
	for i := range partitions {
		partitions[i] = i
	}
	return (&kafka.Hash{}).Balance(kafka.Message{Key: key}, partitions...)
}

// sourceOf is "src_partition/src_offset" of a clean record; it asserts the headers are there.
func sourceOf(ctx *harness.Ctx, r harness.KafkaRecord) string {
	partition, hasPartition := r.Header("src_partition")
	offset, hasOffset := r.Header("src_offset")
	if !hasPartition || !hasOffset {
		var names []string
		for _, h := range r.Headers {
			names = append(names, h.Key)
		}
		ctx.Fatalf("clean record %q has headers %q: every record needs src_partition and src_offset", r.Value, names)
	}
	ctx.Assert(decimalRe.Match(partition) && decimalRe.Match(offset), "src_partition/src_offset must be decimal strings, got %q/%q", partition, offset)
	return string(partition) + "/" + string(offset)
}

func CheckTransformOrder(ctx *harness.Ctx) {
	seeded := seedRaw(ctx)
	ctx.NoError(runCleaner(ctx), "run(transform) returned an error")
	clean := ctx.Kafka.Records(cleanTopic)
	ctx.Assert(len(clean) == len(seeded), "clean holds %d records for %d raw ones: each raw record becomes exactly one clean record", len(clean), len(seeded))
	for _, key := range []string{"ana", "bo", "cy", "dee"} {
		var expected []string
		for _, e := range cleanEvents {
			if e[0] == key {
				expected = append(expected, cleanTransform(e[1]))
			}
		}
		var mine []harness.KafkaRecord
		for _, r := range clean {
			if string(r.Key) == key {
				mine = append(mine, r)
			}
		}
		sort.SliceStable(mine, func(i, j int) bool { return mine[i].Offset < mine[j].Offset })
		var values []string
		var partitions []int
		for _, r := range mine {
			values = append(values, string(r.Value))
			if len(partitions) == 0 || partitions[len(partitions)-1] != r.Partition {
				partitions = append(partitions, r.Partition)
			}
		}
		ctx.Equal(values, expected, "clean records keyed %s (transform(value), in raw order)", key)
		home := cleanHome(ctx, []byte(key))
		ctx.Equal(partitions, []int{home}, "partitions of clean holding the records keyed %s: produce under the source key so a key stays on one partition", key)
	}
	lag := ctx.Kafka.Lag(group, rawTopic)
	ctx.Assert(lag == 0, "%d raw record(s) were never committed: finish the open batch before run returns", lag)
}

func CheckSourceHeaders(ctx *harness.Ctx) {
	seeded := seedRaw(ctx)
	ctx.NoError(runCleaner(ctx), "run(transform) returned an error")
	clean := ctx.Kafka.Records(cleanTopic)
	ctx.Assert(len(clean) > 0, "nothing reached clean")
	bySource := map[string]harness.KafkaRecord{}
	var all []string
	for _, r := range seeded {
		src := fmt.Sprintf("%d/%d", r.Partition, r.Offset)
		bySource[src] = r
		all = append(all, src)
	}
	named := map[string]bool{}
	for _, r := range clean {
		source := sourceOf(ctx, r)
		src, ok := bySource[source]
		ctx.Assert(ok, "clean record %q points at raw[%s], which does not exist", r.Value, source)
		ctx.Assert(string(r.Value) == cleanTransform(string(src.Value)) && string(r.Key) == string(src.Key), "clean record %q (key %s) points at raw[%s], whose transform is %q (key %s)", r.Value, r.Key, source, cleanTransform(string(src.Value)), src.Key)
		named[source] = true
	}
	var names []string
	for source := range named {
		names = append(names, source)
	}
	sort.Strings(names)
	sort.Strings(all)
	ctx.Equal(names, all, "the headers of clean must name every raw record")
}

func CheckCommitAfterAcks(ctx *harness.Ctx) {
	seeded := seedRaw(ctx)
	ctx.Kafka.StallFor(cleanTopic, 1) // the broker acknowledges produces to clean one second from now
	started := ctx.Clock.Now()
	type commitSeen struct {
		group string
		short map[int]int
		at    float64
	}
	var commits []commitSeen
	ctx.Kafka.OnCommit(func(g string, offsets harness.KafkaOffsets) {
		// The writer puts a key on the partition its Hash balancer picks: partition p of clean must
		// already hold at least as many records as the commit covers of the raw records hashing to p.
		need := map[int]int{}
		for tp, upto := range offsets {
			if tp.Topic != rawTopic {
				continue
			}
			for _, r := range seeded {
				if r.Partition == tp.Partition && r.Offset < upto {
					need[cleanHome(ctx, r.Key)]++
				}
			}
		}
		have := map[int]int{}
		for _, r := range ctx.Kafka.Records(cleanTopic) {
			have[r.Partition]++
		}
		short := map[int]int{}
		for p, n := range need {
			if missing := n - have[p]; missing > 0 {
				short[p] = missing
			}
		}
		commits = append(commits, commitSeen{g, short, float64(ctx.Clock.Now()-started) / 1000})
	})
	ctx.NoError(runCleaner(ctx), "run(transform) returned an error")
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "auto-commit is on: offsets were committed on a timer, before the records were acknowledged")
	ctx.Assert(len(commits) > 0, "no offset was ever committed")
	for _, c := range commits {
		ctx.Equal(c.group, group, "offsets were committed for the wrong group")
		ctx.Assert(len(c.short) == 0, "at commit time clean was still missing %v record(s) (per partition) the commit covers: wait for every write before committing", c.short)
		ctx.Assert(c.at >= 1, "committed %.1f s in, before the broker acknowledged anything (it answers after 1 s): the commit must wait for the acks", c.at)
	}
	ctx.Equal(len(ctx.Kafka.Records(cleanTopic)), len(seeded), "records on clean")
	lag := ctx.Kafka.Lag(group, rawTopic)
	ctx.Assert(lag == 0, "%d raw record(s) were never committed", lag)
}

func CheckIdempotent(ctx *harness.Ctx) {
	seedRaw(ctx)
	ctx.Kafka.LoseAcks(cleanTopic, 2) // two records are written but their acks never arrive: the producer retries
	ctx.NoError(runCleaner(ctx), "run(transform) returned an error")
	// kafka-go has no idempotent producer (the step's Go detail): at least once, identical copies.
	landed := map[string]bool{}
	for _, r := range ctx.Kafka.Records(cleanTopic) {
		landed[string(r.Key)+"="+string(r.Value)] = true
	}
	var got, want []string
	for pair := range landed {
		got = append(got, pair)
	}
	for _, e := range cleanEvents {
		want = append(want, e[0]+"="+cleanTransform(e[1]))
	}
	sort.Strings(got)
	sort.Strings(want)
	ctx.Equal(got, want, "distinct key=value records on clean after two lost acks: a retried write must neither lose a record nor change it")
	lag := ctx.Kafka.Lag(group, rawTopic)
	ctx.Assert(lag == 0, "%d raw record(s) were never committed", lag)
}

func CheckFlushTimeout(ctx *harness.Ctx) {
	seeded := seedRaw(ctx)
	ctx.Kafka.Stall(cleanTopic) // the broker never acknowledges produces to clean
	started := ctx.Clock.Now()
	runFails(ctx)
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited <= 2.5, "run gave up after %.1f s: a write waits at most flushTimeout (2 s)", waited)
	commits := ctx.Kafka.Commits(group)
	ctx.Assert(len(commits) == 0, "offsets were committed (%v) although no record of the batch was acknowledged: the batch would be lost", commits)
	ctx.Equal(ctx.Kafka.Lag(group, rawTopic), len(seeded), "raw records not committed")
	ctx.Equal(len(ctx.Kafka.Records(cleanTopic)), 0, "records on clean")
	ctx.Kafka.Resume(cleanTopic)
	restart()
	ctx.NoError(runCleaner(ctx), "run(transform) after restart() returned an error")
	// kafka-go's Writer keeps the batch the failed run stopped waiting for and delivers it once the
	// broker answers again, so a record may land twice: count distinct values.
	distinct := map[string]bool{}
	for _, value := range ctx.Kafka.Values(cleanTopic) {
		distinct[value] = true
	}
	var got []string
	for value := range distinct {
		got = append(got, value)
	}
	sort.Strings(got)
	var want []string
	for _, e := range cleanEvents {
		want = append(want, cleanTransform(e[1]))
	}
	sort.Strings(want)
	ctx.Equal(got, want, "after restart() the failed batch must be re-read from the committed offsets and land: values on clean")
	lag := ctx.Kafka.Lag(group, rawTopic)
	ctx.Assert(lag == 0, "%d raw record(s) were never committed after the restart", lag)
}

func CheckReplayDedupable(ctx *harness.Ctx) {
	seeded := seedRaw(ctx)
	ctx.Kafka.FailNext(cleanTopic, 1) // the first write fails with a retriable error; the others land
	runFails(ctx)
	landed := len(ctx.Kafka.Records(cleanTopic))
	commits := ctx.Kafka.Commits(group)
	ctx.Assert(len(commits) == 0, "offsets were committed (%v) although a record of the batch failed: it would be lost", commits)
	ctx.Assert(landed == len(seeded)-1, "%d records reached clean on the failed attempt, expected the %d whose write did not fail", landed, len(seeded)-1)
	restart()
	ctx.NoError(runCleaner(ctx), "run(transform) after restart() returned an error")
	clean := ctx.Kafka.Records(cleanTopic)
	lag := ctx.Kafka.Lag(group, rawTopic)
	ctx.Assert(lag == 0, "%d raw record(s) were never committed after the restart", lag)
	ctx.Assert(len(clean) == landed+len(seeded), "clean holds %d records after the replay, expected %d from the failed attempt plus %d re-read", len(clean), landed, len(seeded))
	var sources []string
	for _, r := range seeded {
		sources = append(sources, fmt.Sprintf("%d/%d", r.Partition, r.Offset))
	}
	sort.Strings(sources)
	bySource := map[string][]harness.KafkaRecord{}
	for _, r := range clean {
		source := sourceOf(ctx, r)
		bySource[source] = append(bySource[source], r)
	}
	var named []string
	for source := range bySource {
		named = append(named, source)
	}
	sort.Strings(named)
	ctx.Equal(named, sources, "deduplicated by src_partition/src_offset, clean must name exactly the raw records")
	twice := 0
	for source, copies := range bySource {
		distinct := map[string]bool{}
		for _, r := range copies {
			distinct[string(r.Key)+"="+string(r.Value)] = true
		}
		ctx.Assert(len(distinct) == 1, "the copies of raw[%s] on clean differ: %v — a replay must produce the same key and value", source, distinct)
		if len(copies) > 1 {
			twice++
		}
	}
	ctx.Equal(twice, landed, "the records that landed on the failed attempt must appear twice, with the same headers both times")
}
`,
  },
  debrief: `The guarantee is an ordering, not a feature: produce, **flush**, then **commit**. Committing before the acks is at-most-once — a crash between the two loses the batch; committing after is at-least-once — a crash replays it. The two additions make the replay harmless. The **idempotent producer** (\`enable.idempotence\`, which requires \`acks=all\`) gives every record a producer id and a sequence number, so when a produce is written and its acknowledgement is lost, the broker recognises the retry and keeps one copy — the producer's own duplicates never exist. The **source headers** cover the duplicates the producer cannot see: a replay after a crash is a *new* produce of the same source record, and only \`src_partition\`/\`src_offset\` tell a downstream consumer so. Bounding the flush matters as much as ordering it: an unbounded flush on a dead broker holds the partition forever, while a bounded one fails the batch and lets a restart (or a rebalance to another member) try again. Real systems add Kafka transactions when the output and the offsets must move together (\`sendOffsetsToTransaction\`, \`read_committed\` readers), a deduplicating state store downstream keyed by the source headers, rebalance listeners that finish the open batch on revocation, and a dead-letter topic for records the transform rejects — a poison record must not fail the batch forever.`,
};
