import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Job events keyed by job with no code or output blobs',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['runner', 'kafka', 'audit'],
  task: `## Task

**Starting point.** The starter is \`publish(job_id, stage)\`, called when a job is \`started\` and
when it is \`finished\`: it reads the job with \`jobs.get\`, builds the event with
\`event_payload(job, stage)\` (job id, stage, tenant, used profile, exit code, usage, the digests
of code and output, and the last 4 KiB of output), produces it to \`sandbox.job\` keyed by the
requested profile, and writes an outbox row if the produce raises. It serves the demo and hides four
flaws.

**Failure mode the checks target.** One job's \`started\` and \`finished\` land on different
partitions while unrelated jobs share one; a tenant's output is copied into a retained, replicated
topic; a lost acknowledgement or a leader failover duplicates or drops an event; and a delivery that
fails after the produce call returned leaves no trace.

- The record key is the **job id**.
- The payload carries provenance, not content: \`job_id\`, \`stage\`, \`tenant\`, \`profile\`,
  \`exit_code\`, \`usage\` (\`cpu_ms\`, \`mem_mb\`), \`code_digest\`, \`output_digest\`, and no code or
  output text.
- The producer is **idempotent** with **\`acks=all\`** (in Go, confluent-kafka-go: kafka-go has no
  idempotent producer).
- **Wait for the delivery report**, at most \`ACK_TIMEOUT_S\` (2 s); a failed or missing report writes
  \`jobs.insert_outbox(topic, job_id, payload)\` and \`publish\` answers false.`,
  sequence: {
    participants: ['Runner', 'job store', 'Kafka sandbox.job', 'Audit consumer'],
    messages: [
      {from: 'Runner', to: 'job store', label: 'get(job_id) · digests, usage, used profile', kind: 'sync'},
      {from: 'Runner', to: 'Kafka sandbox.job', label: 'produce key = job_id · idempotent · acks=all', kind: 'sync'},
      {from: 'Kafka sandbox.job', to: 'Runner', label: 'delivery report within 2 s → true', kind: 'reply'},
      {from: 'Runner', to: 'job store', label: 'no report / failed → insert_outbox → false', kind: 'async'},
      {from: 'Kafka sandbox.job', to: 'Audit consumer', label: 'one job, one partition, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'job-key',
      title: 'Keys sandbox.job by the job id',
      detail:
        'Events for j-1, j-2, j-1 carry those keys and both j-1 events share a partition. The starter keys by profile, which spreads one job over partitions as profiles change and packs every gvisor job into one.',
      match: {
        python: {all: [/key\s*=\s*job_id/], none: [/key\s*=\s*job\[["']profile["']\]/]},
        typescript: {all: [/key:\s*jobId\b/], none: [/key:\s*job\.profile/]},
        go: {all: [/Key:\s*\[\]byte\(jobID\)/], none: [/Key:\s*\[\]byte\(job\.Profile\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*jobId/], none: [/\(Topic,\s*job\.profile/]},
        cpp: {all: [/job_id\.c_str\(\),\s*job_id\.(size|length)\(\)/], none: [/profile\.c_str\(\)/]},
      },
    },
    {
      id: 'digest-payload',
      title: 'Carries digests and usage, never code or output',
      detail:
        'The finished event carries `code_digest` and `output_digest` equal to the SHA-256 of the code and the output, the used profile, the exit code and the usage, and neither text appears anywhere in the record. The starter adds `output_tail`.',
      match: {
        python: {all: [/code_digest/, /output_digest/], none: [/output_tail|read_output\(/]},
        typescript: {all: [/code_digest/, /output_digest/], none: [/output_tail|readOutput\(/]},
        go: {all: [/code_digest/, /output_digest/], none: [/output_tail|ReadOutput\(/]},
        scala: {all: [/code_digest/, /output_digest/], none: [/output_tail|readOutput\(/]},
        cpp: {all: [/code_digest/, /output_digest/], none: [/output_tail|readOutput\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter uses the default producer configuration.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the job id as key and the payload, and `publish` answers false. The starter only catches an error raised by the produce call itself, which a broker-side failure never is.',
      match: {
        python: {
          all: [/on_delivery\s*=/, /\.flush\(\s*ACK_TIMEOUT_S\s*\)/, /insert_outbox\(/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/await\s+producer\.send\(/, /insertOutbox\(/], none: [/void\s+producer\.send\(/]},
        go: {all: [/deliveries|make\(chan kafka\.Event/, /TopicPartition\.Error/, /InsertOutbox\(/]},
        scala: {all: [/\.get\(\s*AckTimeoutMs/, /insertOutbox\(/]},
        cpp: {all: [/dr_cb/, /insertOutbox\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from sandbox import jobs  # get, read_output, insert_outbox

TOPIC = "sandbox.job"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def event_payload(job: dict, stage: str) -> dict:
    """One lifecycle event of the job, as the audit consumer reads it."""
    output = jobs.read_output(job["job_id"]) or ""
    return {
        "job_id": job["job_id"],
        "stage": stage,
        "tenant": job["tenant"],
        "profile": job["used_profile"],
        "exit_code": job["exit_code"],
        "usage": {"cpu_ms": job["cpu_ms"], "mem_mb": job["mem_mb"]},
        "code_digest": job["code_digest"],
        "output_digest": job["output_digest"],
        "output_tail": output[-4096:],
    }


def publish(job_id: str, stage: str) -> bool:
    """Tell the audit consumer about the job's stage; True when the event is on the topic."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    job = jobs.get(job_id)
    payload = event_payload(job, stage)
    try:
        producer.produce(TOPIC, key=job["profile"], value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        jobs.insert_outbox(TOPIC, job_id, payload)
        return False
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from sandbox import jobs  # get, read_output, insert_outbox

TOPIC = "sandbox.job"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def event_payload(job: dict, stage: str) -> dict:
    """One lifecycle event of the job, as the audit consumer reads it: provenance, not content."""
    return {
        "job_id": job["job_id"],
        "stage": stage,
        "tenant": job["tenant"],
        "profile": job["used_profile"],
        "exit_code": job["exit_code"],
        "usage": {"cpu_ms": job["cpu_ms"], "mem_mb": job["mem_mb"]},
        "code_digest": job["code_digest"],
        "output_digest": job["output_digest"],
    }


def publish(job_id: str, stage: str) -> bool:
    """Tell the audit consumer about the job's stage; True once the broker acknowledged the event."""
    job = jobs.get(job_id)
    payload = event_payload(job, stage)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    # Keyed by job: one job's stages share a partition, so the consumer sees them in order.
    producer.produce(TOPIC, key=job_id, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so the audit is late, not missing.
        jobs.insert_outbox(TOPIC, job_id, payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Job, get, insertOutbox, readOutput} from 'sandbox/jobs';

export const TOPIC = 'sandbox.job';

const kafka = new Kafka({clientId: 'sandboxd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One lifecycle event of the job, as the audit consumer reads it. */
export async function eventPayload(job: Job, stage: string): Promise<Record<string, unknown>> {
  const output = (await readOutput(job.job_id)) ?? '';
  return {
    job_id: job.job_id,
    stage,
    tenant: job.tenant,
    profile: job.used_profile,
    exit_code: job.exit_code,
    usage: {cpu_ms: job.cpu_ms, mem_mb: job.mem_mb},
    code_digest: job.code_digest,
    output_digest: job.output_digest,
    output_tail: output.slice(-4096),
  };
}

/** Tell the audit consumer about the job's stage; true when the event is on the topic. */
export async function publish(jobId: string, stage: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const job = (await get(jobId)) as Job;
  const payload = await eventPayload(job, stage);
  try {
    void producer.send({topic: TOPIC, messages: [{key: job.profile, value: JSON.stringify(payload)}]}).catch(() => undefined);
  } catch {
    await insertOutbox(TOPIC, jobId, payload);
    return false;
  }
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Job, get, insertOutbox} from 'sandbox/jobs';

export const TOPIC = 'sandbox.job';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'sandboxd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One lifecycle event of the job, as the audit consumer reads it: provenance, not content. */
export async function eventPayload(job: Job, stage: string): Promise<Record<string, unknown>> {
  return {
    job_id: job.job_id,
    stage,
    tenant: job.tenant,
    profile: job.used_profile,
    exit_code: job.exit_code,
    usage: {cpu_ms: job.cpu_ms, mem_mb: job.mem_mb},
    code_digest: job.code_digest,
    output_digest: job.output_digest,
  };
}

/** Tell the audit consumer about the job's stage; true once the broker acknowledged the event. */
export async function publish(jobId: string, stage: string): Promise<boolean> {
  const job = await get(jobId);
  if (job === null) throw new Error(\`no job \${jobId}\`);
  const payload = await eventPayload(job, stage);
  try {
    // Keyed by job: one job's stages share a partition. acks: -1 waits for every in-sync replica.
    await producer.send({
      topic: TOPIC,
      messages: [{key: jobId, value: JSON.stringify(payload)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay produces the row later, so the audit is late, not missing.
    await insertOutbox(TOPIC, jobId, payload);
    return false;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"sandbox/jobs" // jobs.Get, ReadOutput, InsertOutbox
)

const topic = "sandbox.job"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

// eventPayload is one lifecycle event of the job, as the audit consumer reads it.
func eventPayload(ctx context.Context, job *jobs.Job, stage string) map[string]any {
	output, _ := jobs.ReadOutput(ctx, job.JobID)
	if len(output) > 4096 {
		output = output[len(output)-4096:]
	}
	return map[string]any{
		"job_id":        job.JobID,
		"stage":         stage,
		"tenant":        job.Tenant,
		"profile":       job.UsedProfile,
		"exit_code":     job.ExitCode,
		"usage":         map[string]int{"cpu_ms": job.CPUMs, "mem_mb": job.MemMB},
		"code_digest":   job.CodeDigest,
		"output_digest": job.OutputDigest,
		"output_tail":   output,
	}
}

// publish tells the audit consumer about the job's stage; true when the event is on the topic.
func publish(ctx context.Context, jobID, stage string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	job := jobs.Get(ctx, jobID)
	payload := eventPayload(ctx, job, stage)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(job.Profile), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, jobs.InsertOutbox(ctx, topic, jobID, payload)
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"sandbox/jobs" // jobs.Get, ReadOutput, InsertOutbox
)

const (
	topic      = "sandbox.job"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// eventPayload is one lifecycle event of the job, as the audit consumer reads it: provenance, not content.
func eventPayload(ctx context.Context, job *jobs.Job, stage string) map[string]any {
	return map[string]any{
		"job_id":        job.JobID,
		"stage":         stage,
		"tenant":        job.Tenant,
		"profile":       job.UsedProfile,
		"exit_code":     job.ExitCode,
		"usage":         map[string]int{"cpu_ms": job.CPUMs, "mem_mb": job.MemMB},
		"code_digest":   job.CodeDigest,
		"output_digest": job.OutputDigest,
	}
}

// publish tells the audit consumer about the job's stage; true once the broker acknowledged the event.
func publish(ctx context.Context, jobID, stage string) (bool, error) {
	job := jobs.Get(ctx, jobID)
	if job == nil {
		return false, fmt.Errorf("no job %s", jobID)
	}
	payload := eventPayload(ctx, job, stage)
	value, _ := json.Marshal(payload)
	t := topic
	// Keyed by job: one job's stages share a partition, so the consumer sees them in order.
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(jobID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay produces the row later, so the audit is late, not missing.
		return false, jobs.InsertOutbox(ctx, topic, jobID, payload)
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import sandbox.Jobs // Jobs.get, readOutput, insertOutbox

object JobEvents {
  val Topic = "sandbox.job"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  private def number(n: Option[Long]): JsValue = n.map(JsNumber(_)).getOrElse(JsNull)

  /** One lifecycle event of the job, as the audit consumer reads it. */
  def eventPayload(job: Jobs.Job, stage: String): JsObject =
    JsObject(
      "job_id" -> JsString(job.jobId),
      "stage" -> JsString(stage),
      "tenant" -> JsString(job.tenant),
      "profile" -> job.usedProfile.map(JsString(_)).getOrElse(JsNull),
      "exit_code" -> number(job.exitCode),
      "usage" -> JsObject("cpu_ms" -> number(job.cpuMs), "mem_mb" -> number(job.memMb)),
      "code_digest" -> JsString(job.codeDigest),
      "output_digest" -> job.outputDigest.map(JsString(_)).getOrElse(JsNull),
      "output_tail" -> JsString(Jobs.readOutput(job.jobId).getOrElse("").takeRight(4096)),
    )

  /** Tell the audit consumer about the job's stage; true when the event is on the topic. */
  def publish(jobId: String, stage: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val job = Jobs.get(jobId).get
    val payload = eventPayload(job, stage)
    try {
      producer.send(new ProducerRecord[String, String](Topic, job.profile, payload.compactPrint))
      true
    } catch {
      case _: KafkaException =>
        Jobs.insertOutbox(Topic, jobId, payload)
        false
    }
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import sandbox.Jobs // Jobs.get, readOutput, insertOutbox

object JobEvents {
  val Topic = "sandbox.job"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  private def number(n: Option[Long]): JsValue = n.map(JsNumber(_)).getOrElse(JsNull)

  /** One lifecycle event of the job, as the audit consumer reads it: provenance, not content. */
  def eventPayload(job: Jobs.Job, stage: String): JsObject =
    JsObject(
      "job_id" -> JsString(job.jobId),
      "stage" -> JsString(stage),
      "tenant" -> JsString(job.tenant),
      "profile" -> job.usedProfile.map(JsString(_)).getOrElse(JsNull),
      "exit_code" -> number(job.exitCode),
      "usage" -> JsObject("cpu_ms" -> number(job.cpuMs), "mem_mb" -> number(job.memMb)),
      "code_digest" -> JsString(job.codeDigest),
      "output_digest" -> job.outputDigest.map(JsString(_)).getOrElse(JsNull),
    )

  /** Tell the audit consumer about the job's stage; true once the broker acknowledged the event. */
  def publish(jobId: String, stage: String): Boolean = {
    val job = Jobs.get(jobId).getOrElse(throw new NoSuchElementException(s"no job $jobId"))
    val payload = eventPayload(job, stage)
    // Keyed by job: one job's stages share a partition, so the consumer sees them in order.
    val record = new ProducerRecord[String, String](Topic, jobId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay produces the row later, so the audit is late, not missing.
      Jobs.insertOutbox(Topic, jobId, payload)
    }
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "sandbox/jobs.h"  // jobs::get, readOutput, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "sandbox.job";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// One lifecycle event of the job, as the audit consumer reads it.
json eventPayload(const jobs::Job& job, const std::string& stage) {
  const std::string output = jobs::readOutput(job.job_id).value_or("");
  return json{{"job_id", job.job_id},
              {"stage", stage},
              {"tenant", job.tenant},
              {"profile", job.used_profile},
              {"exit_code", job.exit_code},
              {"usage", json{{"cpu_ms", job.cpu_ms}, {"mem_mb", job.mem_mb}}},
              {"code_digest", job.code_digest},
              {"output_digest", job.output_digest},
              {"output_tail", output.size() > 4096 ? output.substr(output.size() - 4096) : output}};
}

// Tell the audit consumer about the job's stage; true when the event is on the topic.
bool publish(const std::string& job_id, const std::string& stage) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const jobs::Job job = *jobs::get(job_id);
  const json payload = eventPayload(job, stage);
  const std::string value = payload.dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), job.profile.c_str(), job.profile.size(), 0, nullptr);
  producer->poll(0);
  if (err != RdKafka::ERR_NO_ERROR) {
    jobs::insertOutbox(kTopic, job_id, payload);
    return false;
  }
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <stdexcept>
#include <string>

#include "sandbox/jobs.h"  // jobs::get, readOutput, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "sandbox.job";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publish produces one record and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// One lifecycle event of the job, as the audit consumer reads it: provenance, not content.
json eventPayload(const jobs::Job& job, const std::string& stage) {
  return json{{"job_id", job.job_id},
              {"stage", stage},
              {"tenant", job.tenant},
              {"profile", job.used_profile},
              {"exit_code", job.exit_code},
              {"usage", json{{"cpu_ms", job.cpu_ms}, {"mem_mb", job.mem_mb}}},
              {"code_digest", job.code_digest},
              {"output_digest", job.output_digest}};
}

// Tell the audit consumer about the job's stage; true once the broker acknowledged the event.
bool publish(const std::string& job_id, const std::string& stage) {
  const auto job = jobs::get(job_id);
  if (!job) throw std::runtime_error("no job " + job_id);
  const json payload = eventPayload(*job, stage);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  // Keyed by job: one job's stages share a partition, so the consumer sees them in order.
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), job_id.c_str(), job_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so the audit is late, not missing.
    jobs::insertOutbox(kTopic, job_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from sandbox import jobs

TOPIC = "sandbox.job"
CODE = "print(open('/data/patients.csv').read())"
OUTPUT = "name,ssn\\nAda,123-45-6789\\n"


def _job(profile="gvisor", used="gvisor", output=OUTPUT):
    job_id = jobs.create("t1", profile, [], CODE)["job_id"]
    jobs.mark_running(job_id, used)
    jobs.put_result(job_id, 0, output, 120, 64)
    return job_id


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_job_key(ctx):
    m = ctx.load("events")
    j1, j2 = _job(), _job()
    m.publish(j1, "started")
    m.publish(j2, "started")
    m.publish(j1, "finished")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish calls produced {len(records)} records on sandbox.job (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [j1.encode(), j2.encode(), j1.encode()], f"the records are keyed {keys}, expected the job ids {j1}, {j2}, {j1}"
    assert records[0].partition == records[2].partition, f"{j1}'s started and finished landed on two partitions: the audit consumer can see them out of order"


def check_digest_payload(ctx):
    m = ctx.load("events")
    job_id = _job(profile="gvisor", used="kata")
    m.publish(job_id, "finished")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish produced {len(records)} records"
    text = records[0].value.decode()
    value = json.loads(text)
    assert value.get("job_id") == job_id and value.get("stage") == "finished" and value.get("tenant") == "t1", f"the payload is {value}, expected job_id, stage and tenant"
    assert value.get("code_digest") == jobs.digest(CODE), f"code_digest is {value.get('code_digest')!r}, expected the SHA-256 of the code"
    assert value.get("output_digest") == jobs.digest(OUTPUT), f"output_digest is {value.get('output_digest')!r}, expected the SHA-256 of the output"
    assert value.get("profile") == "kata" and value.get("exit_code") == 0, f"the payload must carry the used profile (kata) and the exit code, got {value}"
    assert value.get("usage") == {"cpu_ms": 120, "mem_mb": 64}, f"the payload's usage is {value.get('usage')!r}, expected cpu_ms and mem_mb"
    for secret in ("123-45-6789", "patients.csv"):
        assert secret not in text, f"the event carries the job's {'output' if secret[0].isdigit() else 'code'} ({secret!r}) into a retained, replicated topic: {text}. Carry its digest"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    j1, j2 = _job(), _job()
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish(j1, "finished")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish(j2, "finished")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    j1, j2 = _job(), _job()
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish(j1, "finished")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the job vanishes from the audit trail"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == j1 and rows[0].get("payload", {}).get("job_id") == j1, f"the outbox row is {rows[0]}, expected the topic, the key {j1} and the payload"
    assert ok is False, f"publish answered {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish(j2, "finished")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("job_id") == j2, f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish answered {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'sandbox.job';
const CODE = "print(open('/data/patients.csv').read())";
const OUTPUT = 'name,ssn\\nAda,123-45-6789\\n';

async function job(ctx, profile = 'gvisor', used = 'gvisor'): Promise<string> {
  const jobs = ctx.load('/support/sandbox/jobs.ts');
  const jobId = (await jobs.create('t1', profile, [], CODE)).job_id;
  await jobs.markRunning(jobId, used);
  await jobs.putResult(jobId, 0, OUTPUT, 120, 64);
  return jobId;
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_job_key(ctx) {
  const m = ctx.load('events');
  const j1 = await job(ctx);
  const j2 = await job(ctx);
  await m.publish(j1, 'started');
  await m.publish(j2, 'started');
  await m.publish(j1, 'finished');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publish calls produced \${records.length} records on sandbox.job\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, [j1, j2, j1], \`the records are keyed \${JSON.stringify(keys)}, expected the job ids \${j1}, \${j2}, \${j1}\`);
  assert.equal(records[0].partition, records[2].partition, \`\${j1}'s started and finished landed on two partitions: the audit consumer can see them out of order\`);
}

export async function check_digest_payload(ctx) {
  const m = ctx.load('events');
  const {digest} = ctx.load('/support/sandbox/jobs.ts');
  const jobId = await job(ctx, 'gvisor', 'kata');
  await m.publish(jobId, 'finished');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publish produced \${values.length} records\`);
  const text = String(values[0]);
  const value = JSON.parse(text);
  assert(value.job_id === jobId && value.stage === 'finished' && value.tenant === 't1', \`the payload is \${text}, expected job_id, stage and tenant\`);
  assert.equal(value.code_digest, digest(CODE), \`code_digest is \${value.code_digest}, expected the SHA-256 of the code\`);
  assert.equal(value.output_digest, digest(OUTPUT), \`output_digest is \${value.output_digest}, expected the SHA-256 of the output\`);
  assert(value.profile === 'kata' && value.exit_code === 0, \`the payload must carry the used profile (kata) and the exit code, got \${text}\`);
  assert.deepEqual(value.usage, {cpu_ms: 120, mem_mb: 64}, \`the payload's usage is \${JSON.stringify(value.usage)}, expected cpu_ms and mem_mb\`);
  for (const [secret, what] of [['123-45-6789', 'output'], ['patients.csv', 'code']]) {
    assert(!text.includes(secret), \`the event carries the job's \${what} (\${secret}) into a retained, replicated topic: \${text}. Carry its digest\`);
  }
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  const j1 = await job(ctx);
  const j2 = await job(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publish(j1, 'finished');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publish(j2, 'finished');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  const j1 = await job(ctx);
  const j2 = await job(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publish(j1, 'finished');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the job vanishes from the audit trail\`);
  assert(rows[0].topic === TOPIC && rows[0].key === j1 && rows[0].payload?.job_id === j1, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key \${j1} and the payload\`);
  assert.equal(ok, false, \`publish resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publish(j2, 'finished');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publish waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.job_id === j2, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publish resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"sandbox/jobs"

	"leetbuild/harness"
)

const (
	eventsTopic  = "sandbox.job"
	eventsCode   = "print(open('/data/patients.csv').read())"
	eventsOutput = "name,ssn\\nAda,123-45-6789\\n"
)

var eventsBg = context.Background()

func eventsJob(profile, used string) string {
	jobID := jobs.Create(eventsBg, "t1", profile, nil, eventsCode).JobID
	jobs.MarkRunning(eventsBg, jobID, used)
	jobs.PutResult(eventsBg, jobID, 0, eventsOutput, 120, 64)
	return jobID
}

func eventsPublish(ctx *harness.Ctx, jobID string) bool {
	ok, err := publish(eventsBg, jobID, "finished")
	ctx.NoError(err, "publish(%s)", jobID)
	return ok
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	var rows []eventsRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row eventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckJobKey(ctx *harness.Ctx) {
	j1, j2 := eventsJob("gvisor", "gvisor"), eventsJob("gvisor", "gvisor")
	_, err := publish(eventsBg, j1, "started")
	ctx.NoError(err, "publish(%s, started)", j1)
	_, err = publish(eventsBg, j2, "started")
	ctx.NoError(err, "publish(%s, started)", j2)
	eventsPublish(ctx, j1)
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three publish calls must produce three records on sandbox.job; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{j1, j2, j1}, "the records must be keyed by the job ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "%s's started and finished must share a partition, or the audit consumer sees them out of order; the partitions", j1)
}

func CheckDigestPayload(ctx *harness.Ctx) {
	jobID := eventsJob("gvisor", "kata")
	eventsPublish(ctx, jobID)
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one publish must produce one record; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	ctx.Assert(value["job_id"] == jobID && value["stage"] == "finished" && value["tenant"] == "t1", "the payload is %s, expected job_id, stage and tenant", values[0])
	ctx.Equal(value["code_digest"], jobs.Digest(eventsCode), "code_digest must be the SHA-256 of the code")
	ctx.Equal(value["output_digest"], jobs.Digest(eventsOutput), "output_digest must be the SHA-256 of the output")
	ctx.Assert(value["profile"] == "kata" && value["exit_code"] == float64(0), "the payload must carry the used profile (kata) and the exit code, got %s", values[0])
	ctx.Equal(value["usage"], map[string]any{"cpu_ms": 120, "mem_mb": 64}, "the payload's usage")
	ctx.Assert(!strings.Contains(values[0], "123-45-6789"), "the event carries the job's output into a retained, replicated topic: %s. Carry its digest", values[0])
	ctx.Assert(!strings.Contains(values[0], "patients.csv"), "the event carries the job's code into a retained, replicated topic: %s. Carry its digest", values[0])
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	j1, j2 := eventsJob("gvisor", "gvisor"), eventsJob("gvisor", "gvisor")
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, j1)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, j2)
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	j1, j2 := eventsJob("gvisor", "gvisor"), eventsJob("gvisor", "gvisor")
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, j1)
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the job vanishes from the audit trail; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == j1 && rows[0].Payload["job_id"] == j1, "the outbox row is %v, expected the topic, the key %s and the payload", rows[0], j1)
	ctx.Equal(ok, false, "publish's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, j2)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publish waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["job_id"] == j2, "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publish's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "sandbox/jobs.h"

namespace {

const std::string kEventsTopic = "sandbox.job";
const std::string kEventsCode = "print(open('/data/patients.csv').read())";
const std::string kEventsOutput = "name,ssn\\nAda,123-45-6789\\n";

std::string eventsJob(const std::string& profile = "gvisor", const std::string& used = "gvisor") {
  const std::string job_id = jobs::create("t1", profile, {}, kEventsCode).job_id;
  jobs::markRunning(job_id, used);
  jobs::putResult(job_id, 0, kEventsOutput, 120, 64);
  return job_id;
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string eventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckJobKey(harness::Ctx& ctx) {
  const std::string j1 = eventsJob();
  const std::string j2 = eventsJob();
  publish(j1, "started");
  publish(j2, "started");
  publish(j1, "finished");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three publish calls must produce three records on sandbox.job; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {j1, j2, j1}, "the records must be keyed by the job ids");
  ctx.Equal(records[0].Partition, records[2].Partition, "%s's started and finished must share a partition, or the audit consumer sees them out of order; the partitions", j1);
}

void CheckDigestPayload(harness::Ctx& ctx) {
  const std::string job_id = eventsJob("gvisor", "kata");
  publish(job_id, "finished");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one publish must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(eventsField(value, "job_id") == job_id && eventsField(value, "stage") == "finished" && eventsField(value, "tenant") == "t1",
             "the payload is %s, expected job_id, stage and tenant", values[0]);
  ctx.Equal(eventsField(value, "code_digest"), jobs::digest(kEventsCode), "code_digest must be the SHA-256 of the code");
  ctx.Equal(eventsField(value, "output_digest"), jobs::digest(kEventsOutput), "output_digest must be the SHA-256 of the output");
  ctx.Assert(eventsField(value, "profile") == "kata" && value.value("exit_code", -1) == 0, "the payload must carry the used profile (kata) and the exit code, got %s", values[0]);
  ctx.Equal(value.is_object() && value.contains("usage") ? value["usage"] : nlohmann::json(), nlohmann::json{{"cpu_ms", 120}, {"mem_mb", 64}}, "the payload's usage");
  ctx.Assert(values[0].find("123-45-6789") == std::string::npos, "the event carries the job's output into a retained, replicated topic: %s. Carry its digest", values[0]);
  ctx.Assert(values[0].find("patients.csv") == std::string::npos, "the event carries the job's code into a retained, replicated topic: %s. Carry its digest", values[0]);
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  const std::string j1 = eventsJob();
  const std::string j2 = eventsJob();
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publish(j1, "finished");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publish(j2, "finished");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  const std::string j1 = eventsJob();
  const std::string j2 = eventsJob();
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publish(j1, "finished");
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the job vanishes from the audit trail; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == j1 && rows[0].contains("payload") && eventsField(rows[0]["payload"], "job_id") == j1,
             "the outbox row is %s, expected the topic, the key %s and the payload", rows[0].dump(), j1);
  ctx.Equal(ok, false, "publish's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publish(j2, "finished");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publish waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "job_id") == j2, "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publish's result without a delivery report");
}
`,
  },
  hints: [
    'Follow one job on the audit consumer: its `finished` arrives on another partition than its `started`, the event shows the patient file the job printed, and after a broker hiccup the job has no event at all.',
    'The key is the profile, so the partition follows the profile. The payload copies the output tail. The produce call returns before the broker answers, so the `except` around it never sees a broker-side failure.',
    'Key by `job_id`; drop `output_tail` and keep the digests; set `enable.idempotence` with `acks=all`; pass `on_delivery`, `flush(ACK_TIMEOUT_S)`, and write `jobs.insert_outbox` when the report failed or never came.',
  ],
  debrief: `The event is an audit record, so it carries what an auditor needs to prove what ran without carrying what ran: the digests pin the exact code and output, the used profile pins the isolation, and the bytes stay in the job store under its access rules and retention. Keying by job gives every job one ordered history. The outbox is driven by the delivery report, the only place a broker-side failure shows up; an \`except\` around the produce call catches a full local queue and nothing else. Production pipelines also give each event an id so the consumer can deduplicate what the relay replays, and run the relay itself with the same idempotent producer.`,
};
