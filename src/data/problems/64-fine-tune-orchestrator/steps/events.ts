import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Fine-tune events keyed by job with config hashes',
  concept: 'kafka',
  file: 'events',
  focus: ['kafka', 'api'],
  task: `## Task

**Starting point.** The starter is the event publisher: \`publish\` builds a payload with the
event name, job id, team, the full hyperparameter block and the first five loss-log entries and
produces it to \`finetune.job\` keyed by team through a producer built from defaults, without
committing the job record at all. The happy path shows an event in the topic, and it hides five flaws.

**Failure mode the checks target.** Keying by team interleaves jobs on one partition, so a consumer
rebuilding one job's history reads another job's events between them. Copying the hyperparameter
block and a loss sample into a retained, replicated topic creates a second, unmanaged copy of the
recipe. Producing before the commit announces a transition the datastore may roll back, and a
default producer can duplicate an event on retry.

- **Key by job id.** Every event carries \`key = job_id\`, so one job's events stay on one
  partition, in order.
- **Reference, not a copy.** The payload carries \`config_hash\`, \`dataset_version\`,
  \`checkpoint_ids\` and \`status\`: enough to find the job, not enough to reproduce it.
- **No recipe, no logs.** The hyperparameter block and any slice of the loss log stay in the
  datastore.
- **Publish after commit.** The job record commits before the produce.
- **Idempotent producer.** Configured idempotent with \`acks=all\`, so a retried produce does not
  duplicate an event.`,
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
        'The event goes to `finetune.job` with `key = job_id`, so all events for a job stay ordered on one partition. The starter keys by team.',
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
        'The payload references the job by `config_hash`, `dataset_version` and `checkpoint_ids` instead of copying the recipe. The starter sends neither hash.',
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
        'Neither the hyperparameter block nor any slice of the training log appears in the event or the topic. The starter embeds both.',
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
        'The job record is committed before the produce, so an event never announces an uncommitted state. The starter produces first and commits later — or never.',
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
        'The producer is configured idempotent and waits for all in-sync replicas, so a retried produce does not duplicate an event. The starter uses the client defaults.',
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
      starter: `"""Fine-tune lifecycle events on Kafka."""
import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("finetune.events")


class EventPublisher:
    def __init__(self, bootstrap: str, jobs: "JobStore") -> None:
        self._producer = Producer({"bootstrap.servers": bootstrap})
        self._jobs = jobs

    def publish(self, job: dict, event: str, checkpoint_ids: list[str]) -> None:
        # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Fine-tune lifecycle events on Kafka. */
import {Kafka, type Producer} from 'kafkajs';

export class EventPublisher {
  private readonly producer: Producer;

  constructor(bootstrap: string, private readonly jobs: JobStore) {
    this.producer = new Kafka({brokers: bootstrap}).producer();
  }

  async publish(job: Job, event: string, checkpointIds: string[]): Promise<void> {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
      starter: `// Package events publishes fine-tune lifecycle events to Kafka.
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
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
      // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
      starter: `// Fine-tune lifecycle events on Kafka.
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
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
    "A dashboard replaying one job's history shows another team's learning rate and loss curve in between, and once showed a `completed` event for a job the database still lists as running.",
    '`publish` serialises `hyperparameters` and `loss_log` into the value, uses `job["team"]` as the key, never commits the record it announces, and the `Producer` config sets no idempotence or acks.',
    'Build the payload from `config_hash`, `dataset_version`, `checkpoint_ids` and `status`; key with `job["id"]`; call `commit()` before `produce()`; configure `enable.idempotence` and `"acks": "all"`.',
  ],
  debrief: `The fix has this shape because a Kafka topic is a durable, replicated, often mirrored log, and whatever lands in it has to be true, ordered and safe to retain. Keying by job id gives each job a single partition and therefore a single order; carrying hashes and ids instead of the recipe keeps the datastore the one place the recipe lives; committing before producing means an event can only describe a state that survived; the idempotent producer makes a retried send land once. Production event paths add an outbox table written in the same transaction as the job record, with a relay that produces from it, so a crash between commit and produce cannot lose the event.`,
};
