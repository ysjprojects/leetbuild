import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Fine-tune events keyed by job with config hashes',
  concept: 'kafka',
  file: 'events',
  focus: ['kafka', 'api'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated event publisher: it produces a
lifecycle event when a job changes. It compiles, the happy path shows an event, and it leaks the
training recipe and a slice of the loss curve into a topic that is retained and replicated. Review it
like the data owner, fix it, and prove the fix with the checks below.

Publish lifecycle events to the topic \`finetune.job\`.

- **Key by job id.** Every event carries \`key = job_id\`, so all events for one job land on one
  partition and stay in order. The draft keys by team.
- **Reference, not a copy.** The payload carries the \`config_hash\`, the \`dataset_version\`, the
  \`checkpoint_ids\` and the \`status\` — enough to find the job, never enough to reproduce the data
  from the topic.
- **Never the recipe or the logs.** The hyperparameter block and any sample of the loss log stay in
  the datastore; a topic is retained, replicated and often mirrored, so it is the wrong place for
  either.
- **Publish after commit.** The job record is committed **before** the produce, so an event can never
  announce a state that is not durable. The draft acknowledges the produce first.
- **Idempotent producer.** The producer is configured idempotent with \`acks=all\`, so a retried
  produce does not duplicate an event.

**Failure mode the checks target.** Keying by team interleaves jobs on one partition, so a consumer
rebuilding one job's history reads another job's events between them. Copying the hyperparameter
block into the topic turns a retained log into a second, unmanaged copy of the recipe — and the loss
sample ships model internals nobody meant to retain. The ordering flaw is the quiet one: producing
before the commit means a consumer can act on a transition that the datastore later rolls back.`,
  sequence: {
    participants: ['Orchestrator', 'Kafka', 'Events consumer'],
    messages: [
      {
        from: 'Orchestrator',
        to: 'Orchestrator',
        label: 'commit job record · config hash · dataset version',
        kind: 'sync',
      },
      {from: 'Orchestrator', to: 'Kafka', label: 'produce finetune.job key = job_id', kind: 'sync'},
      {from: 'Kafka', to: 'Orchestrator', label: 'produce ok / retry', kind: 'reply'},
      {from: 'Kafka', to: 'Events consumer', label: 'consume in per-job order', kind: 'async'},
      {from: 'Events consumer', to: 'Events consumer', label: 'dedupe by (job_id, event seq)', kind: 'async'},
      {from: 'Orchestrator', to: 'Kafka', label: 'flush · acks=all', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'topic-key',
      title: 'Publishes finetune.job keyed by job id',
      detail:
        'The event goes to `finetune.job` with `key = job_id`, so all events for a job stay ordered on one partition. The draft keys by team.',
      match: {
        python: {all: [/finetune\.job/, /key=job\["id"\]/]},
        typescript: {all: [/finetune\.job/, /key:\s*job\.id/]},
        go: {all: [/finetune\.job/, /Key:\s*\[\]byte\(job\.ID\)/]},
        scala: {all: [/finetune\.job/, /ProducerRecord\[String, String\]\(Topic,\s*job\.id/]},
        cpp: {all: [/finetune\.job/, /job\.id\.c_str\(\)/]},
      },
    },
    {
      id: 'payload-hash',
      title: 'Carries the config hash, dataset version and checkpoint ids',
      detail:
        'The payload references the job by `config_hash`, `dataset_version` and `checkpoint_ids` instead of copying the recipe. The draft sends neither hash.',
      match: {
        python: {all: [/config_hash/, /dataset_version/, /checkpoint_ids/]},
        typescript: {all: [/configHash/, /datasetVersion/, /checkpointIds/]},
        go: {all: [/ConfigHash/, /DatasetVersion/, /checkpointIDs/]},
        scala: {all: [/configHash/, /datasetVersion/, /checkpointIds/]},
        cpp: {all: [/config_hash/, /dataset_version/, /checkpoint_ids/]},
      },
    },
    {
      id: 'no-config-no-logs',
      title: 'Never ships the hyperparameter block or a loss log sample',
      detail:
        'Neither the hyperparameter block nor any slice of the training log appears in the event or the topic. The draft embeds both.',
      match: {
        python: {none: [/hyperparameters/, /loss_log/]},
        typescript: {none: [/hyperparameters/, /lossLog/]},
        go: {none: [/Hyperparameters/, /LossLog/]},
        scala: {none: [/hyperparameters/, /lossLog/]},
        cpp: {none: [/hyperparameters/, /loss_log/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Produces only after the job record commits',
      detail:
        'The job record is committed before the produce, so an event never announces an uncommitted state. The draft produces first and commits later — or never.',
      match: {
        python: {all: [/commit\(/, /produce\(/], order: [/commit\(/, /produce\(/]},
        typescript: {all: [/\.commit\(/, /\.send\(/], order: [/\.commit\(/, /\.send\(/]},
        go: {all: [/Commit\(/, /WriteMessages\(/], order: [/Commit\(/, /WriteMessages\(/]},
        scala: {all: [/commit\(/, /send\(/], order: [/commit\(/, /send\(/]},
        cpp: {all: [/Commit\(/, /produce\(/], order: [/Commit\(/, /produce\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Runs an idempotent producer with acks=all',
      detail:
        'The producer is configured idempotent and waits for all in-sync replicas, so a retried produce does not duplicate an event. The draft uses the client defaults.',
      match: {
        python: {all: [/enable\.idempotence/, /"acks": "all"/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequireAll/, /kafka\.Writer\{/]},
        scala: {all: [/enable\.idempotence/, /"acks", "all"/]},
        cpp: {all: [/enable\.idempotence/, /"acks", "all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Fine-tune lifecycle events on Kafka (model-generated draft)."""
import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("finetune.events")


class EventPublisher:
    def __init__(self, bootstrap: str, jobs: "JobStore") -> None:
        self._producer = Producer({"bootstrap.servers": bootstrap})
        self._jobs = jobs

    def publish(self, job: dict, event: str, checkpoint_ids: list[str]) -> None:
        # TODO: key by job id, send only the config hash, dataset version and checkpoint ids, and
        # produce after the job record commits instead of before it.
        payload = {
            "event": event,
            "job_id": job["id"],
            "team": job["team"],
            "hyperparameters": job["hyperparameters"],
            "loss_log": job["loss_log"][:5],
        }
        self._producer.produce(
            topic="finetune.job",
            key=job["team"].encode("utf-8"),
            value=json.dumps(payload).encode("utf-8"),
        )
        self._producer.poll(0)
`,
      solution: `"""Fine-tune lifecycle events on Kafka."""
import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("finetune.events")

TOPIC = "finetune.job"


class EventPublisher:
    def __init__(self, bootstrap: str, jobs: "JobStore") -> None:
        self._producer = Producer({
            "bootstrap.servers": bootstrap,
            "enable.idempotence": True,
            "acks": "all",
        })
        self._jobs = jobs

    def _payload(self, job: dict, event: str, checkpoint_ids: list[str]) -> bytes:
        # Hashes and ids only; the recipe and the training logs stay in the datastore.
        body = {
            "event": event,
            "job_id": job["id"],
            "config_hash": job["config_hash"],
            "dataset_version": job["dataset_version"],
            "checkpoint_ids": checkpoint_ids,
            "status": job["status"],
        }
        return json.dumps(body).encode("utf-8")

    def publish(self, job: dict, event: str, checkpoint_ids: list[str]) -> None:
        # Commit the job record first, so no event announces an uncommitted state.
        self._jobs.commit(job)
        self._producer.produce(
            topic=TOPIC,
            key=job["id"].encode("utf-8"),
            value=self._payload(job, event, checkpoint_ids),
        )
        self._producer.poll(0)

    def close(self) -> None:
        self._producer.flush()
`,
    },
    typescript: {
      starter: `/** Fine-tune lifecycle events on Kafka (model-generated draft). */
import {Kafka, type Producer} from 'kafkajs';

export class EventPublisher {
  private readonly producer: Producer;

  constructor(bootstrap: string, private readonly jobs: JobStore) {
    this.producer = new Kafka({brokers: bootstrap}).producer();
  }

  async publish(job: Job, event: string, checkpointIds: string[]): Promise<void> {
    // TODO: key by job id, send only the config hash, dataset version and checkpoint ids, and
    // produce after the job record commits instead of before it.
    await this.producer.send({
      topic: 'finetune.job',
      messages: [
        {
          key: job.team,
          value: JSON.stringify({
            event,
            job_id: job.id,
            team: job.team,
            hyperparameters: job.hyperparameters,
            loss_log: job.lossLog.slice(0, 5),
          }),
        },
      ],
    });
  }
}
`,
      solution: `/** Fine-tune lifecycle events on Kafka. */
import {Kafka, type Producer} from 'kafkajs';

const TOPIC = 'finetune.job';

export class EventPublisher {
  private readonly producer: Producer;

  constructor(bootstrap: string, private readonly jobs: JobStore) {
    this.producer = new Kafka({brokers: bootstrap}).producer({idempotent: true});
  }

  private payload(job: Job, event: string, checkpointIds: string[]): string {
    // Hashes and ids only; the recipe and the training logs stay in the datastore.
    return JSON.stringify({
      event,
      job_id: job.id,
      config_hash: job.configHash,
      dataset_version: job.datasetVersion,
      checkpoint_ids: checkpointIds,
      status: job.status,
    });
  }

  async publish(job: Job, event: string, checkpointIds: string[]): Promise<void> {
    await this.jobs.commit(job);
    await this.producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: job.id, value: this.payload(job, event, checkpointIds)}],
    });
  }
}
`,
    },
    go: {
      starter: `// Package events publishes fine-tune lifecycle events to Kafka (model-generated draft).
package events

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

type Publisher struct {
	writer *kafka.Writer
	jobs   *JobStore
}

func NewPublisher(bootstrap string, jobs *JobStore) *Publisher {
	return &Publisher{
		writer: &kafka.Writer{Addr: kafka.TCP(bootstrap), Topic: "finetune.job"},
		jobs:   jobs,
	}
}

func (p *Publisher) Publish(ctx context.Context, job *Job, event string, checkpointIDs []string) error {
	// TODO: key by job id, send only the config hash, dataset version and checkpoint ids, and
	// produce after the job record commits instead of before it.
	value, _ := json.Marshal(map[string]any{
		"event":           event,
		"job_id":          job.ID,
		"team":            job.Team,
		"hyperparameters": job.Hyperparameters,
		"loss_log":        job.LossLog[:5],
	})
	return p.writer.WriteMessages(ctx, kafka.Message{Key: []byte(job.Team), Value: value})
}
`,
      solution: `// Package events publishes fine-tune lifecycle events to Kafka.
package events

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const Topic = "finetune.job"

type Publisher struct {
	writer *kafka.Writer
	jobs   *JobStore
}

func NewPublisher(bootstrap string, jobs *JobStore) *Publisher {
	return &Publisher{
		writer: &kafka.Writer{
			Addr:         kafka.TCP(bootstrap),
			Topic:        Topic,
			RequiredAcks: kafka.RequireAll,
			Balancer:     &kafka.Hash{},
		},
		jobs: jobs,
	}
}

func (p *Publisher) payload(job *Job, event string, checkpointIDs []string) ([]byte, error) {
	// Hashes and ids only; the recipe and the training logs stay in the datastore.
	return json.Marshal(map[string]any{
		"event":           event,
		"job_id":          job.ID,
		"config_hash":     job.ConfigHash,
		"dataset_version": job.DatasetVersion,
		"checkpoint_ids":  checkpointIDs,
		"status":          job.Status,
	})
}

func (p *Publisher) Publish(ctx context.Context, job *Job, event string, checkpointIDs []string) error {
	// Commit the job record first, so no event announces an uncommitted state.
	if err := p.jobs.Commit(ctx, job); err != nil {
		return err
	}
	value, err := p.payload(job, event, checkpointIDs)
	if err != nil {
		return err
	}
	return p.writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(job.ID),
		Value: value,
	})
}
`,
    },
    scala: {
      starter: `package finetune

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import java.util.Properties

object Events {
  final class Publisher(bootstrap: String, jobs: JobStore) {
    private val props = new Properties()
    props.put("bootstrap.servers", bootstrap)
    props.put("key.serializer", classOf[StringSerializer].getName)
    props.put("value.serializer", classOf[StringSerializer].getName)
    private val producer = new KafkaProducer[String, String](props)

    def publish(job: Job, event: String, checkpointIds: List[String]): Unit = {
      // TODO: key by job id, send only the config hash, dataset version and checkpoint ids, and
      // produce after the job record commits instead of before it.
      val value =
        s"""{"event":"$event","job_id":"\${job.id}","team":"\${job.team}","hyperparameters":\${job.hyperparametersJson},"loss_log":\${job.lossLogJson}}"""
      producer.send(new ProducerRecord[String, String]("finetune.job", job.team, value))
    }
  }
}
`,
      solution: `package finetune

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import java.util.Properties

object Events {
  val Topic = "finetune.job"

  final class Publisher(bootstrap: String, jobs: JobStore) {
    private val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrap)
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, classOf[StringSerializer].getName)
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, classOf[StringSerializer].getName)
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    private val producer = new KafkaProducer[String, String](props)

    private def payload(job: Job, event: String, checkpointIds: List[String]): String = {
      // Hashes and ids only; the recipe and the training logs stay in the datastore.
      val ids = checkpointIds.map(id => "\\"" + id + "\\"").mkString(",")
      s"""{"event":"$event","job_id":"\${job.id}","config_hash":"\${job.configHash}","dataset_version":"\${job.datasetVersion}","checkpoint_ids":[$ids],"status":"\${job.status}"}"""
    }

    def publish(job: Job, event: String, checkpointIds: List[String]): Unit = {
      // Commit the job record first, so no event announces an uncommitted state.
      jobs.commit(job)
      producer.send(new ProducerRecord[String, String](Topic, job.id, payload(job, event, checkpointIds)))
    }
  }
}
`,
    },
    cpp: {
      starter: `// Fine-tune lifecycle events on Kafka (model-generated draft).
#include <librdkafka/rdkafkacpp.h>

#include <string>

class EventPublisher {
 public:
  EventPublisher(const std::string& bootstrap, JobStore* jobs) : jobs_(jobs) {
    std::string errstr;
    conf_ = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
    conf_->set("bootstrap.servers", bootstrap, errstr);
    producer_.reset(RdKafka::Producer::create(conf_.get(), errstr));
  }

  void Publish(const Job& job, const std::string& event, const std::vector<std::string>& checkpoint_ids) {
    // TODO: key by job id, send only the config hash, dataset version and checkpoint ids, and
    // produce after the job record commits instead of before it.
    const std::string value = "{\\"job_id\\":\\"" + job.id + "\\",\\"team\\":\\"" + job.team +
                              "\\",\\"hyperparameters\\":" + job.hyperparameters_json +
                              ",\\"loss_log\\":" + job.loss_log_json + "}";
    producer_->produce(
        "finetune.job", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(value.c_str()), value.size(),
        job.team.c_str(), job.team.size(), 0, nullptr);
    producer_->poll(0);
  }

 private:
  JobStore* jobs_;
  std::unique_ptr<RdKafka::Conf> conf_;
  std::unique_ptr<RdKafka::Producer> producer_;
};
`,
      solution: `// Fine-tune lifecycle events on Kafka.
#include <librdkafka/rdkafkacpp.h>

#include <string>

namespace {
const char* kTopic = "finetune.job";
}  // namespace

class EventPublisher {
 public:
  EventPublisher(const std::string& bootstrap, JobStore* jobs) : jobs_(jobs) {
    std::string errstr;
    conf_ = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
    conf_->set("bootstrap.servers", bootstrap, errstr);
    conf_->set("enable.idempotence", "true", errstr);
    conf_->set("acks", "all", errstr);
    producer_.reset(RdKafka::Producer::create(conf_.get(), errstr));
  }

  std::string Payload(const Job& job, const std::string& event, const std::vector<std::string>& checkpoint_ids) {
    // Hashes and ids only; the recipe and the training logs stay in the datastore.
    return "{\\"event\\":\\"" + event + "\\",\\"job_id\\":\\"" + job.id +
           "\\",\\"config_hash\\":\\"" + job.config_hash + "\\",\\"dataset_version\\":\\"" + job.dataset_version +
           "\\",\\"checkpoint_ids\\":" + Join(checkpoint_ids) + ",\\"status\\":\\"" + job.status + "\\"}";
  }

  void Publish(const Job& job, const std::string& event, const std::vector<std::string>& checkpoint_ids) {
    // Commit the job record first, so no event announces an uncommitted state.
    jobs_->Commit(job);
    const std::string value = Payload(job, event, checkpoint_ids);
    producer_->produce(
        kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(value.c_str()), value.size(),
        job.id.c_str(), job.id.size(), 0, nullptr);
    producer_->poll(0);
  }

 private:
  JobStore* jobs_;
  std::unique_ptr<RdKafka::Conf> conf_;
  std::unique_ptr<RdKafka::Producer> producer_;
};
`,
    },
  },
  hints: [
    'Key by `job_id`, not by team: all events for one job must land on one partition so a consumer reads them in order.',
    'The payload is a pointer to the job — `config_hash`, `dataset_version`, `checkpoint_ids`, `status`. The recipe and the loss curve stay in the datastore.',
    'Commit the job record first, then produce with an idempotent `acks=all` producer, so no event announces a state that is not durable.',
  ],
  debrief: `The interviewer is testing whether you can review a generated event path against ordering, payload hygiene and durability. The draft reads fine because the topic shows a plausible event. Four separate defects are being checked: the key must be the job id so per-job order holds; the payload must carry hashes and ids rather than the recipe and the loss curve; the produce must follow the commit so a consumer cannot act on a rolled-back transition; and the producer must be idempotent with acks=all so a retry does not duplicate. The payload flaw is the one candidates miss: a retained topic is a second, unmanaged copy of whatever you put in it. Real systems also carry an event id so consumers can dedupe redeliveries.`,
};
