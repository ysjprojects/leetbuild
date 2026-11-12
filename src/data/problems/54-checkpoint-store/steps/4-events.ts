import type {Step} from '@/lib/types';

export const checkpointEventsStep: Step = {
  id: 'events',
  title: 'Checkpoint events keyed by training run',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter ends an upload: \`finish_upload(upload_id)\` produces a
\`checkpoint.event\` with the type, the upload id and the run to Kafka, keyed by the upload id, then
calls \`commit\` (step 2, provided as \`checkpoint.commit\`) and returns its record. It serves the
demo and hides five flaws.

**Failure mode the checks target.** One run's checkpoints land on different partitions and a
consumer sees step 1300 before step 1200; an incomplete upload is announced; the event carries
nothing a consumer can act on; a lost acknowledgement or a leader failover duplicates or drops it;
and a broker outage loses it.

- The record key is the **run id**.
- The payload is \`{"type": "checkpoint.committed", "run_id", "upload_id", "step", "chunks",
  "digest"}\`, taken from the commit's record.
- **Commit first**: produce only for a record \`commit\` returned.
- The producer is **idempotent** with **\`acks=all\`** (Go uses confluent-kafka-go: kafka-go has no
  idempotent producer).
- **Wait for the delivery report**, at most 2 s (\`ACK_TIMEOUT_S\`). When it fails or does not come,
  \`store.insert_outbox(topic, key, payload)\`; \`finish_upload\` still returns the record.`,
  sequence: {
    participants: ['Checkpoint API', 'Redis', 'checkpoint.event', 'Outbox'],
    messages: [
      {from: 'Checkpoint API', to: 'Redis', label: 'commit(u-3) → record · step 1300', kind: 'sync'},
      {from: 'Checkpoint API', to: 'checkpoint.event', label: 'produce key = r1 · idempotent · acks=all', kind: 'sync'},
      {from: 'checkpoint.event', to: 'Checkpoint API', label: 'delivery report within 2 s', kind: 'reply'},
      {from: 'checkpoint.event', to: 'Checkpoint API', label: 'no report / delivery failed', kind: 'reply'},
      {from: 'Checkpoint API', to: 'Outbox', label: 'insert_outbox(topic, r1, payload)', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'run-key',
      title: 'Keys checkpoint.event by training run',
      detail:
        'Three uploads of runs r1, r2, r1 produce records keyed r1, r2, r1, and both r1 records share a partition. The starter keys by upload id, which scatters one run over every partition.',
      match: {
        python: {all: [/key\s*=\s*record\[["']run_id["']\]/], none: [/key\s*=\s*upload_id/]},
        typescript: {all: [/key:\s*record\.run_id/], none: [/key:\s*uploadId/]},
        go: {all: [/Key:\s*\[\]byte\(\s*record\.RunID\s*\)/], none: [/Key:\s*\[\]byte\(\s*uploadID\s*\)/]},
        scala: {all: [/new ProducerRecord\[String, String\]\(\s*Topic,\s*record\.runId/], none: [/Topic,\s*uploadId/]},
        cpp: {all: [/record->run_id\.c_str\(\),\s*record->run_id\.(size|length)\(\)/], none: [/upload_id\.c_str\(\)/]},
      },
    },
    {
      id: 'event-payload',
      title: 'Carries the step, the chunk count and the digest',
      detail:
        'The value is the type, the run, the upload, the step, the chunk count and the manifest digest of the committed record. The starter sends the type, the upload id and the run.',
      match: {
        python: {all: [/["']step["']\s*:/, /["']chunks["']\s*:/, /["']digest["']\s*:/]},
        typescript: {all: [/step:\s*record\.step/, /chunks:\s*record\.chunks/, /digest:\s*record\.digest/]},
        go: {all: [/"step":/, /"chunks":/, /"digest":/]},
        scala: {all: [/"step"\s*->/, /"chunks"\s*->/, /"digest"\s*->/]},
        cpp: {all: [/\{"step",/, /\{"chunks",/, /\{"digest",/]},
      },
    },
    {
      id: 'commit-before-event',
      title: 'Commits before producing, and only a complete upload',
      detail:
        'An incomplete upload produces nothing, and when `checkpoint:{id}` is written the topic is still empty. The starter produces first, so it announces uploads the commit then refuses.',
      match: {
        python: {order: [/=\s*commit\(\s*upload_id\s*\)/, /producer\.produce\(/]},
        typescript: {order: [/await commit\(\s*uploadId\s*\)/, /producer\.send\(/]},
        go: {order: [/commit\.Commit\(/, /producer\.Produce\(/]},
        scala: {order: [/Commit\.commit\(/, /producer\.send\(/]},
        cpp: {order: [/commit::commit\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the payload, while the checkpoint stays committed. The starter fires and forgets.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /producer\.flush\(/, /on_delivery\s*=/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/store::insertOutbox\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from checkpoint import store  # upload, insert_outbox
from checkpoint.commit import commit

TOPIC = "checkpoint.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(upload: dict) -> dict:
    return {"type": "checkpoint.committed", "upload_id": upload["upload_id"], "run_id": upload["run_id"]}


def finish_upload(upload_id: str) -> dict | None:
    """Commit the upload and announce the checkpoint: the record, or None while the upload is incomplete."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    upload = store.upload(upload_id)
    if upload is None:
        return None
    producer.produce(TOPIC, key=upload_id, value=json.dumps(event_payload(upload)))
    producer.poll(0)
    return commit(upload_id)
`,
      solution: `import json

from confluent_kafka import Producer

from checkpoint import store  # upload, insert_outbox
from checkpoint.commit import commit

TOPIC = "checkpoint.event"
ACK_TIMEOUT_S = 2

# Idempotent with acks=all: a write retried after a lost acknowledgement lands once, and survives a failover.
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def event_payload(record: dict) -> dict:
    """What a consumer acts on without reading the weights: the run, the step, the chunk count and the digest."""
    return {
        "type": "checkpoint.committed",
        "run_id": record["run_id"],
        "upload_id": record["upload_id"],
        "step": record["step"],
        "chunks": record["chunks"],
        "digest": record["digest"],
    }


def finish_upload(upload_id: str) -> dict | None:
    """Commit the upload and announce the checkpoint: the record, or None while the upload is incomplete."""
    record = commit(upload_id)
    if record is None:
        return None  # nothing to announce: the upload is not complete
    payload = event_payload(record)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    # Keyed by run: one run's checkpoints stay on one partition, in commit order.
    producer.produce(TOPIC, key=record["run_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so consumers are late, not wrong.
        store.insert_outbox(TOPIC, record["run_id"], payload)
    return record
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {commit} from 'checkpoint/commit';
import {type CheckpointRecord, type Upload, insertOutbox, upload} from 'checkpoint/store';

export const TOPIC = 'checkpoint.event';

const kafka = new Kafka({clientId: 'checkpointd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export function eventPayload(current: Upload) {
  return {type: 'checkpoint.committed', upload_id: current.upload_id, run_id: current.run_id};
}

/** Commit the upload and announce the checkpoint: the record, or null while the upload is incomplete. */
export async function finishUpload(uploadId: string): Promise<CheckpointRecord | null> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const current = await upload(uploadId);
  if (current === null) return null;
  void producer.send({topic: TOPIC, messages: [{key: uploadId, value: JSON.stringify(eventPayload(current))}], acks: 1});
  return commit(uploadId);
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {commit} from 'checkpoint/commit';
import {type CheckpointRecord, insertOutbox} from 'checkpoint/store';

export const TOPIC = 'checkpoint.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'checkpointd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What a consumer acts on without reading the weights: the run, the step, the chunk count and the digest. */
export function eventPayload(record: CheckpointRecord) {
  return {
    type: 'checkpoint.committed',
    run_id: record.run_id,
    upload_id: record.upload_id,
    step: record.step,
    chunks: record.chunks,
    digest: record.digest,
  };
}

/** Commit the upload and announce the checkpoint: the record, or null while the upload is incomplete. */
export async function finishUpload(uploadId: string): Promise<CheckpointRecord | null> {
  const record = await commit(uploadId);
  if (record === null) return null; // nothing to announce: the upload is not complete
  const payload = eventPayload(record);
  try {
    // Keyed by run: one run's checkpoints stay on one partition, in commit order. acks: -1 (all).
    await producer.send({
      topic: TOPIC,
      messages: [{key: record.run_id, value: JSON.stringify(payload)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
  } catch {
    // The broker did not take it: the relay publishes the row later, so consumers are late, not wrong.
    await insertOutbox(TOPIC, record.run_id, payload);
  }
  return record;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"checkpoint/commit" // commit.Commit(ctx, uploadID) (*store.Record, error)
	"checkpoint/store"  // store.GetUpload, InsertOutbox, Record
)

const topic = "checkpoint.event"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func eventPayload(upload *store.Upload) map[string]any {
	return map[string]any{"type": "checkpoint.committed", "upload_id": upload.UploadID, "run_id": upload.RunID}
}

// finishUpload commits the upload and announces the checkpoint: the record, or nil while the upload is incomplete.
func finishUpload(ctx context.Context, uploadID string) (*store.Record, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	upload := store.GetUpload(ctx, uploadID)
	if upload == nil {
		return nil, nil
	}
	value, _ := json.Marshal(eventPayload(upload))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(uploadID), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return nil, err
	}
	return commit.Commit(ctx, uploadID)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"checkpoint/commit" // commit.Commit(ctx, uploadID) (*store.Record, error)
	"checkpoint/store"  // store.GetUpload, InsertOutbox, Record
)

const (
	topic      = "checkpoint.event"
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

// eventPayload is what a consumer acts on without reading the weights: the run, the step, the chunk count and the digest.
func eventPayload(record *store.Record) map[string]any {
	return map[string]any{
		"type":      "checkpoint.committed",
		"run_id":    record.RunID,
		"upload_id": record.UploadID,
		"step":      record.Step,
		"chunks":    record.Chunks,
		"digest":    record.Digest,
	}
}

// finishUpload commits the upload and announces the checkpoint: the record, or nil while the upload is incomplete.
func finishUpload(ctx context.Context, uploadID string) (*store.Record, error) {
	record, err := commit.Commit(ctx, uploadID)
	if err != nil || record == nil {
		return nil, err // nothing to announce: the upload is not complete
	}
	payload := eventPayload(record)
	value, _ := json.Marshal(payload)
	t := topic
	// Keyed by run: one run's checkpoints stay on one partition, in commit order.
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(record.RunID), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so consumers are late, not wrong.
		if err := store.InsertOutbox(ctx, topic, record.RunID, payload); err != nil {
			return nil, err
		}
	}
	return record, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import checkpoint.{Commit, Store} // Commit.commit; Store.upload, insertOutbox, Upload, Record

object Events {
  val Topic = "checkpoint.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventPayload(upload: Store.Upload): JsObject =
    JsObject("type" -> JsString("checkpoint.committed"), "upload_id" -> JsString(upload.uploadId), "run_id" -> JsString(upload.runId))

  /** Commit the upload and announce the checkpoint: the record, or None while the upload is incomplete. */
  def finishUpload(uploadId: String): Option[Store.Record] = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    Store.upload(uploadId).flatMap { upload =>
      producer.send(new ProducerRecord[String, String](Topic, uploadId, eventPayload(upload).compactPrint))
      Commit.commit(uploadId)
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

import checkpoint.{Commit, Store} // Commit.commit; Store.upload, insertOutbox, Upload, Record

object Events {
  val Topic = "checkpoint.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What a consumer acts on without reading the weights: the run, the step, the chunk count and the digest. */
  def eventPayload(record: Store.Record): JsObject =
    JsObject(
      "type" -> JsString("checkpoint.committed"),
      "run_id" -> JsString(record.runId),
      "upload_id" -> JsString(record.uploadId),
      "step" -> JsNumber(record.step),
      "chunks" -> JsNumber(record.chunks),
      "digest" -> JsString(record.digest)
    )

  /** Commit the upload and announce the checkpoint: the record, or None while the upload is incomplete. */
  def finishUpload(uploadId: String): Option[Store.Record] =
    Commit.commit(uploadId).map { record => // None: nothing to announce, the upload is not complete
      val payload = eventPayload(record)
      // Keyed by run: one run's checkpoints stay on one partition, in commit order.
      val sent = new ProducerRecord[String, String](Topic, record.runId, payload.compactPrint)
      val acked = Try(producer.send(sent).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
      // The broker did not take it: the relay publishes the row later, so consumers are late, not wrong.
      if (acked.isFailure) Store.insertOutbox(Topic, record.runId, payload)
      record
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <string>

#include "checkpoint/commit.h"  // commit::commit(upload_id) -> optional<store::Record>
#include "checkpoint/store.h"   // store::upload, insertOutbox, Upload, Record

using json = nlohmann::json;

const std::string kTopic = "checkpoint.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventPayload(const store::Upload& upload) {
  return json{{"type", "checkpoint.committed"}, {"upload_id", upload.upload_id}, {"run_id", upload.run_id}};
}

// Commit the upload and announce the checkpoint: the record, or none while the upload is incomplete.
std::optional<store::Record> finishUpload(const std::string& upload_id) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto upload = store::upload(upload_id);
  if (!upload) return std::nullopt;
  const std::string value = eventPayload(*upload).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    upload_id.c_str(), upload_id.size(), 0, nullptr);
  producer->poll(0);
  return commit::commit(upload_id);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <string>

#include "checkpoint/commit.h"  // commit::commit(upload_id) -> optional<store::Record>
#include "checkpoint/store.h"   // store::upload, insertOutbox, Upload, Record

using json = nlohmann::json;

const std::string kTopic = "checkpoint.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: finishUpload produces one record and waits for it.
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

// What a consumer acts on without reading the weights: the run, the step, the chunk count and the digest.
json eventPayload(const store::Record& record) {
  return json{{"type", "checkpoint.committed"},
              {"run_id", record.run_id},
              {"upload_id", record.upload_id},
              {"step", record.step},
              {"chunks", record.chunks},
              {"digest", record.digest}};
}

// Commit the upload and announce the checkpoint: the record, or none while the upload is incomplete.
std::optional<store::Record> finishUpload(const std::string& upload_id) {
  const auto record = commit::commit(upload_id);
  if (!record) return std::nullopt;  // nothing to announce: the upload is not complete
  const json payload = eventPayload(*record);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  // Keyed by run: one run's checkpoints stay on one partition, in commit order.
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                        record->run_id.c_str(), record->run_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so consumers are late, not wrong.
    store::insertOutbox(kTopic, record->run_id, payload);
  }
  return record;
}
`,
    },
  },
  harness: {
    python: `import json

from checkpoint import store

TOPIC = "checkpoint.event"


def _upload(run="r1", step=1200, staged=2):
    """An upload of run's checkpoint at step in 2 chunks, the first staged of them staged."""
    store.create_run(run, "t1")
    upload_id = store.open_upload(run, "t1", step, 2)["upload_id"]
    for i in range(staged):
        payload = f"{run} step {step} layer {i}".encode()
        store.put_chunk(upload_id, i, payload, store.digest(payload))
    return upload_id


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_run_key(ctx):
    m = ctx.load("events")
    for upload_id in (_upload("r1", 1200), _upload("r2", 300), _upload("r1", 1300)):
        assert m.finish_upload(upload_id) is not None, f"finish_upload({upload_id}) did not commit a complete upload"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three finished uploads produced {len(records)} records on checkpoint.event (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"r1", b"r2", b"r1"], f"the records are keyed {keys}, expected the runs r1, r2, r1"
    assert records[0].partition == records[2].partition, "both r1 checkpoints must land on one partition, or a consumer sees step 1300 before step 1200"


def check_event_payload(ctx):
    m = ctx.load("events")
    upload_id = _upload()
    m.finish_upload(upload_id)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one finished upload produced {len(records)} records"
    value = json.loads(records[0].value)
    expected = {"type": "checkpoint.committed", "run_id": "r1", "upload_id": upload_id, "step": 1200, "chunks": 2, "digest": store.manifest(upload_id)}
    assert value == expected, f"the payload is {value}, expected {expected}: a consumer needs the step, the chunk count and the digest without reading the weights"


def check_commit_before_event(ctx):
    m = ctx.load("events")
    partial = _upload(staged=1)
    assert m.finish_upload(partial) is None, "an upload with a chunk missing must not commit"
    produced = len(ctx.kafka.records(TOPIC))
    assert produced == 0, f"an upload with a chunk missing produced {produced} checkpoint.committed record(s): a consumer resumes from a checkpoint that does not exist. Commit first, then produce"
    full = _upload(step=1300)
    probe = ctx.redis_after(f"checkpoint:{full}", lambda: len(ctx.kafka.records(TOPIC)))
    assert m.finish_upload(full) is not None, "a complete upload must commit"
    assert probe.fired, f"finish_upload never wrote checkpoint:{full}"
    assert probe.result == 0, f"when checkpoint:{full} was written the topic already held {probe.result} record(s): produce after the commit"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the committed checkpoint must still be announced"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.finish_upload(_upload(step=1200))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.finish_upload(_upload(step=1300))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    first = _upload(step=1200)
    record = m.finish_upload(first)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row no consumer ever learns of the checkpoint"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "r1" and rows[0].get("payload", {}).get("upload_id") == first, f"the outbox row is {rows[0]}, expected the topic, the key r1 and the payload"
    assert record is not None and store.record(first) is not None, "the checkpoint must stay committed when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    second = _upload(step=1300)
    before = ctx.clock.time()
    m.finish_upload(second)
    waited = ctx.clock.time() - before
    assert waited <= 5, f"finish_upload waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("upload_id") == second, f"no delivery report within the window and the outbox holds {rows}"
`,
    typescript: `const TOPIC = 'checkpoint.event';

function setup(ctx) {
  const store = ctx.load('/support/checkpoint/store.ts');
  /** An upload of run's checkpoint at step in 2 chunks, the first staged of them staged. */
  const upload = async (run = 'r1', step = 1200, staged = 2): Promise<string> => {
    await store.createRun(run, 't1');
    const {upload_id} = await store.openUpload(run, 't1', step, 2);
    for (let i = 0; i < staged; i++) {
      const payload = Buffer.from(\`\${run} step \${step} layer \${i}\`);
      await store.putChunk(upload_id, i, payload, store.digest(payload));
    }
    return upload_id;
  };
  return {m: ctx.load('events'), store, upload};
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_run_key(ctx) {
  const {m, upload} = setup(ctx);
  for (const uploadId of [await upload('r1', 1200), await upload('r2', 300), await upload('r1', 1300)]) {
    assert((await m.finishUpload(uploadId)) !== null, \`finishUpload(\${uploadId}) did not commit a complete upload\`);
  }
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three finished uploads produced \${records.length} records on checkpoint.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['r1', 'r2', 'r1'], \`the records are keyed \${JSON.stringify(keys)}, expected the runs r1, r2, r1\`);
  assert.equal(records[0].partition, records[2].partition, 'both r1 checkpoints must land on one partition, or a consumer sees step 1300 before step 1200');
}

export async function check_event_payload(ctx) {
  const {m, store, upload} = setup(ctx);
  const uploadId = await upload();
  await m.finishUpload(uploadId);
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one finished upload produced \${values.length} records\`);
  const expected = {type: 'checkpoint.committed', run_id: 'r1', upload_id: uploadId, step: 1200, chunks: 2, digest: await store.manifest(uploadId)};
  assert.deepEqual(JSON.parse(values[0]), expected, \`the payload is \${values[0]}: a consumer needs the step, the chunk count and the digest without reading the weights\`);
}

export async function check_commit_before_event(ctx) {
  const {m, upload} = setup(ctx);
  const partial = await upload('r1', 1200, 1);
  assert.equal(await m.finishUpload(partial), null, 'an upload with a chunk missing must not commit');
  await settle();
  const produced = ctx.kafka.records(TOPIC).length;
  assert.equal(produced, 0, \`an upload with a chunk missing produced \${produced} checkpoint.committed record(s): a consumer resumes from a checkpoint that does not exist. Commit first, then produce\`);
  const full = await upload('r1', 1300);
  const probe = ctx.redisAfter(\`checkpoint:\${full}\`, () => ctx.kafka.records(TOPIC).length);
  assert((await m.finishUpload(full)) !== null, 'a complete upload must commit');
  await settle();
  assert(probe.fired, \`finishUpload never wrote checkpoint:\${full}\`);
  assert.equal(probe.result, 0, \`when checkpoint:\${full} was written the topic already held \${probe.result} record(s): produce after the commit\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the committed checkpoint must still be announced');
}

export async function check_acks_idempotent(ctx) {
  const {m, upload} = setup(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.finishUpload(await upload('r1', 1200));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.finishUpload(await upload('r1', 1300));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const {m, store, upload} = setup(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  const first = await upload('r1', 1200);
  const record = await m.finishUpload(first);
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row no consumer ever learns of the checkpoint\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'r1' && rows[0].payload?.upload_id === first, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key r1 and the payload\`);
  assert(record !== null && (await store.record(first)) !== null, 'the checkpoint must stay committed when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const second = await upload('r1', 1300);
  const before = ctx.clock.now();
  await m.finishUpload(second);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`finishUpload waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.upload_id === second, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"checkpoint/store"

	"leetbuild/harness"
)

const eventsTopic = "checkpoint.event"

var eventsBg = context.Background()

// eventsUpload opens an upload of run's checkpoint at step in 2 chunks and stages the first staged of them.
func eventsUpload(runID string, step int64, staged int) string {
	store.CreateRun(eventsBg, runID, "t1")
	upload := store.OpenUpload(eventsBg, runID, "t1", step, 2)
	for i := 0; i < staged; i++ {
		payload := []byte(fmt.Sprintf("%s step %d layer %d", runID, step, i))
		store.PutChunk(eventsBg, upload.UploadID, int64(i), payload, store.Digest(payload))
	}
	return upload.UploadID
}

func eventsFinish(ctx *harness.Ctx, uploadID string) *store.Record {
	record, err := finishUpload(eventsBg, uploadID)
	ctx.NoError(err, "finishUpload(%s)", uploadID)
	return record
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

func CheckRunKey(ctx *harness.Ctx) {
	for _, uploadID := range []string{eventsUpload("r1", 1200, 2), eventsUpload("r2", 300, 2), eventsUpload("r1", 1300, 2)} {
		ctx.Assert(eventsFinish(ctx, uploadID) != nil, "finishUpload(%s) did not commit a complete upload", uploadID)
	}
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three finished uploads must produce three records on checkpoint.event; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"r1", "r2", "r1"}, "the records must be keyed by the runs")
	ctx.Equal(records[0].Partition, records[2].Partition, "both r1 checkpoints must land on one partition, or a consumer sees step 1300 before step 1200; the partitions")
}

func CheckEventPayload(ctx *harness.Ctx) {
	uploadID := eventsUpload("r1", 1200, 2)
	eventsFinish(ctx, uploadID)
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one finished upload must produce one record; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	expected := map[string]any{"type": "checkpoint.committed", "run_id": "r1", "upload_id": uploadID, "step": 1200.0, "chunks": 2.0, "digest": store.Manifest(eventsBg, uploadID)}
	ctx.Equal(value, expected, "the payload (a consumer needs the step, the chunk count and the digest without reading the weights)")
}

func CheckCommitBeforeEvent(ctx *harness.Ctx) {
	partial := eventsUpload("r1", 1200, 1)
	ctx.Assert(eventsFinish(ctx, partial) == nil, "an upload with a chunk missing must not commit")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "an upload with a chunk missing must produce no checkpoint.committed record (a consumer would resume from a checkpoint that does not exist; commit first, then produce); the records")
	full := eventsUpload("r1", 1300, 2)
	probe := ctx.Redis.After("checkpoint:"+full, func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	ctx.Assert(eventsFinish(ctx, full) != nil, "a complete upload must commit")
	ctx.Settle()
	ctx.Assert(probe.Fired, "finishUpload never wrote checkpoint:%s", full)
	ctx.Equal(probe.Result, 0, "when the checkpoint record was written the topic must still be empty (produce after the commit); the records at commit time")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the committed checkpoint must still be announced; the records")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsFinish(ctx, eventsUpload("r1", 1200, 2))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsFinish(ctx, eventsUpload("r1", 1300, 2))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	first := eventsUpload("r1", 1200, 2)
	record := eventsFinish(ctx, first)
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row no consumer ever learns of the checkpoint; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "r1" && rows[0].Payload["upload_id"] == first, "the outbox row is %v, expected the topic, the key r1 and the payload", rows[0])
	ctx.Assert(record != nil && store.GetRecord(eventsBg, first) != nil, "the checkpoint must stay committed when only the produce failed")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	second := eventsUpload("r1", 1300, 2)
	before := ctx.Clock.Now()
	eventsFinish(ctx, second)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "finishUpload waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["upload_id"] == second, "no delivery report within the window and the outbox holds %v", rows)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "checkpoint/store.h"

namespace {

const std::string kEventsTopic = "checkpoint.event";

// An upload of run's checkpoint at step in 2 chunks, the first staged of them staged.
std::string eventsUpload(const std::string& run_id, long step, int staged = 2) {
  store::createRun(run_id, "t1");
  const store::Upload upload = store::openUpload(run_id, "t1", step, 2);
  for (int i = 0; i < staged; i++) {
    const std::string payload = run_id + " step " + std::to_string(step) + " layer " + std::to_string(i);
    store::putChunk(upload.upload_id, i, payload, store::digest(payload));
  }
  return upload.upload_id;
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

void CheckRunKey(harness::Ctx& ctx) {
  for (const std::string& upload_id : {eventsUpload("r1", 1200), eventsUpload("r2", 300), eventsUpload("r1", 1300)}) {
    ctx.Assert(finishUpload(upload_id).has_value(), "finishUpload(%s) did not commit a complete upload", upload_id);
  }
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three finished uploads must produce three records on checkpoint.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"r1", "r2", "r1"}, "the records must be keyed by the runs");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "both r1 checkpoints must land on one partition, or a consumer sees step 1300 before step 1200; the partitions");
}

void CheckEventPayload(harness::Ctx& ctx) {
  const std::string upload_id = eventsUpload("r1", 1200);
  finishUpload(upload_id);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one finished upload must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  const nlohmann::json expected = {{"type", "checkpoint.committed"}, {"run_id", "r1"}, {"upload_id", upload_id},
                                   {"step", 1200},                   {"chunks", 2},     {"digest", store::manifest(upload_id)}};
  ctx.Assert(value == expected, "the payload is %s, expected %s: a consumer needs the step, the chunk count and the digest without reading the weights",
             values[0], expected.dump());
}

void CheckCommitBeforeEvent(harness::Ctx& ctx) {
  const std::string partial = eventsUpload("r1", 1200, 1);
  ctx.Assert(!finishUpload(partial).has_value(), "an upload with a chunk missing must not commit");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0,
            "an upload with a chunk missing must produce no checkpoint.committed record (a consumer would resume from a checkpoint that does not exist; commit first, then produce); the records");
  const std::string full = eventsUpload("r1", 1300);
  size_t atCommit = 999;
  bool fired = false;
  ctx.Redis.After("checkpoint:" + full, [&] {
    fired = true;
    atCommit = ctx.Kafka.Records(kEventsTopic).size();
  });
  ctx.Assert(finishUpload(full).has_value(), "a complete upload must commit");
  ctx.Settle();
  ctx.Assert(fired, "finishUpload never wrote checkpoint:%s", full);
  ctx.Equal(atCommit, 0, "when the checkpoint record was written the topic must still be empty (produce after the commit); the records at commit time");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "the committed checkpoint must still be announced; the records");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  finishUpload(eventsUpload("r1", 1200));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  finishUpload(eventsUpload("r1", 1300));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  const std::string first = eventsUpload("r1", 1200);
  const auto record = finishUpload(first);
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row no consumer ever learns of the checkpoint; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == "r1" && rows[0].contains("payload") &&
                 eventsField(rows[0]["payload"], "upload_id") == first,
             "the outbox row is %s, expected the topic, the key r1 and the payload", rows[0].dump());
  ctx.Assert(record.has_value() && store::record(first).has_value(), "the checkpoint must stay committed when only the produce failed");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const std::string second = eventsUpload("r1", 1300);
  const int64_t before = ctx.Clock.Now();
  finishUpload(second);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "finishUpload waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "upload_id") == second,
             "no delivery report within the window and the outbox holds %d rows", rows.size());
}
`,
  },
  hints: [
    'A consumer applies step 1300 of run r1 and then step 1200, and once announced a checkpoint the store did not commit. After a broker restart, one committed checkpoint reached no consumer at all.',
    'Kafka orders per partition, so the key decides what stays in order. The produce runs before the commit and is not awaited, so an event can announce a refused commit, and a failed delivery is noticed by no one.',
    'Call `commit` first and return when it gives None; key by `record["run_id"]` with the step, chunks and digest in the payload; use `acks=all` with idempotence; wait for the delivery report at most 2 s and `insert_outbox` otherwise.',
  ],
  debrief: `The run id is the key because training progress is a per-run sequence: a consumer that keeps "latest step per run" needs one run's events in commit order, and Kafka only orders within a partition. Committing first makes every event describe a record that can be read back, and carrying the step, the chunk count and the digest lets a consumer decide without fetching weights. Waiting for the delivery report gives the outbox a trigger, and the idempotent producer closes the one gap waiting opens, a retry after a lost acknowledgement. Production systems usually write the outbox row in the same transaction as the record and let a relay publish every row, so the event and the commit can never disagree.`,
};
