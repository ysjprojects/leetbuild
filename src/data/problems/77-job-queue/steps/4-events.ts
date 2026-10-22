import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Job events keyed by job id for a run history',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'kafka', 'consumer', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the event publisher: it
builds a payload, produces it to \`job.event\` and acks, so the demo shows a history consumer with
something to read. It compiles, it serves the happy path, and it hides four production flaws that
only surface once more than one worker is draining the queue. Review it like the owner of a topic
whose consumer rebuilds each job's history, fix it, and prove the fix with the checks below.

The worker reports a job's life through one publisher; \`job.event\` carries one record per
transition of a job — \`enqueued\`, \`started\`, \`completed\`, \`failed\`, \`dead_lettered\`.

- One publisher emits **every** transition, and each payload carries the \`job_id\`, the
  **\`attempts\`** count and the **\`duration_ms\`** of the attempt where they apply. The draft
  publishes three of the five and drops \`failed\` and \`dead_lettered\`, so the consumer never sees
  the events a support engineer actually gets paged about.
- Every produce is **keyed by the job id** (\`key=job_id\`, \`key: jobId\`, \`Key: []byte(jobID)\`,
  \`ProducerRecord(topic, jobId, payload)\`, the message key argument). The key chooses the
  partition, and the partition is what keeps one job's history ordered while other jobs' events
  interleave. The draft keys by the **worker** that ran the job, so two workers draining the queue
  interleave, a retry lands on a different partition, and a consumer can apply \`started\` after
  \`completed\`.
- \`completed\` is published **only after the side effect has committed** — the worker's report marks
  the job completed first (\`mark_completed\`), and the produce follows that commit. The draft
  publishes \`completed\` and only then marks the job, so the history claims a charge, an email or a
  webhook that may never have happened.
- The job's new state and a **\`job_outbox\` row** are written in **one store call**
  (\`INSERT INTO job_outbox\`), and the produce follows it; when the broker rejects the produce the
  row stays pending and a **relay** (\`relay_outbox\`) republishes it, in outbox order, clearing a
  row only after the ack. The draft has no outbox: a rejection is caught, logged and forgotten, so a
  broker outage silently punches holes in the only history the job has.
- The consumer owns the other end: it appends the event to the job's history and **only then**
  commits the offset, so a crash between the two replays the record instead of losing it.

**Failure mode the checks target.** The key is the subtle one: keying by worker looks harmless with
one worker and turns into a history that reorders itself the moment a retry is routed to a different
pod, because the job's own records no longer share a partition. Publishing \`completed\` before the
effect commits is the lie that costs money — the log says the side effect happened when the worker
was still one crash away from it. The missing outbox is the one that hides for months: invisible
until the broker blinks, and then a \`dead_lettered\` event a paging rule depends on is simply absent
from the log.`,
  sequence: {
    participants: ['Worker pool', 'job.event', 'History consumer', 'Job store · outbox'],
    messages: [
      {
        from: 'Worker pool',
        to: 'Job store · outbox',
        label: 'mark completed · the effect has already committed',
        kind: 'sync',
      },
      {
        from: 'Job store · outbox',
        to: 'Worker pool',
        label: 'commit · state + job_outbox row in one call',
        kind: 'reply',
      },
      {from: 'Worker pool', to: 'job.event', label: 'produce · key = job_id · attempts · duration_ms', kind: 'async'},
      {from: 'job.event', to: 'Worker pool', label: 'ack / broker rejection', kind: 'reply'},
      {from: 'Job store · outbox', to: 'job.event', label: 'relay republishes pending rows in order', kind: 'async'},
      {from: 'job.event', to: 'History consumer', label: 'consume · group job-history', kind: 'async'},
      {
        from: 'History consumer',
        to: 'Job store · outbox',
        label: 'append the history, then commit the offset',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'event-envelope',
      title: 'One publisher writes job.event with job_id and attempts',
      detail:
        'A single publisher produces to the `job.event` topic and the payload carries the `job_id` and the `attempts` count, so the consumer can attach the record to a job. The draft has this shape — it is the one thing the review can keep.',
      match: {
        python: {all: [/\bTOPIC\s*=\s*"job\.event"/, /def publish_event\(/, /"job_id"/, /"attempts"/]},
        typescript: {all: [/\bTOPIC\s*=\s*'job\.event'/, /function publishEvent\(/, /job_id/, /attempts/]},
        go: {all: [/jobEventTopic\s*=\s*"job\.event"/, /func publishEvent\(/, /"job_id"/, /"attempts"/]},
        scala: {all: [/JobEventTopic\s*=\s*"job\.event"/, /def publishEvent\(/, /"job_id"/, /"attempts"/]},
        cpp: {all: [/kJobEventTopic\s*=\s*"job\.event"/, /publish_event\(/, /"job_id"/, /"attempts"/]},
      },
    },
    {
      id: 'key-by-job-id',
      title: 'Every event is keyed by the job id, never by the worker',
      detail:
        "The produce passes the job id as the message key (`key=job_id`, `key: jobId`, `Key: []byte(jobID)`, `ProducerRecord(topic, jobId, …)`), so one job's transitions share a partition and stay ordered. The draft keys by the worker id, so a retry that lands on another worker splits the job's history across partitions.",
      match: {
        python: {all: [/key=job_id/], none: [/key=worker/]},
        typescript: {all: [/key:\s*jobId/], none: [/key:\s*workerId/]},
        go: {all: [/Key:\s*\[\]byte\(jobID\)/], none: [/Key:\s*\[\]byte\(workerID\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(JobEventTopic,\s*(event\.)?jobId,/],
          none: [/ProducerRecord\[String, String\]\(JobEventTopic,\s*workerId,/],
        },
        cpp: {all: [/job_id\.c_str\(\)/], none: [/worker_id\.c_str\(\)/]},
      },
    },
    {
      id: 'completed-after-effect',
      title: 'completed is published only after the effect commits',
      detail:
        'The worker marks the job completed first and the `completed` event follows that commit, so the history never claims a side effect that has not happened. The draft produces `completed` and only then marks the job, which is exactly the record an incident review will read back.',
      match: {
        python: {order: [/store\.mark_completed\(/, /publish_completed\(/]},
        typescript: {order: [/store\.markCompleted\(/, /publishCompleted\(/]},
        go: {order: [/store\.MarkCompleted\(/, /publishCompleted\(/]},
        scala: {order: [/store\.markCompleted\(/, /publishCompleted\(/]},
        cpp: {order: [/store\.mark_completed\(/, /publish_completed\(/]},
      },
    },
    {
      id: 'outbox-on-rejection',
      title: 'The state change and the outbox row commit together, and a relay republishes',
      detail:
        "The job's new state and an `INSERT INTO job_outbox` row go through one store call, the produce follows, and a relay republishes whatever the broker rejected. The draft has no outbox: a rejection is caught, logged and gone, so a short broker outage is a permanent hole in a job's history.",
      match: {
        python: {all: [/INSERT INTO job_outbox/, /def relay_outbox\(/, /except KafkaException/]},
        typescript: {all: [/INSERT INTO job_outbox/, /relayOutbox\(/, /catch\s*\(/]},
        go: {all: [/INSERT INTO job_outbox/, /func relayOutbox\(/, /err != nil/]},
        scala: {all: [/INSERT INTO job_outbox/, /def relayOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/INSERT INTO job_outbox/, /relay_outbox\(/, /catch\s*\(/]},
      },
    },
    {
      id: 'all-transitions',
      title: 'All five transitions carry attempts and duration_ms',
      detail:
        'One publisher emits `enqueued`, `started`, `completed`, `failed` and `dead_lettered`, each payload carrying `attempts` and `duration_ms`. The draft emits three of the five and has no duration at all, so the history cannot explain a slow job and never records the failure or the dead-letter move.',
      match: {
        python: {
          all: [
            /"enqueued"/,
            /"started"/,
            /"completed"/,
            /"failed"/,
            /"dead_lettered"/,
            /"attempts"/,
            /"duration_ms"/,
            /record_event\(/,
          ],
        },
        typescript: {
          all: [
            /'enqueued'/,
            /'started'/,
            /'completed'/,
            /'failed'/,
            /'dead_lettered'/,
            /attempts/,
            /duration_ms/,
            /recordEvent\(/,
          ],
        },
        go: {
          all: [
            /"enqueued"/,
            /"started"/,
            /"completed"/,
            /"failed"/,
            /"dead_lettered"/,
            /"attempts"/,
            /"duration_ms"/,
            /recordEvent\(/,
          ],
        },
        scala: {
          all: [
            /"enqueued"/,
            /"started"/,
            /"completed"/,
            /"failed"/,
            /"dead_lettered"/,
            /"attempts"/,
            /"duration_ms"/,
            /recordEvent\(/,
          ],
        },
        cpp: {
          all: [
            /"enqueued"/,
            /"started"/,
            /"completed"/,
            /"failed"/,
            /"dead_lettered"/,
            /"attempts"/,
            /"duration_ms"/,
            /record_event\(/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("jobqd-events")

TOPIC = "job.event"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class JobStore:
    def mark_completed(self, job_id: str, attempts: int, duration_ms: int) -> None:
        """Record the job as completed, once the side effect has committed."""
        raise NotImplementedError

    def append_history(self, job_id: str, event: dict) -> None:
        """Append one event to the job's history; this is the consumer's write."""
        raise NotImplementedError


store = JobStore()


def publish_event(job_id: str, worker: str, event_type: str, attempts: int) -> None:
    # TODO: this draft keys the event by the worker that ran the job, publishes \`completed\` before
    # the side effect has committed, publishes three of the five transitions, and swallows a
    # producer rejection with a log line where the job_outbox row belongs.
    payload = json.dumps({"type": event_type, "job_id": job_id, "attempts": attempts}).encode("utf-8")
    producer.produce(TOPIC, key=worker.encode("utf-8"), value=payload)
    producer.flush()


def record_event(job_id: str, worker: str, event_type: str, attempts: int = 0) -> None:
    try:
        publish_event(job_id, worker, event_type, attempts)
    except Exception as err:
        logger.warning("event dropped job_id=%s event=%s err=%s", job_id, event_type, err)


def on_enqueued(job_id: str, worker: str) -> None:
    record_event(job_id, worker, "enqueued")


def on_started(job_id: str, worker: str, attempts: int) -> None:
    record_event(job_id, worker, "started", attempts)


@app.post("/v1/jobs/{job_id}/completed")
def complete_job(job_id: str, attempts: int, duration_ms: int) -> JSONResponse:
    record_event(job_id, "worker-1", "completed", attempts)
    store.mark_completed(job_id, attempts, duration_ms)
    return JSONResponse({"job_id": job_id, "state": "completed"})


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "job-history"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        store.append_history(event["job_id"], event)
        consumer.commit(msg)
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("jobqd-events")

TOPIC = "job.event"
OUTBOX_BATCH = 100

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
    }
)


class JobStore:
    """The platform's store: a job's state change and its job_outbox row share one call."""

    def transaction(self) -> "object":
        """The transaction that commits the job's new state together with the outbox row."""
        raise NotImplementedError

    def mark_completed(self, job_id: str, attempts: int, duration_ms: int) -> None:
        """Record the job as completed, after the side effect has committed."""
        raise NotImplementedError

    def pending_outbox(self, limit: int) -> list[dict]:
        """Outbox rows a rejected produce left behind, oldest first."""
        raise NotImplementedError

    def mark_published(self, outbox_id: int) -> None:
        raise NotImplementedError

    def append_history(self, job_id: str, event: dict) -> None:
        """Append one event to the job's history; this is the consumer's write."""
        raise NotImplementedError


store = JobStore()


def event_payload(job_id: str, event_type: str, attempts: int, duration_ms: int, error: str = "") -> dict:
    return {
        "type": event_type,
        "job_id": job_id,
        "attempts": attempts,
        "duration_ms": duration_ms,
        "error": error,
    }


def publish_event(job_id: str, event_type: str, attempts: int, duration_ms: int, error: str = "") -> None:
    """Keyed by the job id, so one job's history stays in one ordered partition."""
    payload = json.dumps(event_payload(job_id, event_type, attempts, duration_ms, error)).encode("utf-8")
    producer.produce(TOPIC, key=job_id.encode("utf-8"), value=payload)
    producer.poll(0)


def record_event(job_id: str, event_type: str, attempts: int = 0, duration_ms: int = 0, error: str = "") -> None:
    """The job's new state and its job_outbox row commit together, then the produce follows."""
    with store.transaction() as tx:
        tx.execute("UPDATE jobs SET state = %s, attempts = %s WHERE job_id = %s", (event_type, attempts, job_id))
        tx.execute(
            "INSERT INTO job_outbox (job_id, event_type, attempts, duration_ms, error) VALUES (%s, %s, %s, %s, %s)",
            (job_id, event_type, attempts, duration_ms, error),
        )
    try:
        publish_event(job_id, event_type, attempts, duration_ms, error)
    except KafkaException as err:
        logger.warning("event kept in the outbox job_id=%s event=%s err=%s", job_id, event_type, err)


def relay_outbox() -> None:
    """Republish what a broker outage left behind; a row is cleared only after the ack."""
    for row in store.pending_outbox(OUTBOX_BATCH):
        try:
            publish_event(row["job_id"], row["event_type"], row["attempts"], row["duration_ms"], row["error"])
        except KafkaException:
            continue
        store.mark_published(row["id"])


def on_enqueued(job_id: str) -> None:
    record_event(job_id, "enqueued")


def on_started(job_id: str, attempts: int) -> None:
    record_event(job_id, "started", attempts)


def on_failed(job_id: str, attempts: int, error: str) -> None:
    record_event(job_id, "failed", attempts, 0, error)


def on_dead_lettered(job_id: str, attempts: int, error: str) -> None:
    record_event(job_id, "dead_lettered", attempts, 0, error)


def publish_completed(job_id: str, attempts: int, duration_ms: int) -> None:
    """Produce the completed event only after the side effect has committed."""
    record_event(job_id, "completed", attempts, duration_ms)


@app.post("/v1/jobs/{job_id}/completed")
def complete_job(job_id: str, attempts: int, duration_ms: int) -> JSONResponse:
    store.mark_completed(job_id, attempts, duration_ms)
    publish_completed(job_id, attempts, duration_ms)
    return JSONResponse({"job_id": job_id, "state": "completed"})


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "job-history", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        store.append_history(event["job_id"], event)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** job.event: a model-generated draft that keys by worker and publishes before the effect commits. */
import Fastify from 'fastify';
import {Kafka, type Producer} from 'kafkajs';

export const app = Fastify();

const TOPIC = 'job.event';

const kafka = new Kafka({clientId: 'jobqd-events', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer();
void producer.connect();

interface JobEvent {
  type: string;
  job_id: string;
  attempts: number;
}

class JobStore {
  /** Record the job as completed, once the side effect has committed. */
  async markCompleted(jobId: string, attempts: number, durationMs: number): Promise<void> {
    void jobId;
    void attempts;
    void durationMs;
  }

  /** Append one event to the job's history; this is the consumer's write. */
  async appendHistory(jobId: string, event: JobEvent): Promise<void> {
    void jobId;
    void event;
  }
}

const store = new JobStore();

async function publishEvent(jobId: string, workerId: string, event: JobEvent): Promise<void> {
  // TODO: this draft keys the event by the worker that ran the job, publishes 'completed' before
  // the side effect has committed, publishes three of the five transitions, and swallows a
  // producer rejection with a log line where the job_outbox row belongs.
  void jobId;
  await producer.send({topic: TOPIC, messages: [{key: workerId, value: JSON.stringify(event)}]});
}

async function recordEvent(event: JobEvent, workerId: string): Promise<void> {
  try {
    await publishEvent(event.job_id, workerId, event);
  } catch (err) {
    app.log.warn({job_id: event.job_id, event: event.type, err}, 'event dropped');
  }
}

async function onEnqueued(jobId: string, workerId: string): Promise<void> {
  await recordEvent({type: 'enqueued', job_id: jobId, attempts: 0}, workerId);
}

async function onStarted(jobId: string, workerId: string, attempts: number): Promise<void> {
  await recordEvent({type: 'started', job_id: jobId, attempts}, workerId);
}

app.post('/v1/jobs/:job_id/completed', async (request, reply) => {
  const jobId = (request.params as {job_id: string}).job_id;
  const body = request.body as {attempts: number; duration_ms: number};
  await recordEvent({type: 'completed', job_id: jobId, attempts: body.attempts}, 'worker-1');
  await store.markCompleted(jobId, body.attempts, body.duration_ms);
  return reply.code(200).send({job_id: jobId, state: 'completed'});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'job-history'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as JobEvent;
      await store.appendHistory(event.job_id, event);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** job.event: one durable, job-keyed event per transition, completed only after the effect commits. */
import Fastify from 'fastify';
import {Kafka, type Producer} from 'kafkajs';

export const app = Fastify();

const TOPIC = 'job.event';
const OUTBOX_BATCH = 100;

interface JobEvent {
  type: string;
  job_id: string;
  attempts: number;
  duration_ms: number;
  error?: string;
}

interface OutboxRow {
  id: string;
  event: JobEvent;
}

class JobStore {
  /** The job's new state and the job_outbox row share one transaction. */
  async transaction<T>(
    body: (tx: {query: (sql: string, params: unknown[]) => Promise<void>}) => Promise<T>,
  ): Promise<T> {
    return body({query: async () => {}});
  }

  /** Record the job as completed, after the side effect has committed. */
  async markCompleted(jobId: string, attempts: number, durationMs: number): Promise<void> {
    void jobId;
    void attempts;
    void durationMs;
  }

  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    void limit;
    return [];
  }

  async markPublished(outboxId: string): Promise<void> {
    void outboxId;
  }

  /** Append one event to the job's history; this is the consumer's write. */
  async appendHistory(jobId: string, event: JobEvent): Promise<void> {
    void jobId;
    void event;
  }
}

const store = new JobStore();

const kafka = new Kafka({clientId: 'jobqd-events', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

function eventPayload(event: JobEvent): JobEvent {
  return {
    type: event.type,
    job_id: event.job_id,
    attempts: event.attempts,
    duration_ms: event.duration_ms,
    error: event.error,
  };
}

/** Keyed by the job id, so one job's history stays in one ordered partition. */
async function publishEvent(jobId: string, event: JobEvent): Promise<void> {
  await producer.send({topic: TOPIC, messages: [{key: jobId, value: JSON.stringify(eventPayload(event))}]});
}

/** The job's new state and its job_outbox row commit together, then the produce follows. */
async function recordEvent(event: JobEvent): Promise<void> {
  await store.transaction(async tx => {
    await tx.query('UPDATE jobs SET state = $1, attempts = $2 WHERE job_id = $3', [
      event.type,
      event.attempts,
      event.job_id,
    ]);
    await tx.query(
      'INSERT INTO job_outbox (job_id, event_type, attempts, duration_ms) VALUES ($1, $2, $3, $4)',
      [event.job_id, event.type, event.attempts, event.duration_ms],
    );
  });
  try {
    await publishEvent(event.job_id, event);
  } catch (err) {
    app.log.warn({job_id: event.job_id, event: event.type, err}, 'event kept in the outbox for the relay');
  }
}

/** Republish what a broker outage left behind; a row is cleared only after the ack. */
async function relayOutbox(): Promise<void> {
  for (const row of await store.pendingOutbox(OUTBOX_BATCH)) {
    try {
      await publishEvent(row.event.job_id, row.event);
    } catch {
      continue;
    }
    await store.markPublished(row.id);
  }
}

async function onEnqueued(jobId: string): Promise<void> {
  await recordEvent({type: 'enqueued', job_id: jobId, attempts: 0, duration_ms: 0});
}

async function onStarted(jobId: string, attempts: number): Promise<void> {
  await recordEvent({type: 'started', job_id: jobId, attempts, duration_ms: 0});
}

async function onFailed(jobId: string, attempts: number, error: string): Promise<void> {
  await recordEvent({type: 'failed', job_id: jobId, attempts, duration_ms: 0, error});
}

async function onDeadLettered(jobId: string, attempts: number, error: string): Promise<void> {
  await recordEvent({type: 'dead_lettered', job_id: jobId, attempts, duration_ms: 0, error});
}

/** The completion is published only once the effect committed and the job was marked completed. */
async function publishCompleted(jobId: string, attempts: number, durationMs: number): Promise<void> {
  await recordEvent({type: 'completed', job_id: jobId, attempts, duration_ms: durationMs});
}

app.post('/v1/jobs/:job_id/completed', async (request, reply) => {
  const jobId = (request.params as {job_id: string}).job_id;
  const body = request.body as {attempts: number; duration_ms: number};
  await store.markCompleted(jobId, body.attempts, body.duration_ms);
  await publishCompleted(jobId, body.attempts, body.duration_ms);
  return reply.code(200).send({job_id: jobId, state: 'completed'});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'job-history'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as JobEvent;
      await store.appendHistory(event.job_id, event);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/segmentio/kafka-go"
)

const jobEventTopic = "job.event"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}}

type jobEvent struct {
	Type     string \`json:"type"\`
	JobID    string \`json:"job_id"\`
	Attempts int    \`json:"attempts"\`
}

// JobStore is the platform's job store: the state change and its outbox row share one call.
type JobStore interface {
	MarkCompleted(ctx context.Context, jobID string, attempts, durationMS int) error
	AppendHistory(ctx context.Context, jobID string, event jobEvent) error
}

var store JobStore

func publishEvent(ctx context.Context, workerID string, event jobEvent) error {
	// TODO: this draft keys the event by the worker that ran the job, publishes "completed" before
	// the side effect has committed, publishes three of the five transitions, and swallows a
	// producer rejection with a log line where the job_outbox row belongs.
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Topic: jobEventTopic, Key: []byte(workerID), Value: payload})
}

func recordEvent(ctx context.Context, workerID string, event jobEvent) {
	if err := publishEvent(ctx, workerID, event); err != nil {
		log.Printf("event dropped job_id=%s event=%s: %v", event.JobID, event.Type, err)
	}
}

func onEnqueued(ctx context.Context, jobID, workerID string) {
	recordEvent(ctx, workerID, jobEvent{Type: "enqueued", JobID: jobID})
}

func onStarted(ctx context.Context, jobID, workerID string, attempts int) {
	recordEvent(ctx, workerID, jobEvent{Type: "started", JobID: jobID, Attempts: attempts})
}

func completeJob(rw http.ResponseWriter, r *http.Request) {
	jobID := r.PathValue("job_id")
	recordEvent(r.Context(), "worker-1", jobEvent{Type: "completed", JobID: jobID, Attempts: 1})
	if err := store.MarkCompleted(r.Context(), jobID, 1, 0); err != nil {
		http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"job_id": jobID, "state": "completed"})
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/jobs/{job_id}/completed", completeJob)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/segmentio/kafka-go"
)

const (
	jobEventTopic = "job.event"
	outboxBatch   = 100
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type jobEvent struct {
	Type       string \`json:"type"\`
	JobID      string \`json:"job_id"\`
	Attempts   int    \`json:"attempts"\`
	DurationMS int    \`json:"duration_ms"\`
	Error      string \`json:"error,omitempty"\`
}

type outboxRow struct {
	ID    string
	Event jobEvent
}

// JobStore and its transaction are the platform's; the state change and the outbox row share one.
type JobStore interface {
	Begin(ctx context.Context) (Transaction, error)
	MarkCompleted(ctx context.Context, jobID string, attempts, durationMS int) error
	PendingOutbox(ctx context.Context, limit int) ([]outboxRow, error)
	MarkPublished(ctx context.Context, outboxID string) error
	AppendHistory(ctx context.Context, jobID string, event jobEvent) error
}

type Transaction interface {
	Exec(ctx context.Context, sql string, params ...any) error
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

var store JobStore

// publishEvent keys by the job id, so one job's history stays in one ordered partition.
func publishEvent(ctx context.Context, jobID string, event jobEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Topic: jobEventTopic, Key: []byte(jobID), Value: payload})
}

// recordEvent commits the job's new state and the job_outbox row together, then publishes.
func recordEvent(ctx context.Context, event jobEvent) {
	tx, err := store.Begin(ctx)
	if err != nil {
		log.Printf("no transaction for job_id=%s: %v", event.JobID, err)
		return
	}
	update := "UPDATE jobs SET state = $1, attempts = $2 WHERE job_id = $3"
	if err := tx.Exec(ctx, update, event.Type, event.Attempts, event.JobID); err != nil {
		_ = tx.Rollback(ctx)
		return
	}
	sql := "INSERT INTO job_outbox (job_id, event_type, attempts, duration_ms) VALUES ($1, $2, $3, $4)"
	if err := tx.Exec(ctx, sql, event.JobID, event.Type, event.Attempts, event.DurationMS); err != nil {
		_ = tx.Rollback(ctx)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		return
	}
	if err := publishEvent(ctx, event.JobID, event); err != nil {
		log.Printf("event kept in the outbox job_id=%s event=%s: %v", event.JobID, event.Type, err)
	}
}

// relayOutbox republishes what a broker outage left behind; a row is cleared only after the ack.
func relayOutbox(ctx context.Context) {
	rows, err := store.PendingOutbox(ctx, outboxBatch)
	if err != nil {
		return
	}
	for _, row := range rows {
		if err := publishEvent(ctx, row.Event.JobID, row.Event); err != nil {
			continue
		}
		store.MarkPublished(ctx, row.ID)
	}
}

func onEnqueued(ctx context.Context, jobID string) {
	recordEvent(ctx, jobEvent{Type: "enqueued", JobID: jobID})
}

func onStarted(ctx context.Context, jobID string, attempts int) {
	recordEvent(ctx, jobEvent{Type: "started", JobID: jobID, Attempts: attempts})
}

func onFailed(ctx context.Context, jobID string, attempts int, errText string) {
	recordEvent(ctx, jobEvent{Type: "failed", JobID: jobID, Attempts: attempts, Error: errText})
}

func onDeadLettered(ctx context.Context, jobID string, attempts int, errText string) {
	recordEvent(ctx, jobEvent{Type: "dead_lettered", JobID: jobID, Attempts: attempts, Error: errText})
}

// publishCompleted is the only path that emits a completion: the effect has committed by now.
func publishCompleted(ctx context.Context, jobID string, attempts, durationMS int) {
	recordEvent(ctx, jobEvent{Type: "completed", JobID: jobID, Attempts: attempts, DurationMS: durationMS})
}

func completeJob(rw http.ResponseWriter, r *http.Request) {
	jobID := r.PathValue("job_id")
	if err := store.MarkCompleted(r.Context(), jobID, 1, 0); err != nil {
		http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
		return
	}
	publishCompleted(r.Context(), jobID, 1, 0)
	writeJSON(rw, http.StatusOK, map[string]any{"job_id": jobID, "state": "completed"})
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/jobs/{job_id}/completed", completeJob)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class JobEvent(eventType: String, jobId: String, attempts: Int)

/** The platform's job store: the state change and its outbox row share one call. */
trait JobStore {
  def markCompleted(jobId: String, attempts: Int, durationMs: Int): Unit
  def appendHistory(jobId: String, event: JobEvent): Unit
}

object Events {
  implicit val system: ActorSystem = ActorSystem("jobqd-events")

  val JobEventTopic = "job.event"

  val producer = new KafkaProducer[String, String](new Properties())

  private val store: JobStore = new JobStore {
    def markCompleted(jobId: String, attempts: Int, durationMs: Int): Unit = ()
    def appendHistory(jobId: String, event: JobEvent): Unit = ()
  }

  def publishEvent(event: JobEvent, workerId: String): Unit = {
    // TODO: this draft keys the event by the worker that ran the job, publishes "completed" before
    // the side effect has committed, publishes three of the five transitions, and swallows a
    // producer rejection with a log line where the job_outbox row belongs.
    val payload =
      """{"type":"%s","job_id":"%s","attempts":%d}""".format(event.eventType, event.jobId, event.attempts)
    producer.send(new ProducerRecord[String, String](JobEventTopic, workerId, payload))
  }

  def recordEvent(event: JobEvent, workerId: String): Unit = {
    try {
      publishEvent(event, workerId)
    } catch {
      case err: Throwable => system.log.warning("event dropped jobId=%s err=%s".format(event.jobId, err.getMessage))
    }
  }

  def onEnqueued(jobId: String, workerId: String): Unit =
    recordEvent(JobEvent("enqueued", jobId, 0), workerId)

  def onStarted(jobId: String, workerId: String, attempts: Int): Unit =
    recordEvent(JobEvent("started", jobId, attempts), workerId)

  val route: Route =
    path("v1" / "jobs" / Segment / "completed") { jobId =>
      post {
        recordEvent(JobEvent("completed", jobId, 1), "worker-1")
        store.markCompleted(jobId, 1, 0)
        complete(StatusCodes.OK, """{"job_id":"%s","state":"completed"}""".format(jobId))
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class JobEvent(eventType: String, jobId: String, attempts: Int, durationMs: Int, error: String)

final case class OutboxRow(id: String, event: JobEvent)

/** The platform's transaction: the job's state change and its job_outbox row share it. */
trait Tx {
  def execute(sql: String, params: Any*): Unit
}

/** The platform's job store, plus the outbox the relay drains. */
trait JobStore {
  def inTransaction(body: Tx => Unit): Unit
  def markCompleted(jobId: String, attempts: Int, durationMs: Int): Unit
  def pendingOutbox(limit: Int): Seq[OutboxRow]
  def markPublished(outboxId: String): Unit
  def appendHistory(jobId: String, event: JobEvent): Unit
}

object Events {
  implicit val system: ActorSystem = ActorSystem("jobqd-events")

  val JobEventTopic = "job.event"
  val OutboxBatch = 100

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  val producer = new KafkaProducer[String, String](props)

  private val store: JobStore = new JobStore {
    def inTransaction(body: Tx => Unit): Unit = ???
    def markCompleted(jobId: String, attempts: Int, durationMs: Int): Unit = ???
    def pendingOutbox(limit: Int): Seq[OutboxRow] = ???
    def markPublished(outboxId: String): Unit = ???
    def appendHistory(jobId: String, event: JobEvent): Unit = ???
  }

  private def eventJson(event: JobEvent): String =
    """{"type":"%s","job_id":"%s","attempts":%d,"duration_ms":%d,"error":"%s"}"""
      .format(event.eventType, event.jobId, event.attempts, event.durationMs, event.error)

  /** Keyed by the job id, so one job's history stays in one ordered partition. */
  def publishEvent(event: JobEvent): Unit = {
    producer.send(new ProducerRecord[String, String](JobEventTopic, event.jobId, eventJson(event)))
  }

  /** The job's new state and its job_outbox row commit together, then the produce follows. */
  def recordEvent(event: JobEvent): Unit = {
    store.inTransaction { tx =>
      tx.execute(
        "UPDATE jobs SET state = ?, attempts = ? WHERE job_id = ?",
        event.eventType,
        event.attempts,
        event.jobId
      )
      tx.execute(
        "INSERT INTO job_outbox (job_id, event_type, attempts, duration_ms) VALUES (?, ?, ?, ?)",
        event.jobId,
        event.eventType,
        event.attempts,
        event.durationMs
      )
    }
    try {
      publishEvent(event)
    } catch {
      case err: Throwable =>
        system.log.warning("event kept in the outbox jobId=%s err=%s".format(event.jobId, err.getMessage))
    }
  }

  /** Republish what a broker outage left behind; a row is cleared only after the ack. */
  def relayOutbox(): Unit = {
    for (row <- store.pendingOutbox(OutboxBatch)) {
      try {
        publishEvent(row.event)
      } catch {
        case _: Throwable => () // the next pass picks the row up again
      }
      store.markPublished(row.id)
    }
  }

  def onEnqueued(jobId: String): Unit = recordEvent(JobEvent("enqueued", jobId, 0, 0, ""))

  def onStarted(jobId: String, attempts: Int): Unit = recordEvent(JobEvent("started", jobId, attempts, 0, ""))

  def onFailed(jobId: String, attempts: Int, error: String): Unit =
    recordEvent(JobEvent("failed", jobId, attempts, 0, error))

  def onDeadLettered(jobId: String, attempts: Int, error: String): Unit =
    recordEvent(JobEvent("dead_lettered", jobId, attempts, 0, error))

  /** The completion is emitted only once the effect committed and the job was marked completed. */
  def publishCompleted(jobId: String, attempts: Int, durationMs: Int): Unit =
    recordEvent(JobEvent("completed", jobId, attempts, durationMs, ""))

  val route: Route =
    path("v1" / "jobs" / Segment / "completed") { jobId =>
      post {
        store.markCompleted(jobId, 1, 0)
        publishCompleted(jobId, 1, 0)
        complete(StatusCodes.OK, """{"job_id":"%s","state":"completed"}""".format(jobId))
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

const std::string kJobEventTopic = "job.event";

struct JobEvent {
  std::string type;
  std::string job_id;
  int attempts = 0;
};

/** The platform's job store: the state change and its outbox row share one call. */
struct JobStore {
  void mark_completed(const std::string& job_id, int attempts, int duration_ms);
  void append_history(const std::string& job_id, const JobEvent& event);
};

JobStore store;

static void publish_event(RdKafka::Producer* producer, const JobEvent& event, const std::string& worker_id) {
  // TODO: this draft keys the event by the worker that ran the job, publishes "completed" before
  // the side effect has committed, publishes three of the five transitions, and swallows a
  // producer rejection with a log line where the job_outbox row belongs.
  const std::string payload =
      json{{"type", event.type}, {"job_id", event.job_id}, {"attempts", event.attempts}}.dump();
  producer->produce(kJobEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), worker_id.c_str(), worker_id.size(), 0,
                    nullptr);
}

static void record_event(RdKafka::Producer* producer, const JobEvent& event, const std::string& worker_id) {
  try {
    publish_event(producer, event, worker_id);
  } catch (const std::exception& err) {
    std::cerr << "event dropped job_id=" << event.job_id << " err=" << err.what() << "\\n";
  }
}

static void on_enqueued(RdKafka::Producer* producer, const std::string& job_id) {
  record_event(producer, JobEvent{"enqueued", job_id, 0}, "worker-1");
}

static void on_started(RdKafka::Producer* producer, const std::string& job_id, int attempts) {
  record_event(producer, JobEvent{"started", job_id, attempts}, "worker-1");
}

int main() {
  std::string errstr;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  auto* producer = RdKafka::Producer::create(conf, errstr);
  httplib::Server svr;

  svr.Post(R"(/v1/jobs/([^/]+)/completed)", [producer](const httplib::Request& req, httplib::Response& res) {
    const std::string job_id = req.matches[1];
    record_event(producer, JobEvent{"completed", job_id, 1}, "worker-1");
    store.mark_completed(job_id, 1, 0);
    res.status = 200;
    res.set_content(json{{"job_id", job_id}, {"state", "completed"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kJobEventTopic = "job.event";
constexpr int kOutboxBatch = 100;

struct JobEvent {
  std::string type;
  std::string job_id;
  int attempts = 0;
  int duration_ms = 0;
  std::string error;
};

struct OutboxRow {
  std::string id;
  JobEvent event;
};

/** The platform's transaction: the job's state change and its job_outbox row share it. */
struct Transaction {
  void execute(const std::string& sql, const std::vector<std::string>& params);
  void commit();
};

/** The platform's job store, plus the outbox the relay drains. */
struct JobStore {
  Transaction begin_transaction();
  void mark_completed(const std::string& job_id, int attempts, int duration_ms);
  std::vector<OutboxRow> pending_outbox(int limit);
  void mark_published(const std::string& outbox_id);
  void append_history(const std::string& job_id, const JobEvent& event);
};

JobStore store;

/** Keyed by the job id, so one job's history stays in one ordered partition. */
static void publish_event(RdKafka::Producer* producer, const JobEvent& event) {
  const std::string payload =
      json{{"type", event.type},
           {"job_id", event.job_id},
           {"attempts", event.attempts},
           {"duration_ms", event.duration_ms},
           {"error", event.error}}
          .dump();
  producer->produce(kJobEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), event.job_id.c_str(), event.job_id.size(), 0,
                    nullptr);
  producer->poll(0);
}

/** The job's new state and its job_outbox row commit together, then the produce follows. */
static void record_event(RdKafka::Producer* producer, const JobEvent& event) {
  {
    auto tx = store.begin_transaction();
    tx.execute("UPDATE jobs SET state = $1, attempts = $2 WHERE job_id = $3",
               {event.type, std::to_string(event.attempts), event.job_id});
    tx.execute("INSERT INTO job_outbox (job_id, event_type, attempts, duration_ms) VALUES ($1, $2, $3, $4)",
               {event.job_id, event.type, std::to_string(event.attempts), std::to_string(event.duration_ms)});
    tx.commit();
  }
  try {
    publish_event(producer, event);
  } catch (const std::exception& err) {
    std::cerr << "event kept in the outbox job_id=" << event.job_id << " err=" << err.what() << "\\n";
  }
}

/** Republish what a broker outage left behind; a row is cleared only after the ack. */
static void relay_outbox(RdKafka::Producer* producer) {
  for (const OutboxRow& row : store.pending_outbox(kOutboxBatch)) {
    try {
      publish_event(producer, row.event);
    } catch (const std::exception&) {
      continue;
    }
    store.mark_published(row.id);
  }
}

static void on_enqueued(RdKafka::Producer* producer, const std::string& job_id) {
  record_event(producer, JobEvent{"enqueued", job_id, 0, 0, ""});
}

static void on_started(RdKafka::Producer* producer, const std::string& job_id, int attempts) {
  record_event(producer, JobEvent{"started", job_id, attempts, 0, ""});
}

static void on_failed(RdKafka::Producer* producer, const std::string& job_id, int attempts,
                      const std::string& error) {
  record_event(producer, JobEvent{"failed", job_id, attempts, 0, error});
}

static void on_dead_lettered(RdKafka::Producer* producer, const std::string& job_id, int attempts,
                             const std::string& error) {
  record_event(producer, JobEvent{"dead_lettered", job_id, attempts, 0, error});
}

/** The completion is emitted only once the effect committed and the job was marked completed. */
static void publish_completed(RdKafka::Producer* producer, const std::string& job_id, int attempts, int duration_ms) {
  record_event(producer, JobEvent{"completed", job_id, attempts, duration_ms, ""});
}

int main() {
  std::string errstr;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("acks", "all", errstr);
  conf->set("enable.idempotence", "true", errstr);
  auto* producer = RdKafka::Producer::create(conf, errstr);
  httplib::Server svr;

  svr.Post(R"(/v1/jobs/([^/]+)/completed)", [producer](const httplib::Request& req, httplib::Response& res) {
    const std::string job_id = req.matches[1];
    store.mark_completed(job_id, 1, 0);
    publish_completed(producer, job_id, 1, 0);
    res.status = 200;
    res.set_content(json{{"job_id", job_id}, {"state", "completed"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The message key decides the partition, and the partition decides the order the history consumer replays. Key by `job_id` — the thing whose history must stay ordered — not by the worker that happened to claim the attempt; a retry on another worker moves the job to another partition.',
    'A history is only complete if every transition is on it: `enqueued`, `started`, `completed`, `failed`, `dead_lettered`, each carrying `attempts` and `duration_ms`. Three of five is a history with holes exactly where someone is paging.',
    '`completed` is a claim about a side effect that has already happened, so commit the effect and mark the job first and produce second. Then treat the produce as part of the same store call: the state change and the `job_outbox` row commit together, only the ack clears the row, and a relay republishes whatever the broker rejected — in outbox order.',
  ],
  debrief: `The interviewer is testing whether you understand a topic as a log ordered per key, and an event as a claim about something that already happened. The draft reads fine with one worker, one producer and a healthy broker: it produces a valid payload, a valid key and a valid ack, and the flaws only appear when a retry is routed to another pod, when the side effect fails after the completion was announced, or when the broker is unreachable for a minute. The checks cover exactly those: the job-id key (one job's records share a partition), the full transition set with attempts and durations (a history a support engineer can replay), the ordering of the completion after the effect commits (no claim ahead of the fact), and the state change plus job_outbox row in one store call with a relay behind it (recoverable on rejection). The key is the subtle one, because keying by worker looks like it preserves order while one worker is draining the queue and silently stops doing so the moment the pool scales out. The outbox is the one that hides: nothing breaks until the broker blinks, and then the missing records are the ones paging rules and dashboards read. Real platforms add a schema registry with per-event versions, a consumer that stores the last applied transition so a replayed partition cannot move a job backwards, a retention window sized to the longest job, and a relay that publishes in outbox order with a metric on its lag and an alert when it grows.`,
};
