import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Kafka transcode.event: job-keyed, completion after the job is final, signed references',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'output'],
  task: `## Task

**Starting point.** The starter produces the \`transcode.event\` stream the progress consumer reads:
\`publish_segments(job, worker_id, start, end, outcome)\` produces one record for the segment
range \`[start, end)\`, and \`complete_job(job, worker_id, manifest)\` produces a
\`transcode.completed\` record whose renditions carry the output's storage URL, then calls
\`jobs.finalize_job\`. Both records are keyed by \`worker_id\` and the producer runs with
\`acks=1\`. A finished job shows up on the topic, and the starter hides five flaws.

**Failure mode the checks target.** One job's events land on several partitions and the consumer's
progress goes backwards; a job with a missing segment is announced as complete; a reader fetches
the job the event announced and finds it still queued; a URL that never expires sits in a
retained topic; and a lost acknowledgement doubles a record the consumer counts.

- Every record is keyed by the **job id**.
- \`complete_job\` answers \`None\` and produces nothing while \`manifest["missing"]\` is not empty.
- It calls \`jobs.finalize_job\` first and produces after it.
- Each rendition carries \`urls.sign(bucket, key, expires_at)\` and \`expires_at\` = now +
  \`urls.SIGNED_URL_TTL_S\` (900 s).
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent\`; kafka-go has no idempotent
  producer, so Go uses \`RequireAll\` and the consumer deduplicates).`,
  sequence: {
    participants: ['Worker', 'job store', 'transcode.event', 'Progress consumer'],
    messages: [
      {from: 'Worker', to: 'transcode.event', label: 'segments [0, 4) done · key = job id', kind: 'sync'},
      {from: 'Worker', to: 'Worker', label: 'manifest: missing = [] ?', kind: 'sync'},
      {from: 'Worker', to: 'job store', label: 'finalize_job(job, renditions)', kind: 'sync'},
      {from: 'Worker', to: 'transcode.event', label: 'transcode.completed · signed URL · expires_at', kind: 'sync'},
      {from: 'transcode.event', to: 'Worker', label: 'ack (acks=all, idempotent retry)', kind: 'reply'},
      {from: 'transcode.event', to: 'Progress consumer', label: 'one partition per job, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'job-key',
      title: 'Every record is keyed by the job id',
      detail:
        "The record key is the job id, so one job's events land on one partition and stay ordered; the starter keys by the worker, which scatters a job across partitions.",
      match: {
        python: {all: [/key=job\[["']job_id["']\]/, /transcode\.event/], none: [/key=worker_id/]},
        typescript: {all: [/key:\s*job\.job_id/, /transcode\.event/], none: [/key:\s*workerId/]},
        go: {all: [/Key:\s*\[\]byte\(job\.JobID\)/, /transcode\.event/], none: [/Key:\s*\[\]byte\(workerID\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(EventTopic,\s*job\.jobId/, /transcode\.event/],
          none: [/EventTopic,\s*workerId/],
        },
        cpp: {
          all: [/job\.job_id\.c_str\(\),\s*job\.job_id\.size\(\)/, /transcode\.event/],
          none: [/worker_id\.c_str\(\)/],
        },
      },
    },
    {
      id: 'gapless-complete',
      title: 'A job with a missing segment is not announced',
      detail:
        '`complete_job` answers nothing, finalizes nothing and produces nothing while the manifest lists a missing index; the starter announces whatever it is handed.',
      match: {
        python: {all: [/if manifest\[["']missing["']\]|not manifest\[["']complete["']\]/]},
        typescript: {all: [/manifest\.missing\.length|!manifest\.complete/]},
        go: {all: [/len\(manifest\.Missing\)|!manifest\.Complete/]},
        scala: {all: [/manifest\.missing\.nonEmpty|!manifest\.complete/]},
        cpp: {all: [/!manifest\.missing\.empty\(\)|!manifest\.complete/]},
      },
    },
    {
      id: 'after-manifest',
      title: 'The completion is produced after the job is finalized',
      detail:
        '`complete_job` calls `finalize_job` and produces only afterwards, so a consumer that reads the job the event announced finds it done; the starter produces first.',
      match: {
        python: {order: [/def complete_job/, /jobs\.finalize_job\(/, /producer\.produce\(/]},
        typescript: {order: [/function completeJob/, /\bfinalizeJob\(/, /producer\.send\(/]},
        go: {order: [/func completeJob/, /jobs\.FinalizeJob\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/def completeJob/, /Jobs\.finalizeJob\(/, /producer\.send\(/]},
        cpp: {order: [/completeJob\(/, /jobs::finalizeJob\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'signed-refs',
      title: 'Renditions carry signed, expiring references',
      detail:
        'Each rendition carries `sign(bucket, key, expires_at)` and `expires_at` = now + `SIGNED_URL_TTL_S`; a plain storage URL in a retained topic grants access long after the video is deleted.',
      match: {
        python: {all: [/urls\.sign\(/, /urls\.SIGNED_URL_TTL_S/, /expires_at/], none: [/storage\.example/]},
        typescript: {all: [/\bsign\(/, /SIGNED_URL_TTL_S/, /expires_at/], none: [/storage\.example/]},
        go: {all: [/urls\.Sign\(/, /urls\.SignedURLTTL/, /expires_at/], none: [/storage\.example/]},
        scala: {all: [/Urls\.sign\(/, /Urls\.SignedUrlTtlSeconds/, /expires_at/], none: [/storage\.example/]},
        cpp: {all: [/urls::sign\(/, /urls::kSignedUrlTtlS/, /expires_at/], none: [/storage\.example/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the record once and a leader failover loses nothing; kafka-go has no idempotent producer, so its writer uses `RequireAll`.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from transcoder import jobs  # jobs.output_key, jobs.finalize_job
from transcoder import urls  # urls.sign(bucket, key, expires_at), urls.SIGNED_URL_TTL_S

EVENT_TOPIC = "transcode.event"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.error("transcode event not delivered: %s", err)


def publish_segments(job: dict, worker_id: str, start: int, end: int, outcome: str) -> dict:
    """One record for the segments [start, end) of the job, which ended with outcome ("done" or "failed")."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = {"type": "transcode.segments", "job_id": job["job_id"], "segment_start": start, "segment_end": end, "outcome": outcome, "worker": worker_id}
    producer.produce(EVENT_TOPIC, key=worker_id, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload


def complete_job(job: dict, worker_id: str, manifest: dict) -> dict | None:
    """Finalize the job with its rendition and announce it; None when the job is not complete."""
    key = jobs.output_key(job)
    rendition = {"preset": job["preset"], "duration_s": job["duration_s"], "url": f"https://{job['output_bucket']}.storage.example/{key}"}
    payload = {"type": "transcode.completed", "job_id": job["job_id"], "segment_count": job["segment_count"], "renditions": [rendition], "worker": worker_id}
    producer.produce(EVENT_TOPIC, key=worker_id, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    jobs.finalize_job(job["job_id"], [{"preset": job["preset"], "key": key, "duration_s": job["duration_s"]}])
    return payload
`,
      solution: `import json
import logging
import time

from confluent_kafka import Producer

from transcoder import jobs  # jobs.output_key, jobs.finalize_job
from transcoder import urls  # urls.sign(bucket, key, expires_at), urls.SIGNED_URL_TTL_S

EVENT_TOPIC = "transcode.event"
log = logging.getLogger("events")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.error("transcode event not delivered: %s", err)


def publish_segments(job: dict, worker_id: str, start: int, end: int, outcome: str) -> dict:
    """One record for the segments [start, end) of the job, which ended with outcome ("done" or "failed")."""
    payload = {"type": "transcode.segments", "job_id": job["job_id"], "segment_start": start, "segment_end": end, "outcome": outcome, "worker": worker_id}
    producer.produce(EVENT_TOPIC, key=job["job_id"], value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload


def complete_job(job: dict, worker_id: str, manifest: dict) -> dict | None:
    """Finalize the job with its rendition and announce it; None when the job is not complete."""
    if manifest["missing"]:
        return None  # a video with a hole is not finished
    key = jobs.output_key(job)
    # The job row is final before anyone hears about it.
    jobs.finalize_job(job["job_id"], [{"preset": job["preset"], "key": key, "duration_s": job["duration_s"]}])
    expires_at = int(time.time()) + urls.SIGNED_URL_TTL_S
    rendition = {"preset": job["preset"], "duration_s": job["duration_s"], "url": urls.sign(job["output_bucket"], key, expires_at), "expires_at": expires_at}
    payload = {"type": "transcode.completed", "job_id": job["job_id"], "segment_count": job["segment_count"], "renditions": [rendition], "worker": worker_id}
    producer.produce(EVENT_TOPIC, key=job["job_id"], value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Job, finalizeJob, outputKey} from 'transcoder/jobs';
import type {Coverage} from 'transcoder/segments';
import {SIGNED_URL_TTL_S, sign} from 'transcoder/urls';

export const EVENT_TOPIC = 'transcode.event';

const kafka = new Kafka({clientId: 'transcoderd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One record for the segments [start, end) of the job, which ended with outcome ("done" or "failed"). */
export async function publishSegments(job: Job, workerId: string, start: number, end: number, outcome: string): Promise<Record<string, unknown>> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = {type: 'transcode.segments', job_id: job.job_id, segment_start: start, segment_end: end, outcome, worker: workerId};
  await producer.send({topic: EVENT_TOPIC, messages: [{key: workerId, value: JSON.stringify(payload)}], acks: 1});
  return payload;
}

/** Finalize the job with its rendition and announce it; null when the job is not complete. */
export async function completeJob(job: Job, workerId: string, manifest: Coverage): Promise<Record<string, unknown> | null> {
  const key = outputKey(job);
  const rendition = {preset: job.preset, duration_s: job.duration_s, url: \`https://\${job.output_bucket}.storage.example/\${key}\`};
  const payload = {type: 'transcode.completed', job_id: job.job_id, segment_count: job.segment_count, renditions: [rendition], worker: workerId};
  await producer.send({topic: EVENT_TOPIC, messages: [{key: workerId, value: JSON.stringify(payload)}], acks: 1});
  await finalizeJob(job.job_id, [{preset: job.preset, key, duration_s: job.duration_s}]);
  return payload;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Job, finalizeJob, outputKey} from 'transcoder/jobs';
import type {Coverage} from 'transcoder/segments';
import {SIGNED_URL_TTL_S, sign} from 'transcoder/urls';

export const EVENT_TOPIC = 'transcode.event';

const kafka = new Kafka({clientId: 'transcoderd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the record once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One record for the segments [start, end) of the job, which ended with outcome ("done" or "failed"). */
export async function publishSegments(job: Job, workerId: string, start: number, end: number, outcome: string): Promise<Record<string, unknown>> {
  const payload = {type: 'transcode.segments', job_id: job.job_id, segment_start: start, segment_end: end, outcome, worker: workerId};
  await producer.send({topic: EVENT_TOPIC, messages: [{key: job.job_id, value: JSON.stringify(payload)}], acks: -1});
  return payload;
}

/** Finalize the job with its rendition and announce it; null when the job is not complete. */
export async function completeJob(job: Job, workerId: string, manifest: Coverage): Promise<Record<string, unknown> | null> {
  if (manifest.missing.length > 0) return null; // a video with a hole is not finished
  const key = outputKey(job);
  // The job row is final before anyone hears about it.
  await finalizeJob(job.job_id, [{preset: job.preset, key, duration_s: job.duration_s}]);
  const expires_at = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
  const rendition = {preset: job.preset, duration_s: job.duration_s, url: sign(job.output_bucket, key, expires_at), expires_at};
  const payload = {type: 'transcode.completed', job_id: job.job_id, segment_count: job.segment_count, renditions: [rendition], worker: workerId};
  await producer.send({topic: EVENT_TOPIC, messages: [{key: job.job_id, value: JSON.stringify(payload)}], acks: -1});
  return payload;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"

	"transcoder/jobs"     // jobs.Job, jobs.OutputKey, jobs.FinalizeJob
	"transcoder/segments" // segments.Coverage; urls.Sign and urls.SignedURLTTL live in "transcoder/urls"
)

const eventTopic = "transcode.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// publishSegments produces one record for the segments [start, end) of the job, which ended with
// outcome ("done" or "failed").
func publishSegments(ctx context.Context, job *jobs.Job, workerID string, start, end int, outcome string) (map[string]any, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	payload := map[string]any{"type": "transcode.segments", "job_id": job.JobID, "segment_start": start, "segment_end": end, "outcome": outcome, "worker": workerID}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(workerID), Value: value}); err != nil {
		return nil, err
	}
	return payload, nil
}

// completeJob finalizes the job with its rendition and announces it; nil when the job is not complete.
func completeJob(ctx context.Context, job *jobs.Job, workerID string, manifest segments.Coverage) (map[string]any, error) {
	key := jobs.OutputKey(job)
	rendition := map[string]any{"preset": job.Preset, "duration_s": job.DurationS, "url": "https://" + job.OutputBucket + ".storage.example/" + key}
	payload := map[string]any{"type": "transcode.completed", "job_id": job.JobID, "segment_count": job.SegmentCount, "renditions": []any{rendition}, "worker": workerID}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(workerID), Value: value}); err != nil {
		return nil, err
	}
	jobs.FinalizeJob(ctx, job.JobID, []jobs.Rendition{{Preset: job.Preset, Key: key, DurationS: job.DurationS}})
	return payload, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"

	"transcoder/jobs"     // jobs.Job, jobs.OutputKey, jobs.FinalizeJob
	"transcoder/segments" // segments.Coverage
	"transcoder/urls"     // urls.Sign(bucket, key, expiresAt), urls.SignedURLTTL
)

const eventTopic = "transcode.event"

// RequireAll: the record is on every replica before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate; the consumer deduplicates by
// (job_id, type, segment_start).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// publishSegments produces one record for the segments [start, end) of the job, which ended with
// outcome ("done" or "failed").
func publishSegments(ctx context.Context, job *jobs.Job, workerID string, start, end int, outcome string) (map[string]any, error) {
	payload := map[string]any{"type": "transcode.segments", "job_id": job.JobID, "segment_start": start, "segment_end": end, "outcome": outcome, "worker": workerID}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(job.JobID), Value: value}); err != nil {
		return nil, err
	}
	return payload, nil
}

// completeJob finalizes the job with its rendition and announces it; nil when the job is not complete.
func completeJob(ctx context.Context, job *jobs.Job, workerID string, manifest segments.Coverage) (map[string]any, error) {
	if len(manifest.Missing) > 0 {
		return nil, nil // a video with a hole is not finished
	}
	key := jobs.OutputKey(job)
	// The job row is final before anyone hears about it.
	jobs.FinalizeJob(ctx, job.JobID, []jobs.Rendition{{Preset: job.Preset, Key: key, DurationS: job.DurationS}})
	expiresAt := time.Now().Unix() + urls.SignedURLTTL
	rendition := map[string]any{"preset": job.Preset, "duration_s": job.DurationS, "url": urls.Sign(job.OutputBucket, key, expiresAt), "expires_at": expiresAt}
	payload := map[string]any{"type": "transcode.completed", "job_id": job.JobID, "segment_count": job.SegmentCount, "renditions": []any{rendition}, "worker": workerID}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(job.JobID), Value: value}); err != nil {
		return nil, err
	}
	return payload, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import transcoder.{Jobs, Segments, Urls} // Jobs.outputKey, Jobs.finalizeJob, Segments.Coverage, Urls.sign, Urls.SignedUrlTtlSeconds

object Events {
  val EventTopic = "transcode.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"transcode event not delivered: \${exception.getMessage}")
  }

  /** One record for the segments [start, end) of the job, which ended with outcome ("done" or "failed"). */
  def publishSegments(job: Jobs.Job, workerId: String, start: Int, end: Int, outcome: String): JsObject = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = JsObject("type" -> JsString("transcode.segments"), "job_id" -> JsString(job.jobId), "segment_start" -> JsNumber(start),
      "segment_end" -> JsNumber(end), "outcome" -> JsString(outcome), "worker" -> JsString(workerId))
    producer.send(new ProducerRecord[String, String](EventTopic, workerId, payload.compactPrint), onDelivery).get()
    payload
  }

  /** Finalize the job with its rendition and announce it; None when the job is not complete. */
  def completeJob(job: Jobs.Job, workerId: String, manifest: Segments.Coverage): Option[JsObject] = {
    val key = Jobs.outputKey(job)
    val rendition = JsObject("preset" -> JsString(job.preset), "duration_s" -> JsNumber(job.durationS),
      "url" -> JsString(s"https://\${job.outputBucket}.storage.example/$key"))
    val payload = JsObject("type" -> JsString("transcode.completed"), "job_id" -> JsString(job.jobId), "segment_count" -> JsNumber(job.segmentCount),
      "renditions" -> JsArray(rendition), "worker" -> JsString(workerId))
    producer.send(new ProducerRecord[String, String](EventTopic, workerId, payload.compactPrint), onDelivery).get()
    Jobs.finalizeJob(job.jobId, Seq(Jobs.Rendition(job.preset, key, job.durationS)))
    Some(payload)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import transcoder.{Jobs, Segments, Urls} // Jobs.outputKey, Jobs.finalizeJob, Segments.Coverage, Urls.sign, Urls.SignedUrlTtlSeconds

object Events {
  val EventTopic = "transcode.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"transcode event not delivered: \${exception.getMessage}")
  }

  /** One record for the segments [start, end) of the job, which ended with outcome ("done" or "failed"). */
  def publishSegments(job: Jobs.Job, workerId: String, start: Int, end: Int, outcome: String): JsObject = {
    val payload = JsObject("type" -> JsString("transcode.segments"), "job_id" -> JsString(job.jobId), "segment_start" -> JsNumber(start),
      "segment_end" -> JsNumber(end), "outcome" -> JsString(outcome), "worker" -> JsString(workerId))
    producer.send(new ProducerRecord[String, String](EventTopic, job.jobId, payload.compactPrint), onDelivery).get()
    payload
  }

  /** Finalize the job with its rendition and announce it; None when the job is not complete. */
  def completeJob(job: Jobs.Job, workerId: String, manifest: Segments.Coverage): Option[JsObject] =
    if (manifest.missing.nonEmpty) None // a video with a hole is not finished
    else {
      val key = Jobs.outputKey(job)
      // The job row is final before anyone hears about it.
      Jobs.finalizeJob(job.jobId, Seq(Jobs.Rendition(job.preset, key, job.durationS)))
      val expiresAt = System.currentTimeMillis() / 1000 + Urls.SignedUrlTtlSeconds
      val rendition = JsObject("preset" -> JsString(job.preset), "duration_s" -> JsNumber(job.durationS),
        "url" -> JsString(Urls.sign(job.outputBucket, key, expiresAt)), "expires_at" -> JsNumber(expiresAt))
      val payload = JsObject("type" -> JsString("transcode.completed"), "job_id" -> JsString(job.jobId), "segment_count" -> JsNumber(job.segmentCount),
        "renditions" -> JsArray(rendition), "worker" -> JsString(workerId))
      producer.send(new ProducerRecord[String, String](EventTopic, job.jobId, payload.compactPrint), onDelivery).get()
      Some(payload)
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "transcoder/jobs.h"      // jobs::Job, jobs::outputKey, jobs::finalizeJob
#include "transcoder/segments.h"  // segments::Coverage
#include "transcoder/urls.h"      // urls::sign(bucket, key, expires_at), urls::kSignedUrlTtlS

using json = nlohmann::json;

const std::string kEventTopic = "transcode.event";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "transcode event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One record for the segments [start, end) of the job, which ended with outcome ("done" or "failed").
json publishSegments(const jobs::Job& job, const std::string& worker_id, int start, int end, const std::string& outcome) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const json payload = {{"type", "transcode.segments"}, {"job_id", job.job_id}, {"segment_start", start}, {"segment_end", end}, {"outcome", outcome}, {"worker", worker_id}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    worker_id.c_str(), worker_id.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}

// Finalize the job with its rendition and announce it; none when the job is not complete.
std::optional<json> completeJob(const jobs::Job& job, const std::string& worker_id, const segments::Coverage& manifest) {
  const std::string key = jobs::outputKey(job);
  const json rendition = {{"preset", job.preset}, {"duration_s", job.duration_s}, {"url", "https://" + job.output_bucket + ".storage.example/" + key}};
  const json payload = {{"type", "transcode.completed"}, {"job_id", job.job_id}, {"segment_count", job.segment_count}, {"renditions", json::array({rendition})}, {"worker", worker_id}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    worker_id.c_str(), worker_id.size(), 0, nullptr);
  producer->flush(2000);
  jobs::finalizeJob(job.job_id, {{job.preset, key, job.duration_s}});
  return payload;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "transcoder/jobs.h"      // jobs::Job, jobs::outputKey, jobs::finalizeJob
#include "transcoder/segments.h"  // segments::Coverage
#include "transcoder/urls.h"      // urls::sign(bucket, key, expires_at), urls::kSignedUrlTtlS

using json = nlohmann::json;

const std::string kEventTopic = "transcode.event";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "transcode event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One record for the segments [start, end) of the job, which ended with outcome ("done" or "failed").
json publishSegments(const jobs::Job& job, const std::string& worker_id, int start, int end, const std::string& outcome) {
  const json payload = {{"type", "transcode.segments"}, {"job_id", job.job_id}, {"segment_start", start}, {"segment_end", end}, {"outcome", outcome}, {"worker", worker_id}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    job.job_id.c_str(), job.job_id.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}

// Finalize the job with its rendition and announce it; none when the job is not complete.
std::optional<json> completeJob(const jobs::Job& job, const std::string& worker_id, const segments::Coverage& manifest) {
  if (!manifest.missing.empty()) return std::nullopt;  // a video with a hole is not finished
  const std::string key = jobs::outputKey(job);
  // The job row is final before anyone hears about it.
  jobs::finalizeJob(job.job_id, {{job.preset, key, job.duration_s}});
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long expires_at = now + urls::kSignedUrlTtlS;
  const json rendition = {{"preset", job.preset}, {"duration_s", job.duration_s}, {"url", urls::sign(job.output_bucket, key, expires_at)}, {"expires_at", expires_at}};
  const json payload = {{"type", "transcode.completed"}, {"job_id", job.job_id}, {"segment_count", job.segment_count}, {"renditions", json::array({rendition})}, {"worker", worker_id}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    job.job_id.c_str(), job.job_id.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}
`,
    },
  },
  harness: {
    python: `import json

from transcoder import jobs, presets, urls

TOPIC = "transcode.event"


def _job(ctx):
    return jobs.create("t-1", "s3://uploads/talk.mov", "9f" * 32, 18.0, "h264-720p", presets.encoder_args("h264-720p"), "renditions", "talks/42")


def _manifest(n, missing=()):
    return {"segment_count": n, "done": [i for i in range(n) if i not in missing], "missing": list(missing), "complete": not missing}


def _payloads(ctx):
    out = []
    for record in ctx.kafka.records(TOPIC):
        try:
            out.append(json.loads(record.value))
        except Exception as exc:
            raise AssertionError(f"a record's value is not JSON: {record.value!r} ({exc})")
    return out


def check_job_key(ctx):
    m = ctx.load("events")
    job = _job(ctx)
    m.publish_segments(job, "w-1", 0, 2, "done")
    m.publish_segments(job, "w-2", 2, 3, "done")
    assert m.complete_job(job, "w-2", _manifest(3)) is not None, "a job whose three segments are done must be completed"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three events produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [job["job_id"].encode()] * 3, f"records must be keyed by the job id {job['job_id']}, got {keys}: keyed by the worker, one job's events scatter across partitions"
    assert len({r.partition for r in records}) == 1, f"{job['job_id']}'s events landed on partitions {sorted({r.partition for r in records})}: one job's history must stay on one partition, in order"
    first = _payloads(ctx)[0]
    assert first.get("segment_start") == 0 and first.get("segment_end") == 2 and first.get("outcome") == "done", f"the first event must carry the range [0, 2) and its outcome, got {first}"


def check_gapless_complete(ctx):
    m = ctx.load("events")
    job = _job(ctx)
    got = m.complete_job(job, "w-1", _manifest(3, missing=[2]))
    assert got is None, f"complete_job announced a job whose segment 2 is missing: {got}"
    assert ctx.kafka.records(TOPIC) == [], f"a completion was produced for a job with a hole: {ctx.kafka.records(TOPIC)}"
    assert jobs.get(job["job_id"])["state"] == "queued", "a job with segment 2 missing was finalized as done"
    assert m.complete_job(job, "w-1", _manifest(3)) is not None, "once every segment is done the job must be completed"
    assert jobs.get(job["job_id"])["state"] == "done", "the completed job must be finalized"


def check_after_manifest(ctx):
    m = ctx.load("events")
    job = _job(ctx)
    # The moment the job row is written, what is already on the topic.
    at_final = ctx.redis_after(f"job:{job['job_id']}", lambda: len(ctx.kafka.records(TOPIC)))
    m.complete_job(job, "w-1", _manifest(3))
    assert at_final.fired, "complete_job never finalized the job"
    assert at_final.result == 0, f"when the job was finalized the topic already held {at_final.result} record(s): a consumer reading the announced job found it still queued. Finalize, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"one completion left {len(ctx.kafka.records(TOPIC))} records"
    final = jobs.get(job["job_id"])
    want = [{"preset": "h264-720p", "key": "talks/42/h264-720p/index.m3u8", "duration_s": 18.0}]
    assert final["state"] == "done" and final["renditions"] == want, f"the finalized job holds {final['state']} {final['renditions']}, expected done {want}"


def check_signed_refs(ctx):
    m = ctx.load("events")
    job = _job(ctx)
    event = m.complete_job(job, "w-1", _manifest(3))
    expires = int(ctx.clock.time()) + 900
    rendition = (event or {}).get("renditions", [{}])[0]
    assert rendition.get("expires_at") == expires, f"the rendition carries expires_at {rendition.get('expires_at')!r}, expected now + SIGNED_URL_TTL_S = {expires}"
    want = urls.sign("renditions", jobs.output_key(job), expires)
    assert rendition.get("url") == want, f"the rendition's URL is {rendition.get('url')!r}: a plain storage URL in a retained topic never expires. Expected urls.sign(bucket, key, expires_at) = {want!r}"
    assert _payloads(ctx)[-1] == event, "the record on the topic must be the event complete_job returned"


def check_idempotent_acks(ctx):
    m = ctx.load("events")
    job = _job(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    m.publish_segments(job, "w-1", 0, 2, "done")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one event whose acknowledgement was lost left {len(records)} records: the producer's retry wrote it twice and the consumer counts segments twice. Enable idempotence (with acks=all)"
    m.publish_segments(job, "w-1", 2, 3, "done")
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the second event and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'transcode.event';

async function setup(ctx) {
  const jobs = ctx.load('/support/transcoder/jobs.ts');
  const presets = ctx.load('/support/transcoder/presets.ts');
  const urls = ctx.load('/support/transcoder/urls.ts');
  const job = await jobs.create('t-1', 's3://uploads/talk.mov', '9f'.repeat(32), 18, 'h264-720p', presets.encoderArgs('h264-720p'), 'renditions', 'talks/42');
  return {m: ctx.load('events'), jobs, urls, job};
}

const manifest = (n: number, missing: number[] = []) => ({
  segment_count: n,
  done: Array.from({length: n}, (_, i) => i).filter(i => !missing.includes(i)),
  missing,
  complete: missing.length === 0,
});

function payloads(ctx) {
  return ctx.kafka.records(TOPIC).map(r => {
    try {
      return JSON.parse(r.value.toString());
    } catch (e) {
      assert.fail(\`a record's value is not JSON: \${r.value} (\${e})\`);
    }
  });
}

export async function check_job_key(ctx) {
  const {m, job} = await setup(ctx);
  await m.publishSegments(job, 'w-1', 0, 2, 'done');
  await m.publishSegments(job, 'w-2', 2, 3, 'done');
  assert((await m.completeJob(job, 'w-2', manifest(3))) !== null, 'a job whose three segments are done must be completed');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three events produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, [job.job_id, job.job_id, job.job_id], \`records must be keyed by the job id \${job.job_id}, got \${JSON.stringify(keys)}: keyed by the worker, one job's events scatter across partitions\`);
  assert.equal(new Set(records.map(r => r.partition)).size, 1, \`\${job.job_id}'s events landed on several partitions: one job's history must stay on one partition, in order\`);
  const first = payloads(ctx)[0];
  assert(first.segment_start === 0 && first.segment_end === 2 && first.outcome === 'done', \`the first event must carry the range [0, 2) and its outcome, got \${JSON.stringify(first)}\`);
}

export async function check_gapless_complete(ctx) {
  const {m, jobs, job} = await setup(ctx);
  const got = await m.completeJob(job, 'w-1', manifest(3, [2]));
  assert.equal(got, null, \`completeJob announced a job whose segment 2 is missing: \${JSON.stringify(got)}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'a completion was produced for a job with a hole');
  assert.equal((await jobs.get(job.job_id)).state, 'queued', 'a job with segment 2 missing was finalized as done');
  assert((await m.completeJob(job, 'w-1', manifest(3))) !== null, 'once every segment is done the job must be completed');
  assert.equal((await jobs.get(job.job_id)).state, 'done', 'the completed job must be finalized');
}

export async function check_after_manifest(ctx) {
  const {m, jobs, job} = await setup(ctx);
  // The moment the job row is written, what is already on the topic.
  const atFinal = ctx.redisAfter(\`job:\${job.job_id}\`, () => ctx.kafka.records(TOPIC).length);
  await m.completeJob(job, 'w-1', manifest(3));
  assert(atFinal.fired, 'completeJob never finalized the job');
  assert.equal(atFinal.result, 0, \`when the job was finalized the topic already held \${atFinal.result} record(s): a consumer reading the announced job found it still queued. Finalize, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`one completion left \${ctx.kafka.records(TOPIC).length} records\`);
  const final = await jobs.get(job.job_id);
  const want = [{preset: 'h264-720p', key: 'talks/42/h264-720p/index.m3u8', duration_s: 18}];
  assert(final.state === 'done' && JSON.stringify(final.renditions) === JSON.stringify(want), \`the finalized job holds \${final.state} \${JSON.stringify(final.renditions)}, expected done \${JSON.stringify(want)}\`);
}

export async function check_signed_refs(ctx) {
  const {m, jobs, urls, job} = await setup(ctx);
  const event = await m.completeJob(job, 'w-1', manifest(3));
  const expires = Math.floor(ctx.clock.now() / 1000) + 900;
  const rendition = event?.renditions?.[0] ?? {};
  assert.equal(rendition.expires_at, expires, \`the rendition carries expires_at \${rendition.expires_at}, expected now + SIGNED_URL_TTL_S = \${expires}\`);
  const want = urls.sign('renditions', jobs.outputKey(job), expires);
  assert.equal(rendition.url, want, \`the rendition's URL is \${rendition.url}: a plain storage URL in a retained topic never expires. Expected sign(bucket, key, expires_at) = \${want}\`);
  assert.deepStrictEqual(payloads(ctx).at(-1), JSON.parse(JSON.stringify(event)), 'the record on the topic must be the event completeJob returned');
}

export async function check_idempotent_acks(ctx) {
  const {m, job} = await setup(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.publishSegments(job, 'w-1', 0, 2, 'done');
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`one event whose acknowledgement was lost left \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote it twice and the consumer counts segments twice. Make the producer idempotent (acks -1)\`);
  await m.publishSegments(job, 'w-1', 2, 3, 'done');
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the second event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"transcoder/jobs"
	"transcoder/presets"
	"transcoder/segments"
	"transcoder/urls"

	"leetbuild/harness"
)

const topicName = "transcode.event"

var eventsBg = context.Background()

func eventJob() *jobs.Job {
	args, _ := presets.EncoderArgs("h264-720p")
	return jobs.Create(eventsBg, "t-1", "s3://uploads/talk.mov", "9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f", 18, "h264-720p", args, "renditions", "talks/42")
}

func coverage(n int, missing ...int) segments.Coverage {
	gone := map[int]bool{}
	for _, i := range missing {
		gone[i] = true
	}
	done := []int{}
	for i := 0; i < n; i++ {
		if !gone[i] {
			done = append(done, i)
		}
	}
	if missing == nil {
		missing = []int{}
	}
	return segments.Coverage{SegmentCount: n, Done: done, Missing: missing, Complete: len(missing) == 0}
}

func recordPayload(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "a record's value is not JSON: %s", value)
	return p
}

func mustSegments(ctx *harness.Ctx, job *jobs.Job, worker string, start, end int) {
	_, err := publishSegments(eventsBg, job, worker, start, end, "done")
	ctx.NoError(err, "publishSegments(%s, [%d, %d)) failed", worker, start, end)
}

func mustComplete(ctx *harness.Ctx, job *jobs.Job, manifest segments.Coverage) map[string]any {
	event, err := completeJob(eventsBg, job, "w-1", manifest)
	ctx.NoError(err, "completeJob failed")
	return event
}

func CheckJobKey(ctx *harness.Ctx) {
	job := eventJob()
	mustSegments(ctx, job, "w-1", 0, 2)
	mustSegments(ctx, job, "w-2", 2, 3)
	ctx.Assert(mustComplete(ctx, job, coverage(3)) != nil, "a job whose three segments are done must be completed")
	records := ctx.Kafka.Records(topicName)
	ctx.Equal(len(records), 3, "three events must produce three records on %s; the records", topicName)
	ctx.Equal(ctx.Kafka.Keys(topicName), []string{job.JobID, job.JobID, job.JobID}, "records must be keyed by the job id (keyed by the worker, one job's events scatter across partitions)")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "%s's events landed on partitions %d, %d, %d: one job's history must stay on one partition, in order", job.JobID, records[0].Partition, records[1].Partition, records[2].Partition)
	first := recordPayload(ctx, records[0].Value)
	ctx.Assert(first["segment_start"] == 0.0 && first["segment_end"] == 2.0 && first["outcome"] == "done", "the first event must carry the range [0, 2) and its outcome, got %v", first)
}

func CheckGaplessComplete(ctx *harness.Ctx) {
	job := eventJob()
	got := mustComplete(ctx, job, coverage(3, 2))
	ctx.Assert(got == nil, "completeJob announced a job whose segment 2 is missing: %v", got)
	ctx.Equal(len(ctx.Kafka.Records(topicName)), 0, "a job with a hole must produce no completion; the records")
	ctx.Equal(jobs.Get(eventsBg, job.JobID).State, "queued", "a job with segment 2 missing must not be finalized; its state")
	ctx.Assert(mustComplete(ctx, job, coverage(3)) != nil, "once every segment is done the job must be completed")
	ctx.Equal(jobs.Get(eventsBg, job.JobID).State, "done", "the completed job must be finalized; its state")
}

func CheckAfterManifest(ctx *harness.Ctx) {
	job := eventJob()
	// The moment the job row is written, what is already on the topic.
	atFinal := ctx.Redis.After("job:"+job.JobID, func() any { return len(ctx.Kafka.Records(topicName)) })
	mustComplete(ctx, job, coverage(3))
	ctx.Assert(atFinal.Fired, "completeJob never finalized the job")
	ctx.Equal(atFinal.Result, 0, "when the job was finalized the topic already held records: a consumer reading the announced job found it still queued. Finalize, then produce; records at the finalize")
	ctx.Equal(len(ctx.Kafka.Records(topicName)), 1, "one completion, the records")
	final := jobs.Get(eventsBg, job.JobID)
	ctx.Equal(final.State, "done", "the finalized job's state")
	ctx.Equal(final.Renditions, []jobs.Rendition{{Preset: "h264-720p", Key: "talks/42/h264-720p/index.m3u8", DurationS: 18}}, "the finalized job's renditions")
}

func CheckSignedRefs(ctx *harness.Ctx) {
	job := eventJob()
	event := mustComplete(ctx, job, coverage(3))
	ctx.Assert(event != nil, "a complete job must be announced")
	raw, _ := json.Marshal(event)
	var decoded struct {
		Renditions []struct {
			URL       string \`json:"url"\`
			ExpiresAt int64  \`json:"expires_at"\`
		} \`json:"renditions"\`
	}
	json.Unmarshal(raw, &decoded)
	ctx.Assert(len(decoded.Renditions) == 1, "the completion must carry one rendition, got %s", raw)
	expires := ctx.Clock.Now()/1000 + 900
	r := decoded.Renditions[0]
	ctx.Equal(r.ExpiresAt, expires, "the rendition's expires_at must be now + SignedURLTTL")
	want := urls.Sign("renditions", jobs.OutputKey(job), expires)
	ctx.Equal(r.URL, want, "a plain storage URL in a retained topic never expires; the rendition's URL must be urls.Sign(bucket, key, expires_at)")
	records := ctx.Kafka.Records(topicName)
	ctx.Equal(string(records[len(records)-1].Value), string(raw), "the record on the topic must be the event completeJob returned")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	job := eventJob()
	mustSegments(ctx, job, "w-1", 0, 2)
	mustSegments(ctx, job, "w-1", 2, 3)
	lost := ctx.Kafka.Failover(topicName)
	ctx.Equal(len(ctx.Kafka.Records(topicName)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged the event. Use RequireAll; the records on the topic", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <set>
#include <string>
#include <vector>

#include "transcoder/jobs.h"
#include "transcoder/presets.h"
#include "transcoder/segments.h"
#include "transcoder/urls.h"

namespace {

const std::string kTopic = "transcode.event";

jobs::Job eventJob() {
  return jobs::create("t-1", "s3://uploads/talk.mov", std::string(64, 'f'), 18, "h264-720p", *presets::encoderArgs("h264-720p"), "renditions", "talks/42");
}

segments::Coverage coverage(int n, const std::vector<int>& missing = {}) {
  segments::Coverage out;
  out.segment_count = n;
  const std::set<int> gone(missing.begin(), missing.end());
  for (int i = 0; i < n; i++) {
    if (!gone.count(i)) out.done.push_back(i);
  }
  out.missing = missing;
  out.complete = missing.empty();
  return out;
}

nlohmann::json recordPayload(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  const auto p = nlohmann::json::parse(record.Value.value_or(""), nullptr, false);
  ctx.Assert(p.is_object(), "a record's value is not JSON: %s", record.Value.value_or(""));
  return p;
}

std::optional<nlohmann::json> mustComplete(harness::Ctx& ctx, const jobs::Job& job, const segments::Coverage& manifest) {
  try {
    return completeJob(job, "w-1", manifest);
  } catch (const std::exception& e) {
    ctx.Fatalf("completeJob threw %s: %s", harness::CurrentExceptionType(), e.what());
  }
}

}  // namespace

void CheckJobKey(harness::Ctx& ctx) {
  const jobs::Job job = eventJob();
  publishSegments(job, "w-1", 0, 2, "done");
  publishSegments(job, "w-2", 2, 3, "done");
  ctx.Assert(mustComplete(ctx, job, coverage(3)).has_value(), "a job whose three segments are done must be completed");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), size_t{3}, "three events must produce three records on %s; the records", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {job.job_id, job.job_id, job.job_id}, "records must be keyed by the job id (keyed by the worker, one job's events scatter across partitions)");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
             "%s's events landed on partitions %d, %d, %d: one job's history must stay on one partition, in order", job.job_id, records[0].Partition, records[1].Partition, records[2].Partition);
  const auto first = recordPayload(ctx, records[0]);
  ctx.Assert(first.value("segment_start", -1) == 0 && first.value("segment_end", -1) == 2 && first.value("outcome", "") == "done", "the first event must carry the range [0, 2) and its outcome, got %s", first.dump());
}

void CheckGaplessComplete(harness::Ctx& ctx) {
  const jobs::Job job = eventJob();
  const auto got = mustComplete(ctx, job, coverage(3, {2}));
  ctx.Assert(!got.has_value(), "completeJob announced a job whose segment 2 is missing: %s", got ? got->dump() : "");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), size_t{0}, "a job with a hole must produce no completion; the records");
  ctx.Equal(jobs::get(job.job_id)->state, "queued", "a job with segment 2 missing must not be finalized; its state");
  ctx.Assert(mustComplete(ctx, job, coverage(3)).has_value(), "once every segment is done the job must be completed");
  ctx.Equal(jobs::get(job.job_id)->state, "done", "the completed job must be finalized; its state");
}

void CheckAfterManifest(harness::Ctx& ctx) {
  const jobs::Job job = eventJob();
  // The moment the job row is written, what is already on the topic.
  int at_final = -1;
  ctx.Redis.After("job:" + job.job_id, [&] { at_final = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  mustComplete(ctx, job, coverage(3));
  ctx.Assert(at_final >= 0, "completeJob never finalized the job");
  ctx.Equal(at_final, 0, "when the job was finalized the topic already held records: a consumer reading the announced job found it still queued. Finalize, then produce; records at the finalize");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), size_t{1}, "one completion, the records");
  const auto final_job = jobs::get(job.job_id);
  ctx.Equal(final_job->state, "done", "the finalized job's state");
  ctx.Assert(final_job->renditions.size() == 1 && final_job->renditions[0].key == "talks/42/h264-720p/index.m3u8" && final_job->renditions[0].duration_s == 18,
             "the finalized job must hold its h264-720p rendition at talks/42/h264-720p/index.m3u8, 18 s");
}

void CheckSignedRefs(harness::Ctx& ctx) {
  const jobs::Job job = eventJob();
  const auto event = mustComplete(ctx, job, coverage(3));
  ctx.Assert(event && event->contains("renditions") && (*event)["renditions"].size() == 1, "the completion must carry one rendition, got %s", event ? event->dump() : "");
  const auto& r = (*event)["renditions"][0];
  const long long expires = ctx.Clock.Now() / 1000 + 900;
  ctx.Equal(r.value("expires_at", 0LL), expires, "the rendition's expires_at must be now + kSignedUrlTtlS");
  ctx.Equal(r.value("url", ""), urls::sign("renditions", jobs::outputKey(job), expires), "a plain storage URL in a retained topic never expires; the rendition's URL must be urls::sign(bucket, key, expires_at)");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Assert(recordPayload(ctx, records.back()) == *event, "the record on the topic must be the event completeJob returned");
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  const jobs::Job job = eventJob();
  ctx.Kafka.LoseAcks(kTopic, 1);
  publishSegments(job, "w-1", 0, 2, "done");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), size_t{1}, "one event whose acknowledgement was lost: the producer's retry wrote it twice and the consumer counts segments twice. Set enable.idempotence (with acks=all); the records on the topic");
  publishSegments(job, "w-1", 2, 3, "done");
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), size_t{2}, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    'Watch one job on the dashboard: its progress jumps back, it flashes "done" with segment 7 still missing, and the URL in last month\'s completion record still plays the video.',
    'Both produces are keyed by `worker_id`, `complete_job` never looks at `manifest["missing"]` and produces before `finalize_job`, the rendition carries a plain storage URL, and the producer runs with `acks=1` and no idempotence.',
    'Key by `job["job_id"]`, return None while `manifest["missing"]` is not empty, call `jobs.finalize_job` before the produce, send `urls.sign(bucket, key, expires_at)` with `expires_at = int(time.time()) + urls.SIGNED_URL_TTL_S`, and set `enable.idempotence` with `acks=all`.',
  ],
  debrief: `The key is the ordering guarantee: Kafka orders within a partition only, so one job's events share one. The completion is a claim about state, which is why it waits for a gapless manifest and for the job row to be final: a reader that follows the event must find what it announced. The signed reference with \`expires_at\` means the retained, replicated log holds a grant that lapses in fifteen minutes rather than one that outlives the video, and idempotence with \`acks=all\` keeps a broker retry from counting a segment twice. A real pipeline writes the completion to an outbox in the same transaction as the job row and lets a relay produce it, so a broker outage delays the event without losing it.`,
};
