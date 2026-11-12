import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'finetune.job: commit the move, then announce it',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['redis', 'kafka'],
  task: `## Task

**Starting point.** The starter's \`record_transition(job_id, from_status, to_status)\` loads the job
with \`store.by_id\`, produces \`{job_id, team, status, dataset_version, hyperparameters,
checkpoint_ids}\` to \`finetune.job\` keyed by the team through a producer built from defaults, then
commits the move with the provided \`store.transition\` (a compare-and-set on the job's status) and
returns what it answered. The demo shows one event per move. It hides 5 flaws.

**Failure mode the checks target.** Producing first announces moves the store refuses: the team
cancels a run a second before the trainer reports success, and every consumer hears "succeeded" for a
cancelled job. The key decides what a compacted topic keeps: keyed by team, one job's final status
replaces another's. The hyperparameter block is the recipe itself, copied into a retained, replicated
topic. A lost acknowledgement duplicates an event, and a refused produce vanishes.

Requirements:

- \`store.transition\` **first**; when it answers false, return false and produce nothing.
- Key every event by **\`job_id\`**.
- The payload is \`{job_id, team, status, config_hash, dataset_version, checkpoint_ids}\`: a reference
  to the recipe, not the recipe.
- The producer is **idempotent with \`acks=all\`** (Go uses confluent-kafka-go: kafka-go has no
  idempotent producer).
- When the broker refuses the produce, the event goes to the provided \`outbox\` from the **delivery
  report**, not from a \`try\` around the enqueue; the committed move stands.`,
  sequence: {
    participants: ['Worker', 'job store', 'finetune.job', 'outbox'],
    messages: [
      {from: 'Worker', to: 'job store', label: 'transition(job, running, succeeded)', kind: 'sync'},
      {from: 'job store', to: 'Worker', label: 'true', kind: 'reply'},
      {
        from: 'Worker',
        to: 'finetune.job',
        label: 'produce key=job_id {status, config_hash, dataset_version, checkpoint_ids}',
        kind: 'async',
      },
      {from: 'finetune.job', to: 'Worker', label: 'delivery report: error', kind: 'reply'},
      {from: 'Worker', to: 'outbox', label: 'insert_outbox(event)', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'job-key',
      title: 'Keys every event by job id',
      detail:
        'Two jobs of one team produce events keyed job-7 and job-8, and one job\u2019s events share a partition. The starter keys by team, so a compacted topic keeps one job per team.',
      match: {
        python: {all: [/produce\([^)]*key\s*=\s*job_id\b/], none: [/key\s*=\s*job\[\s*["']team["']\s*\]/]},
        typescript: {all: [/key:\s*jobId\b/], none: [/key:\s*job\.team\b/]},
        go: {all: [/Key:\s*\[\]byte\(\s*jobID\s*\)/], none: [/Key:\s*\[\]byte\(\s*job\.Team\s*\)/]},
        scala: {
          all: [/ProducerRecord(\[[^\]]*\])?\(\s*Config\.Topic\s*,\s*jobId\s*,/],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*Config\.Topic\s*,\s*job\.team\s*,/],
        },
        cpp: {
          all: [/produce\([\s\S]{0,300}?job_id\.(c_str|data)\(\)/],
          none: [/produce\([\s\S]{0,300}?team\.(c_str|data)\(\)/],
        },
      },
    },
    {
      id: 'reference-payload',
      title: 'Carries the config hash, not the hyperparameters',
      detail:
        'The event carries job_id, team, status, config_hash, dataset_version and checkpoint_ids, and no hyperparameters field or value. The starter copies the hyperparameter block and leaves the hash out.',
      match: {
        python: {all: [/config_hash/], none: [/["']hyperparameters["']/]},
        typescript: {all: [/config_hash/], none: [/hyperparameters/]},
        go: {all: [/ConfigHash/], none: [/Hyperparameters/]},
        scala: {all: [/config_hash/], none: [/hyperparameters/]},
        cpp: {all: [/config_hash/], none: [/hyperparameters/]},
      },
    },
    {
      id: 'commit-before-produce',
      title: 'Produces only after the store accepted the move',
      detail:
        'A job the team cancelled cannot move from running to succeeded: record_transition answers false, the topic stays empty and the job stays cancelled. The starter produces first and commits after.',
      match: {
        python: {order: [/store\.transition\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.transition\(/, /producer\.send\(/]},
        go: {order: [/jobs\.Transition\(/, /producer\.Produce\(/]},
        scala: {order: [/Jobs\.transition\(/, /producer\.send\(/]},
        cpp: {order: [/jobs::transition\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Writes an event once when an acknowledgement is lost',
      detail:
        'The broker writes the event but its acknowledgement never arrives and the producer retries: the topic holds the event once. The starter\u2019s default producer writes it twice.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/idempotent:\s*true/]},
        go: {all: [/"enable\.idempotence":\s*true/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-refusal',
      title: 'Keeps a refused event in the outbox from the delivery report',
      detail:
        'When the broker refuses the produce, the event lands in the outbox (ft:outbox) where the broker answers (the delivery callback, the rejected send, the report\u2019s error); record_transition does not raise and the move stays committed. The starter never looks at the result.',
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /outbox\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/outbox\.insertOutbox\(/, /catch\s*\(|\.catch\(/]},
        go: {all: [/outbox\.Insert\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insertOutbox\(/, /exception != null/]},
        cpp: {all: [/outbox::insert_outbox\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from finetune.config import TOPIC
from finetune.jobs import store

logger = logging.getLogger("finetune.events")

producer = Producer({"bootstrap.servers": "kafka:9092"})


def record_transition(job_id: str, from_status: str, to_status: str) -> bool:
    """Move the job from from_status to to_status and announce it on finetune.job; False when the move was refused."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    job = store.by_id(job_id)
    if job is None:
        return False
    event = {
        "job_id": job_id,
        "team": job["team"],
        "status": to_status,
        "dataset_version": job["dataset_version"],
        "hyperparameters": job["hyperparameters"],
        "checkpoint_ids": job["checkpoint_ids"],
    }
    producer.produce(TOPIC, key=job["team"], value=json.dumps(event).encode("utf-8"))
    producer.poll(0)
    committed = store.transition(job_id, from_status, to_status)
    logger.info("job %s %s -> %s committed=%s", job_id, from_status, to_status, committed)
    return committed
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from finetune.config import TOPIC
from finetune.jobs import store
from finetune.outbox import outbox

logger = logging.getLogger("finetune.events")

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",  # every in-sync replica has the event before the broker answers
        "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
    }
)


def record_transition(job_id: str, from_status: str, to_status: str) -> bool:
    """Move the job from from_status to to_status and announce it on finetune.job; False when the move was refused."""
    if not store.transition(job_id, from_status, to_status):
        logger.info("transition refused job=%s %s -> %s", job_id, from_status, to_status)
        return False
    job = store.by_id(job_id)
    event = {
        "job_id": job_id,
        "team": job["team"],
        "status": to_status,
        "config_hash": job["config_hash"],
        "dataset_version": job["dataset_version"],
        "checkpoint_ids": job["checkpoint_ids"],
    }

    def on_delivery(err, msg) -> None:
        if err is not None:
            outbox.insert_outbox(event)  # the broker said no: the relay republishes it later
            logger.warning("finetune.job produce failed job=%s status=%s: %s", job_id, to_status, err)

    producer.produce(TOPIC, key=job_id, value=json.dumps(event).encode("utf-8"), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery reports already in; returns at once
    logger.info("job %s %s -> %s", job_id, from_status, to_status)
    return True
`,
    },
    typescript: {
      starter: `import {Kafka, type Producer} from 'kafkajs';

import {TOPIC} from 'finetune/config';
import {store} from 'finetune/jobs';

const kafka = new Kafka({clientId: 'finetuned', brokers: ['kafka:9092']});
export const producer: Producer = kafka.producer();
void producer.connect();

/** Move the job from fromStatus to toStatus and announce it on finetune.job; false when the move was refused. */
export async function recordTransition(jobId: string, fromStatus: string, toStatus: string): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const job = await store.byId(jobId);
  if (job === null) return false;
  const event = {
    job_id: jobId,
    team: job.team,
    status: toStatus,
    dataset_version: job.dataset_version,
    hyperparameters: job.hyperparameters,
    checkpoint_ids: job.checkpoint_ids,
  };
  void producer.send({topic: TOPIC, messages: [{key: job.team, value: JSON.stringify(event)}]});
  const committed = await store.transition(jobId, fromStatus, toStatus);
  console.log(\`job \${jobId} \${fromStatus} -> \${toStatus} committed=\${committed}\`);
  return committed;
}
`,
      solution: `import {Kafka, type Producer} from 'kafkajs';

import {TOPIC} from 'finetune/config';
import {store} from 'finetune/jobs';
import {outbox} from 'finetune/outbox';

const kafka = new Kafka({clientId: 'finetuned', brokers: ['kafka:9092']});
// idempotent: a write retried after a lost acknowledgement lands once (it implies acks -1)
export const producer: Producer = kafka.producer({idempotent: true});
void producer.connect();

/** Move the job from fromStatus to toStatus and announce it on finetune.job; false when the move was refused. */
export async function recordTransition(jobId: string, fromStatus: string, toStatus: string): Promise<boolean> {
  if (!(await store.transition(jobId, fromStatus, toStatus))) {
    console.log(\`transition refused job=\${jobId} \${fromStatus} -> \${toStatus}\`);
    return false;
  }
  const job = await store.byId(jobId);
  const event = {
    job_id: jobId,
    team: job?.team ?? '',
    status: toStatus,
    config_hash: job?.config_hash ?? '',
    dataset_version: job?.dataset_version ?? '',
    checkpoint_ids: job?.checkpoint_ids ?? [],
  };
  try {
    await producer.send({topic: TOPIC, messages: [{key: jobId, value: JSON.stringify(event)}], acks: -1});
  } catch (err) {
    await outbox.insertOutbox(event); // the broker said no: the relay republishes it later
    console.warn(\`finetune.job produce failed job=\${jobId} status=\${toStatus}: \${(err as Error).message}\`);
  }
  console.log(\`job \${jobId} \${fromStatus} -> \${toStatus}\`);
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"finetune/config" // config.Topic — provided
	"finetune/jobs"   // jobs.ByID(ctx, jobID), jobs.Transition(ctx, jobID, from, to) — provided
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

// recordTransition moves the job from fromStatus to toStatus and announces it on finetune.job;
// false when the move was refused.
func recordTransition(ctx context.Context, jobID, fromStatus, toStatus string) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	job, err := jobs.ByID(ctx, jobID)
	if err != nil {
		return false, err
	}
	if job == nil {
		return false, nil
	}
	value, err := json.Marshal(map[string]any{
		"job_id":          jobID,
		"team":            job.Team,
		"status":          toStatus,
		"dataset_version": job.DatasetVersion,
		"hyperparameters": job.Hyperparameters,
		"checkpoint_ids":  job.CheckpointIDs,
	})
	if err != nil {
		return false, err
	}
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(job.Team), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	committed, err := jobs.Transition(ctx, jobID, fromStatus, toStatus)
	log.Printf("job %s %s -> %s committed=%v", jobID, fromStatus, toStatus, committed)
	return committed, err
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"finetune/config" // config.Topic — provided
	"finetune/jobs"   // jobs.ByID(ctx, jobID), jobs.Transition(ctx, jobID, from, to) — provided
	"finetune/outbox" // outbox.Insert(ctx, eventJSON) — provided
)

const ackTimeout = 2 * time.Second

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the event before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

type transitionEvent struct {
	JobID          string   \`json:"job_id"\`
	Team           string   \`json:"team"\`
	Status         string   \`json:"status"\`
	ConfigHash     string   \`json:"config_hash"\`
	DatasetVersion string   \`json:"dataset_version"\`
	CheckpointIDs  []string \`json:"checkpoint_ids"\`
}

// recordTransition moves the job from fromStatus to toStatus and announces it on finetune.job;
// false when the move was refused.
func recordTransition(ctx context.Context, jobID, fromStatus, toStatus string) (bool, error) {
	moved, err := jobs.Transition(ctx, jobID, fromStatus, toStatus)
	if err != nil {
		return false, err
	}
	if !moved {
		log.Printf("transition refused job=%s %s -> %s", jobID, fromStatus, toStatus)
		return false, nil
	}
	job, err := jobs.ByID(ctx, jobID)
	if err != nil {
		return false, err
	}
	value, err := json.Marshal(transitionEvent{
		JobID:          jobID,
		Team:           job.Team,
		Status:         toStatus,
		ConfigHash:     job.ConfigHash,
		DatasetVersion: job.DatasetVersion,
		CheckpointIDs:  job.CheckpointIDs,
	})
	if err != nil {
		return false, err
	}
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(jobID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err = producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// the broker said no: the relay republishes it later
		if err := outbox.Insert(ctx, value); err != nil {
			return true, err
		}
		log.Printf("finetune.job produce failed job=%s status=%s: %v", jobID, toStatus, err)
	}
	log.Printf("job %s %s -> %s", jobID, fromStatus, toStatus)
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import finetune.{Config, Jobs}

object TransitionEvents {
  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Move the job from fromStatus to toStatus and announce it on finetune.job; false when the move was refused. */
  def recordTransition(jobId: String, fromStatus: String, toStatus: String): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    Jobs.byId(jobId) match {
      case None => false
      case Some(job) =>
        val event = ujson.write(
          ujson.Obj(
            "job_id" -> jobId,
            "team" -> job.team,
            "status" -> toStatus,
            "dataset_version" -> job.dataset_version,
            "hyperparameters" -> ujson.Obj.from(job.hyperparameters.map { case (k, v) => k -> ujson.Num(v) }),
            "checkpoint_ids" -> ujson.Arr.from(job.checkpoint_ids.map(ujson.Str(_)))
          )
        )
        producer.send(new ProducerRecord[String, String](Config.Topic, job.team, event))
        val committed = Jobs.transition(jobId, fromStatus, toStatus)
        System.err.println(s"job $jobId $fromStatus -> $toStatus committed=$committed")
        committed
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer

import finetune.{Config, Jobs, Outbox}

object TransitionEvents {
  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the event before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Move the job from fromStatus to toStatus and announce it on finetune.job; false when the move was refused. */
  def recordTransition(jobId: String, fromStatus: String, toStatus: String): Boolean = {
    if (!Jobs.transition(jobId, fromStatus, toStatus)) {
      System.err.println(s"transition refused job=$jobId $fromStatus -> $toStatus")
      return false
    }
    val job = Jobs.byId(jobId).get
    val event = ujson.write(
      ujson.Obj(
        "job_id" -> jobId,
        "team" -> job.team,
        "status" -> toStatus,
        "config_hash" -> job.config_hash,
        "dataset_version" -> job.dataset_version,
        "checkpoint_ids" -> ujson.Arr.from(job.checkpoint_ids.map(ujson.Str(_)))
      )
    )
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) {
          Outbox.insertOutbox(event) // the broker said no: the relay republishes it later
          System.err.println(s"finetune.job produce failed job=$jobId status=$toStatus: \${exception.getMessage}")
        }
    }
    producer.send(new ProducerRecord[String, String](Config.Topic, jobId, event), onDelivery)
    System.err.println(s"job $jobId $fromStatus -> $toStatus")
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

#include "finetune/config.h"  // config::kTopic — provided
#include "finetune/jobs.h"    // jobs::by_id(job_id), jobs::transition(job_id, from, to) — provided

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Move the job from from_status to to_status and announce it on finetune.job; false when the move was refused.
bool record_transition(const std::string& job_id, const std::string& from_status, const std::string& to_status) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto job = jobs::by_id(job_id);
  if (!job) return false;
  const std::string team = job->value("team", "");
  const std::string event = nlohmann::json{{"job_id", job_id},
                                           {"team", team},
                                           {"status", to_status},
                                           {"dataset_version", job->value("dataset_version", "")},
                                           {"hyperparameters", (*job)["hyperparameters"]},
                                           {"checkpoint_ids", (*job)["checkpoint_ids"]}}
                                .dump();
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                    event.size(), team.c_str(), team.size(), 0, nullptr);
  producer->poll(0);
  const bool committed = jobs::transition(job_id, from_status, to_status);
  std::cerr << "job " << job_id << " " << from_status << " -> " << to_status << " committed=" << committed << "\\n";
  return committed;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "finetune/config.h"  // config::kTopic — provided
#include "finetune/jobs.h"    // jobs::by_id(job_id), jobs::transition(job_id, from, to) — provided
#include "finetune/outbox.h"  // outbox::insert_outbox(event_json) — provided

// The delivery report: a refused event goes to the outbox for the relay to republish.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    outbox::insert_outbox(std::string(static_cast<const char*>(message.payload()), message.len()));
    std::cerr << "finetune.job produce failed: " << message.errstr() << "\\n";
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the event before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Move the job from from_status to to_status and announce it on finetune.job; false when the move was refused.
bool record_transition(const std::string& job_id, const std::string& from_status, const std::string& to_status) {
  if (!jobs::transition(job_id, from_status, to_status)) {
    std::cerr << "transition refused job=" << job_id << " " << from_status << " -> " << to_status << "\\n";
    return false;
  }
  const auto job = jobs::by_id(job_id);
  const std::string event = nlohmann::json{{"job_id", job_id},
                                           {"team", job->value("team", "")},
                                           {"status", to_status},
                                           {"config_hash", job->value("config_hash", "")},
                                           {"dataset_version", job->value("dataset_version", "")},
                                           {"checkpoint_ids", (*job)["checkpoint_ids"]}}
                                .dump();
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                    event.size(), job_id.c_str(), job_id.size(), 0, nullptr);
  producer->poll(0);  // serve delivery reports already in; returns at once
  std::cerr << "job " << job_id << " " << from_status << " -> " << to_status << "\\n";
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "finetune.job"
CONFIG_HASH = "7e" * 32
HYPERPARAMETERS = {"learning_rate": 0.0002, "lora_rank": 16, "epochs": 3}


def _seed(ctx, job_id, status, team="ml-search"):
    ctx.redis.hset(f"ft:job:{job_id}", mapping={
        "job_id": job_id, "team": team, "status": status, "base_model": "llama-3.1-8b",
        "dataset_version": "support-tickets@v3", "dataset_sha256": "b1" * 32, "config_hash": CONFIG_HASH,
        "compute_budget": 400, "hyperparameters": json.dumps(HYPERPARAMETERS), "checkpoint_ids": json.dumps([f"ckpt-{job_id}-1"]),
    })


def _settle(m):
    """Serve the producer's delivery reports, as the worker's loop would between moves."""
    if hasattr(m, "producer"):
        m.producer.poll(0)


def _events(ctx):
    return [json.loads(v) for v in ctx.kafka.values(TOPIC)]


def _status(ctx, job_id):
    return ctx.redis.hget(f"ft:job:{job_id}", "status")


def check_job_key(ctx):
    m = ctx.load("events")
    _seed(ctx, "job-7", "queued")
    _seed(ctx, "job-8", "queued")
    assert m.record_transition("job-7", "queued", "running") is True
    assert m.record_transition("job-8", "queued", "running") is True
    assert m.record_transition("job-7", "running", "succeeded") is True
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three moves produced {len(records)} records on {TOPIC}"
    keys = sorted(r.key for r in records)
    assert keys == [b"job-7", b"job-7", b"job-8"], f"events must be keyed by job id, got {keys}: keyed by team, a compacted topic keeps one job per team and the other jobs' final statuses are gone"
    assert len({r.partition for r in records if r.key == b"job-7"}) == 1, "one job's events must share a partition so they stay in order"


def check_reference_payload(ctx):
    m = ctx.load("events")
    _seed(ctx, "job-7", "running")
    assert m.record_transition("job-7", "running", "succeeded") is True
    _settle(m)
    values = ctx.kafka.values(TOPIC)
    assert len(values) == 1, f"one move produced {len(values)} records"
    event = json.loads(values[0])
    expected = {"job_id": "job-7", "team": "ml-search", "status": "succeeded", "config_hash": CONFIG_HASH, "dataset_version": "support-tickets@v3", "checkpoint_ids": ["ckpt-job-7-1"]}
    for key, value in expected.items():
        assert event.get(key) == value, f"the event must carry {key}={value!r}, got {event}"
    assert "hyperparameters" not in event and b"learning_rate" not in values[0], f"the event copies the hyperparameter block into a retained, replicated topic: {event}; config_hash is the reference"


def check_commit_before_produce(ctx):
    m = ctx.load("events")
    _seed(ctx, "job-7", "cancelled")  # the team cancelled the run a second before the trainer reported success
    moved = m.record_transition("job-7", "running", "succeeded")
    _settle(m)
    assert _events(ctx) == [], f"the store refused running -> succeeded for a cancelled job, yet the topic says {_events(ctx)}: produce only after the commit"
    assert moved is False, f"record_transition must answer False when the store refuses the move, got {moved!r}"
    assert _status(ctx, "job-7") == "cancelled", f"the job must stay cancelled, it reads {_status(ctx, 'job-7')}"
    _seed(ctx, "job-8", "running")
    assert m.record_transition("job-8", "running", "succeeded") is True
    _settle(m)
    assert [e.get("job_id") for e in _events(ctx)] == ["job-8"] and _status(ctx, "job-8") == "succeeded", f"an accepted move is committed and announced once: {_events(ctx)}, status {_status(ctx, 'job-8')}"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    _seed(ctx, "job-7", "running")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.record_transition("job-7", "running", "succeeded")
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one move whose acknowledgement was lost left {len(records)} records: the producer's retry wrote the event again. enable.idempotence (with acks=all) makes the retry land once"


def check_outbox_on_refusal(ctx):
    m = ctx.load("events")
    _seed(ctx, "job-7", "running")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.record_transition("job-7", "running", "succeeded")
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"record_transition raised when the broker refused the produce: {e!r}; the event goes to the outbox, the move stays committed") from e
    _settle(m)
    rows = [json.loads(row) for row in ctx.redis.lrange("ft:outbox", 0, -1)]
    assert len(rows) == 1, f"the broker refused one produce and the outbox holds {len(rows)} rows: a refused event must be kept for the relay"
    assert rows[0].get("job_id") == "job-7" and rows[0].get("status") == "succeeded", f"the outbox row must be the event itself, got {rows[0]}"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused produce"
    assert _status(ctx, "job-7") == "succeeded", f"the committed move stands, the job reads {_status(ctx, 'job-7')}"
    _seed(ctx, "job-8", "running")
    m.record_transition("job-8", "running", "succeeded")
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1 and ctx.redis.llen("ft:outbox") == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row"
`,
    typescript: `const TOPIC = 'finetune.job';
const CONFIG_HASH = '7e'.repeat(32);
const HYPERPARAMETERS = {learning_rate: 0.0002, lora_rank: 16, epochs: 3};

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function seed(ctx, jobId: string, status: string, team = 'ml-search') {
  const fields = {
    job_id: jobId, team, status, base_model: 'llama-3.1-8b', dataset_version: 'support-tickets@v3',
    dataset_sha256: 'b1'.repeat(32), config_hash: CONFIG_HASH, compute_budget: '400',
    hyperparameters: JSON.stringify(HYPERPARAMETERS), checkpoint_ids: JSON.stringify([\`ckpt-\${jobId}-1\`]),
  };
  ctx.redis.hset(\`ft:job:\${jobId}\`, ...Object.entries(fields).flat());
}

const events = ctx => ctx.kafka.values(TOPIC).map(v => JSON.parse(v.toString()));
const statusOf = (ctx, jobId: string) => ctx.redis.hget(\`ft:job:\${jobId}\`, 'status');

export async function check_job_key(ctx) {
  const m = ctx.load('events');
  seed(ctx, 'job-7', 'queued');
  seed(ctx, 'job-8', 'queued');
  assert.equal(await m.recordTransition('job-7', 'queued', 'running'), true);
  assert.equal(await m.recordTransition('job-8', 'queued', 'running'), true);
  assert.equal(await m.recordTransition('job-7', 'running', 'succeeded'), true);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three moves produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null).sort();
  assert.deepEqual(keys, ['job-7', 'job-7', 'job-8'], \`events must be keyed by job id, got \${JSON.stringify(keys)}: keyed by team, a compacted topic keeps one job per team and the other jobs' final statuses are gone\`);
  assert.equal(new Set(records.filter(r => r.key?.toString() === 'job-7').map(r => r.partition)).size, 1, "one job's events must share a partition so they stay in order");
}

export async function check_reference_payload(ctx) {
  const m = ctx.load('events');
  seed(ctx, 'job-7', 'running');
  assert.equal(await m.recordTransition('job-7', 'running', 'succeeded'), true);
  await settle();
  const values = ctx.kafka.values(TOPIC).map(v => v.toString());
  assert.equal(values.length, 1, \`one move produced \${values.length} records\`);
  const event = JSON.parse(values[0]);
  const expected = {job_id: 'job-7', team: 'ml-search', status: 'succeeded', config_hash: CONFIG_HASH, dataset_version: 'support-tickets@v3', checkpoint_ids: ['ckpt-job-7-1']};
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(event[key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${values[0]}\`);
  assert(!('hyperparameters' in event) && !values[0].includes('learning_rate'), \`the event copies the hyperparameter block into a retained, replicated topic: \${values[0]}; config_hash is the reference\`);
}

export async function check_commit_before_produce(ctx) {
  const m = ctx.load('events');
  seed(ctx, 'job-7', 'cancelled'); // the team cancelled the run a second before the trainer reported success
  const moved = await m.recordTransition('job-7', 'running', 'succeeded');
  await settle();
  assert.deepEqual(events(ctx), [], \`the store refused running -> succeeded for a cancelled job, yet the topic says \${JSON.stringify(events(ctx))}: produce only after the commit\`);
  assert.equal(moved, false, \`recordTransition must resolve false when the store refuses the move, got \${moved}\`);
  assert.equal(statusOf(ctx, 'job-7'), 'cancelled', \`the job must stay cancelled, it reads \${statusOf(ctx, 'job-7')}\`);
  seed(ctx, 'job-8', 'running');
  assert.equal(await m.recordTransition('job-8', 'running', 'succeeded'), true);
  await settle();
  assert(JSON.stringify(events(ctx).map(e => e.job_id)) === '["job-8"]' && statusOf(ctx, 'job-8') === 'succeeded', \`an accepted move is committed and announced once: \${JSON.stringify(events(ctx))}, status \${statusOf(ctx, 'job-8')}\`);
}

export async function check_idempotent_producer(ctx) {
  const m = ctx.load('events');
  seed(ctx, 'job-7', 'running');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.recordTransition('job-7', 'running', 'succeeded');
  await settle();
  const n = ctx.kafka.records(TOPIC).length;
  assert.equal(n, 1, \`one move whose acknowledgement was lost left \${n} records: the producer's retry wrote the event again. idempotent: true makes the retry land once\`);
}

export async function check_outbox_on_refusal(ctx) {
  const m = ctx.load('events');
  seed(ctx, 'job-7', 'running');
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await m.recordTransition('job-7', 'running', 'succeeded');
  } catch (e) {
    assert.fail(\`recordTransition rejected when the broker refused the produce: \${e}; the event goes to the outbox, the move stays committed\`);
  }
  await settle();
  const rows = ctx.redis.lrange('ft:outbox', 0, -1).map(row => JSON.parse(row));
  assert.equal(rows.length, 1, \`the broker refused one produce and the outbox holds \${rows.length} rows: a refused event must be kept for the relay\`);
  assert(rows[0].job_id === 'job-7' && rows[0].status === 'succeeded', \`the outbox row must be the event itself, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused produce');
  assert.equal(statusOf(ctx, 'job-7'), 'succeeded', \`the committed move stands, the job reads \${statusOf(ctx, 'job-7')}\`);
  seed(ctx, 'job-8', 'running');
  await m.recordTransition('job-8', 'running', 'succeeded');
  await settle();
  assert(ctx.kafka.records(TOPIC).length === 1 && ctx.redis.lrange('ft:outbox', 0, -1).length === 1, 'a healthy produce after the refusal reaches the topic and adds no outbox row');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"leetbuild/harness"
)

const (
	eventsTopic      = "finetune.job"
	eventsConfigHash = "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e"
)

func eventsSeed(ctx *harness.Ctx, jobID, status string) {
	ctx.Redis.Do("HSET", "ft:job:"+jobID, "job_id", jobID, "team", "ml-search", "status", status, "base_model", "llama-3.1-8b",
		"dataset_version", "support-tickets@v3", "dataset_sha256", strings.Repeat("b1", 32), "config_hash", eventsConfigHash,
		"compute_budget", "400", "hyperparameters", \`{"learning_rate":0.0002,"lora_rank":16,"epochs":3}\`,
		"checkpoint_ids", \`["ckpt-\`+jobID+\`-1"]\`)
}

func eventsMove(ctx *harness.Ctx, jobID, from, to string) bool {
	moved, err := recordTransition(context.Background(), jobID, from, to)
	ctx.NoError(err, "recordTransition(%s, %s, %s)", jobID, from, to)
	return moved
}

func eventsAll(ctx *harness.Ctx) []map[string]any {
	out := []map[string]any{}
	for _, value := range ctx.Kafka.Values(eventsTopic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(value), &e), "the event is JSON: %s", value)
		out = append(out, e)
	}
	return out
}

func eventsStatus(ctx *harness.Ctx, jobID string) string {
	status, _ := ctx.Redis.HGet("ft:job:"+jobID, "status")
	return status
}

func CheckJobKey(ctx *harness.Ctx) {
	eventsSeed(ctx, "job-7", "queued")
	eventsSeed(ctx, "job-8", "queued")
	ctx.Assert(eventsMove(ctx, "job-7", "queued", "running"), "job-7 queued -> running must be accepted")
	ctx.Assert(eventsMove(ctx, "job-8", "queued", "running"), "job-8 queued -> running must be accepted")
	ctx.Assert(eventsMove(ctx, "job-7", "running", "succeeded"), "job-7 running -> succeeded must be accepted")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three moves; records on %s", eventsTopic)
	keys := ctx.Kafka.Keys(eventsTopic)
	sort.Strings(keys)
	ctx.Equal(keys, []string{"job-7", "job-7", "job-8"}, "events must be keyed by job id (keyed by team, a compacted topic keeps one job per team and the other jobs' final statuses are gone)")
	partitions := map[int32]bool{}
	for _, r := range records {
		if string(r.Key) == "job-7" {
			partitions[int32(r.Partition)] = true
		}
	}
	ctx.Equal(len(partitions), 1, "one job's events must share a partition so they stay in order; partitions for job-7")
}

func CheckReferencePayload(ctx *harness.Ctx) {
	eventsSeed(ctx, "job-7", "running")
	ctx.Assert(eventsMove(ctx, "job-7", "running", "succeeded"), "running -> succeeded must be accepted")
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one move; records")
	all := eventsAll(ctx)
	ctx.Equal(all[0], map[string]any{"job_id": "job-7", "team": "ml-search", "status": "succeeded", "config_hash": eventsConfigHash, "dataset_version": "support-tickets@v3", "checkpoint_ids": []any{"ckpt-job-7-1"}},
		"the event must be the reference {job_id, team, status, config_hash, dataset_version, checkpoint_ids}, not the recipe")
	ctx.Assert(!strings.Contains(values[0], "learning_rate"), "the event copies the hyperparameter block into a retained, replicated topic: %s; config_hash is the reference", values[0])
}

func CheckCommitBeforeProduce(ctx *harness.Ctx) {
	eventsSeed(ctx, "job-7", "cancelled") // the team cancelled the run a second before the trainer reported success
	moved := eventsMove(ctx, "job-7", "running", "succeeded")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "the store refused running -> succeeded for a cancelled job, yet the topic says %v: produce only after the commit; records", eventsAll(ctx))
	ctx.Assert(!moved, "recordTransition must answer false when the store refuses the move")
	ctx.Equal(eventsStatus(ctx, "job-7"), "cancelled", "the job must stay cancelled")
	eventsSeed(ctx, "job-8", "running")
	ctx.Assert(eventsMove(ctx, "job-8", "running", "succeeded"), "job-8 running -> succeeded must be accepted")
	ctx.Settle()
	all := eventsAll(ctx)
	ctx.Assert(len(all) == 1 && all[0]["job_id"] == "job-8" && eventsStatus(ctx, "job-8") == "succeeded", "an accepted move is committed and announced once: %v, status %s", all, eventsStatus(ctx, "job-8"))
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	eventsSeed(ctx, "job-7", "running")
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsMove(ctx, "job-7", "running", "succeeded")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "one move whose acknowledgement was lost: the producer's retry must not write the event again (enable.idempotence with acks=all); the records")
}

func CheckOutboxOnRefusal(ctx *harness.Ctx) {
	eventsSeed(ctx, "job-7", "running")
	ctx.Kafka.FailNext(eventsTopic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("recordTransition panicked when the broker refused the produce: %v; the event goes to the outbox, the move stays committed", e)
			}
		}()
		eventsMove(ctx, "job-7", "running", "succeeded")
	}()
	ctx.Settle()
	rows := ctx.Redis.LRange("ft:outbox", 0, -1)
	ctx.Equal(len(rows), 1, "the broker refused one produce: a refused event must be kept for the relay; outbox rows")
	var row map[string]any
	json.Unmarshal([]byte(rows[0]), &row)
	ctx.Assert(row["job_id"] == "job-7" && row["status"] == "succeeded", "the outbox row must be the event itself, got %s", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "nothing reached the topic for the refused produce; records")
	ctx.Equal(eventsStatus(ctx, "job-7"), "succeeded", "the committed move stands; the job's status")
	eventsSeed(ctx, "job-8", "running")
	eventsMove(ctx, "job-8", "running", "succeeded")
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(eventsTopic)) == 1 && len(ctx.Redis.LRange("ft:outbox", 0, -1)) == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <exception>
#include <set>
#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "finetune.job";
const std::string kConfigHash = "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e";

void seedJob(harness::Ctx& ctx, const std::string& job_id, const std::string& status) {
  ctx.Redis.Do("HSET", "ft:job:" + job_id, "job_id", job_id, "team", "ml-search", "status", status, "base_model", "llama-3.1-8b", "dataset_version",
               "support-tickets@v3", "dataset_sha256", "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1", "config_hash", kConfigHash,
               "compute_budget", "400", "hyperparameters", R"({"learning_rate":0.0002,"lora_rank":16,"epochs":3})", "checkpoint_ids",
               "[\\"ckpt-" + job_id + "-1\\"]");
}

void settle(harness::Ctx& ctx) {
  ctx.Settle();
  producer->poll(0);  // the worker's loop serves delivery reports between moves
}

std::vector<nlohmann::json> eventsAll(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& value : ctx.Kafka.Values(kEventsTopic)) out.push_back(nlohmann::json::parse(value, nullptr, false));
  return out;
}

std::string statusOf(harness::Ctx& ctx, const std::string& job_id) { return ctx.Redis.HGet("ft:job:" + job_id, "status").value_or(""); }

}  // namespace

void CheckJobKey(harness::Ctx& ctx) {
  seedJob(ctx, "job-7", "queued");
  seedJob(ctx, "job-8", "queued");
  ctx.Assert(record_transition("job-7", "queued", "running"), "job-7 queued -> running must be accepted");
  ctx.Assert(record_transition("job-8", "queued", "running"), "job-8 queued -> running must be accepted");
  ctx.Assert(record_transition("job-7", "running", "succeeded"), "job-7 running -> succeeded must be accepted");
  settle(ctx);
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three moves; records on %s", kEventsTopic);
  auto keys = ctx.Kafka.Keys(kEventsTopic);
  std::sort(keys.begin(), keys.end());
  ctx.Equal(keys, {"job-7", "job-7", "job-8"}, "events must be keyed by job id (keyed by team, a compacted topic keeps one job per team and the other jobs' final statuses are gone)");
  std::set<int> partitions;
  for (const auto& r : records) {
    if (r.Key.value_or("") == "job-7") partitions.insert(r.Partition);
  }
  ctx.Equal(partitions.size(), 1, "one job's events must share a partition so they stay in order; partitions for job-7");
}

void CheckReferencePayload(harness::Ctx& ctx) {
  seedJob(ctx, "job-7", "running");
  ctx.Assert(record_transition("job-7", "running", "succeeded"), "running -> succeeded must be accepted");
  settle(ctx);
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one move; records");
  const auto all = eventsAll(ctx);
  ctx.Equal(all[0],
            nlohmann::json({{"job_id", "job-7"}, {"team", "ml-search"}, {"status", "succeeded"}, {"config_hash", kConfigHash}, {"dataset_version", "support-tickets@v3"}, {"checkpoint_ids", {"ckpt-job-7-1"}}}),
            "the event must be the reference {job_id, team, status, config_hash, dataset_version, checkpoint_ids}, not the recipe");
  ctx.Assert(values[0].find("learning_rate") == std::string::npos, "the event copies the hyperparameter block into a retained, replicated topic: %s; config_hash is the reference", values[0]);
}

void CheckCommitBeforeProduce(harness::Ctx& ctx) {
  seedJob(ctx, "job-7", "cancelled");  // the team cancelled the run a second before the trainer reported success
  const bool moved = record_transition("job-7", "running", "succeeded");
  settle(ctx);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0, "the store refused running -> succeeded for a cancelled job, yet the topic says %v: produce only after the commit; records", eventsAll(ctx));
  ctx.Assert(!moved, "record_transition must answer false when the store refuses the move");
  ctx.Equal(statusOf(ctx, "job-7"), "cancelled", "the job must stay cancelled");
  seedJob(ctx, "job-8", "running");
  ctx.Assert(record_transition("job-8", "running", "succeeded"), "job-8 running -> succeeded must be accepted");
  settle(ctx);
  const auto all = eventsAll(ctx);
  ctx.Assert(all.size() == 1 && all[0].value("job_id", "") == "job-8" && statusOf(ctx, "job-8") == "succeeded", "an accepted move is committed and announced once: %v, status %s", all, statusOf(ctx, "job-8"));
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  seedJob(ctx, "job-7", "running");
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  record_transition("job-7", "running", "succeeded");
  settle(ctx);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "one move whose acknowledgement was lost: the producer's retry must not write the event again (enable.idempotence with acks=all); the records");
}

void CheckOutboxOnRefusal(harness::Ctx& ctx) {
  seedJob(ctx, "job-7", "running");
  ctx.Kafka.FailNext(kEventsTopic, 1);
  try {
    record_transition("job-7", "running", "succeeded");
  } catch (const std::exception& e) {
    ctx.Fatalf("record_transition threw when the broker refused the produce: %s; the event goes to the outbox, the move stays committed", e.what());
  }
  settle(ctx);
  const auto rows = ctx.Redis.LRange("ft:outbox", 0, -1);
  ctx.Equal(rows.size(), 1, "the broker refused one produce: a refused event must be kept for the relay; outbox rows");
  const auto row = nlohmann::json::parse(rows.empty() ? std::string("{}") : rows[0], nullptr, false);
  ctx.Assert(row.is_object() && row.value("job_id", "") == "job-7" && row.value("status", "") == "succeeded", "the outbox row must be the event itself, got %v", row);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0, "nothing reached the topic for the refused produce; records");
  ctx.Equal(statusOf(ctx, "job-7"), "succeeded", "the committed move stands; the job's status");
  seedJob(ctx, "job-8", "running");
  record_transition("job-8", "running", "succeeded");
  settle(ctx);
  ctx.Assert(ctx.Kafka.Records(kEventsTopic).size() == 1 && ctx.Redis.LRange("ft:outbox", 0, -1).size() == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row");
}
`,
  },
  hints: [
    'Symptom: a run the team cancelled shows up as succeeded on the topic, a compacted topic keeps one job per team, the recipe sits in every replica of the topic, a lost acknowledgement duplicates an event, and a refused produce disappears.',
    'Mechanism: the starter produces before `store.transition` and ignores what it answered; the key is `job["team"]`; the payload is built from the stored hyperparameters; the producer has neither idempotence nor a delivery callback.',
    'Change: return False unless `store.transition(...)` is true, then produce `key=job_id` with `config_hash` in place of `hyperparameters`; `enable.idempotence: True` with `acks: "all"`; an `on_delivery` callback that calls `outbox.insert_outbox(event)` on an error.',
  ],
  debrief: `The order is the contract here: an event says what the datastore already believes, so the commit comes first and a refused commit produces nothing. The compare-and-set in \`store.transition\` is what turns the race with a cancellation into a clean refusal instead of two truths. The key follows the consumer: anything that rebuilds or compacts per job needs the job id, and per-job order then comes free from the partition. The config hash keeps the topic a set of references; the recipe stays where access is controlled. The delivery report is where a broker refusal arrives, so that is where the outbox row is written. A production pipeline also runs a relay that drains the outbox with the same idempotent producer and validates each event against a schema registry.`,
};
