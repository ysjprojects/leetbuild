import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Job events keyed by job id for a run history',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter is the \`job.event\` publisher. \`publish(event)\` produces the event
\`{job_id, kind, attempts, duration_ms, worker}\` keyed by the worker id and logs the error if the
produce call raises. \`complete(job_id, worker, duration_ms)\` publishes the \`completed\` event, then
acks the claim (\`queue.ack\`) and returns the ack's answer. It serves the demo and hides three flaws.

**Failure mode the checks target.** One job's events, written by the workers that ran its attempts,
land on different partitions and arrive out of order; a worker whose claim already expired announces
a completion while another worker runs the job; a record the broker refuses is lost, because the
refusal arrives in the delivery report and nothing reads it.

- Key every record by \`job_id\`.
- \`complete\` acks first; when the ack answers false it publishes nothing and returns false.
- Handle the broker's answer where it arrives (\`on_delivery\`, the rejected \`send\`, the
  \`WriteMessages\` error, \`dr_cb\`, a producer \`Callback\`): a refused event goes to
  \`store.outbox_add(event)\`, and \`publish\` does not raise.`,
  sequence: {
    participants: ['Worker', 'Queue', 'Kafka job.event', 'Outbox'],
    messages: [
      {from: 'Worker', to: 'Queue', label: 'ack(job_id, worker)', kind: 'sync'},
      {from: 'Queue', to: 'Worker', label: 'false → claim gone, publish nothing', kind: 'reply'},
      {
        from: 'Worker',
        to: 'Kafka job.event',
        label: 'produce key = job_id · {kind: completed, attempts, duration_ms}',
        kind: 'async',
      },
      {from: 'Kafka job.event', to: 'Worker', label: 'delivery report: error', kind: 'reply'},
      {from: 'Worker', to: 'Outbox', label: 'outbox_add(event) · the relay republishes it', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'event-envelope',
      title: 'A completed attempt publishes one job.event',
      detail:
        'A completed attempt produces one record on `job.event` carrying `job_id`, `kind: "completed"`, `attempts`, `duration_ms` and `worker`, and `complete` returns true.',
      match: {
        python: {all: [/TOPIC\s*=\s*["']job\.event["']/, /["']duration_ms["']/]},
        typescript: {all: [/TOPIC\s*=\s*['"]job\.event['"]/, /duration_ms/]},
        go: {all: [/"job\.event"/, /"duration_ms"/]},
        scala: {all: [/"job\.event"/, /"duration_ms"/]},
        cpp: {all: [/"job\.event"/, /"duration_ms"/]},
      },
    },
    {
      id: 'job-key',
      title: 'Keys every event by the job id',
      detail:
        "A job whose attempts ran on two workers has both events keyed by its id on one partition; another job's events carry its own id. The starter keys by the worker, so one job's history is spread over partitions.",
      match: {
        python: {all: [/key\s*=\s*event\[["']job_id["']\]/]},
        typescript: {all: [/key:\s*event\.job_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*event\.JobID\s*\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(\s*Topic\s*,\s*field\(event,\s*"job_id"\)/]},
        cpp: {all: [/key\s*=\s*event\.value\(\s*"job_id"/]},
      },
    },
    {
      id: 'completed-after-ack',
      title: 'Publishes completed only after the ack succeeded',
      detail:
        'When the claim expired and another worker holds the job, `complete` returns false and the topic stays empty; the worker that holds the claim publishes its completion. The starter publishes first and acks afterwards.',
      match: {
        python: {all: [/if not queue\.ack\(/], order: [/queue\.ack\(/, /\bpublish\(\{/]},
        typescript: {all: [/if \(!\(await queue\.ack\(/], order: [/queue\.ack\(/, /await publish\(\{/]},
        go: {all: [/queue\.Ack\(/], order: [/queue\.Ack\(/, /publish\(ctx,\s*jobEvent\{/]},
        scala: {all: [/if \(!Queue\.ack\(/], order: [/Queue\.ack\(/, /publish\(JsObject\(/]},
        cpp: {all: [/if \(!queue::ack\(/], order: [/queue::ack\(/, /publish\(json\{/]},
      },
    },
    {
      id: 'outbox-on-rejection',
      title: 'A refused record goes to the outbox from the delivery report',
      detail:
        'When the broker refuses the record, the event lands in `jobs:outbox`, nothing reaches the topic, and `complete` neither raises nor undoes the completed job. The starter looks only at errors the produce call itself raises.',
      match: {
        python: {all: [/on_delivery\s*=/, /store\.outbox_add\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/catch[\s\S]*store\.outboxAdd\(/]},
        go: {all: [/store\.OutboxAdd\(/]},
        scala: {all: [/Store\.outboxAdd\(/, /exception != null/]},
        cpp: {all: [/store::outboxAdd\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import KafkaException, Producer

from jobs import queue, store  # queue.ack · store.get_job, outbox_add

TOPIC = "job.event"

logger = logging.getLogger("jobqd.events")
producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish(event: dict) -> None:
    """Produce one job.event: {job_id, kind, attempts, duration_ms, worker}."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    try:
        producer.produce(TOPIC, key=event["worker"], value=json.dumps(event))
        producer.poll(0)
    except KafkaException as exc:
        logger.warning("job.event produce failed job=%s: %s", event["job_id"], exc)


def complete(job_id: str, worker: str, duration_ms: int) -> bool:
    """Finish an attempt that succeeded: ack the claim and publish completed. False when the claim was gone."""
    job = store.get_job(job_id)
    publish({"job_id": job_id, "kind": "completed", "attempts": job["attempts"], "duration_ms": duration_ms, "worker": worker})
    return queue.ack(job_id, worker)
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from jobs import queue, store  # queue.ack · store.get_job, outbox_add

TOPIC = "job.event"

logger = logging.getLogger("jobqd.events")
producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish(event: dict) -> None:
    """Produce one job.event: {job_id, kind, attempts, duration_ms, worker}."""

    def on_delivery(err, msg) -> None:
        if err is not None:
            # The broker said no, and it says so here, not at produce(): the relay republishes the row.
            store.outbox_add(event)
            logger.warning("job.event refused job=%s: %s", event["job_id"], err)

    # Keyed by the job: every attempt's events share one partition, in order.
    producer.produce(TOPIC, key=event["job_id"], value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)


def complete(job_id: str, worker: str, duration_ms: int) -> bool:
    """Finish an attempt that succeeded: ack the claim and publish completed. False when the claim was gone."""
    # The ack is the commit: a worker whose claim expired may not announce the job as done.
    if not queue.ack(job_id, worker):
        return False
    job = store.get_job(job_id)
    publish({"job_id": job_id, "kind": "completed", "attempts": job["attempts"], "duration_ms": duration_ms, "worker": worker})
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as queue from 'jobs/queue'; // ack
import * as store from 'jobs/store'; // getJob, outboxAdd

export const TOPIC = 'job.event';

export interface JobEvent {
  job_id: string;
  kind: string;
  attempts: number;
  duration_ms: number;
  worker: string;
}

const kafka = new Kafka({clientId: 'jobqd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Produce one job.event. */
export async function publish(event: JobEvent): Promise<void> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  try {
    await producer.send({topic: TOPIC, messages: [{key: event.worker, value: JSON.stringify(event)}]});
  } catch (err) {
    console.warn(\`job.event produce failed job=\${event.job_id}: \${(err as Error).message}\`);
  }
}

/** Finish an attempt that succeeded: ack the claim and publish completed. False when the claim was gone. */
export async function complete(jobId: string, worker: string, durationMs: number): Promise<boolean> {
  const job = (await store.getJob(jobId)) as store.Job;
  await publish({job_id: jobId, kind: 'completed', attempts: job.attempts, duration_ms: durationMs, worker});
  return queue.ack(jobId, worker);
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as queue from 'jobs/queue'; // ack
import * as store from 'jobs/store'; // getJob, outboxAdd

export const TOPIC = 'job.event';

export interface JobEvent {
  job_id: string;
  kind: string;
  attempts: number;
  duration_ms: number;
  worker: string;
}

const kafka = new Kafka({clientId: 'jobqd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Produce one job.event. */
export async function publish(event: JobEvent): Promise<void> {
  try {
    // Keyed by the job: every attempt's events share one partition, in order.
    await producer.send({topic: TOPIC, messages: [{key: event.job_id, value: JSON.stringify(event)}]});
  } catch (err) {
    // The broker said no: keep the event for the relay instead of dropping it.
    await store.outboxAdd({...event});
    console.warn(\`job.event refused job=\${event.job_id}: \${(err as Error).message}\`);
  }
}

/** Finish an attempt that succeeded: ack the claim and publish completed. False when the claim was gone. */
export async function complete(jobId: string, worker: string, durationMs: number): Promise<boolean> {
  // The ack is the commit: a worker whose claim expired may not announce the job as done.
  if (!(await queue.ack(jobId, worker))) return false;
  const job = (await store.getJob(jobId)) as store.Job;
  await publish({job_id: jobId, kind: 'completed', attempts: job.attempts, duration_ms: durationMs, worker});
  return true;
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

	"jobs/queue" // queue.Ack
	"jobs/store" // store.GetJob, OutboxAdd
)

const topic = "job.event"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}}

type jobEvent struct {
	JobID      string \`json:"job_id"\`
	Kind       string \`json:"kind"\`
	Attempts   int    \`json:"attempts"\`
	DurationMs int64  \`json:"duration_ms"\`
	Worker     string \`json:"worker"\`
}

// publish produces one job.event.
func publish(ctx context.Context, event jobEvent) error {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.Worker), Value: value}); err != nil {
		log.Printf("job.event produce failed job=%s: %v", event.JobID, err)
	}
	return nil
}

// complete finishes an attempt that succeeded: ack the claim and publish completed. False when the claim was gone.
func complete(ctx context.Context, jobID, worker string, durationMs int64) (bool, error) {
	job := store.GetJob(ctx, jobID)
	if err := publish(ctx, jobEvent{JobID: jobID, Kind: "completed", Attempts: job.Attempts, DurationMs: durationMs, Worker: worker}); err != nil {
		return false, err
	}
	return queue.Ack(ctx, jobID, worker)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"

	"jobs/queue" // queue.Ack
	"jobs/store" // store.GetJob, OutboxAdd
)

const topic = "job.event"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}}

type jobEvent struct {
	JobID      string \`json:"job_id"\`
	Kind       string \`json:"kind"\`
	Attempts   int    \`json:"attempts"\`
	DurationMs int64  \`json:"duration_ms"\`
	Worker     string \`json:"worker"\`
}

// publish produces one job.event.
func publish(ctx context.Context, event jobEvent) error {
	value, _ := json.Marshal(event)
	// Keyed by the job: every attempt's events share one partition, in order.
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.JobID), Value: value}); err != nil {
		// The broker said no: keep the event for the relay instead of dropping it.
		log.Printf("job.event refused job=%s: %v", event.JobID, err)
		return store.OutboxAdd(ctx, event)
	}
	return nil
}

// complete finishes an attempt that succeeded: ack the claim and publish completed. False when the claim was gone.
func complete(ctx context.Context, jobID, worker string, durationMs int64) (bool, error) {
	// The ack is the commit: a worker whose claim expired may not announce the job as done.
	acked, err := queue.Ack(ctx, jobID, worker)
	if err != nil || !acked {
		return false, err
	}
	job := store.GetJob(ctx, jobID)
	return true, publish(ctx, jobEvent{JobID: jobID, Kind: "completed", Attempts: job.Attempts, DurationMs: durationMs, Worker: worker})
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import jobs.{Queue, Store} // Queue.ack · Store.getJob, outboxAdd

object Events {
  val Topic = "job.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def field(event: JsObject, name: String): String = event.fields(name) match {
    case JsString(s) => s
    case other => other.compactPrint
  }

  /** Produce one job.event: {job_id, kind, attempts, duration_ms, worker}. */
  def publish(event: JsObject): Unit = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    try producer.send(new ProducerRecord[String, String](Topic, field(event, "worker"), event.compactPrint))
    catch { case e: KafkaException => System.err.println(s"job.event produce failed job=\${field(event, "job_id")}: \${e.getMessage}") }
  }

  /** Finish an attempt that succeeded: ack the claim and publish completed. False when the claim was gone. */
  def complete(jobId: String, worker: String, durationMs: Long): Boolean = {
    val job = Store.getJob(jobId).getOrElse(throw new NoSuchElementException(s"no job $jobId"))
    publish(JsObject("job_id" -> JsString(jobId), "kind" -> JsString("completed"), "attempts" -> JsNumber(job.attempts),
      "duration_ms" -> JsNumber(durationMs), "worker" -> JsString(worker)))
    Queue.ack(jobId, worker)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import jobs.{Queue, Store} // Queue.ack · Store.getJob, outboxAdd

object Events {
  val Topic = "job.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def field(event: JsObject, name: String): String = event.fields(name) match {
    case JsString(s) => s
    case other => other.compactPrint
  }

  /** Produce one job.event: {job_id, kind, attempts, duration_ms, worker}. */
  def publish(event: JsObject): Unit = {
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) {
          // The broker said no, and it says so here, not at send(): the relay republishes the row.
          Store.outboxAdd(event)
          System.err.println(s"job.event refused job=\${field(event, "job_id")}: \${exception.getMessage}")
        }
    }
    // Keyed by the job: every attempt's events share one partition, in order.
    producer.send(new ProducerRecord[String, String](Topic, field(event, "job_id"), event.compactPrint), onDelivery)
  }

  /** Finish an attempt that succeeded: ack the claim and publish completed. False when the claim was gone. */
  def complete(jobId: String, worker: String, durationMs: Long): Boolean = {
    // The ack is the commit: a worker whose claim expired may not announce the job as done.
    if (!Queue.ack(jobId, worker)) return false
    val job = Store.getJob(jobId).getOrElse(throw new NoSuchElementException(s"no job $jobId"))
    publish(JsObject("job_id" -> JsString(jobId), "kind" -> JsString("completed"), "attempts" -> JsNumber(job.attempts),
      "duration_ms" -> JsNumber(durationMs), "worker" -> JsString(worker)))
    true
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "jobs/queue.h"  // queue::ack
#include "jobs/store.h"  // store::getJob, outboxAdd

using json = nlohmann::json;

const std::string kTopic = "job.event";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Produce one job.event: {job_id, kind, attempts, duration_ms, worker}.
void publish(const json& event) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string value = event.dump();
  const std::string key = event.value("worker", "");
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   const_cast<char*>(value.data()), value.size(), key.data(), key.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) std::cerr << "job.event produce failed: " << RdKafka::err2str(err) << "\\n";
  producer->poll(0);
}

// Finish an attempt that succeeded: ack the claim and publish completed. False when the claim was gone.
bool complete(const std::string& job_id, const std::string& worker, long long duration_ms) {
  const auto job = store::getJob(job_id);
  publish(json{{"job_id", job_id}, {"kind", "completed"}, {"attempts", job ? job->attempts : 0}, {"duration_ms", duration_ms}, {"worker", worker}});
  return queue::ack(job_id, worker);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "jobs/queue.h"  // queue::ack
#include "jobs/store.h"  // store::getJob, outboxAdd

using json = nlohmann::json;

const std::string kTopic = "job.event";

// The delivery report: the broker's refusal arrives here, not at produce(); the relay republishes the row.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    store::outboxAdd(json::parse(std::string(static_cast<const char*>(message.payload()), message.len())));
    std::cerr << "job.event refused: " << message.errstr() << "\\n";
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Produce one job.event: {job_id, kind, attempts, duration_ms, worker}.
void publish(const json& event) {
  const std::string value = event.dump();
  // Keyed by the job: every attempt's events share one partition, in order.
  const std::string key = event.value("job_id", "");
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), key.data(), key.size(), 0, nullptr);
  producer->poll(0);  // serve delivery reports already in; returns at once
}

// Finish an attempt that succeeded: ack the claim and publish completed. False when the claim was gone.
bool complete(const std::string& job_id, const std::string& worker, long long duration_ms) {
  // The ack is the commit: a worker whose claim expired may not announce the job as done.
  if (!queue::ack(job_id, worker)) return false;
  const auto job = store::getJob(job_id);
  publish(json{{"job_id", job_id}, {"kind", "completed"}, {"attempts", job ? job->attempts : 0}, {"duration_ms", duration_ms}, {"worker", worker}});
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from jobs import queue, store

TOPIC = "job.event"


def _claimed(job_id, worker="w-1"):
    store.create_job(job_id, "t-1", "email.send", {"to": "ada@example.com", "template": "welcome"})
    assert queue.claim(worker) == job_id, f"the harness could not claim {job_id}"
    store.begin_attempt(job_id)


def _settle(m):
    """Serve the producer's delivery reports, as the worker's loop would between jobs."""
    m.producer.poll(0)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def check_event_envelope(ctx):
    m = ctx.load("events")
    _claimed("job-1")
    assert m.complete("job-1", "w-1", 840) is True, "completing an attempt the worker holds must return True"
    _settle(m)
    events = _events(ctx)
    assert len(events) == 1, f"one completed attempt produced {len(events)} records on {TOPIC}"
    expected = {"job_id": "job-1", "kind": "completed", "attempts": 1, "duration_ms": 840, "worker": "w-1"}
    for key, value in expected.items():
        assert events[0].get(key) == value, f"the event must carry {key}={value!r}, got {events[0]}"


def check_job_key(ctx):
    m = ctx.load("events")
    _claimed("job-1", "w-1")
    _claimed("job-2", "w-2")
    # job-1's first attempt ran on w-3 and failed; its second runs on w-1
    m.publish({"job_id": "job-1", "kind": "failed", "attempts": 1, "duration_ms": 30000, "worker": "w-3"})
    assert m.complete("job-1", "w-1", 900) is True
    assert m.complete("job-2", "w-2", 450) is True
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    keys = sorted((r.key or b"").decode() for r in records)
    assert keys == ["job-1", "job-1", "job-2"], f"the records are keyed {keys}, expected by job id: keyed by worker, a job retried on another worker has its history split across partitions"
    partitions = {r.partition for r in records if r.key == b"job-1"}
    assert len(partitions) == 1, f"job-1's two events landed on partitions {sorted(partitions)}: one job's history must share a partition to stay in order"


def check_completed_after_ack(ctx):
    m = ctx.load("events")
    _claimed("job-1", "w-1")
    ctx.clock.advance(61)  # w-1 was too slow: the claim expired and the job went to w-2
    queue.return_expired()
    assert queue.claim("w-2") == "job-1"
    done = m.complete("job-1", "w-1", 61000)
    _settle(m)
    assert done is False, f"complete returned {done!r} for a claim w-1 no longer holds"
    assert ctx.kafka.records(TOPIC) == [], f"w-1 lost its claim, yet it published {_events(ctx)}: the history says the job finished while w-2 is still running it. Ack first and publish only when the ack succeeded"
    assert m.complete("job-1", "w-2", 700) is True, "the worker holding the claim must complete the job"
    _settle(m)
    events = _events(ctx)
    assert len(events) == 1 and events[0].get("worker") == "w-2", f"the completion must be published once, by w-2: {events}"


def check_outbox_on_rejection(ctx):
    m = ctx.load("events")
    _claimed("job-1")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        done = m.complete("job-1", "w-1", 840)
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"complete raised when the broker refused the record: {e!r}; the event goes to the outbox and the worker goes on") from e
    _settle(m)
    rows = [json.loads(row) for row in ctx.redis.lrange("jobs:outbox", 0, -1)]
    assert len(rows) == 1, f"the broker refused the completed event and jobs:outbox holds {len(rows)} rows: the refusal arrives in the delivery report, and the event must be kept for the relay"
    assert rows[0].get("job_id") == "job-1" and rows[0].get("kind") == "completed", f"the outbox row must be the event itself, got {rows[0]}"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused record"
    assert done is True and store.get_job("job-1")["state"] == "completed", f"the job is done whatever the broker said: complete returned {done!r} and the job is {store.get_job('job-1')}"
`,
    typescript: `const TOPIC = 'job.event';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

async function setup(ctx) {
  return {m: ctx.load('events'), queue: ctx.load('/support/jobs/queue.ts'), store: ctx.load('/support/jobs/store.ts')};
}

async function claimed(queue, store, jobId: string, worker = 'w-1'): Promise<void> {
  await store.createJob(jobId, 't-1', 'email.send', {to: 'ada@example.com', template: 'welcome'});
  assert.equal(await queue.claim(worker), jobId, \`the harness could not claim \${jobId}\`);
  await store.beginAttempt(jobId);
}

const events = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));

export async function check_event_envelope(ctx) {
  const {m, queue, store} = await setup(ctx);
  await claimed(queue, store, 'job-1');
  assert.equal(await m.complete('job-1', 'w-1', 840), true, 'completing an attempt the worker holds must return true');
  await settle();
  const all = events(ctx);
  assert.equal(all.length, 1, \`one completed attempt produced \${all.length} records on \${TOPIC}\`);
  const expected = {job_id: 'job-1', kind: 'completed', attempts: 1, duration_ms: 840, worker: 'w-1'};
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(all[0][key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${JSON.stringify(all[0])}\`);
}

export async function check_job_key(ctx) {
  const {m, queue, store} = await setup(ctx);
  await claimed(queue, store, 'job-1', 'w-1');
  await claimed(queue, store, 'job-2', 'w-2');
  // job-1's first attempt ran on w-3 and failed; its second runs on w-1
  await m.publish({job_id: 'job-1', kind: 'failed', attempts: 1, duration_ms: 30000, worker: 'w-3'});
  assert.equal(await m.complete('job-1', 'w-1', 900), true);
  assert.equal(await m.complete('job-2', 'w-2', 450), true);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  const keys = records.map(r => r.key?.toString() ?? '').sort();
  assert.deepEqual(keys, ['job-1', 'job-1', 'job-2'], \`the records are keyed \${JSON.stringify(keys)}, expected by job id: keyed by worker, a job retried on another worker has its history split across partitions\`);
  const partitions = new Set(records.filter(r => r.key?.toString() === 'job-1').map(r => r.partition));
  assert.equal(partitions.size, 1, \`job-1's two events landed on partitions \${JSON.stringify([...partitions])}: one job's history must share a partition to stay in order\`);
}

export async function check_completed_after_ack(ctx) {
  const {m, queue, store} = await setup(ctx);
  await claimed(queue, store, 'job-1', 'w-1');
  ctx.clock.advance(61); // w-1 was too slow: the claim expired and the job went to w-2
  await queue.returnExpired();
  assert.equal(await queue.claim('w-2'), 'job-1');
  const done = await m.complete('job-1', 'w-1', 61000);
  await settle();
  assert.equal(done, false, \`complete returned \${done} for a claim w-1 no longer holds\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, \`w-1 lost its claim, yet it published \${JSON.stringify(events(ctx))}: the history says the job finished while w-2 is still running it. Ack first and publish only when the ack succeeded\`);
  assert.equal(await m.complete('job-1', 'w-2', 700), true, 'the worker holding the claim must complete the job');
  await settle();
  const all = events(ctx);
  assert(all.length === 1 && all[0].worker === 'w-2', \`the completion must be published once, by w-2: \${JSON.stringify(all)}\`);
}

export async function check_outbox_on_rejection(ctx) {
  const {m, queue, store} = await setup(ctx);
  await claimed(queue, store, 'job-1');
  ctx.kafka.failNext(TOPIC, 1);
  let done;
  try {
    done = await m.complete('job-1', 'w-1', 840);
  } catch (e) {
    assert.fail(\`complete rejected when the broker refused the record: \${e}; the event goes to the outbox and the worker goes on\`);
  }
  await settle();
  const rows = ctx.redis.lrange('jobs:outbox', 0, -1).map(row => JSON.parse(row));
  assert.equal(rows.length, 1, \`the broker refused the completed event and jobs:outbox holds \${rows.length} rows: the event must be kept for the relay\`);
  assert(rows[0].job_id === 'job-1' && rows[0].kind === 'completed', \`the outbox row must be the event itself, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused record');
  const job = await store.getJob('job-1');
  assert(done === true && job.state === 'completed', \`the job is done whatever the broker said: complete returned \${done} and the job is \${JSON.stringify(job)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"

	"jobs/queue"
	"jobs/store"

	"leetbuild/harness"
)

var eventsBg = context.Background()

func eventsClaimed(ctx *harness.Ctx, jobID, worker string) {
	ctx.NoError(store.CreateJob(eventsBg, jobID, "t-1", "email.send", map[string]any{"to": "ada@example.com", "template": "welcome"}), "CreateJob")
	got, err := queue.Claim(eventsBg, worker)
	ctx.NoError(err, "Claim")
	ctx.Equal(got, jobID, "the harness's claim")
	store.BeginAttempt(eventsBg, jobID)
}

func eventsComplete(ctx *harness.Ctx, jobID, worker string, durationMs int64) bool {
	done, err := complete(eventsBg, jobID, worker, durationMs)
	ctx.NoError(err, "complete(%s, %s)", jobID, worker)
	return done
}

func eventsAll(ctx *harness.Ctx) []map[string]any {
	out := []map[string]any{}
	for _, r := range ctx.Kafka.Records(topic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal(r.Value, &e), "the event is JSON: %s", r.Value)
		out = append(out, e)
	}
	return out
}

func CheckEventEnvelope(ctx *harness.Ctx) {
	eventsClaimed(ctx, "job-1", "w-1")
	ctx.Assert(eventsComplete(ctx, "job-1", "w-1", 840), "completing an attempt the worker holds must return true")
	ctx.Settle()
	all := eventsAll(ctx)
	ctx.Equal(len(all), 1, "one completed attempt's records on job.event")
	ctx.Equal(all[0], map[string]any{"job_id": "job-1", "kind": "completed", "attempts": float64(1), "duration_ms": float64(840), "worker": "w-1"}, "the event")
}

func CheckJobKey(ctx *harness.Ctx) {
	eventsClaimed(ctx, "job-1", "w-1")
	eventsClaimed(ctx, "job-2", "w-2")
	// job-1's first attempt ran on w-3 and failed; its second runs on w-1
	ctx.NoError(publish(eventsBg, jobEvent{JobID: "job-1", Kind: "failed", Attempts: 1, DurationMs: 30000, Worker: "w-3"}), "publish")
	ctx.Assert(eventsComplete(ctx, "job-1", "w-1", 900), "job-1 completes")
	ctx.Assert(eventsComplete(ctx, "job-2", "w-2", 450), "job-2 completes")
	ctx.Settle()
	keys := ctx.Kafka.Keys(topic)
	sort.Strings(keys)
	ctx.Equal(keys, []string{"job-1", "job-1", "job-2"}, "the record keys (keyed by worker, a job retried on another worker has its history split across partitions)")
	partitions := map[int]bool{}
	for _, r := range ctx.Kafka.Records(topic) {
		if string(r.Key) == "job-1" {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "one job's history must share a partition to stay in order; the partitions job-1's events landed on")
}

func CheckCompletedAfterAck(ctx *harness.Ctx) {
	eventsClaimed(ctx, "job-1", "w-1")
	ctx.Clock.Advance(61) // w-1 was too slow: the claim expired and the job went to w-2
	queue.ReturnExpired(eventsBg)
	got, _ := queue.Claim(eventsBg, "w-2")
	ctx.Equal(got, "job-1", "w-2's claim")
	done := eventsComplete(ctx, "job-1", "w-1", 61000)
	ctx.Settle()
	ctx.Assert(!done, "complete returned true for a claim w-1 no longer holds")
	ctx.Assert(len(ctx.Kafka.Records(topic)) == 0, "w-1 lost its claim, yet it published %v: the history says the job finished while w-2 is still running it. Ack first and publish only when the ack succeeded", eventsAll(ctx))
	ctx.Assert(eventsComplete(ctx, "job-1", "w-2", 700), "the worker holding the claim must complete the job")
	ctx.Settle()
	all := eventsAll(ctx)
	ctx.Assert(len(all) == 1 && all[0]["worker"] == "w-2", "the completion must be published once, by w-2: %v", all)
}

func CheckOutboxOnRejection(ctx *harness.Ctx) {
	eventsClaimed(ctx, "job-1", "w-1")
	ctx.Kafka.FailNext(topic, 1)
	done, err := complete(eventsBg, "job-1", "w-1", 840)
	ctx.NoError(err, "complete must not fail when the broker refused the record (the event goes to the outbox and the worker goes on)")
	ctx.Settle()
	rows := ctx.Redis.LRange("jobs:outbox", 0, -1)
	ctx.Equal(len(rows), 1, "the broker refused the completed event: it must be kept for the relay; outbox rows")
	var row map[string]any
	json.Unmarshal([]byte(rows[0]), &row)
	ctx.Assert(row["job_id"] == "job-1" && row["kind"] == "completed", "the outbox row must be the event itself, got %s", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(topic)), 0, "nothing reached the topic for the refused record; records")
	job := store.GetJob(eventsBg, "job-1")
	ctx.Assert(done && job.State == "completed", "the job is done whatever the broker said: complete returned %v and the job is %+v", done, job)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <exception>
#include <set>
#include <string>
#include <vector>

#include "jobs/queue.h"
#include "jobs/store.h"

namespace {

void eventsClaimed(harness::Ctx& ctx, const std::string& job_id, const std::string& worker) {
  store::createJob(job_id, "t-1", "email.send", nlohmann::json{{"to", "ada@example.com"}, {"template", "welcome"}});
  ctx.Equal(queue::claim(worker).value_or(""), job_id, "the harness's claim");
  store::beginAttempt(job_id);
}

// Serve the producer's delivery reports, as the worker's loop would between jobs.
void eventsSettle(harness::Ctx& ctx) {
  ctx.Settle();
  producer->poll(0);
}

std::vector<nlohmann::json> eventsAll(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& r : ctx.Kafka.Records(kTopic)) out.push_back(nlohmann::json::parse(r.Value.value_or("null"), nullptr, false));
  return out;
}

}  // namespace

void CheckEventEnvelope(harness::Ctx& ctx) {
  eventsClaimed(ctx, "job-1", "w-1");
  ctx.Assert(complete("job-1", "w-1", 840), "completing an attempt the worker holds must return true");
  eventsSettle(ctx);
  const auto all = eventsAll(ctx);
  ctx.Equal(all.size(), 1, "one completed attempt's records on job.event");
  ctx.Equal(all[0], nlohmann::json({{"job_id", "job-1"}, {"kind", "completed"}, {"attempts", 1}, {"duration_ms", 840}, {"worker", "w-1"}}), "the event");
}

void CheckJobKey(harness::Ctx& ctx) {
  eventsClaimed(ctx, "job-1", "w-1");
  eventsClaimed(ctx, "job-2", "w-2");
  // job-1's first attempt ran on w-3 and failed; its second runs on w-1
  publish(nlohmann::json{{"job_id", "job-1"}, {"kind", "failed"}, {"attempts", 1}, {"duration_ms", 30000}, {"worker", "w-3"}});
  ctx.Assert(complete("job-1", "w-1", 900), "job-1 completes");
  ctx.Assert(complete("job-2", "w-2", 450), "job-2 completes");
  eventsSettle(ctx);
  auto keys = ctx.Kafka.Keys(kTopic);
  std::sort(keys.begin(), keys.end());
  ctx.Equal(keys, std::vector<std::string>{"job-1", "job-1", "job-2"}, "the record keys (keyed by worker, a job retried on another worker has its history split across partitions)");
  std::set<int> partitions;
  for (const auto& r : ctx.Kafka.Records(kTopic)) {
    if (r.Key.value_or("") == "job-1") partitions.insert(r.Partition);
  }
  ctx.Equal(partitions.size(), 1, "one job's history must share a partition to stay in order; the partitions job-1's events landed on");
}

void CheckCompletedAfterAck(harness::Ctx& ctx) {
  eventsClaimed(ctx, "job-1", "w-1");
  ctx.Clock.Advance(61);  // w-1 was too slow: the claim expired and the job went to w-2
  queue::returnExpired();
  ctx.Equal(queue::claim("w-2").value_or(""), "job-1", "w-2's claim");
  const bool done = complete("job-1", "w-1", 61000);
  eventsSettle(ctx);
  ctx.Assert(!done, "complete returned true for a claim w-1 no longer holds");
  ctx.Assert(ctx.Kafka.Records(kTopic).empty(), "w-1 lost its claim, yet it published %d completed event(s): the history says the job finished while w-2 is still running it. Ack first and publish only when the ack succeeded", eventsAll(ctx).size());
  ctx.Assert(complete("job-1", "w-2", 700), "the worker holding the claim must complete the job");
  eventsSettle(ctx);
  const auto all = eventsAll(ctx);
  ctx.Assert(all.size() == 1 && all[0].value("worker", "") == "w-2", "the completion must be published once, by w-2 (%d records)", all.size());
}

void CheckOutboxOnRejection(harness::Ctx& ctx) {
  eventsClaimed(ctx, "job-1", "w-1");
  ctx.Kafka.FailNext(kTopic, 1);
  bool done = false;
  try {
    done = complete("job-1", "w-1", 840);
  } catch (const std::exception& e) {
    ctx.Fatalf("complete threw when the broker refused the record: %s; the event goes to the outbox and the worker goes on", e.what());
  }
  eventsSettle(ctx);
  const auto rows = ctx.Redis.LRange("jobs:outbox", 0, -1);
  ctx.Equal(rows.size(), 1, "the broker refused the completed event: it must be kept for the relay; outbox rows");
  const auto row = nlohmann::json::parse(rows.empty() ? "{}" : rows[0], nullptr, false);
  ctx.Assert(row.value("job_id", "") == "job-1" && row.value("kind", "") == "completed", "the outbox row must be the event itself, got %s", rows.empty() ? "" : rows[0]);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "nothing reached the topic for the refused record; records");
  ctx.Assert(done && store::getJob("job-1")->state == "completed", "the job is done whatever the broker said: complete returned %t and the job is %s", done, store::getJob("job-1")->state);
}
`,
  },
  hints: [
    'Run one job on two workers and read its history from the topic: its events sit on two partitions. Let a claim expire and finish the attempt anyway: a completed event appears while another worker runs the job. Refuse one produce: the event is gone.',
    "The key is the worker, and the partition follows the key. `complete` produces before it learns whether the ack worked. The `try` around `produce` sees only local errors; the broker's refusal comes back later, in the delivery report.",
    'Produce with `key=event["job_id"]` and an `on_delivery` callback that calls `store.outbox_add(event)` on an error; in `complete`, return False when `queue.ack(job_id, worker)` does, and publish only after it returned True.',
  ],
  debrief: `The key is the job because the history is read per job and Kafka orders records only within a partition; keyed by worker, a job retried on another machine has its events split across partitions. The ack comes first because the event is a statement about committed state: a worker whose claim expired has lost the right to say the job finished, and the ack is where it finds out. The outbox is written from the delivery report because that is where the broker's answer arrives; a \`try\` around \`produce\` catches only a full local queue. Production pipelines write the outbox row in the same transaction as the state change and let a relay drain it, so a crash between the ack and the produce cannot lose the event either.`,
};
