import type {Step} from '@/lib/types';

export const transcriptionEventsStep: Step = {
  id: 'events',
  title: 'Transcript segments keyed by job, PII redacted before publish',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'redactor', 'kafka', 'db'],
  task: `## Task

**Starting point.** The starter's \`publish_segment\` builds a JSON payload of job id, chunk index,
text and timestamps, produces it to \`transcript.segment\` keyed by the chunk index through a bare
producer, flushes, and then calls the redactor. It compiles, it serves the demo, and it hides five
flaws.

**Failure mode the checks target.** Kafka orders records per partition, and the key is the only
thing that decides the partition, so a key of \`chunk_index\` throws away per-job ordering for free.
The redaction order is the second half of the same sentence: a topic is the longest-lived copy of a
transcript you own, so publishing before the redaction pass writes the raw audio transcript into
storage that no buffer TTL will reclaim. The rest is what a demo cannot show: a produce the broker
rejected, a leader failover, a line with no speaker.

Each finished chunk publishes one \`transcript.segment\` record:

- **Keyed by job id**, so every segment of one job lands on one partition in produce order and the
  consumer reassembles the transcript without sorting.
- **Redaction runs before the produce.** The worker sends the text to the redactor and only the
  *redacted* text goes into the record.
- **The payload carries timestamps and the speaker label**:
  \`{"job_id", "chunk_index", "text", "start_s", "end_s", "speaker_label"}\`.
- **An outbox row on rejection.** If the producer rejects the record (broker down, acks not met),
  \`INSERT INTO outbox (id, topic, key, payload)\` so the segment survives and the relay publishes it
  later.
- **A durable producer.** \`acks=all\` and the idempotent producer, so a segment survives a broker
  failover and the producer's own retries do not publish it twice.`,
  sequence: {
    participants: ['Chunk worker', 'Redactor', 'transcript.segment topic', 'jobs store'],
    messages: [
      {
        from: 'Chunk worker',
        to: 'Redactor',
        label: 'redact segment text · keep start_s, end_s, speaker_label',
        kind: 'sync',
      },
      {from: 'Redactor', to: 'Chunk worker', label: 'redacted text', kind: 'reply'},
      {
        from: 'Chunk worker',
        to: 'transcript.segment topic',
        label: 'produce transcript.segment · key = job id',
        kind: 'async',
      },
      {from: 'transcript.segment topic', to: 'Chunk worker', label: 'reject · acks not met', kind: 'reply'},
      {
        from: 'Chunk worker',
        to: 'jobs store',
        label: 'INSERT INTO outbox (id, topic, key, payload) on reject',
        kind: 'sync',
      },
      {from: 'jobs store', to: 'Chunk worker', label: 'row committed', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'key-by-job',
      title: 'Keys the record by job id, not by chunk index',
      detail:
        'The record key is the **job id**, so every segment of one job hashes to the same partition and keeps its produce order. The starter keys by `chunk_index`, which interleaves segments from concurrent jobs and scatters one job across partitions.',
      match: {
        python: {all: [/key=job_id/], none: [/key=str\(chunk_index\)|key=chunk_index/]},
        typescript: {
          all: [/key:\s*job_id|key:\s*jobId/],
          none: [/key:\s*String\(chunk_index\)|key:\s*chunk_index/],
        },
        go: {
          all: [/Key:\s*\[\]byte\(jobID\)/],
          none: [/Key:\s*\[\]byte\(strconv\.Itoa\(chunkIndex\)\)/],
        },
        scala: {
          all: [/ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*jobId/],
          none: [/ProducerRecord\[[^\]]*\]\([^)]*chunkIndex/],
        },
        cpp: {
          all: [/const std::string&\s*key\s*=\s*job_id/],
          none: [/key\s*=\s*std::to_string\(chunk_index\)/],
        },
      },
    },
    {
      id: 'redact-before-publish',
      title: 'Redacts the segment before the produce, not after',
      detail:
        'The redactor runs first and only the redacted text goes into the record: `redact` appears before `produce`/`send`/`WriteMessages`. The starter produces the raw text and calls the redactor afterwards, so the retained topic holds a copy the redaction pass never touched.',
      match: {
        python: {all: [/redactor\.redact\(/], order: [/redact\(/, /producer\.produce\(/]},
        typescript: {all: [/redact\(/], order: [/redact\(/, /producer\.send\(/]},
        go: {all: [/redact\(/], order: [/redact\(/, /writer\.WriteMessages\(/]},
        scala: {all: [/redact\(/], order: [/redact\(/, /producer\.send\(/]},
        cpp: {all: [/redact\(/], order: [/redact\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'segment-payload',
      title: 'The payload carries timestamps and the speaker label',
      detail:
        '`start_s`, `end_s` and `speaker_label` travel with the redacted `text`, so the read path can assemble a transcript with timings and attribute each line. The starter ships the timestamps but drops the speaker label.',
      match: {
        python: {all: [/"start_s"/, /"end_s"/, /speaker_label/]},
        typescript: {all: [/\bstart_s\b/, /\bend_s\b/, /\bspeaker_label\b/]},
        go: {all: [/"start_s"/, /"end_s"/, /"speaker_label"/]},
        scala: {all: [/"start_s"/, /"end_s"/, /speaker_label/]},
        cpp: {all: [/"start_s"/, /"end_s"/, /speaker_label/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Writes an outbox row when the produce is rejected',
      detail:
        'A rejected produce becomes an `INSERT INTO outbox (id, topic, key, payload)` row so the segment survives the broker and the relay can publish it later. The starter catches the failure and drops the event: the chunk counts as complete while its segment is gone.',
      match: {
        python: {all: [/INSERT INTO outbox \(id, topic, key, payload\)/, /except/]},
        typescript: {all: [/INSERT INTO outbox \(id, topic, key, payload\)/, /catch/]},
        go: {all: [/INSERT INTO outbox \(id, topic, key, payload\)/, /err != nil/]},
        scala: {all: [/INSERT INTO outbox \(id, topic, key, payload\)/, /catch/]},
        cpp: {all: [/INSERT INTO outbox \(id, topic, key, payload\)/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'producer-acks',
      title: 'Producer waits for all replicas and is idempotent',
      detail:
        '`acks=all` means a leader failover cannot lose an acknowledged segment, and the idempotent producer keeps its own retries from publishing one segment twice. The starter uses a bare producer with default acks and no idempotence.',
      match: {
        python: {all: [/acks/, /enable\.idempotence/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/props\.put\(\s*"acks"\s*,\s*"all"\s*\)/, /enable\.idempotence/]},
        cpp: {all: [/conf->set\("acks",\s*"all"/, /enable\.idempotence/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

log = logging.getLogger("transcription-events")

TOPIC = "transcript.segment"
producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_segment(job_id: str, chunk_index: int, text: str, start_s: float, end_s: float) -> None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = json.dumps(
        {
            "job_id": job_id,
            "chunk_index": chunk_index,
            "text": text,
            "start_s": start_s,
            "end_s": end_s,
        }
    )
    producer.produce(TOPIC, key=str(chunk_index), value=payload)
    producer.flush(10000)
    redactor.redact(text)
`,
      solution: `import json
import logging

from confluent_kafka import KafkaError, Producer

log = logging.getLogger("transcription-events")

TOPIC = "transcript.segment"
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
    }
)


def publish_segment(
    cur,
    job_id: str,
    chunk_index: int,
    text: str,
    start_s: float,
    end_s: float,
    speaker_label: str,
) -> None:
    """Redact first, then produce keyed by job id; a rejected produce leaves an outbox row."""
    redacted = redactor.redact(text)
    payload = json.dumps(
        {
            "job_id": job_id,
            "chunk_index": chunk_index,
            "text": redacted,
            "start_s": start_s,
            "end_s": end_s,
            "speaker_label": speaker_label,
        }
    )
    try:
        producer.produce(TOPIC, key=job_id, value=payload)
        producer.flush(10000)
    except KafkaError as error:
        log.warning("segment produce rejected job=%s chunk=%s: %s", job_id, chunk_index, error)
        cur.execute(
            "INSERT INTO outbox (id, topic, key, payload) VALUES (%s, %s, %s, %s)",
            (f"{job_id}:{chunk_index}", TOPIC, job_id, payload),
        )
`,
    },
    typescript: {
      starter: `/** A segment publisher: raw text out, keyed by chunk index. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'transcription-events', brokers: ['kafka:9092']});
const producer = kafka.producer();

export const TOPIC = 'transcript.segment';

export async function publishSegment(
  cur: Queryable,
  job_id: string,
  chunk_index: number,
  text: string,
  start_s: number,
  end_s: number,
): Promise<void> {
  await producer.connect();
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  await producer.send({
    topic: TOPIC,
    messages: [
      {key: String(chunk_index), value: JSON.stringify({job_id, chunk_index, text, start_s, end_s})},
    ],
  });
  redact(text);
}
`,
      solution: `/** Segment publisher: redact first, key by job id, keep the row when the broker rejects. */
import {Kafka, type Producer} from 'kafkajs';

const kafka = new Kafka({clientId: 'transcription-events', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer({idempotent: true});

export const TOPIC = 'transcript.segment';

export async function publishSegment(
  cur: Queryable,
  job_id: string,
  chunk_index: number,
  text: string,
  start_s: number,
  end_s: number,
  speaker_label: string,
): Promise<void> {
  const redacted = redact(text);
  const payload = JSON.stringify({job_id, chunk_index, text: redacted, start_s, end_s, speaker_label});
  await producer.connect();
  try {
    // acks: -1 waits for all in-sync replicas; the idempotent producer makes its retries safe.
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: job_id, value: payload}]});
  } catch (error) {
    console.warn(\`segment produce rejected job=\${job_id} chunk=\${chunk_index}\`, error);
    await cur.query('INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)', [
      \`\${job_id}:\${chunk_index}\`,
      TOPIC,
      job_id,
      payload,
    ]);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"strconv"

	"github.com/segmentio/kafka-go"
)

const topic = "transcript.segment"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092")}

func publishSegment(ctx context.Context, cur *sql.DB, jobID string, chunkIndex int, text string, startS, endS float64) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(map[string]any{
		"job_id":      jobID,
		"chunk_index": chunkIndex,
		"text":        text,
		"start_s":     startS,
		"end_s":       endS,
	})
	if err := writer.WriteMessages(ctx, kafka.Message{Topic: topic, Key: []byte(strconv.Itoa(chunkIndex)), Value: payload}); err != nil {
		log.Printf("segment produce failed job=%s: %v", jobID, err)
	}
	redact(text)
	return nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"strconv"

	"github.com/segmentio/kafka-go"
)

const topic = "transcript.segment"

// RequiredAcks all: an acknowledged segment survives a leader failover.
// (kafka-go has no idempotent mode; this is what it can promise.)
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

func publishSegment(ctx context.Context, cur *sql.DB, jobID string, chunkIndex int, text string, startS, endS float64, speakerLabel string) error {
	redacted := redact(text)
	payload, err := json.Marshal(map[string]any{
		"job_id":        jobID,
		"chunk_index":   chunkIndex,
		"text":          redacted,
		"start_s":       startS,
		"end_s":         endS,
		"speaker_label": speakerLabel,
	})
	if err != nil {
		return err
	}
	// Key by job id: every segment of one job lands on the same partition and keeps its order.
	if err := writer.WriteMessages(ctx, kafka.Message{Topic: topic, Key: []byte(jobID), Value: payload}); err != nil {
		// The segment must not be lost: keep the outbox row for the relay to publish later.
		log.Printf("segment produce rejected job=%s chunk=%d: %v", jobID, chunkIndex, err)
		if _, dbErr := cur.ExecContext(
			ctx,
			"INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)",
			jobID+":"+strconv.Itoa(chunkIndex), topic, jobID, string(payload),
		); dbErr != nil {
			return dbErr
		}
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object TranscriptEvents {
  val Topic = "transcript.segment"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def publishSegment(jobId: String, chunkIndex: Int, text: String, startS: Double, endS: Double): Unit = {
    val payload = s"""{"job_id":"$jobId","chunk_index":$chunkIndex,"text":"$text","start_s":$startS,"end_s":$endS}"""
    producer.send(new ProducerRecord[String, String](Topic, chunkIndex.toString, payload))
    redact(text)
  }
}
`,
      solution: `import java.sql.Connection
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object TranscriptEvents {
  val Topic = "transcript.segment"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  val producer = new KafkaProducer[String, String](props)

  def publishSegment(conn: Connection, jobId: String, chunkIndex: Int, text: String, startS: Double, endS: Double, speakerLabel: String): Unit = {
    val redacted = redact(text)
    val payload = s"""{"job_id":"$jobId","chunk_index":$chunkIndex,"text":"$redacted","start_s":$startS,"end_s":$endS,"speaker_label":"$speakerLabel"}"""
    try {
      // Key by job id: one job's segments share a partition and keep their order.
      producer.send(new ProducerRecord[String, String](Topic, jobId, payload)).get()
    } catch {
      case error: Exception =>
        val insert = conn.prepareStatement("INSERT INTO outbox (id, topic, key, payload) VALUES (?, ?, ?, ?)")
        insert.setString(1, jobId + ":" + chunkIndex)
        insert.setString(2, Topic)
        insert.setString(3, jobId)
        insert.setString(4, payload)
        insert.executeUpdate()
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <string>
#include <vector>

const std::string kTopic = "transcript.segment";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
void publish_segment(pqxx::work& tx, const std::string& job_id, int chunk_index, const std::string& text, double start_s, double end_s) {
  const std::string key = std::to_string(chunk_index);
  const std::string payload =
      "{\\"job_id\\":\\"" + job_id + "\\",\\"chunk_index\\":" + std::to_string(chunk_index) + ",\\"text\\":\\"" + text +
      "\\",\\"start_s\\":" + std::to_string(start_s) + ",\\"end_s\\":" + std::to_string(end_s) + "}";
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                    payload.size(), key.c_str(), key.size(), 0, nullptr);
  redact(text);
  producer->flush(10000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

const std::string kTopic = "transcript.segment";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void publish_segment(pqxx::work& tx, const std::string& job_id, int chunk_index, const std::string& text, double start_s, double end_s, const std::string& speaker_label) {
  const std::string redacted = redact(text);
  // Key by job id: one job's segments share a partition and keep their order.
  const std::string& key = job_id;
  const std::string payload = nlohmann::json{
      {"job_id", job_id},
      {"chunk_index", chunk_index},
      {"text", redacted},
      {"start_s", start_s},
      {"end_s", end_s},
      {"speaker_label", speaker_label},
  }.dump();
  const auto error = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                       const_cast<char*>(payload.data()), payload.size(), key.c_str(), key.size(), 0, nullptr);
  if (error != RdKafka::ERR_NO_ERROR) {
    // The segment must not be lost: keep the outbox row for the relay to publish later.
    tx.exec_params("INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)", job_id, kTopic, key, payload);
  }
  producer->flush(10000);
}
`,
    },
  },
  hints: [
    "Symptom: a consumer rebuilding one job reads its segments interleaved with other jobs' and out of order, a compliance scan finds raw card numbers in the retained topic, and diarized lines have no speaker.",
    'Mechanism: the key is `str(chunk_index)`, so the partition follows the chunk, not the job; `redactor.redact` runs after `produce`, on text already sent; nothing guards the send and the producer uses default acks.',
    'Change: `key=job_id`; `text = redactor.redact(text)` before `produce`; add `speaker_label` to the payload; wrap the produce in try/except and `INSERT INTO outbox (id, topic, key, payload)` on failure; configure `acks=all`, `enable.idempotence=true`.',
  ],
  debrief: `The key carries ordering because Kafka orders only within a partition and the key is the only lever on partition choice; keyed by \`job_id\`, one job's segments arrive in produce order and the consumer does no sorting. Redaction runs before the produce because the topic is the most retained copy of the transcript in the system and no buffer TTL reaches it, so the order of two calls decides whether raw speech is stored for the topic's lifetime. The outbox row turns a rejected produce from a lost minute into a deferred one, which keeps "the segment exists if the chunk was transcribed" true; \`acks=all\` plus idempotence makes the retry that follows safe. Production pipelines also version the payload schema so consumers can tell old segments from new.`,
};
