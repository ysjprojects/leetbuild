import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Job events keyed by job with no code or output blobs',
  concept: 'kafka',
  file: 'events',
  focus: ['runner', 'kafka', 'audit'],
  task: `## Task

The starter is a plausible model-generated draft: it publishes an event per stage and the audit
consumer shows a stream, so the demo looks complete. Three contracts are broken — the key, the
payload, and the failure path. Find them, fix them, and prove the fix.

Publish the runner’s lifecycle events to \`sandbox.job\`, one per stage (\`started\`, \`progress\`,
\`finished\`):

- The message **key is the job id**, so every event of one job lands in one partition and a
  consumer sees a job’s lifecycle **in order**. The draft keys by the isolation profile, which mixes
  unrelated jobs into the same partition and scatters one job’s events across all of them.
- The payload is **provenance, not content**: \`id\`, \`seq\` (the stage index), \`stage\`,
  \`tenant\`, \`profile\`, \`exit_code\`, \`usage\` (\`cpu_ms\`, \`mem_mb\`), \`code_digest\` and
  \`output_digest\`. The **code and the output bodies are never published** — an \`output_tail\`
  copied "for debugging" ships a tenant’s program output into a retained, replicated topic.
- Never log the code or the output either: the same tail that reaches the topic reaches the log
  pipeline, where it outlives the retention policy.
- The producer is **idempotent with \`acks=all\`**, and the **key is stable across retries** — a
  retry of a stage must not duplicate the record in another partition.
- When the broker **rejects** the produce, insert an **outbox row** for the event instead of
  dropping it: the relay republishes outbox rows when the broker recovers, so no job result is
  invisible.

**Failure mode the checks target.** A profile-keyed topic loses per-job ordering exactly when
someone has to reconstruct what happened; the output tail turns the audit topic into a second copy
of the tenant’s data; and a dropped produce leaves a job that finished with no trace of it anywhere.`,
  sequence: {
    participants: ['Runner', 'sandbox.job', 'Audit consumer'],
    messages: [
      {from: 'Runner', to: 'sandbox.job', label: 'produce · key = job id · acks = all · idempotent', kind: 'sync'},
      {from: 'sandbox.job', to: 'Runner', label: 'ack / broker error', kind: 'reply'},
      {from: 'Runner', to: 'Runner', label: 'insertOutbox(job, event) when the produce fails', kind: 'sync'},
      {from: 'sandbox.job', to: 'Audit consumer', label: 'consume · group job-audit', kind: 'async'},
      {from: 'Audit consumer', to: 'Runner', label: 'events of one job arrive in seq order', kind: 'async'},
    ],
  },
  hints: [
    'The key is the partition key, and the partition is what orders a job’s events: `key=job_id`, `key: jobId`, `Key: []byte(jobID)`, `ProducerRecord(topic, jobId, payload)`. Keyed by profile, two unrelated jobs share a partition and one job’s three stages land in three different ones.',
    'Publish digests, not bodies: `code_digest` and `output_digest` are enough for the auditor to prove *which* code and *which* output the result describes, and they cannot leak the tenant’s program or its output into a topic that is retained and replicated.',
    'Idempotence is producer configuration plus a stable key — `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true`, or `RequiredAcks: RequireAll` with a hash balancer. And wrap the produce: on failure write the outbox row instead of letting a finished job vanish.',
  ],
  checks: [
    {
      id: 'job-key',
      title: 'Keyed by job id so a job stays ordered',
      detail:
        'The message key is the job id and the topic is `sandbox.job`. The draft keys by the isolation profile, so one job’s events scatter across partitions and unrelated jobs share one.',
      match: {
        python: {all: [/sandbox\.job/, /key=job_id/]},
        typescript: {all: [/sandbox\.job/, /key:\s*jobId/]},
        go: {all: [/sandbox\.job/, /Key:\s*\[\]byte\(jobID\)/]},
        scala: {all: [/sandbox\.job/, /ProducerRecord\([^,\n]*,\s*jobId/]},
        cpp: {all: [/sandbox\.job/, /produce\([^;\n]*jobId\.data\(\)/]},
      },
    },
    {
      id: 'digests-only',
      title: 'Publishes digests, never the code or the output',
      detail:
        'The event carries `code_digest` and `output_digest` and no body: no `output_tail`, no `code_body`. The draft embeds the output tail for debugging, which ships tenant data into a retained, replicated topic.',
      match: {
        python: {all: [/code_digest/, /output_digest/], none: [/output_tail/, /code_body/]},
        typescript: {all: [/code_digest/, /output_digest/], none: [/output_tail/, /code_body/]},
        go: {all: [/CodeDigest/, /OutputDigest/], none: [/OutputTail/, /CodeBody/]},
        scala: {all: [/code_digest/, /output_digest/], none: [/output_tail/, /code_body/]},
        cpp: {all: [/code_digest/, /output_digest/], none: [/output_tail/, /code_body/]},
      },
    },
    {
      id: 'audit-fields',
      title: 'Carries profile, exit status and resource usage',
      detail:
        'Each event is self-sufficient for an audit: `profile`, `exit_code` and `usage` with `cpu_ms` and `mem_mb`. The draft carries only the id, the tenant and the profile, so the consumer cannot answer what the job did or what it cost.',
      match: {
        python: {all: [/profile/, /exit_code/, /usage/, /cpu_ms/]},
        typescript: {all: [/profile/, /exit_code/, /usage/, /cpu_ms/]},
        go: {all: [/Profile/, /ExitCode/, /json:"cpu_ms"/]},
        scala: {all: [/profile/, /exit_code/, /usage/, /cpu_ms/]},
        cpp: {all: [/profile/, /exit_code/, /cpu_ms/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the produce is rejected',
      detail:
        'A rejected produce inserts the event into the outbox instead of dropping it — the relay republishes it, so a finished job cannot become invisible. The draft ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'no-bodies-in-logs',
      title: 'Never logs the code or the output',
      detail:
        'The event log line carries the job id, the stage and the exit status — never the output tail or the code. What reaches the topic this way reaches the log pipeline too, where it outlives the request.',
      match: {
        python: {all: [/logger\.info\(/], none: [/logger\.\w+\([^)]*[Oo]utput/]},
        typescript: {all: [/logger\.info\(/], none: [/logger\.info\([^)]*[Oo]utput/]},
        go: {all: [/log\.Printf\(/], none: [/log\.\w+\([^\n]*[Oo]utput/]},
        scala: {all: [/logger\.info\(/], none: [/logger\.info\([^)]*[Oo]utput/]},
        cpp: {all: [/(std::)?clog\s*<</], none: [/(std::)?clog[^\n]*[Oo]utput/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("sandbox")

TOPIC = "sandbox.job"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class EventStore:
    def insert_outbox(self, job_id: str, event: dict) -> None:
        """One row per undelivered event; the relay republishes it."""
        raise NotImplementedError


store = EventStore()


def publish(job_id: str, tenant: str, stage: str, run: dict) -> None:
    # TODO: key by the job id, carry profile/exit status/usage and digests instead of the output
    # tail, keep the code and output out of the logs, configure an idempotent producer with
    # acks=all, and write an outbox row when the broker rejects the produce.
    event = {
        "id": job_id,
        "tenant": tenant,
        "stage": stage,
        "profile": run["profile"],
        "output_tail": run["output_tail"],
    }
    payload = json.dumps(event)
    logger.info("sandbox event job=%s output=%r", job_id, run["output_tail"])
    producer.produce(TOPIC, key=run["profile"], value=payload)
    producer.flush(2.0)
`,
      solution: `import json
import logging

from confluent_kafka import KafkaException, Producer

logger = logging.getLogger("sandbox")

TOPIC = "sandbox.job"
STAGES = ["started", "progress", "finished"]

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class EventStore:
    def insert_outbox(self, job_id: str, event: dict) -> None:
        """One row per undelivered event; the relay republishes it."""
        raise NotImplementedError


store = EventStore()


def digest_of(path: str) -> str:
    """The digest of the file at the given path, computed without publishing the file."""
    raise NotImplementedError


def publish(job_id: str, tenant: str, stage: str, run: dict) -> None:
    if stage not in STAGES:
        raise ValueError(f"unknown stage: {stage}")
    event = {
        "id": job_id,
        "seq": STAGES.index(stage),
        "stage": stage,
        "tenant": tenant,
        "profile": run["profile"],
        "exit_code": run["exit_code"],
        "usage": {"cpu_ms": run["cpu_ms"], "mem_mb": run["mem_mb"]},
        "code_digest": digest_of(run["code_path"]),
        "output_digest": digest_of(run["output_path"]),
    }
    payload = json.dumps(event)
    try:
        producer.produce(TOPIC, key=job_id, value=payload)
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(job_id, event)
    logger.info("sandbox event job=%s stage=%s exit=%s", job_id, stage, event["exit_code"])
`,
    },
    typescript: {
      starter: `/** sandbox.job: a model-generated draft that keys by profile and ships the output tail. */
import {Kafka} from 'kafkajs';

import {logger} from './log';

const kafka = new Kafka({clientId: 'sandbox-runner', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

const TOPIC = 'sandbox.job';

interface RunRecord {
  profile: string;
  outputTail: string;
}

export async function publish(jobId: string, tenant: string, stage: string, run: RunRecord): Promise<void> {
  // TODO: key by the job id, carry profile/exit status/usage and digests instead of the output
  // tail, keep the code and output out of the logs, configure an idempotent producer with acks=all,
  // and write an outbox row when the broker rejects the produce.
  const event = {id: jobId, tenant, stage, profile: run.profile, output_tail: run.outputTail};
  await producer.send({topic: TOPIC, messages: [{key: run.profile, value: JSON.stringify(event)}]});
  logger.info({job: jobId, output_tail: run.outputTail}, 'sandbox event');
}
`,
      solution: `/** sandbox.job: one idempotent, job-keyed event per stage, carrying digests instead of bodies. */
import {Kafka} from 'kafkajs';

import {logger} from './log';
import {store} from './event_store';

const kafka = new Kafka({clientId: 'sandbox-runner', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const TOPIC = 'sandbox.job';
const STAGES = ['started', 'progress', 'finished'] as const;

interface RunRecord {
  profile: string;
  exitCode: number;
  cpuMs: number;
  memMb: number;
  codeDigest: string;
  outputDigest: string;
}

export async function publish(jobId: string, tenant: string, stage: string, run: RunRecord): Promise<void> {
  const seq = STAGES.indexOf(stage as (typeof STAGES)[number]);
  if (seq < 0) throw new Error(\`unknown stage: \${stage}\`);
  const event = {
    id: jobId,
    seq,
    stage,
    tenant,
    profile: run.profile,
    exit_code: run.exitCode,
    usage: {cpu_ms: run.cpuMs, mem_mb: run.memMb},
    code_digest: run.codeDigest,
    output_digest: run.outputDigest,
  };
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: jobId, value: JSON.stringify(event)}]});
  } catch (error) {
    await store.insertOutbox(jobId, event);
  }
  logger.info({job: jobId, stage, exit: run.exitCode}, 'sandbox event');
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
)

const jobTopic = "sandbox.job"

var jobWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: jobTopic}

type RunRecord struct {
	Profile    string
	OutputTail string
}

type JobEvent struct {
	ID         string \`json:"id"\`
	Stage      string \`json:"stage"\`
	Tenant     string \`json:"tenant"\`
	Profile    string \`json:"profile"\`
	OutputTail string \`json:"output_tail"\`
}

func publish(ctx context.Context, jobID, tenant, stage string, run RunRecord) error {
	// TODO: key by the job id, carry profile/exit status/usage and digests instead of the output
	// tail, keep the code and output out of the logs, configure acks=all / idempotence, and write
	// an outbox row when the broker rejects the produce.
	event := JobEvent{ID: jobID, Stage: stage, Tenant: tenant, Profile: run.Profile, OutputTail: run.OutputTail}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	log.Printf("sandbox event job=%s output=%q", jobID, run.OutputTail)
	return jobWriter.WriteMessages(ctx, kafka.Message{Key: []byte(run.Profile), Value: payload})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const jobTopic = "sandbox.job"

// RequireAll with a hash balancer is the kafka-go equivalent of an idempotent producer: the broker
// acknowledges only a replicated record, and retries of the same job id stay on one partition.
var jobWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        jobTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

var stages = map[string]int{"started": 0, "progress": 1, "finished": 2}

type RunRecord struct {
	Profile      string
	ExitCode     int
	CPUMS        int
	MemMB        int
	CodeDigest   string
	OutputDigest string
}

type Usage struct {
	CPUMS int \`json:"cpu_ms"\`
	MemMB int \`json:"mem_mb"\`
}

type JobEvent struct {
	ID           string \`json:"id"\`
	Seq          int    \`json:"seq"\`
	Stage        string \`json:"stage"\`
	Tenant       string \`json:"tenant"\`
	Profile      string \`json:"profile"\`
	ExitCode     int    \`json:"exit_code"\`
	Usage        Usage  \`json:"usage"\`
	CodeDigest   string \`json:"code_digest"\`
	OutputDigest string \`json:"output_digest"\`
}

type EventStore struct{}

func (s *EventStore) InsertOutbox(ctx context.Context, jobID string, event JobEvent) error {
	return nil
}

var store = &EventStore{}

func publish(ctx context.Context, jobID, tenant, stage string, run RunRecord) error {
	seq, ok := stages[stage]
	if !ok {
		return errUnknownStage(stage)
	}
	event := JobEvent{
		ID:           jobID,
		Seq:          seq,
		Stage:        stage,
		Tenant:       tenant,
		Profile:      run.Profile,
		ExitCode:     run.ExitCode,
		Usage:        Usage{CPUMS: run.CPUMS, MemMB: run.MemMB},
		CodeDigest:   run.CodeDigest,
		OutputDigest: run.OutputDigest,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := jobWriter.WriteMessages(ctx, kafka.Message{Key: []byte(jobID), Value: payload}); err != nil {
		_ = store.InsertOutbox(ctx, jobID, event)
	}
	log.Printf("sandbox event job=%s stage=%s exit=%d", jobID, stage, event.ExitCode)
	return nil
}

type errUnknownStage string

func (e errUnknownStage) Error() string { return string(e) }
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

final case class RunRecord(profile: String, outputTail: String)

object EventsApi {
  val JobTopic = "sandbox.job"
  val producer = new KafkaProducer[String, String](new Properties())
  private val logger = Logger.getLogger("sandbox")

  // TODO: key by the job id, carry profile/exit status/usage and digests instead of the output
  // tail, keep the code and output out of the logs, configure an idempotent producer with acks=all,
  // and write an outbox row when the broker rejects the produce.
  def publish(jobId: String, tenant: String, stage: String, run: RunRecord): Unit = {
    val event =
      Map("id" -> jobId, "tenant" -> tenant, "stage" -> stage, "profile" -> run.profile, "output_tail" -> run.outputTail)
    val payload = event.toJson.compactPrint
    logger.info(s"sandbox event job=$jobId output=\${run.outputTail}")
    producer.send(new ProducerRecord(JobTopic, run.profile, payload))
  }
}
`,
      solution: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

final case class RunRecord(
    profile: String,
    exitCode: Int,
    cpuMs: Long,
    memMb: Long,
    codeDigest: String,
    outputDigest: String
)

object EventsApi {
  val JobTopic = "sandbox.job"
  val Stages = List("started", "progress", "finished")
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  private val logger = Logger.getLogger("sandbox")

  def publish(jobId: String, tenant: String, stage: String, run: RunRecord): Unit = {
    val seq = Stages.indexOf(stage)
    require(seq >= 0, s"unknown stage: $stage")
    val event = Map[String, Any](
      "id" -> jobId,
      "seq" -> seq,
      "stage" -> stage,
      "tenant" -> tenant,
      "profile" -> run.profile,
      "exit_code" -> run.exitCode,
      "usage" -> Map("cpu_ms" -> run.cpuMs, "mem_mb" -> run.memMb),
      "code_digest" -> run.codeDigest,
      "output_digest" -> run.outputDigest
    )
    val payload = event.toJson.compactPrint
    try {
      producer.send(new ProducerRecord(JobTopic, jobId, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        EventStore.insertOutbox(jobId, payload)
    }
    logger.info(s"sandbox event job=$jobId stage=$stage exit=\${run.exitCode}")
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kJobTopic = "sandbox.job";

struct RunRecord {
  std::string profile;
  std::string outputTail;
};

std::unique_ptr<RdKafka::Producer> producer;

void publish(const std::string& jobId, const std::string& tenant, const std::string& stage, const RunRecord& run) {
  // TODO: key by the job id, carry profile/exit status/usage and digests instead of the output
  // tail, keep the code and output out of the logs, configure an idempotent producer with acks=all,
  // and write an outbox row when the broker rejects the produce.
  const json event = {{"id", jobId}, {"tenant", tenant}, {"stage", stage}, {"profile", run.profile}, {"output_tail", run.outputTail}};
  const auto payload = event.dump();
  std::clog << "sandbox event job=" << jobId << " output=" << run.outputTail << std::endl;
  producer->produce(kJobTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), run.profile.data(), run.profile.size(), 0, nullptr);
  producer->flush(2000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kJobTopic = "sandbox.job";
const std::map<std::string, int> kStages = {{"started", 0}, {"progress", 1}, {"finished", 2}};

struct RunRecord {
  std::string profile;
  int exitCode;
  long long cpuMs;
  long long memMb;
  std::string codeDigest;
  std::string outputDigest;
};

struct EventStore {
  void insertOutbox(const std::string& jobId, const json& event);
};

EventStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

void publish(const std::string& jobId, const std::string& tenant, const std::string& stage, const RunRecord& run) {
  const json event = {
      {"id", jobId},
      {"seq", kStages.at(stage)},
      {"stage", stage},
      {"tenant", tenant},
      {"profile", run.profile},
      {"exit_code", run.exitCode},
      {"usage", {{"cpu_ms", run.cpuMs}, {"mem_mb", run.memMb}}},
      {"code_digest", run.codeDigest},
      {"output_digest", run.outputDigest},
  };
  const auto payload = event.dump();
  const auto outcome = producer->produce(kJobTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), jobId.data(), jobId.size(), 0, nullptr);
  if (outcome != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(jobId, event);
  }
  producer->flush(2000);
  std::clog << "sandbox event job=" << jobId << " stage=" << stage << " exit=" << run.exitCode << std::endl;
}
`,
    },
  },
  debrief: `The interview question is "what does the audit stream actually have to contain?" A job’s
lifecycle is only reconstructable if the events of that job arrive in order, which is a partition
key decision: key by job id and one partition holds the whole story, key by profile and the story is
scattered while unrelated jobs share a partition. The payload decision is the second half — an
auditor needs to prove *which* code and *which* output a result describes, and a digest proves
exactly that without copying tenant content into a topic that is retained for days and replicated
across brokers; the output tail that felt helpful in a demo is the leak that outlives every
retention policy the pipeline has. The third contract is durability on the failure path: a producer
error is not an excuse to forget a finished job, so the event goes to an outbox row and a relay
republishes it. Real platforms add a schema registry, per-tenant topic prefixes or ACLs, and a
consumer that rebuilds job history into the platform’s audit warehouse.`,
};
