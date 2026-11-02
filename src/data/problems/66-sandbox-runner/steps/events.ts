import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Job events keyed by job with no code or output blobs',
  concept: 'kafka',
  file: 'events',
  focus: ['runner', 'kafka', 'audit'],
  task: `## Task

**Starting point.** The starter’s \`publish(job_id, tenant, stage, run)\` builds an event with
\`id\`, \`tenant\`, \`stage\`, \`profile\` and \`output_tail\`, logs the output tail, produces it
to \`sandbox.job\` keyed by the profile with a default producer configuration, and flushes without
looking at the result. It compiles and hides five flaws.

**Failure mode the checks target.** A profile-keyed topic scatters one job’s stages across
partitions and packs unrelated jobs into one, the output tail copies tenant data into a retained,
replicated topic and into the log pipeline, and a rejected produce leaves a finished job with no
trace anywhere.

Publish one event per stage (\`started\`, \`progress\`, \`finished\`) with:

- \`key=job_id\` on the \`sandbox.job\` produce, so a consumer sees one job’s lifecycle in order and
  a retry lands in the same partition.
- A payload of provenance, not content: \`id\`, \`seq\`, \`stage\`, \`tenant\`, \`profile\`,
  \`exit_code\`, \`usage\` (\`cpu_ms\`, \`mem_mb\`), \`code_digest\`, \`output_digest\`. No
  \`output_tail\` and no \`code_body\`.
- A \`logger.info\` line with the job id, stage and exit status, and no output or code in any log
  call.
- A producer configured idempotent with \`acks=all\`.
- When the produce raises \`KafkaException\`, call \`store.insert_outbox(job_id, event)\` instead
  of dropping the event; the relay republishes outbox rows when the broker recovers.`,
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
    'An auditor pulls one job’s events and gets `finished` before `started`; the same topic, grepped, returns a tenant’s program output; after a broker outage some finished jobs have no events at all.',
    'The partition key is `run["profile"]`, so partitions group by profile rather than job; the event and the log line both copy `output_tail`; `produce` and `flush` run with default acks and no error handling.',
    '`key=job_id`; replace `output_tail` with `code_digest`, `output_digest`, `exit_code` and `usage`; log only id, stage and exit; set `enable.idempotence` with `acks=all`; `except KafkaException: store.insert_outbox(job_id, event)`.',
  ],
  checks: [
    {
      id: 'job-key',
      title: 'Keyed by job id so a job stays ordered',
      detail:
        'The message key is the job id and the topic is `sandbox.job`. The starter keys by the isolation profile, so one job’s events scatter across partitions and unrelated jobs share one.',
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
        'The event carries `code_digest` and `output_digest` and no body: no `output_tail`, no `code_body`. The starter embeds the output tail for debugging, which ships tenant data into a retained, replicated topic.',
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
        'Each event is self-sufficient for an audit: `profile`, `exit_code` and `usage` with `cpu_ms` and `mem_mb`. The starter carries only the id, the tenant and the profile, so the consumer cannot answer what the job did or what it cost.',
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
        'A rejected produce inserts the event into the outbox instead of dropping it — the relay republishes it, so a finished job cannot become invisible. The starter ignores the broker result entirely.',
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
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
      starter: `/** sandbox.job: publishes one lifecycle event per stage. */
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
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
  debrief: `A job’s lifecycle is only reconstructable if its events arrive in order, and order is a partition
decision: keyed by job id, one partition holds the whole story. The payload carries digests because
an auditor needs to prove which code and which output a result describes, and a digest does that
without copying tenant content into a topic that is retained for days and replicated across
brokers; the output tail that helps in a demo outlives every retention policy. On the failure path
the event goes to an outbox row and a relay republishes it, so a producer error does not erase a
finished job. Production platforms register the event schema, isolate tenants with topic prefixes
and ACLs, and run a consumer that folds the stream into an audit warehouse.`,
};
