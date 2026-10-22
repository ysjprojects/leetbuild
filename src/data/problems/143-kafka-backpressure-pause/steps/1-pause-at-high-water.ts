import type {Step} from '@/lib/types';

export const pauseAtHighWaterStep: Step = {
  id: 'pause-at-high-water',
  title: 'Pause the partitions when the buffer is full',
  concept: 'kafka',
  file: 'backpressure',
  focus: ['kafka', 'worker'],
  task: `## Task

Implement a consumer that fetches faster than it works, without ever holding more than a bounded
number of records in memory. Two loops share a queue: the **poll loop** fetches from \`jobs\` (group
\`workers\`, auto-commit off) and appends; the **drain loop** pops, calls the worker, and commits. When
the queue is full the poll loop **pauses** every assigned partition; when the drain loop has emptied it
far enough it **resumes** them.

- \`run(worker)\`: subscribe to \`jobs\` as group \`workers\` with \`enable.auto.commit\` off; start the
  drain loop beside the poll loop; return once \`stop()\` has ended both. \`worker(job)\` is awaited (a
  coroutine in Python / an \`async\` function in TypeScript) with \`job = {partition, offset, value}\`,
  \`value\` decoded as text.
- The poll loop keeps calling \`poll\` — it also serves the client's callbacks — and appends every record
  it gets. When the queue reaches **\`HIGH = 20\`** it pauses the whole assignment and sets \`paused\`.
  A paused consumer's \`poll\` returns nothing, so the loop idles for \`IDLE_S = 0.01\` on an empty poll;
  after each record it yields so the drain loop gets to run.
- The drain loop pops the oldest record, awaits \`worker(job)\`, **then** commits that record's offset
  (\`offset + 1\`), and counts it as processed. If the consumer is paused and the queue is down to
  **\`LOW = 5\`** or fewer, it resumes the assignment and clears \`paused\`. Records are processed in the
  order fetched, so each partition stays in offset order.
- \`stats()\` returns \`{queued, paused, processed}\`: records waiting in the queue, whether the
  partitions are paused, records committed so far.
- \`stop()\`: stop polling, let the drain loop finish what is queued, close the consumer.

:::widget consumer-groups {"partitions": 3}

> Pause is the consumer telling the broker "no more for now" without leaving the group. Blocking the
> poll loop instead would stop the heartbeats and callbacks too — after \`max.poll.interval.ms\` the
> broker assumes the consumer died and rebalances its partitions away.`,
  sequence: {
    participants: ['Kafka', 'poll loop', 'queue', 'drain loop'],
    messages: [
      {from: 'poll loop', to: 'Kafka', label: 'poll', kind: 'sync'},
      {from: 'Kafka', to: 'poll loop', label: 'jobs[1]@37', kind: 'reply'},
      {from: 'poll loop', to: 'queue', label: 'append → 20 queued = HIGH', kind: 'sync'},
      {from: 'poll loop', to: 'Kafka', label: 'pause(assignment)', kind: 'sync'},
      {from: 'poll loop', to: 'Kafka', label: 'poll → nothing (paused)', kind: 'sync'},
      {from: 'drain loop', to: 'queue', label: 'pop jobs[0]@12 → worker', kind: 'sync'},
      {from: 'drain loop', to: 'Kafka', label: 'commit jobs[0] → 13', kind: 'sync'},
      {from: 'drain loop', to: 'queue', label: '… pops until 5 queued = LOW', kind: 'sync'},
      {from: 'drain loop', to: 'Kafka', label: 'resume(assignment)', kind: 'sync'},
      {from: 'Kafka', to: 'poll loop', label: 'jobs[2]@40 (fetching again)', kind: 'reply'},
    ],
  },
  hints: [
    'Two loops, one queue, one `paused` flag. The poll loop only ever appends and pauses; the drain loop only ever pops, commits and resumes. Neither blocks on the other.',
    'Pause and resume take the assignment (`consumer.assignment()` / `[{topic: TOPIC}]`), not the record: every partition stops, because the bound is on the whole queue. Check the queue length right after each append (`>= HIGH`) and right after each commit (`<= LOW`).',
    'Keep polling while paused — the client returns nothing for paused partitions — and sleep `IDLE_S` on an empty poll so the drain loop gets the CPU. Commit from the record you popped (`offset + 1` for that partition), after the worker returns.',
  ],
  checks: [
    {
      id: 'bounded',
      title: 'The queue never holds more than HIGH records',
      detail:
        'With a worker ten times slower than the fetcher and 200 records seeded, `stats().queued` sampled through the run never exceeds 20, and all 200 records are processed: the poll loop must stop fetching at the high-water mark.',
      match: {
        python: {all: [/\bHIGH = 20\b/, /\bLOW = 5\b/, /queue\.qsize\(\) >= HIGH\b/]},
        typescript: {all: [/\bHIGH = 20\b/, /\bLOW = 5\b/, /queue\.length >= HIGH\b/]},
        go: {all: [/\bhighWater\s*=\s*20\b/, /\blowWater\s*=\s*5\b/, /len\(queue\) >= highWater\b/]},
        scala: {all: [/\bHighWater = 20\b/, /\bLowWater = 5\b/, /queue\.size >= HighWater\b/]},
        cpp: {all: [/\bkHigh = 20\b/, /\bkLow = 5\b/, /queue\.size\(\) >= kHigh\b/]},
      },
    },
    {
      id: 'pause-resume',
      title: 'Pauses the assignment at HIGH, resumes at LOW',
      detail:
        'The run sees the consumer paused with 20 records queued, and the first unpaused sample after each pause has 5 or fewer queued: a pause at the high-water mark, a resume at the low-water mark, repeated as the slow worker drains, and not paused once everything is processed.',
      match: {
        python: {all: [/consumer\.pause\(/, /consumer\.resume\(/, /queue\.qsize\(\) <= LOW\b/]},
        typescript: {all: [/consumer\.pause\(/, /consumer\.resume\(/, /queue\.length <= LOW\b/]},
        go: {all: [/consumer\.Pause\(/, /consumer\.Resume\(/, /len\(queue\) <= lowWater\b/]},
        scala: {all: [/consumer\.pause\(/, /consumer\.resume\(/, /queue\.size <= LowWater\b/]},
        cpp: {all: [/consumer->pause\(/, /consumer->resume\(/, /queue\.size\(\) <= kLow\b/]},
      },
    },
    {
      id: 'in-order',
      title: 'Every record once, each partition in offset order',
      detail:
        'The worker sees all 200 records exactly once, with the seeded values, and within every partition the offsets arrive as 0, 1, 2…: the queue is FIFO and nothing is dropped or replayed while pausing and resuming.',
      match: {
        python: {all: [/queue\.put_nowait\(msg\)/, /await queue\.get\(\)/]},
        typescript: {all: [/queue\.push\(/, /queue\.shift\(\)/]},
        go: {all: [/queue <- msg/, /range queue/]},
        scala: {all: [/queue\.put\(record\)/, /queue\.poll\(/]},
        cpp: {all: [/queue\.push_back\(/, /queue\.pop_front\(\)/]},
      },
    },
    {
      id: 'commit-after',
      title: 'Commits only what the worker has finished',
      detail:
        'Auto-commit is off; at every commit the committed offset of a partition is at most the number of records of that partition the worker has completed, and once the run ends the group has no lag: offsets follow the work, never the fetch.',
      match: {
        python: {all: [/"enable\.auto\.commit":\s*False/], order: [/await worker\(/, /consumer\.commit\(message=msg/]},
        typescript: {all: [/autoCommit:\s*false/], order: [/await worker\(/, /consumer\.commitOffsets\(/]},
        go: {all: [/"enable\.auto\.commit":\s*false/], order: [/\bworker\(job\)/, /consumer\.CommitMessage\(/]},
        scala: {
          all: [/"enable\.auto\.commit",\s*"false"/, /"max\.poll\.records"/],
          order: [/\bworker\(Job\(/, /consumer\.commitSync\(/],
        },
        cpp: {all: [/"enable\.auto\.commit",\s*"false"/], order: [/\bworker\(Job\{/, /consumer->commitSync\(/]},
      },
    },
    {
      id: 'fast-worker',
      title: 'A worker that keeps up is never paused',
      detail:
        'With a worker that returns at once, `stats()` — which must report the live queue length — never shows the consumer paused and the queue stays well below HIGH: backpressure engages only when the drain loop falls behind.',
      match: {
        python: {all: [/"queued":\s*queue\.qsize\(\)/, /"paused":\s*paused\b/]},
        typescript: {all: [/queued:\s*queue\.length\b/, /\bpaused\b.*\bprocessed\b/]},
        go: {all: [/Queued:\s*len\(queue\)/, /Paused:\s*paused\.Load\(\)/]},
        scala: {all: [/Status\(queue\.size,\s*paused\b/]},
        cpp: {all: [/\{queue\.size\(\),\s*paused\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import logging

from confluent_kafka import Consumer

TOPIC = "jobs"
GROUP = "workers"
HIGH = 20
LOW = 5
IDLE_S = 0.01

log = logging.getLogger("workers")
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)

queue: asyncio.Queue = asyncio.Queue()
paused = False
processed = 0
running = False


def stats() -> dict:
    # TODO: records waiting, whether the partitions are paused, records committed
    return {"queued": 0, "paused": False, "processed": 0}


def stop() -> None:
    global running
    running = False


async def _drain(worker) -> None:
    global paused, processed
    # TODO: pop the oldest record (None = stop), await worker(job), commit that record, count it
    # TODO: paused and queue down to LOW → resume the assignment, clear paused
    raise NotImplementedError


async def run(worker) -> None:
    global running, paused
    running = True
    consumer.subscribe([TOPIC])
    # TODO: start _drain(worker) as a task
    # TODO: poll(0) in a loop: None → sleep IDLE_S; a record → append; queue at HIGH → pause the assignment
    # TODO: yield after each record; on stop() put the None sentinel, await the drain task, close
    raise NotImplementedError
`,
      solution: `import asyncio
import logging

from confluent_kafka import Consumer

TOPIC = "jobs"
GROUP = "workers"
HIGH = 20
LOW = 5
IDLE_S = 0.01

log = logging.getLogger("workers")
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)

queue: asyncio.Queue = asyncio.Queue()
paused = False
processed = 0
running = False


def stats() -> dict:
    return {"queued": queue.qsize(), "paused": paused, "processed": processed}


def stop() -> None:
    global running
    running = False


async def _drain(worker) -> None:
    global paused, processed
    while True:
        msg = await queue.get()
        if msg is None:  # the poll loop's sentinel: stop() was called and the queue is drained
            return
        await worker({"partition": msg.partition(), "offset": msg.offset(), "value": msg.value().decode()})
        consumer.commit(message=msg, asynchronous=False)
        processed += 1
        if paused and queue.qsize() <= LOW:
            consumer.resume(consumer.assignment())
            paused = False


async def run(worker) -> None:
    global running, paused
    running = True
    consumer.subscribe([TOPIC])
    drain = asyncio.create_task(_drain(worker))
    while running:
        msg = consumer.poll(0)  # still called while paused: callbacks are served, records are not
        if msg is None:
            await asyncio.sleep(IDLE_S)
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        queue.put_nowait(msg)
        if queue.qsize() >= HIGH:
            consumer.pause(consumer.assignment())
            paused = True
        await asyncio.sleep(0)  # let the drain task run between records
    queue.put_nowait(None)
    await drain
    consumer.close()
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'jobs';
export const GROUP = 'workers';
export const HIGH = 20;
export const LOW = 5;
export const IDLE_MS = 10;

export interface Job {
  partition: number;
  offset: number;
  value: string;
}
export type Worker = (job: Job) => Promise<void>;

const kafka = new Kafka({clientId: 'workers', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});

const queue: Job[] = [];
let paused = false;
let processed = 0;
let running = false;

export function stats(): {queued: number; paused: boolean; processed: number} {
  // TODO: records waiting, whether the partitions are paused, records committed
  return {queued: 0, paused: false, processed: 0};
}

export function stop(): void {
  running = false;
  consumer.stop();
  // TODO: wake the drain loop so it can finish and exit
}

async function drain(worker: Worker): Promise<void> {
  // TODO: while running or records remain: pop the oldest (none → wait to be woken), await worker(job),
  // TODO: commitOffsets for that partition (offset + 1), count it; paused and queue down to LOW → resume
  throw new Error('not implemented');
}

export async function run(worker: Worker): Promise<void> {
  running = true;
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  // TODO: start drain(worker) beside consumer.run (autoCommit off)
  // TODO: eachMessage: append the job, wake the drain loop; queue at HIGH → pause the topic
  // TODO: once consumer.run returns, await the drain loop and disconnect
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const TOPIC = 'jobs';
export const GROUP = 'workers';
export const HIGH = 20;
export const LOW = 5;
export const IDLE_MS = 10;

export interface Job {
  partition: number;
  offset: number;
  value: string;
}
export type Worker = (job: Job) => Promise<void>;

const kafka = new Kafka({clientId: 'workers', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});

const queue: Job[] = [];
let paused = false;
let processed = 0;
let running = false;
let wake: (() => void) | null = null;

/** The drain loop waits on this when the queue is empty; an append (or stop) wakes it at once. */
function idle(): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  wake = resolve;
  return promise;
}
const notify = (): void => {
  wake?.();
  wake = null;
};

export function stats(): {queued: number; paused: boolean; processed: number} {
  return {queued: queue.length, paused, processed};
}

export function stop(): void {
  running = false;
  consumer.stop();
  notify();
}

async function drain(worker: Worker): Promise<void> {
  while (running || queue.length > 0) {
    const job = queue.shift();
    if (job === undefined) {
      await idle();
      continue;
    }
    await worker(job);
    await consumer.commitOffsets([{topic: TOPIC, partition: job.partition, offset: String(job.offset + 1)}]);
    processed += 1;
    if (paused && queue.length <= LOW) {
      consumer.resume([{topic: TOPIC}]);
      paused = false;
    }
  }
}

export async function run(worker: Worker): Promise<void> {
  running = true;
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  const draining = drain(worker);
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({partition, message}) => {
      queue.push({partition, offset: Number(message.offset), value: message.value?.toString() ?? ''});
      notify();
      if (queue.length >= HIGH) {
        consumer.pause([{topic: TOPIC}]);
        paused = true;
      }
    },
  });
  await draining;
  await consumer.disconnect();
}
`,
    },
    go: {
      starter: `package main

import (
	"log"
	"sync/atomic"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

const (
	topic     = "jobs"
	group     = "workers"
	highWater = 20
	lowWater  = 5
	idle      = 10 * time.Millisecond
)

type Job struct {
	Partition int32
	Offset    int64
	Value     string
}

type Status struct {
	Queued    int
	Paused    bool
	Processed int
}

var (
	consumer  = newConsumer()
	queue     = make(chan *kafka.Message, highWater)
	paused    atomic.Bool
	processed atomic.Int64
	running   atomic.Bool
)

func newConsumer() *kafka.Consumer {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers": "kafka:9092",
		"group.id":          group,
		"auto.offset.reset": "earliest",
		// TODO: disable auto-commit
	})
	if err != nil {
		log.Fatal(err)
	}
	return c
}

func Stats() Status {
	// TODO: records waiting, whether the partitions are paused, records committed
	return Status{}
}

func Stop() { running.Store(false) }

func drain(worker func(Job), done chan<- struct{}) {
	defer close(done)
	// TODO: range over queue: worker(job), CommitMessage, count; paused and queue down to lowWater → Resume
}

func Run(worker func(Job)) error {
	running.Store(true)
	if err := consumer.SubscribeTopics([]string{topic}, nil); err != nil {
		return err
	}
	// TODO: start drain in a goroutine
	// TODO: Poll(idle) in a loop; a message → queue <- msg; queue at highWater → Pause the assignment
	// TODO: on Stop(): close(queue), wait for drain, Close the consumer
	return nil
}
`,
      solution: `package main

import (
	"log"
	"sync/atomic"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

const (
	topic     = "jobs"
	group     = "workers"
	highWater = 20
	lowWater  = 5
	idle      = 10 * time.Millisecond
)

type Job struct {
	Partition int32
	Offset    int64
	Value     string
}

type Status struct {
	Queued    int
	Paused    bool
	Processed int
}

var (
	consumer = newConsumer()
	// A channel of highWater slots: len(queue) is the live queue length.
	queue     = make(chan *kafka.Message, highWater)
	paused    atomic.Bool
	processed atomic.Int64
	running   atomic.Bool
)

func newConsumer() *kafka.Consumer {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"group.id":           group,
		"auto.offset.reset":  "earliest",
		"enable.auto.commit": false,
	})
	if err != nil {
		log.Fatal(err)
	}
	return c
}

func Stats() Status {
	return Status{Queued: len(queue), Paused: paused.Load(), Processed: int(processed.Load())}
}

func Stop() { running.Store(false) }

func assignment() []kafka.TopicPartition {
	assigned, err := consumer.Assignment()
	if err != nil {
		log.Printf("assignment: %v", err)
	}
	return assigned
}

func drain(worker func(Job), done chan<- struct{}) {
	defer close(done)
	for msg := range queue {
		job := Job{Partition: msg.TopicPartition.Partition, Offset: int64(msg.TopicPartition.Offset), Value: string(msg.Value)}
		worker(job)
		if _, err := consumer.CommitMessage(msg); err != nil { // librdkafka is thread-safe: commit from here
			log.Printf("commit %v: %v", msg.TopicPartition, err)
		}
		processed.Add(1)
		if paused.Load() && len(queue) <= lowWater {
			consumer.Resume(assignment())
			paused.Store(false)
		}
	}
}

func Run(worker func(Job)) error {
	running.Store(true)
	if err := consumer.SubscribeTopics([]string{topic}, nil); err != nil {
		return err
	}
	done := make(chan struct{})
	go drain(worker, done)
	for running.Load() {
		switch ev := consumer.Poll(int(idle / time.Millisecond)).(type) { // nothing while every partition is paused
		case *kafka.Message:
			msg := ev
			queue <- msg
			if len(queue) >= highWater {
				consumer.Pause(assignment())
				paused.Store(true)
			}
		case kafka.Error:
			log.Printf("consumer error: %v", ev)
		}
	}
	close(queue)
	<-done
	return consumer.Close()
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.{ConcurrentLinkedQueue, LinkedBlockingQueue, TimeUnit}
import java.util.concurrent.atomic.AtomicInteger

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.jdk.CollectionConverters._

case class Job(partition: Int, offset: Long, value: String)
case class Status(queued: Int, paused: Boolean, processed: Int)

object Backpressure {
  val Topic = "jobs"
  val Group = "workers"
  val HighWater = 20
  val LowWater = 5
  val Idle: Duration = Duration.ofMillis(10)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", Group)
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit; cap max.poll.records so one poll cannot overshoot HighWater
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)

  private val queue = new LinkedBlockingQueue[ConsumerRecord[String, String]]()
  private val completed = new ConcurrentLinkedQueue[ConsumerRecord[String, String]]()
  @volatile private var paused = false
  @volatile private var running = false
  private val processed = new AtomicInteger(0)

  def stats(): Status = Status(0, false, 0) // TODO: live queue length, paused, processed

  def stop(): Unit = running = false

  private def drain(worker: Job => Unit): Unit = {
    // TODO: while running or records remain: take the oldest, worker(Job(...)), hand it to \`completed\`, count it
  }

  def run(worker: Job => Unit): Unit = {
    running = true
    consumer.subscribe(List(Topic).asJava)
    // TODO: start drain on a thread
    // TODO: poll(Idle) in a loop: put each record; queue at HighWater → pause the assignment
    // TODO: commit the completed records (on this thread); paused and queue down to LowWater → resume
    // TODO: on stop(): join the drain thread, commit what is left, close
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.{ConcurrentLinkedQueue, LinkedBlockingQueue, TimeUnit}
import java.util.concurrent.atomic.AtomicInteger

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import scala.jdk.CollectionConverters._

case class Job(partition: Int, offset: Long, value: String)
case class Status(queued: Int, paused: Boolean, processed: Int)

object Backpressure {
  val Topic = "jobs"
  val Group = "workers"
  val HighWater = 20
  val LowWater = 5
  val Idle: Duration = Duration.ofMillis(10)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", Group)
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  // A poll after a resume may return at most the room a resume frees, so the queue never overshoots HighWater.
  props.put("max.poll.records", (HighWater - LowWater).toString)
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)

  private val queue = new LinkedBlockingQueue[ConsumerRecord[String, String]]()
  // Finished records, handed back to the poll thread: the Java consumer may only be used from one thread.
  private val completed = new ConcurrentLinkedQueue[ConsumerRecord[String, String]]()
  @volatile private var paused = false
  @volatile private var running = false
  private val processed = new AtomicInteger(0)

  def stats(): Status = Status(queue.size, paused, processed.get)

  def stop(): Unit = running = false

  private def drain(worker: Job => Unit): Unit =
    while (running || !queue.isEmpty) {
      val record = queue.poll(Idle.toMillis, TimeUnit.MILLISECONDS)
      if (record != null) {
        worker(Job(record.partition(), record.offset(), record.value()))
        completed.add(record)
        processed.incrementAndGet()
      }
    }

  private def commitCompleted(): Unit = {
    var record = completed.poll()
    while (record != null) {
      val tp = new TopicPartition(record.topic(), record.partition())
      consumer.commitSync(Map(tp -> new OffsetAndMetadata(record.offset() + 1)).asJava)
      record = completed.poll()
    }
  }

  def run(worker: Job => Unit): Unit = {
    running = true
    consumer.subscribe(List(Topic).asJava)
    val drainer = new Thread(() => drain(worker))
    drainer.start()
    while (running) {
      val records = consumer.poll(Idle) // keeps heartbeating; returns nothing while every partition is paused
      records.asScala.foreach { record =>
        queue.put(record)
        if (!paused && queue.size >= HighWater) {
          consumer.pause(consumer.assignment())
          paused = true
        }
      }
      commitCompleted()
      if (paused && queue.size <= LowWater) {
        consumer.resume(consumer.assignment())
        paused = false
      }
    }
    drainer.join()
    commitCompleted()
    consumer.close()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

const std::string kTopic = "jobs";
const std::string kGroup = "workers";
constexpr size_t kHigh = 20;
constexpr size_t kLow = 5;
constexpr int kIdleMs = 10;

struct Job {
  int partition;
  int64_t offset;
  std::string value;
};

struct Status {
  size_t queued;
  bool paused;
  int processed;
};

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  return std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
}

auto consumer = make_consumer();
std::deque<std::unique_ptr<RdKafka::Message>> queue;
std::mutex mu;
std::condition_variable has_work;
std::atomic<bool> paused{false};
std::atomic<bool> running{false};
std::atomic<int> processed{0};

Status stats() {
  // TODO: live queue length (under mu), paused, processed
  return {0, false, 0};
}

void stop() {
  running = false;
  has_work.notify_all();
}

void drain(const std::function<void(const Job&)>& worker) {
  // TODO: wait for work (or stop); pop the oldest; worker(Job{...}); commitSync that message; count it
  // TODO: paused and queue down to kLow → resume the assignment
}

void run(const std::function<void(const Job&)>& worker) {
  running = true;
  consumer->subscribe({kTopic});
  // TODO: start drain on a thread
  // TODO: consume(kIdleMs) in a loop: a message → push_back + notify; queue at kHigh → pause the assignment
  // TODO: on stop(): wake and join the drain thread, close the consumer
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

const std::string kTopic = "jobs";
const std::string kGroup = "workers";
constexpr size_t kHigh = 20;
constexpr size_t kLow = 5;
constexpr int kIdleMs = 10;

struct Job {
  int partition;
  int64_t offset;
  std::string value;
};

struct Status {
  size_t queued;
  bool paused;
  int processed;
};

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  return std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
}

auto consumer = make_consumer();
std::deque<std::unique_ptr<RdKafka::Message>> queue;
std::mutex mu;
std::condition_variable has_work;
std::atomic<bool> paused{false};
std::atomic<bool> running{false};
std::atomic<int> processed{0};

// pause/resume take the whole assignment: the bound is on the queue, not on one partition.
void set_assignment_paused(bool pause) {
  std::vector<RdKafka::TopicPartition*> assigned;
  consumer->assignment(assigned);
  if (pause) {
    consumer->pause(assigned);
  } else {
    consumer->resume(assigned);
  }
  RdKafka::TopicPartition::destroy(assigned);
  paused = pause;
}

Status stats() {
  std::lock_guard<std::mutex> lock(mu);
  return {queue.size(), paused.load(), processed.load()};
}

void stop() {
  running = false;
  has_work.notify_all();
}

void drain(const std::function<void(const Job&)>& worker) {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg;
    {
      std::unique_lock<std::mutex> lock(mu);
      has_work.wait(lock, [] { return !queue.empty() || !running; });
      if (queue.empty()) return;  // stopped and drained
      msg = std::move(queue.front());
      queue.pop_front();
    }
    worker(Job{msg->partition(), msg->offset(), std::string(static_cast<const char*>(msg->payload()), msg->len())});
    consumer->commitSync(msg.get());  // librdkafka is thread-safe: the drain thread commits
    processed++;
    std::lock_guard<std::mutex> lock(mu);
    if (paused && queue.size() <= kLow) set_assignment_paused(false);
  }
}

void run(const std::function<void(const Job&)>& worker) {
  running = true;
  consumer->subscribe({kTopic});
  std::thread drainer(drain, std::cref(worker));
  while (running) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(kIdleMs));  // times out while every partition is paused
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    std::lock_guard<std::mutex> lock(mu);
    queue.push_back(std::move(msg));
    has_work.notify_one();
    if (queue.size() >= kHigh) set_assignment_paused(true);
  }
  has_work.notify_all();
  drainer.join();
  consumer->close();
}
`,
    },
  },
  harness: {
    python: `import asyncio

TOPIC = "jobs"
GROUP = "workers"
N = 200
HIGH = 20
LOW = 5


def _seed(ctx):
    # A paused consumer gets nothing from poll: the run is ended by stop(), not by the broker draining.
    ctx.kafka.stop_when_drained = False
    ctx.clock.sleep_limit = 50000
    for i in range(N):
        ctx.kafka.seed(TOPIC, key=f"job-{i}", value=f"job-{i}", partition=i % 3)
    return ctx.load("backpressure")


class Trace:
    """The harness's worker: samples stats() per job, remembers every job, counts the finished ones per partition."""

    def __init__(self, m, slow):
        self.m, self.slow = m, slow
        self.samples, self.jobs = [], []
        self.done = {0: 0, 1: 0, 2: 0}

    async def worker(self, job):
        self.samples.append(self.m.stats())
        self.jobs.append(job)
        if self.slow:
            for _ in range(10):  # 50 ms of virtual time in 5 ms slices: the poll loop gets ten turns per job
                await asyncio.sleep(0.005)
        self.done[job["partition"]] += 1


async def _run(ctx, m, t):
    task = asyncio.create_task(m.run(t.worker))
    for _ in range(20000):
        t.samples.append(m.stats())
        if m.stats()["processed"] >= N or task.done():
            break
        await asyncio.sleep(0.01)
    m.stop()
    await task
    assert m.stats()["processed"] == N, f"processed {m.stats()['processed']} of {N} jobs"


async def check_bounded(ctx):
    m = _seed(ctx)
    t = Trace(m, slow=True)
    await _run(ctx, m, t)
    peak = max(s["queued"] for s in t.samples)
    assert peak <= HIGH, f"the queue held {peak} jobs at one point; it must never exceed HIGH = {HIGH}"
    assert m.stats()["queued"] == 0, "once every job is processed the queue must be empty"


async def check_pause_resume(ctx):
    m = _seed(ctx)
    t = Trace(m, slow=True)
    await _run(ctx, m, t)
    paused = [s["paused"] for s in t.samples]
    assert any(paused), "with a worker ten times slower than the fetcher the consumer was never paused: pause the assignment when the queue reaches HIGH"
    first = paused.index(True)
    assert t.samples[first]["queued"] >= HIGH - 1, f"the consumer paused with only {t.samples[first]['queued']} queued; the pause belongs at HIGH = {HIGH}"
    resumes = [i for i in range(1, len(paused)) if paused[i - 1] and not paused[i]]
    assert resumes, "the consumer paused but never resumed"
    for i in resumes:
        assert t.samples[i]["queued"] <= LOW, f"resumed with {t.samples[i]['queued']} still queued; resume only once the queue is down to LOW = {LOW}"
    assert len(resumes) >= 2, f"paused and resumed {len(resumes)} time(s) over {N} jobs; the cycle should repeat as the slow worker drains"
    assert not m.stats()["paused"], "once every job is processed the consumer must not be left paused"


async def check_in_order(ctx):
    m = _seed(ctx)
    t = Trace(m, slow=True)
    await _run(ctx, m, t)
    seen = [(job["partition"], job["offset"]) for job in t.jobs]
    assert len(seen) == N, f"the worker ran {len(seen)} times for {N} jobs"
    assert len(set(seen)) == N, "some job reached the worker more than once"
    for p in range(3):
        offsets = [o for q, o in seen if q == p]
        assert offsets == list(range(len(offsets))), f"partition {p} was processed out of order: offsets {offsets[:8]}…"
    for job in t.jobs:
        expected = f"job-{3 * job['offset'] + job['partition']}"
        assert job["value"] == expected, f"job at {job['partition']}@{job['offset']} carried {job['value']!r}, expected {expected!r}"


async def check_commit_after(ctx):
    m = _seed(ctx)
    t = Trace(m, slow=True)
    violations = []

    def hook(group, offsets):
        for (topic, p), o in offsets.items():
            if group != GROUP or topic != TOPIC:
                violations.append(f"a commit for {group}/{topic}: the group is {GROUP}, the topic {TOPIC}")
            elif o > t.done[p]:
                violations.append(f"partition {p}: committed offset {o} while the worker had finished {t.done[p]} of its jobs")

    ctx.kafka.on_commit(hook)
    await _run(ctx, m, t)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, before the worker ran"
    assert not violations, violations[0]
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, f"{ctx.kafka.lag(GROUP, TOPIC)} processed jobs were never committed"


async def check_fast_worker(ctx):
    m = _seed(ctx)
    t = Trace(m, slow=False)
    await _run(ctx, m, t)
    assert not any(s["paused"] for s in t.samples), "the worker kept up, yet the consumer was paused: pause only when the queue reaches HIGH"
    peak = max(s["queued"] for s in t.samples)
    assert peak < HIGH, f"the queue reached {peak} with a worker that returns at once; the drain loop must run between polls"
`,
    typescript: `const TOPIC = 'jobs';
const GROUP = 'workers';
const N = 200;
const HIGH = 20;
const LOW = 5;

interface Job {
  partition: number;
  offset: number;
  value: string;
}
interface Stats {
  queued: number;
  paused: boolean;
  processed: number;
}

function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function seed(ctx) {
  // A paused consumer gets nothing: the run is ended by stop(), not by the broker draining.
  ctx.kafka.stopWhenDrained = false;
  for (let i = 0; i < N; i++) ctx.kafka.seed(TOPIC, {key: \`job-\${i}\`, value: \`job-\${i}\`, partition: i % 3});
  return ctx.load('backpressure');
}

interface Trace {
  samples: Stats[];
  jobs: Job[];
  done: number[];
  worker: (job: Job) => Promise<void>;
}

/** The harness's worker: samples stats() per job, remembers every job, counts the finished ones per partition. */
function trace(m, slow: boolean): Trace {
  const samples: Stats[] = [];
  const jobs: Job[] = [];
  const done = [0, 0, 0];
  const worker = async (job: Job) => {
    samples.push(m.stats());
    jobs.push(job);
    if (slow) await sleep(50);
    done[job.partition] += 1;
  };
  return {samples, jobs, done, worker};
}

async function run(ctx, m, t: Trace) {
  const sampler = setInterval(() => t.samples.push(m.stats()), 10);
  const {promise: finished, resolve: finish} = Promise.withResolvers<void>();
  ctx.kafka.onCommit(() => {
    if (ctx.kafka.lag(GROUP, TOPIC) === 0) finish();
  });
  const running = m.run(t.worker);
  try {
    await Promise.race([finished, ctx.drain(running)]);
  } finally {
    clearInterval(sampler);
  }
  await sleep(0);
  m.stop();
  await ctx.drain(running);
  assert.equal(m.stats().processed, N, \`processed \${m.stats().processed} of \${N} jobs\`);
}

export async function check_bounded(ctx) {
  const m = seed(ctx);
  const t = trace(m, true);
  await run(ctx, m, t);
  const peak = Math.max(...t.samples.map(s => s.queued));
  assert(peak <= HIGH, \`the queue held \${peak} jobs at one point; it must never exceed HIGH = \${HIGH}\`);
  assert.equal(m.stats().queued, 0, 'once every job is processed the queue must be empty');
}

export async function check_pause_resume(ctx) {
  const m = seed(ctx);
  const t = trace(m, true);
  await run(ctx, m, t);
  const paused = t.samples.map(s => s.paused);
  assert(paused.some(Boolean), 'with a worker ten times slower than the fetcher the consumer was never paused: pause the topic when the queue reaches HIGH');
  const first = paused.indexOf(true);
  assert(t.samples[first].queued >= HIGH - 1, \`the consumer paused with only \${t.samples[first].queued} queued; the pause belongs at HIGH = \${HIGH}\`);
  const resumes = paused.map((p, i) => (i > 0 && paused[i - 1] && !p ? i : -1)).filter(i => i >= 0);
  assert(resumes.length > 0, 'the consumer paused but never resumed');
  for (const i of resumes)
    assert(t.samples[i].queued <= LOW, \`resumed with \${t.samples[i].queued} still queued; resume only once the queue is down to LOW = \${LOW}\`);
  assert(resumes.length >= 2, \`paused and resumed \${resumes.length} time(s) over \${N} jobs; the cycle should repeat as the slow worker drains\`);
  assert(!m.stats().paused, 'once every job is processed the consumer must not be left paused');
}

export async function check_in_order(ctx) {
  const m = seed(ctx);
  const t = trace(m, true);
  await run(ctx, m, t);
  const seen = t.jobs.map(j => \`\${j.partition}@\${j.offset}\`);
  assert.equal(seen.length, N, \`the worker ran \${seen.length} times for \${N} jobs\`);
  assert.equal(new Set(seen).size, N, 'some job reached the worker more than once');
  for (let p = 0; p < 3; p++) {
    const offsets = t.jobs.filter(j => j.partition === p).map(j => j.offset);
    assert.deepEqual(offsets, offsets.map((_, i) => i), \`partition \${p} was processed out of order: offsets \${offsets.slice(0, 8).join(', ')}…\`);
  }
  for (const job of t.jobs) {
    const expected = \`job-\${3 * job.offset + job.partition}\`;
    assert.equal(job.value, expected, \`job at \${job.partition}@\${job.offset} carried \${JSON.stringify(job.value)}, expected \${JSON.stringify(expected)}\`);
  }
}

export async function check_commit_after(ctx) {
  const m = seed(ctx);
  const t = trace(m, true);
  const violations: string[] = [];
  ctx.kafka.onCommit((group: string, offsets: Map<string, number>) => {
    for (const [tp, o] of offsets) {
      const [topic, p] = tp.split('|');
      if (group !== GROUP || topic !== TOPIC) violations.push(\`a commit for \${group}/\${topic}: the group is \${GROUP}, the topic \${TOPIC}\`);
      else if (o > t.done[Number(p)]) violations.push(\`partition \${p}: committed offset \${o} while the worker had finished \${t.done[Number(p)]} of its jobs\`);
    }
  });
  await run(ctx, m, t);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, before the worker ran');
  assert.equal(violations.length, 0, violations[0]);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, \`\${ctx.kafka.lag(GROUP, TOPIC)} processed jobs were never committed\`);
}

export async function check_fast_worker(ctx) {
  const m = seed(ctx);
  const t = trace(m, false);
  await run(ctx, m, t);
  assert(!t.samples.some(s => s.paused), 'the worker kept up, yet the consumer was paused: pause only when the queue reaches HIGH');
  const peak = Math.max(...t.samples.map(s => s.queued));
  assert(peak < HIGH, \`the queue reached \${peak} with a worker that returns at once; the drain loop must run between deliveries\`);
}
`,
  },
  debrief: `Backpressure in a Kafka consumer is a hysteresis loop over a bounded queue: fetch until HIGH, pause, drain until LOW, resume. The gap between the two marks is what stops the consumer from flapping pause/resume on every record; the queue bound is what keeps memory flat no matter how far the topic runs ahead. Pausing keeps the consumer in the group — it still polls, heartbeats and serves rebalance callbacks — where simply blocking in the poll loop would trip \`max.poll.interval.ms\` and hand the partitions to someone else. Committing from the drain loop after the worker returns keeps the delivery guarantee at-least-once: nothing in the queue is committed, so a crash replays it rather than losing it. Real consumers bound the queue in bytes as well as records, pause partitions individually when one key runs hot, and (with the Java client, which is single-threaded) route the commits back to the poll thread and cap \`max.poll.records\` so a single poll cannot overshoot the high-water mark.`,
};
