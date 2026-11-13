import type {Step} from '@/lib/types';

export const transcriptionEventsStep: Step = {
  id: 'events',
  title: 'Transcript segments keyed by job, redacted before they are published',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['worker', 'redactor', 'kafka', 'db'],
  task: `## Task

**Starting point.** The starter's \`publish_segments(job_id, segments)\` produces one
\`transcript.segment\` record per segment with \`{job_id, chunk_index, text}\`, keyed by the chunk
index, writes an outbox row (\`jobs.insert_outbox\`) when \`produce\` raises, flushes, then redacts the
text (\`redact\`) and saves the segments on the job (\`jobs.save_segments\`). Live captions and search
consume the topic. It serves the demo and hides five flaws.

**Failure mode the checks target.** One job's segments spread over several partitions and reach the
captions out of order; phone numbers and e-mail addresses reach a retained topic unredacted; a record
carries no timestamps or speaker; a record the broker refuses is lost, because the refusal arrives in
the delivery report, not from \`produce\`; and a lost acknowledgement or a leader failover duplicates
or drops a segment.

- The record key is the **job id**, and a chunk's segments are produced in the order they were spoken.
- Redact first: the topic, the outbox and the saved transcript only ever see \`redact(text)\`.
- The payload is \`{job_id, chunk_index, start_ms, end_ms, speaker, text}\`.
- A refused record goes to \`jobs.insert_outbox(topic, job_id, payload)\` from the delivery report
  (callback, rejected \`send\`, returned \`WriteMessages\` error): every refused record and no accepted
  one. \`publish_segments\` does not raise, and returns only once every report is in (the worker marks
  the chunk done then): each segment is on the topic or in the outbox, once.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent\` with \`acks: -1\`; kafka-go has no
  idempotent producer, so its writer uses \`RequireAll\`).`,
  sequence: {
    participants: ['Chunk worker', 'Redactor', 'jobs store', 'transcript.segment', 'outbox'],
    messages: [
      {from: 'Chunk worker', to: 'Redactor', label: 'redact(text) for every segment', kind: 'sync'},
      {from: 'Chunk worker', to: 'jobs store', label: 'save_segments(job_id, redacted)', kind: 'sync'},
      {
        from: 'Chunk worker',
        to: 'transcript.segment',
        label: 'produce · key = job_id · {job_id, chunk_index, start_ms, end_ms, speaker, text}',
        kind: 'sync',
      },
      {from: 'transcript.segment', to: 'Chunk worker', label: 'delivery report: refused', kind: 'reply'},
      {from: 'Chunk worker', to: 'outbox', label: 'insert_outbox(topic, job_id, payload)', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'job-key',
      title: 'Keyed by job id',
      detail:
        "The record key is the job id (`key=job_id`, `key: jobId`, `[]byte(jobID)`, `ProducerRecord(Topic, jobId, …)`), so one job's segments land on one partition, each chunk's in the order they were spoken; the starter keys by chunk index.",
      match: {
        python: {all: [/produce\([^\n]*key=job_id/], none: [/key\s*=\s*str\(/]},
        typescript: {all: [/key:\s*jobId\b/], none: [/key\s*=\s*String\(/]},
        go: {all: [/Key:\s*\[\]byte\(jobID\)/], none: [/Key:\s*\[\]byte\(strconv/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*jobId/], none: [/chunkIndex\.toString/]},
        cpp: {all: [/job_id\.c_str\(\),\s*job_id\.(size|length)\(\)/], none: [/key\.c_str\(\)/]},
      },
    },
    {
      id: 'redact-before-publish',
      title: 'Redacts before anything is published',
      detail:
        'Every text goes through `redact` before the produce, so the retained topic and the outbox never hold a phone number or an e-mail address; the starter produces the raw text and redacts only the saved copy.',
      match: {
        python: {order: [/\bredact\(/, /producer\.produce\(/]},
        typescript: {order: [/\bredact\(/, /producer\.send\(/]},
        go: {order: [/redact\.Redact\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/Redact\.redact\(/, /producer\.send\(/]},
        cpp: {order: [/redact::redact\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'segment-payload',
      title: 'Each record carries timestamps and the speaker',
      detail:
        'The payload carries `start_ms`, `end_ms` and `speaker` beside `job_id`, `chunk_index` and `text`, so captions can be placed and attributed; the starter sends the text alone.',
      match: {
        python: {all: [/["']start_ms["']/, /["']end_ms["']/, /["']speaker["']/]},
        typescript: {all: [/start_ms\s*:/, /end_ms\s*:/, /speaker\s*:/]},
        go: {all: [/json:"start_ms"/, /json:"end_ms"/, /json:"speaker"/]},
        scala: {all: [/"start_ms"\s*->/, /"end_ms"\s*->/, /"speaker"\s*->/]},
        cpp: {all: [/\{"start_ms",/, /\{"end_ms",/, /\{"speaker",/]},
      },
    },
    {
      id: 'outbox-from-delivery',
      title: 'Writes the outbox row from the delivery report',
      detail:
        'A record the broker refuses becomes an outbox row, with its redacted payload, where the broker answers: the delivery callback, the rejected `send`, the returned `WriteMessages` error, `dr_cb`, a producer `Callback`. Every refused record gets a row and no accepted one does (a batch the broker refuses whole is outboxed whole), and all of it before `publish_segments` returns, so each segment lands once. A `try` around `produce` catches only a full local queue.',
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /jobs\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {
          all: [/await producer\.send\(/, /catch\b[\s\S]{0,120}?insertOutbox\(/],
          none: [/void producer\.send\(/],
        },
        go: {all: [/err\s*:?=\s*writer\.WriteMessages\(/, /jobs\.InsertOutbox\(/], none: [/Async:\s*true/]},
        scala: {all: [/Jobs\.insertOutbox\(/, /exception != null/], none: [/case\s+_:\s*KafkaException/]},
        cpp: {all: [/jobs::insertOutbox\(/, /dr_cb/], none: [/!=\s*RdKafka::ERR_NO_ERROR\)\s*jobs::insertOutbox/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer has idempotence and `acks=all` (kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the segment once and a leader failover loses nothing; kafka-go has no idempotent producer, so its writer uses `RequireAll` and the consumers deduplicate by `(job_id, start_ms)`.',
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

from confluent_kafka import KafkaException, Producer

from transcribe import jobs  # jobs.save_segments, jobs.insert_outbox
from transcribe.redact import redact

TOPIC = "transcript.segment"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_segments(job_id: str, segments: list[dict]) -> None:
    """Publish a chunk's segments for captions and search, and keep them on the job."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    for segment in segments:
        key = str(segment["chunk_index"])
        payload = {"job_id": job_id, "chunk_index": segment["chunk_index"], "text": segment["text"]}
        try:
            producer.produce(TOPIC, key=key, value=json.dumps(payload).encode())
        except KafkaException:
            jobs.insert_outbox(TOPIC, key, payload)  # the broker said no: the relay produces it later
    producer.flush()
    jobs.save_segments(job_id, [{**s, "text": redact(s["text"])} for s in segments])
`,
      solution: `import json

from confluent_kafka import Producer

from transcribe import jobs  # jobs.save_segments, jobs.insert_outbox
from transcribe.redact import redact

TOPIC = "transcript.segment"

# Idempotent with acks=all: a retry after a lost acknowledgement writes the segment once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def publish_segments(job_id: str, segments: list[dict]) -> None:
    """Publish a chunk's segments for captions and search, and keep them on the job."""
    # Redaction comes first: nothing downstream ever holds the raw text.
    redacted = [{**s, "text": redact(s["text"])} for s in segments]
    jobs.save_segments(job_id, redacted)
    for s in redacted:
        payload = {"job_id": job_id, "chunk_index": s["chunk_index"], "start_ms": s["start_ms"], "end_ms": s["end_ms"], "speaker": s["speaker"], "text": s["text"]}

        def on_delivery(err, msg, payload=payload) -> None:
            if err is not None:
                jobs.insert_outbox(TOPIC, job_id, payload)  # the broker said no: the relay produces it later

        producer.produce(TOPIC, key=job_id, value=json.dumps(payload).encode(), on_delivery=on_delivery)
    producer.flush()  # serves the delivery reports of this chunk's records
`,
    },
    typescript: {
      starter: `import {Kafka, type Producer} from 'kafkajs';

import {type Segment, insertOutbox, saveSegments} from 'transcribe/jobs';
import {redact} from 'transcribe/redact';

export const TOPIC = 'transcript.segment';

const kafka = new Kafka({clientId: 'transcribed', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer();
void producer.connect();

/** Publish a chunk's segments for captions and search, and keep them on the job. */
export async function publishSegments(jobId: string, segments: Segment[]): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (const segment of segments) {
    const key = String(segment.chunk_index);
    const payload = {job_id: jobId, chunk_index: segment.chunk_index, text: segment.text};
    try {
      void producer.send({topic: TOPIC, messages: [{key, value: JSON.stringify(payload)}], acks: 1});
    } catch {
      await insertOutbox(TOPIC, key, payload); // the broker said no: the relay produces it later
    }
  }
  await saveSegments(jobId, segments.map(s => ({...s, text: redact(s.text)})));
}
`,
      solution: `import {Kafka, type Producer} from 'kafkajs';

import {type Segment, insertOutbox, saveSegments} from 'transcribe/jobs';
import {redact} from 'transcribe/redact';

export const TOPIC = 'transcript.segment';

const kafka = new Kafka({clientId: 'transcribed', brokers: ['kafka:9092']});
// Idempotent with acks -1 (all): a retry after a lost acknowledgement writes the segment once, on every replica.
const producer: Producer = kafka.producer({idempotent: true});
void producer.connect();

/** Publish a chunk's segments for captions and search, and keep them on the job. */
export async function publishSegments(jobId: string, segments: Segment[]): Promise<void> {
  // Redaction comes first: nothing downstream ever holds the raw text.
  const redacted = segments.map(s => ({...s, text: redact(s.text)}));
  await saveSegments(jobId, redacted);
  for (const s of redacted) {
    const payload = {job_id: jobId, chunk_index: s.chunk_index, start_ms: s.start_ms, end_ms: s.end_ms, speaker: s.speaker, text: s.text};
    try {
      await producer.send({topic: TOPIC, messages: [{key: jobId, value: JSON.stringify(payload)}], acks: -1});
    } catch {
      await insertOutbox(TOPIC, jobId, payload); // the broker said no: the relay produces it later
    }
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/segmentio/kafka-go"

	"transcribe/jobs"   // jobs.Segment, jobs.SaveSegments, jobs.InsertOutbox
	"transcribe/redact" // redact.Redact(text)
)

const topic = "transcript.segment"

var writer = &kafka.Writer{
	Addr:     kafka.TCP("kafka:9092"),
	Topic:    topic,
	Balancer: &kafka.Hash{},
	Async:    true,
}

type segmentEvent struct {
	JobID      string \`json:"job_id"\`
	ChunkIndex int    \`json:"chunk_index"\`
	Text       string \`json:"text"\`
}

// publishSegments publishes a chunk's segments for captions and search, and keeps them on the job.
func publishSegments(ctx context.Context, jobID string, segments []jobs.Segment) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	for _, s := range segments {
		event := segmentEvent{JobID: jobID, ChunkIndex: s.ChunkIndex, Text: s.Text}
		value, _ := json.Marshal(event)
		msg := kafka.Message{Key: []byte(strconv.Itoa(s.ChunkIndex)), Value: value}
		if err := writer.WriteMessages(ctx, msg); err != nil {
			jobs.InsertOutbox(ctx, topic, string(msg.Key), event) // the broker said no: the relay produces it later
		}
	}
	redacted := make([]jobs.Segment, 0, len(segments))
	for _, s := range segments {
		s.Text = redact.Redact(s.Text)
		redacted = append(redacted, s)
	}
	jobs.SaveSegments(ctx, jobID, redacted)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"

	"transcribe/jobs"   // jobs.Segment, jobs.SaveSegments, jobs.InsertOutbox
	"transcribe/redact" // redact.Redact(text)
)

const topic = "transcript.segment"

// RequireAll: the record is on every replica before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate; the consumers deduplicate by
// (job_id, start_ms).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type segmentEvent struct {
	JobID      string \`json:"job_id"\`
	ChunkIndex int    \`json:"chunk_index"\`
	StartMs    int    \`json:"start_ms"\`
	EndMs      int    \`json:"end_ms"\`
	Speaker    string \`json:"speaker"\`
	Text       string \`json:"text"\`
}

// publishSegments publishes a chunk's segments for captions and search, and keeps them on the job.
func publishSegments(ctx context.Context, jobID string, segments []jobs.Segment) {
	// Redaction comes first: nothing downstream ever holds the raw text.
	redacted := make([]jobs.Segment, 0, len(segments))
	for _, s := range segments {
		s.Text = redact.Redact(s.Text)
		redacted = append(redacted, s)
	}
	jobs.SaveSegments(ctx, jobID, redacted)
	for _, s := range redacted {
		event := segmentEvent{JobID: jobID, ChunkIndex: s.ChunkIndex, StartMs: s.StartMs, EndMs: s.EndMs, Speaker: s.Speaker, Text: s.Text}
		value, _ := json.Marshal(event)
		// A synchronous write returns the broker's answer for this record.
		if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(jobID), Value: value}); err != nil {
			jobs.InsertOutbox(ctx, topic, jobID, event) // the broker said no: the relay produces it later
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import transcribe.{Jobs, Redact} // Jobs.saveSegments, Jobs.insertOutbox; Redact.redact

object SegmentEvents {
  val Topic = "transcript.segment"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Publish a chunk's segments for captions and search, and keep them on the job. */
  def publishSegments(jobId: String, segments: Seq[Jobs.Segment]): Unit = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    segments.foreach { s =>
      val key = s.chunkIndex.toString
      val payload = JsObject("job_id" -> JsString(jobId), "chunk_index" -> JsNumber(s.chunkIndex), "text" -> JsString(s.text))
      try producer.send(new ProducerRecord[String, String](Topic, key, payload.compactPrint))
      catch { case _: KafkaException => Jobs.insertOutbox(Topic, key, payload) } // the broker said no: the relay produces it later
    }
    producer.flush()
    Jobs.saveSegments(jobId, segments.map(s => s.copy(text = Redact.redact(s.text))))
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import transcribe.{Jobs, Redact} // Jobs.saveSegments, Jobs.insertOutbox; Redact.redact

object SegmentEvents {
  val Topic = "transcript.segment"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the segment once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Publish a chunk's segments for captions and search, and keep them on the job. */
  def publishSegments(jobId: String, segments: Seq[Jobs.Segment]): Unit = {
    // Redaction comes first: nothing downstream ever holds the raw text.
    val redacted = segments.map(s => s.copy(text = Redact.redact(s.text)))
    Jobs.saveSegments(jobId, redacted)
    redacted.foreach { s =>
      val payload = JsObject(
        "job_id" -> JsString(jobId), "chunk_index" -> JsNumber(s.chunkIndex), "start_ms" -> JsNumber(s.startMs),
        "end_ms" -> JsNumber(s.endMs), "speaker" -> JsString(s.speaker), "text" -> JsString(s.text))
      val onDelivery: Callback = new Callback {
        override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
          if (exception != null) Jobs.insertOutbox(Topic, jobId, payload) // the broker said no: the relay produces it later
      }
      producer.send(new ProducerRecord[String, String](Topic, jobId, payload.compactPrint), onDelivery)
    }
    producer.flush()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

#include "transcribe/jobs.h"    // jobs::Segment, jobs::saveSegments, jobs::insertOutbox
#include "transcribe/redact.h"  // redact::redact(text)

using json = nlohmann::json;

const std::string kTopic = "transcript.segment";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Publish a chunk's segments for captions and search, and keep them on the job.
void publishSegments(const std::string& job_id, const std::vector<jobs::Segment>& segments) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (const jobs::Segment& s : segments) {
    const std::string key = std::to_string(s.chunk_index);
    const json payload = {{"job_id", job_id}, {"chunk_index", s.chunk_index}, {"text", s.text}};
    const std::string value = payload.dump();
    if (producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                          value.size(), key.c_str(), key.size(), 0, nullptr) != RdKafka::ERR_NO_ERROR) jobs::insertOutbox(kTopic, key, payload);
  }
  producer->flush(5000);
  std::vector<jobs::Segment> redacted = segments;
  for (jobs::Segment& s : redacted) s.text = redact::redact(s.text);
  jobs::saveSegments(job_id, redacted);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

#include "transcribe/jobs.h"    // jobs::Segment, jobs::saveSegments, jobs::insertOutbox
#include "transcribe/redact.h"  // redact::redact(text)

using json = nlohmann::json;

const std::string kTopic = "transcript.segment";

// The delivery report: a refused record goes to the outbox for the relay to produce again.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    const std::string key = message.key() ? *message.key() : "";
    jobs::insertOutbox(kTopic, key, json::parse(std::string(static_cast<const char*>(message.payload()), message.len())));
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the segment once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Publish a chunk's segments for captions and search, and keep them on the job.
void publishSegments(const std::string& job_id, const std::vector<jobs::Segment>& segments) {
  // Redaction comes first: nothing downstream ever holds the raw text.
  std::vector<jobs::Segment> redacted = segments;
  for (jobs::Segment& s : redacted) s.text = redact::redact(s.text);
  jobs::saveSegments(job_id, redacted);
  for (const jobs::Segment& s : redacted) {
    const std::string value = json{{"job_id", job_id}, {"chunk_index", s.chunk_index}, {"start_ms", s.start_ms},
                                   {"end_ms", s.end_ms}, {"speaker", s.speaker}, {"text", s.text}}.dump();
    producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                      value.size(), job_id.c_str(), job_id.size(), 0, nullptr);
  }
  producer->flush(5000);  // serves the delivery reports of this chunk's records
}
`,
    },
  },
  harness: {
    python: `import json

from transcribe import jobs

TOPIC = "transcript.segment"
RAW = "Call me back at 415-555-0199 or write to ana@example.com."
REDACTED = "Call me back at [PHONE] or write to [EMAIL]."


def _segments(index=1):
    base = index * 30000
    return [
        {"chunk_index": index, "start_ms": base, "end_ms": base + 10000, "speaker": "A", "text": "Thanks for holding."},
        {"chunk_index": index, "start_ms": base + 10000, "end_ms": base + 20000, "speaker": "B", "text": RAW},
    ]


def _events(ctx):
    return sorted((json.loads(v) for v in ctx.kafka.values(TOPIC)), key=lambda e: (e.get("job_id", ""), e.get("start_ms", 0)))


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_job_key(ctx):
    m = ctx.load("events")
    m.publish_segments("tr-1", _segments(1))
    m.publish_segments("tr-1", _segments(0))
    m.publish_segments("tr-2", _segments(0))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 6, f"three chunks of two segments produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = sorted(r.key for r in records)
    assert keys == [b"tr-1"] * 4 + [b"tr-2"] * 2, f"records must be keyed by the job id, got {keys}: keyed by chunk, one job's segments spread over partitions and reach the captions out of order"
    assert len({r.partition for r in records if r.key == b"tr-1"}) == 1, "every segment of job tr-1 must land on one partition"
    starts = [json.loads(r.value).get("start_ms") for r in records if r.key == b"tr-1"]
    assert starts == [30000, 40000, 0, 10000], f"job tr-1's records sit on its partition in the order start_ms {starts}, expected {[30000, 40000, 0, 10000]}: each chunk's segments in the order they were spoken, one chunk after the other"


def check_redact_before_publish(ctx):
    m = ctx.load("events")
    m.publish_segments("tr-1", _segments(1))
    values = ctx.kafka.values(TOPIC)
    assert len(values) == 2, f"two segments produced {len(values)} records"
    for value in values:
        assert b"415-555-0199" not in value and b"ana@example.com" not in value, f"a record on the retained topic carries a phone number or an e-mail address: {value!r}; redact before the produce"
    saved = [s["text"] for s in jobs.segments("tr-1")]
    assert saved == ["Thanks for holding.", REDACTED], f"the job's saved transcript is {saved}, expected the redacted texts"


def check_segment_payload(ctx):
    m = ctx.load("events")
    m.publish_segments("tr-1", _segments(1))
    events = _events(ctx)
    assert len(events) == 2, f"two segments produced {len(events)} records"
    for event, segment in zip(events, _segments(1)):
        for name in ("job_id", "chunk_index", "start_ms", "end_ms", "speaker"):
            want = "tr-1" if name == "job_id" else segment[name]
            assert event.get(name) == want, f"the record must carry {name}={want!r}, got {event}"


def check_outbox_from_delivery(ctx):
    m = ctx.load("events")
    # The broker refuses the first record, the one with the phone number and the e-mail address.
    segments = _segments(1)
    segments[0]["text"], segments[1]["text"] = RAW, "Thanks for holding."
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.publish_segments("tr-1", segments)
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"publish_segments raised when the broker refused a record: {e!r}; the record goes to the outbox, the worker goes on") from e
    rows = _outbox(ctx)
    refused = [row for row in rows if row.get("payload", {}).get("start_ms") == 30000]
    assert refused, f"the broker refused the record of start_ms 30000 and the outbox holds {rows}: the refusal arrives in the delivery report, which must write the row"
    for row in rows:
        assert row.get("topic") == TOPIC and row.get("key") == "tr-1", f"an outbox row must hold the topic, the job id and the refused payload, got {row}"
        assert "415-555-0199" not in json.dumps(row) and "ana@example.com" not in json.dumps(row), f"an outbox row carries a phone number or an e-mail address: {row}; the outbox only ever sees the redacted text"
    assert refused[0]["payload"].get("text") == REDACTED, f"the refused payload's text is {refused[0]['payload'].get('text')!r}, expected {REDACTED!r}"
    published = sorted(json.loads(v).get("start_ms") for v in ctx.kafka.values(TOPIC))
    outboxed = sorted(row.get("payload", {}).get("start_ms") for row in rows)
    assert sorted(published + outboxed) == [30000, 40000], f"each segment once, on the topic or in the outbox: the topic holds start_ms {published}, the outbox {outboxed}"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    m.publish_segments("tr-1", _segments(1)[:1])
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one segment whose acknowledgement was lost left {len(records)} records: the producer's retry wrote it twice. Enable idempotence (with acks=all)"
    m.publish_segments("tr-1", _segments(2)[:1])
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the segment and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'transcript.segment';
const RAW = 'Call me back at 415-555-0199 or write to ana@example.com.';
const REDACTED = 'Call me back at [PHONE] or write to [EMAIL].';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const segmentsOf = (index = 1) => {
  const base = index * 30000;
  return [
    {chunk_index: index, start_ms: base, end_ms: base + 10000, speaker: 'A', text: 'Thanks for holding.'},
    {chunk_index: index, start_ms: base + 10000, end_ms: base + 20000, speaker: 'B', text: RAW},
  ];
};

const events = ctx =>
  ctx.kafka
    .values(TOPIC)
    .map(v => JSON.parse(v.toString()))
    .sort((a, b) => \`\${a.job_id}\`.localeCompare(\`\${b.job_id}\`) || a.start_ms - b.start_ms);
const outboxRows = ctx => ctx.redis.lrange('outbox', 0, -1).map(row => JSON.parse(row));

async function publish(m, jobId: string, segments): Promise<void> {
  await m.publishSegments(jobId, segments);
  await settle();
}

export async function check_job_key(ctx) {
  const m = ctx.load('events');
  await publish(m, 'tr-1', segmentsOf(1));
  await publish(m, 'tr-1', segmentsOf(0));
  await publish(m, 'tr-2', segmentsOf(0));
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 6, \`three chunks of two segments produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null).sort();
  assert.deepStrictEqual(keys, ['tr-1', 'tr-1', 'tr-1', 'tr-1', 'tr-2', 'tr-2'], \`records must be keyed by the job id, got \${JSON.stringify(keys)}: keyed by chunk, one job's segments spread over partitions and reach the captions out of order\`);
  assert.equal(new Set(records.filter(r => r.key?.toString() === 'tr-1').map(r => r.partition)).size, 1, 'every segment of job tr-1 must land on one partition');
  const starts = records.filter(r => r.key?.toString() === 'tr-1').map(r => JSON.parse(r.value.toString()).start_ms);
  assert.deepStrictEqual(starts, [30000, 40000, 0, 10000], \`job tr-1's records sit on its partition in the order start_ms \${JSON.stringify(starts)}, expected [30000,40000,0,10000]: each chunk's segments in the order they were spoken, one chunk after the other\`);
}

export async function check_redact_before_publish(ctx) {
  const m = ctx.load('events');
  const jobs = ctx.load('/support/transcribe/jobs.ts');
  await publish(m, 'tr-1', segmentsOf(1));
  const values = ctx.kafka.values(TOPIC).map(v => v.toString());
  assert.equal(values.length, 2, \`two segments produced \${values.length} records\`);
  for (const value of values) assert(!value.includes('415-555-0199') && !value.includes('ana@example.com'), \`a record on the retained topic carries a phone number or an e-mail address: \${value}; redact before the produce\`);
  const saved = (await jobs.segments('tr-1')).map(s => s.text);
  assert.deepStrictEqual(saved, ['Thanks for holding.', REDACTED], \`the job's saved transcript is \${JSON.stringify(saved)}, expected the redacted texts\`);
}

export async function check_segment_payload(ctx) {
  const m = ctx.load('events');
  await publish(m, 'tr-1', segmentsOf(1));
  const all = events(ctx);
  assert.equal(all.length, 2, \`two segments produced \${all.length} records\`);
  segmentsOf(1).forEach((segment, i) => {
    for (const name of ['job_id', 'chunk_index', 'start_ms', 'end_ms', 'speaker']) {
      const want = name === 'job_id' ? 'tr-1' : segment[name];
      assert.deepStrictEqual(all[i][name], want, \`the record must carry \${name}=\${JSON.stringify(want)}, got \${JSON.stringify(all[i])}\`);
    }
  });
}

export async function check_outbox_from_delivery(ctx) {
  const m = ctx.load('events');
  // The broker refuses the first record, the one with the phone number and the e-mail address.
  const [first, second] = segmentsOf(1);
  const segments = [{...first, text: RAW}, {...second, text: 'Thanks for holding.'}];
  ctx.kafka.failNext(TOPIC, 1);
  try {
    // No settle: the worker marks the chunk done as soon as publishSegments resolves.
    await m.publishSegments('tr-1', segments);
  } catch (e) {
    assert.fail(\`publishSegments rejected when the broker refused a record: \${e}; the record goes to the outbox, the worker goes on\`);
  }
  const rows = outboxRows(ctx);
  const refused = rows.filter(row => row.payload?.start_ms === 30000);
  assert(refused.length > 0, \`the broker refused the record of start_ms 30000 and when publishSegments resolved the outbox held \${JSON.stringify(rows)}: the refusal arrives as the rejected send, which must write the row before publishSegments resolves (the worker marks the chunk done then)\`);
  for (const row of rows) {
    assert(row.topic === TOPIC && row.key === 'tr-1', \`an outbox row must hold the topic, the job id and the refused payload, got \${JSON.stringify(row)}\`);
    const text = JSON.stringify(row);
    assert(!text.includes('415-555-0199') && !text.includes('ana@example.com'), \`an outbox row carries a phone number or an e-mail address: \${text}; the outbox only ever sees the redacted text\`);
  }
  assert.equal(refused[0].payload.text, REDACTED, \`the refused payload's text is \${JSON.stringify(refused[0].payload.text)}, expected \${JSON.stringify(REDACTED)}\`);
  const published = ctx.kafka.values(TOPIC).map(v => JSON.parse(v.toString()).start_ms);
  const outboxed = rows.map(row => row.payload?.start_ms);
  assert.deepStrictEqual([...published, ...outboxed].sort((a, b) => a - b), [30000, 40000], \`each segment once, on the topic or in the outbox, when publishSegments resolved: the topic held start_ms \${JSON.stringify(published)}, the outbox \${JSON.stringify(outboxed)}\`);
  await settle();
  const later = [...ctx.kafka.values(TOPIC).map(v => JSON.parse(v.toString()).start_ms), ...outboxRows(ctx).map(row => row.payload?.start_ms)];
  assert.deepStrictEqual(later.sort((a, b) => a - b), [30000, 40000], \`after publishSegments resolved, more landed: the topic and the outbox now hold start_ms \${JSON.stringify(later)}, expected each segment once\`);
}

export async function check_idempotent_producer(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1);
  await publish(m, 'tr-1', segmentsOf(1).slice(0, 1));
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one segment whose acknowledgement was lost left \${records.length} records: the producer's retry wrote it twice. Make the producer idempotent (acks -1)\`);
  await publish(m, 'tr-1', segmentsOf(2).slice(0, 1));
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the segment and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"transcribe/jobs"

	"leetbuild/harness"
)

const (
	eventsRaw      = "Call me back at 415-555-0199 or write to ana@example.com."
	eventsRedacted = "Call me back at [PHONE] or write to [EMAIL]."
)

func eventsSegments(index int) []jobs.Segment {
	base := index * 30000
	return []jobs.Segment{
		{ChunkIndex: index, StartMs: base, EndMs: base + 10000, Speaker: "A", Text: "Thanks for holding."},
		{ChunkIndex: index, StartMs: base + 10000, EndMs: base + 20000, Speaker: "B", Text: eventsRaw},
	}
}

func eventsPublish(ctx *harness.Ctx, jobID string, segments []jobs.Segment) {
	publishSegments(context.Background(), jobID, segments)
	ctx.Settle()
}

func eventsAll(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, v := range ctx.Kafka.Values(topic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(v), &e), "the record is JSON: %s", v)
		out = append(out, e)
	}
	start := func(e map[string]any) float64 {
		f, _ := e["start_ms"].(float64)
		return f
	}
	sort.Slice(out, func(i, j int) bool { return start(out[i]) < start(out[j]) })
	return out
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, row := range ctx.Redis.LRange("outbox", 0, -1) {
		var r map[string]any
		ctx.NoError(json.Unmarshal([]byte(row), &r), "the outbox row is JSON: %s", row)
		out = append(out, r)
	}
	return out
}

func CheckJobKey(ctx *harness.Ctx) {
	eventsPublish(ctx, "tr-1", eventsSegments(1))
	eventsPublish(ctx, "tr-1", eventsSegments(0))
	eventsPublish(ctx, "tr-2", eventsSegments(0))
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 6, "three chunks of two segments; the records on %s", topic)
	keys := ctx.Kafka.Keys(topic)
	sort.Strings(keys)
	ctx.Equal(keys, []string{"tr-1", "tr-1", "tr-1", "tr-1", "tr-2", "tr-2"}, "records must be keyed by the job id (keyed by chunk, one job's segments spread over partitions and reach the captions out of order)")
	partitions := map[int]bool{}
	for _, r := range records {
		if string(r.Key) == "tr-1" {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "every segment of job tr-1 must land on one partition; partitions")
	starts := []int{}
	for _, r := range records {
		if string(r.Key) == "tr-1" {
			var e struct {
				StartMs int \`json:"start_ms"\`
			}
			json.Unmarshal(r.Value, &e)
			starts = append(starts, e.StartMs)
		}
	}
	ctx.Equal(starts, []int{30000, 40000, 0, 10000}, "job tr-1's records on its partition, each chunk's segments in the order they were spoken, one chunk after the other; start_ms in partition order")
}

func CheckRedactBeforePublish(ctx *harness.Ctx) {
	eventsPublish(ctx, "tr-1", eventsSegments(1))
	values := ctx.Kafka.Values(topic)
	ctx.Equal(len(values), 2, "two segments; records")
	for _, v := range values {
		ctx.Assert(!strings.Contains(v, "415-555-0199") && !strings.Contains(v, "ana@example.com"), "a record on the retained topic carries a phone number or an e-mail address: %s; redact before the produce", v)
	}
	var saved []string
	for _, s := range jobs.Segments(context.Background(), "tr-1") {
		saved = append(saved, s.Text)
	}
	ctx.Equal(saved, []string{"Thanks for holding.", eventsRedacted}, "the job's saved transcript")
}

func CheckSegmentPayload(ctx *harness.Ctx) {
	eventsPublish(ctx, "tr-1", eventsSegments(1))
	all := eventsAll(ctx)
	ctx.Equal(len(all), 2, "two segments; records")
	for i, s := range eventsSegments(1) {
		want := map[string]any{"job_id": "tr-1", "chunk_index": float64(s.ChunkIndex), "start_ms": float64(s.StartMs), "end_ms": float64(s.EndMs), "speaker": s.Speaker}
		for name, value := range want {
			ctx.Equal(all[i][name], value, "the record must carry %s (%v)", name, all[i])
		}
	}
}

func CheckOutboxFromDelivery(ctx *harness.Ctx) {
	// The broker refuses the first record, the one with the phone number and the e-mail address.
	segments := eventsSegments(1)
	segments[0].Text, segments[1].Text = eventsRaw, "Thanks for holding."
	ctx.Kafka.FailNext(topic, 1)
	func() {
		defer func() {
			if e := recover(); e != nil {
				ctx.Fatalf("publishSegments panicked when the broker refused a record: %v; the record goes to the outbox, the worker goes on", e)
			}
		}()
		// No Settle: the worker marks the chunk done as soon as publishSegments returns.
		publishSegments(context.Background(), "tr-1", segments)
	}()
	rows := eventsOutbox(ctx)
	var refused map[string]any
	outboxed := []int{}
	for _, row := range rows {
		payload, _ := row["payload"].(map[string]any)
		ctx.Assert(row["topic"] == topic && row["key"] == "tr-1" && payload != nil, "an outbox row must hold the topic, the job id and the refused payload, got %v", row)
		text, _ := json.Marshal(row)
		ctx.Assert(!strings.Contains(string(text), "415-555-0199") && !strings.Contains(string(text), "ana@example.com"), "an outbox row carries a phone number or an e-mail address: %s; the outbox only ever sees the redacted text", text)
		start, _ := payload["start_ms"].(float64)
		outboxed = append(outboxed, int(start))
		if start == 30000 {
			refused = payload
		}
	}
	ctx.Assert(refused != nil, "the broker refused the record of start_ms 30000 and when publishSegments returned the outbox held %v: the refusal arrives as the returned write error, which must write the row before publishSegments returns (the worker marks the chunk done then)", rows)
	ctx.Equal(refused["text"], eventsRedacted, "the refused payload's text")
	published := []int{}
	for _, e := range eventsAll(ctx) {
		start, _ := e["start_ms"].(float64)
		published = append(published, int(start))
	}
	all := append(append([]int{}, published...), outboxed...)
	sort.Ints(all)
	ctx.Equal(all, []int{30000, 40000}, "each segment once, on the topic (start_ms %v) or in the outbox (start_ms %v), when publishSegments returned; every start_ms", published, outboxed)
	ctx.Settle()
	later := []int{}
	for _, e := range eventsAll(ctx) {
		start, _ := e["start_ms"].(float64)
		later = append(later, int(start))
	}
	for _, row := range eventsOutbox(ctx) {
		payload, _ := row["payload"].(map[string]any)
		start, _ := payload["start_ms"].(float64)
		later = append(later, int(start))
	}
	sort.Ints(later)
	ctx.Equal(later, []int{30000, 40000}, "after publishSegments returned, more landed; each segment once, on the topic or in the outbox; every start_ms")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	eventsPublish(ctx, "tr-1", eventsSegments(1)[:1])
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "one segment; the records on the topic")
	eventsPublish(ctx, "tr-1", eventsSegments(2)[:1])
	lost := ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged the segment. Use RequireAll; the records on the topic", lost)
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

const std::string kRaw = "Call me back at 415-555-0199 or write to ana@example.com.";
const std::string kRedacted = "Call me back at [PHONE] or write to [EMAIL].";

std::vector<jobs::Segment> eventsSegments(int index) {
  const int base = index * 30000;
  return {{index, base, base + 10000, "A", "Thanks for holding."}, {index, base + 10000, base + 20000, "B", kRaw}};
}

void eventsPublish(harness::Ctx& ctx, const std::string& job_id, const std::vector<jobs::Segment>& segments) {
  publishSegments(job_id, segments);
  ctx.Settle();
}

std::vector<nlohmann::json> eventsAll(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& v : ctx.Kafka.Values(kTopic)) out.push_back(nlohmann::json::parse(v, nullptr, false));
  std::sort(out.begin(), out.end(), [](const nlohmann::json& a, const nlohmann::json& b) { return a.value("start_ms", 0) < b.value("start_ms", 0); });
  return out;
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& row : ctx.Redis.LRange("outbox", 0, -1)) out.push_back(nlohmann::json::parse(row, nullptr, false));
  return out;
}

}  // namespace

void CheckJobKey(harness::Ctx& ctx) {
  eventsPublish(ctx, "tr-1", eventsSegments(1));
  eventsPublish(ctx, "tr-1", eventsSegments(0));
  eventsPublish(ctx, "tr-2", eventsSegments(0));
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 6, "three chunks of two segments; the records on %s", kTopic);
  auto keys = ctx.Kafka.Keys(kTopic);
  std::sort(keys.begin(), keys.end());
  ctx.Equal(keys, {"tr-1", "tr-1", "tr-1", "tr-1", "tr-2", "tr-2"}, "records must be keyed by the job id (keyed by chunk, one job's segments spread over partitions and reach the captions out of order)");
  std::set<int> partitions;
  for (const auto& r : records) {
    if (r.Key.value_or("") == "tr-1") partitions.insert(r.Partition);
  }
  ctx.Equal(partitions.size(), 1, "every segment of job tr-1 must land on one partition; partitions");
  std::vector<int> starts;
  for (const auto& r : records) {
    if (r.Key.value_or("") != "tr-1") continue;
    const auto e = nlohmann::json::parse(r.Value.value_or(""), nullptr, false);
    starts.push_back(e.is_object() ? e.value("start_ms", -1) : -1);
  }
  ctx.Equal(starts, {30000, 40000, 0, 10000}, "job tr-1's records on its partition, each chunk's segments in the order they were spoken, one chunk after the other; start_ms in partition order");
}

void CheckRedactBeforePublish(harness::Ctx& ctx) {
  eventsPublish(ctx, "tr-1", eventsSegments(1));
  const auto values = ctx.Kafka.Values(kTopic);
  ctx.Equal(values.size(), 2, "two segments; records");
  for (const auto& v : values) {
    ctx.Assert(v.find("415-555-0199") == std::string::npos && v.find("ana@example.com") == std::string::npos, "a record on the retained topic carries a phone number or an e-mail address: %s; redact before the produce", v);
  }
  std::vector<std::string> saved;
  for (const auto& s : jobs::segments("tr-1")) saved.push_back(s.text);
  ctx.Equal(saved, std::vector<std::string>{"Thanks for holding.", kRedacted}, "the job's saved transcript");
}

void CheckSegmentPayload(harness::Ctx& ctx) {
  eventsPublish(ctx, "tr-1", eventsSegments(1));
  const auto all = eventsAll(ctx);
  ctx.Equal(all.size(), 2, "two segments; records");
  const auto segments = eventsSegments(1);
  for (size_t i = 0; i < segments.size() && i < all.size(); i++) {
    const nlohmann::json want = {{"job_id", "tr-1"}, {"chunk_index", segments[i].chunk_index}, {"start_ms", segments[i].start_ms}, {"end_ms", segments[i].end_ms}, {"speaker", segments[i].speaker}};
    for (const auto& [name, value] : want.items()) {
      ctx.Assert(all[i].is_object() && all[i].contains(name) && all[i][name] == value, "the record must carry %s=%s, got %s", name, value.dump(), all[i].dump());
    }
  }
}

void CheckOutboxFromDelivery(harness::Ctx& ctx) {
  // The broker refuses the first record, the one with the phone number and the e-mail address.
  auto segments = eventsSegments(1);
  segments[0].text = kRaw;
  segments[1].text = "Thanks for holding.";
  ctx.Kafka.FailNext(kTopic, 1);
  try {
    // No Settle: the worker marks the chunk done as soon as publishSegments returns.
    publishSegments("tr-1", segments);
  } catch (const std::exception& e) {
    ctx.Fatalf("publishSegments threw when the broker refused a record: %s; the record goes to the outbox, the worker goes on", e.what());
  }
  const auto rows = eventsOutbox(ctx);
  nlohmann::json refused;
  std::vector<int> outboxed;
  for (const auto& row : rows) {
    const bool shaped = row.is_object() && row.value("topic", "") == kTopic && row.value("key", "") == "tr-1" && row.contains("payload") && row["payload"].is_object();
    ctx.Assert(shaped, "an outbox row must hold the topic, the job id and the refused payload, got %s", row.dump());
    const std::string text = row.dump();
    ctx.Assert(text.find("415-555-0199") == std::string::npos && text.find("ana@example.com") == std::string::npos, "an outbox row carries a phone number or an e-mail address: %s; the outbox only ever sees the redacted text", text);
    const int start = row["payload"].value("start_ms", -1);
    outboxed.push_back(start);
    if (start == 30000) refused = row["payload"];
  }
  ctx.Assert(refused.is_object(), "the broker refused the record of start_ms 30000 and when publishSegments returned the outbox held %s: the refusal arrives in the delivery report (dr_cb), which must write the row before publishSegments returns (the worker marks the chunk done then)", nlohmann::json(rows).dump());
  ctx.Equal(refused.value("text", ""), kRedacted, "the refused payload's text");
  std::vector<int> published;
  for (const auto& e : eventsAll(ctx)) published.push_back(e.is_object() ? e.value("start_ms", -1) : -1);
  std::vector<int> all = published;
  all.insert(all.end(), outboxed.begin(), outboxed.end());
  std::sort(all.begin(), all.end());
  ctx.Equal(all, {30000, 40000}, "each segment once, on the topic (start_ms %v) or in the outbox (start_ms %v), when publishSegments returned; every start_ms", published, outboxed);
  ctx.Settle();
  std::vector<int> later;
  for (const auto& e : eventsAll(ctx)) later.push_back(e.is_object() ? e.value("start_ms", -1) : -1);
  for (const auto& row : eventsOutbox(ctx)) {
    later.push_back(row.is_object() && row.contains("payload") && row["payload"].is_object() ? row["payload"].value("start_ms", -1) : -1);
  }
  std::sort(later.begin(), later.end());
  ctx.Equal(later, {30000, 40000}, "after publishSegments returned, more landed; each segment once, on the topic or in the outbox; every start_ms");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);
  eventsPublish(ctx, "tr-1", {eventsSegments(1)[0]});
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one segment whose acknowledgement was lost: the producer's retry wrote it twice. Set enable.idempotence (with acks=all); the records on the topic");
  eventsPublish(ctx, "tr-1", {eventsSegments(2)[0]});
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the segment. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    'Publish a chunk with a phone number in it and read the topic: the number is there, the record has no timestamps or speaker, and two chunks of one job landed on two partitions.',
    "The key is the chunk index and the payload is built from the raw segment, because redaction runs after the produce, for the saved copy only; the `except KafkaException` sees a full local queue, never the broker's refusal.",
    'Redact first and save; produce `key=job_id` with `start_ms`, `end_ms` and `speaker`; `insert_outbox(TOPIC, job_id, payload)` in an `on_delivery` callback when `err` is set; `enable.idempotence` with `acks=all`.',
  ],
  debrief: `Redaction moved in front of the produce because a topic is the longest-lived copy the service owns: it is retained, replicated and read by consumers nobody audits, so the only safe text to write there is the redacted one. The key is the job because a partition is the only place Kafka keeps order, and captions need one job's segments in order. The outbox row is written where the broker's answer arrives, the delivery report; a \`try\` around \`produce\` only learns about a full local buffer. Production pipelines version the payload in a schema registry, run a relay that drains the outbox with the same idempotent producer, and let the redaction policy differ per tenant.`,
};
