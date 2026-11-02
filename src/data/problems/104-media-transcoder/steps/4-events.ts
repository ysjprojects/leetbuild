import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Job events keyed by job id with segment ranges',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'output'],
  task: `## Task

**Starting point.** The starter is the event path on topic \`transcode.event\`: \`publish_segment\`
and \`publish_completion\` build a small JSON object with a bare segment index and the output URL,
produce it keyed by \`worker_id\`, and \`finalize_manifest\` runs afterwards. It serves the demo and
hides five flaws.

**Failure mode the checks target.** A worker-keyed topic scrambles per-job ordering and makes the
consumer's progress counters wrong; publishing completion before the manifest is final is how a
job briefly reports done and then 404s on its own output; a permanent output URL in a retained
topic is an access leak that survives every deletion of the video behind it; and a producer with
no idempotence duplicates the record a consumer counts.

- Every event is **keyed by the job id**, so one job's events land on one partition and stay
  ordered.
- An event carries a **segment index range**, \`segment_start\`, \`segment_end\` and \`outcome\`,
  rather than a single index or a whole-file blob.
- The completion event is **published after the manifest is finalized**
  (\`finalize_manifest(job_id, manifest)\` writes the row, then the produce runs).
- Output references are **signed and short-lived** (\`SIGNED_URL_TTL_S = 900\`, an
  \`expires_at\`/\`expiresAt\`/\`ExpiresAt\` on every reference).
- The producer is **idempotent with \`acks=all\`** (\`enable.idempotence\`,
  \`idempotent: true\` + \`acks: -1\`, \`RequireAll\` + a hash balancer).`,
  sequence: {
    participants: ['Transcoder API', 'transcode.event', 'Event consumer', 'Output store'],
    messages: [
      {from: 'Transcoder API', to: 'Output store', label: 'PUT segment rendition', kind: 'sync'},
      {from: 'Output store', to: 'Transcoder API', label: 'signed reference · expires_at', kind: 'reply'},
      {
        from: 'Transcoder API',
        to: 'transcode.event',
        label: 'produce key = job_id · segment_start · segment_end · outcome',
        kind: 'sync',
      },
      {from: 'transcode.event', to: 'Event consumer', label: 'consume partition(worker ← job) in order', kind: 'async'},
      {from: 'Transcoder API', to: 'Transcoder API', label: 'finalize_manifest(job_id, manifest)', kind: 'sync'},
      {
        from: 'Transcoder API',
        to: 'transcode.event',
        label: 'produce completion — after the manifest is final',
        kind: 'sync',
      },
      {
        from: 'Event consumer',
        to: 'Event consumer',
        label: 'count completed ranges · flag failed ranges',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'job-key',
      title: 'Keyed by job id',
      detail:
        'The record key is the job id (`key=job_id`, `key: jobId`, `Key: []byte(jobID)`, `ProducerRecord(Topic, jobId, …)`), so a job’s events share a partition and keep their order. The starter keys by worker id, which interleaves every job that worker touched.',
      match: {
        python: {all: [/key=job_id/, /job_id/]},
        typescript: {all: [/key:\s*jobId/, /jobId/]},
        go: {all: [/Key:\s*\[\]byte\(jobID\)/, /job_id/]},
        scala: {all: [/ProducerRecord\(Topic,\s*jobId/, /jobId/]},
        cpp: {all: [/produce\([^;\n]*job_id/, /job_id/]},
      },
    },
    {
      id: 'ranges',
      title: 'Carries segment index ranges and an outcome',
      detail:
        'Events carry `segment_start`, `segment_end` and `outcome` instead of a whole-file blob. The starter publishes a bare segment index and a permanent URL, so the consumer cannot describe which part of the file finished.',
      match: {
        python: {all: [/segment_start/, /segment_end/, /outcome/]},
        typescript: {all: [/segmentStart/, /segmentEnd/, /outcome/]},
        go: {all: [/segment_start/, /segment_end/, /outcome/]},
        scala: {all: [/segment_start/, /segment_end/, /outcome/]},
        cpp: {all: [/segment_start/, /segment_end/, /outcome/]},
      },
    },
    {
      id: 'after-manifest',
      title: 'Completion is published after the manifest is final',
      detail:
        'The manifest is finalized before the completion event is produced. The starter produces first, so a consumer can announce a job that the read endpoint cannot describe yet.',
      match: {
        python: {order: [/finalize_manifest\(/, /producer\.produce\(/]},
        typescript: {order: [/finalizeManifest\(/, /producer\.send\(/]},
        go: {order: [/FinalizeManifest\(/, /WriteMessages\(/]},
        scala: {order: [/finalizeManifest\(/, /producer\.send\(/]},
        cpp: {order: [/finalizeManifest\(/, /produce\(/]},
      },
    },
    {
      id: 'signed-refs',
      title: 'Signed short-lived references, never permanent URLs',
      detail:
        'Output references are signed and expiring (`SIGNED_URL_TTL_S`, `sign_url`/`signUrl`, `expires_at`/`expiresAt`). The starter embeds a permanent output URL — the topic is retained and replicated, so that grant outlives the video.',
      match: {
        python: {all: [/SIGNED_URL_TTL_S/, /sign_url\(/, /expires_at/], none: [/public_url/]},
        typescript: {all: [/SIGNED_URL_TTL_S/, /signUrl\(/, /expiresAt/], none: [/publicUrl/]},
        go: {all: [/signedUrlTtlS/, /SignURL\(/, /ExpiresAt/], none: [/PublicURL/]},
        scala: {all: [/SignedUrlTtlS/, /signUrl\(/, /expires_at/], none: [/publicUrl/]},
        cpp: {all: [/kSignedUrlTtlS/, /signUrl\(/, /expires_at/], none: [/public_url/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` + `"acks": "all"`, `idempotent: true` + `acks: -1`, `RequireAll` + a hash balancer). A retried produce must not duplicate the record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("transcoder")

TOPIC = "transcode.event"
producer = Producer({"bootstrap.servers": "kafka:9092"})
manifests: dict = {}


def publish_segment(job_id: str, worker_id: str, index: int, output_url: str) -> None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    event = {"job_id": job_id, "worker_id": worker_id, "segment": index, "output_url": output_url}
    producer.produce(TOPIC, key=worker_id, value=json.dumps(event))


def publish_completion(job_id: str, worker_id: str, output_url: str) -> None:
    event = {"job_id": job_id, "state": "done", "output_url": output_url}
    producer.produce(TOPIC, key=worker_id, value=json.dumps(event))
    producer.flush()


def finalize_manifest(job_id: str, manifest: dict) -> None:
    manifests[job_id] = manifest
`,
      solution: `import json
import logging
import time

from confluent_kafka import Producer

logger = logging.getLogger("transcoder")

TOPIC = "transcode.event"
SIGNED_URL_TTL_S = 900

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
manifests: dict = {}


def sign_url(bucket: str, key: str, ttl_s: int = SIGNED_URL_TTL_S) -> dict:
    """A short-lived reference; an event may never carry permanent output access."""
    return {"bucket": bucket, "key": key, "expires_at": int(time.time()) + ttl_s}


def publish_segment_range(
    job_id: str, segment_start: int, segment_end: int, outcome: str, rendition: dict
) -> None:
    """One event per finished range, keyed by job so a job's stream stays ordered."""
    event = {
        "job_id": job_id,
        "segment_start": segment_start,
        "segment_end": segment_end,
        "outcome": outcome,
        "rendition": sign_url(rendition["bucket"], rendition["key"]),
    }
    producer.produce(TOPIC, key=job_id, value=json.dumps(event))
    producer.poll(0)


def finalize_manifest(job_id: str, manifest: dict) -> None:
    """The manifest row is the source of truth for progress; write it before announcing."""
    manifests[job_id] = manifest


def publish_completion(job_id: str, manifest: dict) -> None:
    finalize_manifest(job_id, manifest)
    event = {
        "job_id": job_id,
        "segment_start": 0,
        "segment_end": manifest["segment_count"] - 1,
        "outcome": "complete" if manifest["complete"] else "failed",
        "renditions": [sign_url(row["bucket"], row["key"]) for row in manifest["renditions"]],
        "failed_segments": manifest["failed"],
    }
    producer.produce(TOPIC, key=job_id, value=json.dumps(event))
    producer.flush()
    logger.info("completion published job=%s outcome=%s", job_id, event["outcome"])
`,
    },
    typescript: {
      starter: `/** Job events: flawed code that keys by worker and leaks a permanent URL. */
import {Kafka} from 'kafkajs';

export const TOPIC = 'transcode.event';

const producer = new Kafka({clientId: 'transcoderd', brokers: ['kafka:9092']}).producer();

export async function publishSegment(
  jobId: string,
  workerId: string,
  index: number,
  outputUrl: string,
): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const event = {job_id: jobId, worker_id: workerId, segment: index, output_url: outputUrl};
  await producer.send({topic: TOPIC, messages: [{key: workerId, value: JSON.stringify(event)}]});
}

export async function publishCompletion(jobId: string, workerId: string, outputUrl: string): Promise<void> {
  const event = {job_id: jobId, state: 'done', output_url: outputUrl};
  await producer.send({topic: TOPIC, messages: [{key: workerId, value: JSON.stringify(event)}]});
  await producer.flush();
}

export function finalizeManifest(jobId: string, manifest: unknown): void {
  manifests.set(jobId, manifest);
}

export const manifests = new Map<string, unknown>();
`,
      solution: `/** Job events: keyed by job id, ranged, signed, and published after the manifest is final. */
import {Kafka, type Producer} from 'kafkajs';

export const TOPIC = 'transcode.event';
export const SIGNED_URL_TTL_S = 900;

export const producer: Producer = new Kafka({clientId: 'transcoderd', brokers: ['kafka:9092']}).producer({
  idempotent: true,
  acks: -1,
});

export interface SignedRef {
  bucket: string;
  key: string;
  expiresAt: number;
}

export interface Manifest {
  segmentCount: number;
  complete: boolean;
  failed: number[];
  renditions: {bucket: string; key: string}[];
}

const manifests = new Map<string, Manifest>();

/** A short-lived reference; an event may never carry permanent output access. */
export function signUrl(bucket: string, key: string, ttlS: number = SIGNED_URL_TTL_S): SignedRef {
  return {bucket, key, expiresAt: Math.floor(Date.now() / 1000) + ttlS};
}

/** The manifest row is the source of truth for progress; write it before announcing. */
export function finalizeManifest(jobId: string, manifest: Manifest): void {
  manifests.set(jobId, manifest);
}

/** One event per finished range, keyed by job so a job's stream stays ordered. */
export async function publishSegmentRange(
  jobId: string,
  segmentStart: number,
  segmentEnd: number,
  outcome: string,
  rendition: {bucket: string; key: string},
): Promise<void> {
  const event = {
    job_id: jobId,
    segment_start: segmentStart,
    segment_end: segmentEnd,
    outcome,
    rendition: signUrl(rendition.bucket, rendition.key),
  };
  await producer.send({topic: TOPIC, messages: [{key: jobId, value: JSON.stringify(event)}]});
}

export async function publishCompletion(jobId: string, manifest: Manifest): Promise<void> {
  finalizeManifest(jobId, manifest);
  const event = {
    job_id: jobId,
    segment_start: 0,
    segment_end: manifest.segmentCount - 1,
    outcome: manifest.complete ? 'complete' : 'failed',
    renditions: manifest.renditions.map(row => signUrl(row.bucket, row.key)),
    failed_segments: manifest.failed,
  };
  await producer.send({topic: TOPIC, messages: [{key: jobId, value: JSON.stringify(event)}]});
  await producer.flush();
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const topic = "transcode.event"

var producer = &kafka.Writer{
	Addr:  kafka.TCP("kafka:9092"),
	Topic: topic,
}

func publishSegment(ctx context.Context, jobID, workerID string, index int, outputURL string) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	value, err := json.Marshal(map[string]any{
		"job_id":     jobID,
		"worker_id":  workerID,
		"segment":    index,
		"output_url": outputURL,
	})
	if err != nil {
		return err
	}
	return producer.WriteMessages(ctx, kafka.Message{Key: []byte(workerID), Value: value})
}

func publishCompletion(ctx context.Context, jobID, workerID, outputURL string) error {
	value, err := json.Marshal(map[string]any{"job_id": jobID, "state": "done", "output_url": outputURL})
	if err != nil {
		return err
	}
	return producer.WriteMessages(ctx, kafka.Message{Key: []byte(workerID), Value: value})
}

func FinalizeManifest(ctx context.Context, jobID string, manifest Manifest) error {
	return manifests.Put(ctx, jobID, manifest)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	topic         = "transcode.event"
	signedUrlTtlS = 900
)

var producer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type SignedRef struct {
	Bucket    string \`json:"bucket"\`
	Key       string \`json:"key"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

// SignURL returns a short-lived reference; an event may never carry permanent output access.
func SignURL(bucket, key string) SignedRef {
	return SignedRef{Bucket: bucket, Key: key, ExpiresAt: time.Now().Add(time.Duration(signedUrlTtlS) * time.Second).Unix()}
}

// FinalizeManifest is the source of truth for progress; write it before announcing anything.
func FinalizeManifest(ctx context.Context, jobID string, manifest Manifest) error {
	return manifests.Put(ctx, jobID, manifest)
}

// publishSegmentRange publishes one event per finished range, keyed by job so its stream stays ordered.
func publishSegmentRange(ctx context.Context, jobID string, segmentStart, segmentEnd int, outcome string, rendition Rendition) error {
	value, err := json.Marshal(map[string]any{
		"job_id":        jobID,
		"segment_start": segmentStart,
		"segment_end":   segmentEnd,
		"outcome":       outcome,
		"rendition":     SignURL(rendition.Bucket, rendition.Key),
	})
	if err != nil {
		return err
	}
	return producer.WriteMessages(ctx, kafka.Message{Key: []byte(jobID), Value: value})
}

func publishCompletion(ctx context.Context, jobID string, manifest Manifest) error {
	if err := FinalizeManifest(ctx, jobID, manifest); err != nil {
		return err
	}
	refs := make([]SignedRef, 0, len(manifest.Renditions))
	for _, row := range manifest.Renditions {
		refs = append(refs, SignURL(row.Bucket, row.Key))
	}
	outcome := "failed"
	if manifest.Complete {
		outcome = "complete"
	}
	value, err := json.Marshal(map[string]any{
		"job_id":          jobID,
		"segment_start":   0,
		"segment_end":     manifest.SegmentCount - 1,
		"outcome":         outcome,
		"renditions":      refs,
		"failed_segments": manifest.Failed,
	})
	if err != nil {
		return err
	}
	return producer.WriteMessages(ctx, kafka.Message{Key: []byte(jobID), Value: value})
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}

import java.util.Properties

object Events {
  val Topic = "transcode.event"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def publishSegment(jobId: String, workerId: String, index: Int, outputUrl: String): Unit = {
    val event = s"""{"job_id":"$jobId","worker_id":"$workerId","segment":$index,"output_url":"$outputUrl"}"""
    producer.send(new ProducerRecord(Topic, workerId, event))
  }

  def publishCompletion(jobId: String, workerId: String, outputUrl: String): Unit = {
    val event = s"""{"job_id":"$jobId","state":"done","output_url":"$outputUrl"}"""
    producer.send(new ProducerRecord(Topic, workerId, event))
    producer.flush()
  }

  def finalizeManifest(jobId: String, manifest: Manifest): Unit = manifests.put(jobId, manifest)
}
`,
      solution: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}

import java.time.Instant
import java.util.Properties

object Events {
  val Topic = "transcode.event"
  val SignedUrlTtlS = 900

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  val producer = new KafkaProducer[String, String](props)

  /** A short-lived reference; an event may never carry permanent output access. */
  def signUrl(bucket: String, key: String): String = {
    val expires_at = Instant.now().getEpochSecond + SignedUrlTtlS
    s"""{"bucket":"$bucket","key":"$key","expires_at":$expires_at}"""
  }

  /** The manifest row is the source of truth for progress; write it before announcing. */
  def finalizeManifest(jobId: String, manifest: Manifest): Unit = manifests.put(jobId, manifest)

  /** One event per finished range, keyed by job so a job's stream stays ordered. */
  def publishSegmentRange(
      jobId: String,
      segmentStart: Int,
      segmentEnd: Int,
      outcome: String,
      bucket: String,
      key: String
  ): Unit = {
    val rendition = signUrl(bucket, key)
    val event =
      s"""{"job_id":"$jobId","segment_start":$segmentStart,"segment_end":$segmentEnd,"outcome":"$outcome","rendition":$rendition}"""
    producer.send(new ProducerRecord(Topic, jobId, event))
  }

  def publishCompletion(jobId: String, manifest: Manifest): Unit = {
    finalizeManifest(jobId, manifest)
    val last = manifest.segmentCount - 1
    val outcome = if (manifest.complete) "complete" else "failed"
    val refs = manifest.renditions.map(row => signUrl(row.bucket, row.key)).mkString(",")
    val failed = manifest.failed.mkString("[", ",", "]")
    val event =
      s"""{"job_id":"$jobId","segment_start":0,"segment_end":$last,"outcome":"$outcome","renditions":[$refs],"failed_segments":$failed}"""
    producer.send(new ProducerRecord(Topic, jobId, event))
    producer.flush()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <map>
#include <memory>
#include <string>

const char* kTopic = "transcode.event";

class EventProducer {
 public:
  EventProducer() {
    std::string errstr;
    RdKafka::Conf* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
    conf->set("bootstrap.servers", "kafka:9092", errstr);
    producer_.reset(RdKafka::Producer::create(conf, errstr));
    delete conf;
  }

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  void publishSegment(const std::string& job_id, const std::string& worker_id, int index,
                      const std::string& output_url) {
    const std::string event = "{\\"job_id\\":\\"" + job_id + "\\",\\"worker_id\\":\\"" + worker_id +
                              "\\",\\"segment\\":" + std::to_string(index) + ",\\"output_url\\":\\"" + output_url + "\\"}";
    send(worker_id, event);
  }

  void publishCompletion(const std::string& job_id, const std::string& worker_id, const std::string& output_url) {
    const std::string event = "{\\"job_id\\":\\"" + job_id + "\\",\\"state\\":\\"done\\",\\"output_url\\":\\"" +
                              output_url + "\\"}";
    send(worker_id, event);
    commitManifest(job_id);
    producer_->flush(5000);
  }

 private:
  void send(const std::string& key, const std::string& value) {
    producer_->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                       const_cast<char*>(value.data()), value.size(), key.data(), key.size(), 0, nullptr);
  }

  void commitManifest(const std::string& job_id) { manifests_[job_id] = pending_; }

  std::unique_ptr<RdKafka::Producer> producer_;
  std::map<std::string, Manifest> manifests_;
  Manifest pending_;
};
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <ctime>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace {

constexpr int kSignedUrlTtlS = 900;
const char* kTopic = "transcode.event";

}  // namespace

class EventProducer {
 public:
  EventProducer() {
    std::string errstr;
    RdKafka::Conf* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
    conf->set("bootstrap.servers", "kafka:9092", errstr);
    conf->set("enable.idempotence", "true", errstr);
    conf->set("acks", "all", errstr);
    producer_.reset(RdKafka::Producer::create(conf, errstr));
    delete conf;
  }

  /** A short-lived reference; an event may never carry permanent output access. */
  std::string signUrl(const std::string& bucket, const std::string& key) const {
    const auto expires_at = std::time(nullptr) + kSignedUrlTtlS;
    return "{\\"bucket\\":\\"" + bucket + "\\",\\"key\\":\\"" + key +
           "\\",\\"expires_at\\":" + std::to_string(expires_at) + "}";
  }

  /** The manifest row is the source of truth for progress; write it before announcing. */
  void finalizeManifest(const std::string& job_id, const Manifest& manifest) { manifests_[job_id] = manifest; }

  /** One event per finished range, keyed by job so a job's stream stays ordered. */
  void publishSegmentRange(const std::string& job_id, int segment_start, int segment_end, const std::string& outcome,
                           const std::string& bucket, const std::string& key) {
    const std::string event = "{\\"job_id\\":\\"" + job_id + "\\",\\"segment_start\\":" + std::to_string(segment_start) +
                              ",\\"segment_end\\":" + std::to_string(segment_end) + ",\\"outcome\\":\\"" + outcome +
                              "\\",\\"rendition\\":" + signUrl(bucket, key) + "}";
    produce(job_id, event);
  }

  void publishCompletion(const std::string& job_id, const Manifest& manifest) {
    finalizeManifest(job_id, manifest);
    const std::string outcome = manifest.complete ? "complete" : "failed";
    std::string refs;
    for (const auto& row : manifest.renditions) {
      if (!refs.empty()) refs += ",";
      refs += signUrl(row.bucket, row.key);
    }
    std::string failed;
    for (int index : manifest.failed) {
      if (!failed.empty()) failed += ",";
      failed += std::to_string(index);
    }
    const std::string event = "{\\"job_id\\":\\"" + job_id + "\\",\\"segment_start\\":0,\\"segment_end\\":" +
                              std::to_string(manifest.segmentCount - 1) + ",\\"outcome\\":\\"" + outcome +
                              "\\",\\"renditions\\":[" + refs + "],\\"failed_segments\\":[" + failed + "]}";
    produce(job_id, event);
    producer_->flush(5000);
  }

 private:
  void produce(const std::string& key, const std::string& value) {
    producer_->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                       const_cast<char*>(value.data()), value.size(), key.data(), key.size(), 0, nullptr);
  }

  std::unique_ptr<RdKafka::Producer> producer_;
  std::map<std::string, Manifest> manifests_;
};
`,
    },
  },
  hints: [
    'The customer dashboard shows progress going backwards, a job flashes "done" and then its output 404s, and a security audit finds last year\'s renditions still reachable through URLs sitting in the topic.',
    'Both produces use `key=worker_id`, so one job spreads across partitions; `publish_completion` runs before `finalize_manifest`; the payload carries a bare `segment` and the raw `output_url`; the producer has no config.',
    'Key by `job_id`, send `segment_start`/`segment_end`/`outcome`, call `finalize_manifest` before the completion produce, replace the URL with `sign_url` plus `expires_at`, and configure `enable.idempotence` with `acks=all`.',
  ],
  debrief: `The fix treats the topic as a contract with consumers you do not own. The key is the ordering guarantee: Kafka orders within a partition only, so one job's events must share one. Publish-after-manifest is a write ordering rule: the row a reader will fetch has to exist before the announcement that it exists. Ranges let a consumer keep its own counters without calling the API, and the signed reference with \`expires_at\` means the retained, replicated log holds a grant that dies in fifteen minutes rather than outliving the video. Idempotence with \`acks=all\` closes the last gap, a broker retry that would double-count a segment. What this step did not do: a production topic carries a registered schema with a compatibility policy, so adding \`outcome\` cannot break a consumer deployed last month.`,
};
