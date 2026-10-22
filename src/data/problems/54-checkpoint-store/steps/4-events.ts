import type {Step} from '@/lib/types';

export const checkpointEventsStep: Step = {
  id: 'events',
  title: 'Checkpoint events keyed by training run',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces an event on the
happy path and the topic fills up, so the demo shows checkpoints arriving. Three production
contracts are broken. Find them, fix them, and prove the fix with the checks below.

\`POST /v1/runs/{run_id}/checkpoints\` commits a checkpoint, and every chunk accept, commit and
verification publishes one \`checkpoint.event\`.

- Every event is keyed by the **training run**, not by the upload id. The key is the partition key,
  so a run's checkpoints and verifications stay ordered; keyed by upload id, one run's events scatter
  across partitions and "the last commit" becomes a guess.
- The event carries the **step number, chunk count and digest** — enough for a consumer to reason
  about a checkpoint without reading the weights.
- The commit event is published **only after the commit marker is durable**: the marker is what a
  resume trusts, so an event announcing a commit that never persisted is a lie the topic keeps
  forever.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks \`all\`
  plus a stable key), so a retry of a produce cannot duplicate a record.
- When the broker rejects the produce, the event goes to the **outbox** instead of being dropped. The
  draft lets the exception escape and the event is lost, which is exactly the case an outage makes
  common.

**Failure mode the checks target.** A run-keyed topic is what makes per-run ordering possible at
all; publishing the commit before the marker means a consumer can act on a checkpoint that a crash
rolled back; and a produce path with no outbox turns every broker hiccup into a missing checkpoint
record. All three are invisible in a demo where the broker is up and the process never crashes.`,
  sequence: {
    participants: ['Checkpoint API', 'checkpoint.event', 'Event consumer'],
    messages: [
      {
        from: 'Checkpoint API',
        to: 'Checkpoint API',
        label: 'writeCommitMarker(run, step, chunks, digest)',
        kind: 'sync',
      },
      {from: 'Checkpoint API', to: 'checkpoint.event', label: 'produce · key = run · acks = all', kind: 'sync'},
      {from: 'checkpoint.event', to: 'Checkpoint API', label: 'ack / broker error', kind: 'reply'},
      {from: 'Checkpoint API', to: 'Checkpoint API', label: 'insertOutbox(run, event) on rejection', kind: 'async'},
      {from: 'checkpoint.event', to: 'Event consumer', label: 'consume · ordered per run', kind: 'async'},
      {from: 'Event consumer', to: 'checkpoint.event', label: 'commit offset after processing', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'run-key',
      title: 'Keys every event by training run',
      detail:
        'The message key is the training run, so one run’s events land in one partition and stay ordered. The draft keys by upload id, which scatters a run’s checkpoints across partitions.',
      match: {
        python: {all: [/key=run_id/]},
        typescript: {all: [/key:\s*runId/]},
        go: {all: [/Key:\s*\[\]byte\(runID\)/]},
        scala: {all: [/"checkpoint\.event",\s*runId/]},
        cpp: {all: [/produce\([^;\n]*runId/]},
      },
    },
    {
      id: 'commit-after-marker',
      title: 'Publishes the commit only after the marker is durable',
      detail:
        'The commit marker is written first and the event is published after it, so the topic never announces a commit that a crash rolled back. The draft publishes first and persists the marker afterwards.',
      match: {
        python: {order: [/write_commit_marker\(/, /publish_event\(/]},
        typescript: {order: [/writeCommitMarker\(/, /publishEvent\(/]},
        go: {order: [/writeCommitMarker\(/, /publishEvent\(/]},
        scala: {order: [/writeCommitMarker\(/, /publishEvent\(/]},
        cpp: {order: [/WriteCommitMarker\(/, /PublishEvent\(/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Falls back to the outbox when the produce is rejected',
      detail:
        'A rejected produce writes an outbox row instead of losing the event. The draft lets the broker error escape the request, so an outage silently drops checkpoint records.',
      match: {
        python: {all: [/insert_outbox\(/]},
        typescript: {all: [/insertOutbox\(/]},
        go: {all: [/InsertOutbox\(/]},
        scala: {all: [/insertOutbox\(/]},
        cpp: {all: [/InsertOutbox\(/]},
      },
    },
    {
      id: 'event-fields',
      title: 'Carries step number, chunk count and digest',
      detail:
        'The event payload holds the run’s step number, the chunk count and the digest, so a consumer can act without the weights. The draft publishes only an id and an index.',
      match: {
        python: {all: [/"chunks"/, /"digest"/, /"step"/]},
        typescript: {all: [/chunks:/, /digest:/, /step:/]},
        go: {all: [/"chunks":/, /"digest":/, /"step":/]},
        scala: {all: [/chunks/, /digest/, /step/]},
        cpp: {all: [/"chunks"/, /"digest"/, /"step"/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Runs an idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` plus `acks`, KafkaJS’s `idempotent: true` and `acks: -1`, or required acks `all` with a hash balancer. A produce retry must not duplicate a checkpoint event.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
producer = Producer({"bootstrap.servers": "kafka:9092"})


class ChunkEvent(BaseModel):
    upload_id: str
    index: int


@app.post("/v1/runs/{run_id}/checkpoints")
def commit(run_id: str, body: ChunkEvent, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft keys by upload id instead of the training run, publishes the commit event
    # before the commit marker is durable, and lets a broker rejection drop the event. Key by run,
    # publish after the marker, carry the step, chunk count and digest, and write an outbox row when
    # the produce fails.
    producer.produce(
        "checkpoint.event",
        key=body.upload_id,
        value=json.dumps({"id": body.upload_id, "index": body.index}),
    )
    producer.flush(2.0)
    return {"run_id": run_id, "state": "committed"}
`,
      solution: `import json

import redis
from confluent_kafka import KafkaException, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class CheckpointEvent(BaseModel):
    run_id: str
    step: int
    chunks: int
    digest: str


class OutboxStore:
    def insert_outbox(self, run_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


outbox = OutboxStore()


def write_commit_marker(run_id: str, step: int, chunks: int, digest: str) -> None:
    """The marker a resume trusts: durable before any commit event leaves the service."""
    raise NotImplementedError


def publish_event(run_id: str, event: dict) -> None:
    try:
        producer.produce("checkpoint.event", key=run_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        outbox.insert_outbox(run_id, event)


@app.post("/v1/runs/{run_id}/checkpoints")
def commit(run_id: str, body: CheckpointEvent, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    write_commit_marker(run_id, body.step, body.chunks, body.digest)
    publish_event(
        run_id,
        {
            "id": body.run_id,
            "step": body.step,
            "chunks": body.chunks,
            "digest": body.digest,
            "state": "committed",
        },
    )
    return {"run_id": run_id, "state": "committed"}
`,
    },
    typescript: {
      starter: `/** checkpoint.event: a model-generated draft that keys by upload id and publishes early. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'checkpoint-store', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

interface ChunkEvent {
  upload_id: string;
  index: number;
}

app.post('/v1/runs/:runId/checkpoints', async (request, reply) => {
  // TODO: this draft keys by upload id instead of the training run, publishes the commit event
  // before the commit marker is durable, and lets a broker rejection drop the event. Key by run,
  // publish after the marker, carry the step, chunk count and digest, and write an outbox row when
  // the produce fails.
  const tenant = request.headers['x-tenant-id'] as string;
  const {runId} = request.params as {runId: string};
  const body = request.body as ChunkEvent;
  await producer.send({
    topic: 'checkpoint.event',
    messages: [{key: body.upload_id, value: JSON.stringify({id: body.upload_id, index: body.index})}],
  });
  await r.set(\`committed:\${runId}\`, '1');
  return reply.code(202).send({run_id: runId, state: 'committed'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** checkpoint.event: one event per checkpoint keyed by training run; marker first, then publish. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

import {outbox} from './outbox';

export const app = Fastify();
const kafka = new Kafka({clientId: 'checkpoint-store', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1, acks: -1});
void producer.connect();
const r = new Redis('redis://redis:6379');

interface CheckpointEvent {
  run_id: string;
  step: number;
  chunks: number;
  digest: string;
}

/** The marker a resume trusts: durable before any commit event leaves the service. */
export async function writeCommitMarker(runId: string, step: number, chunks: number, digest: string): Promise<void> {
  await r.set(\`committed:\${runId}\`, \`\${step}:\${digest}:\${chunks}\`);
}

export async function publishEvent(runId: string, event: Record<string, unknown>): Promise<void> {
  try {
    await producer.send({
      topic: 'checkpoint.event',
      messages: [{key: runId, value: JSON.stringify(event)}],
    });
  } catch {
    await outbox.insertOutbox(runId, event);
  }
}

app.post('/v1/runs/:runId/checkpoints', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {runId} = request.params as {runId: string};
  const body = request.body as CheckpointEvent;

  await writeCommitMarker(runId, body.step, body.chunks, body.digest);
  await publishEvent(runId, {
    id: body.run_id,
    step: body.step,
    chunks: body.chunks,
    digest: body.digest,
    state: 'committed',
  });
  return reply.code(202).send({run_id: runId, state: 'committed'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	kafka "github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "checkpoint.event"}

type ChunkEvent struct {
	UploadID string \`json:"upload_id"\`
	Index    int    \`json:"index"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func commit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	runID := r.PathValue("runId")
	var body ChunkEvent
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft keys by upload id instead of the training run, publishes the commit event
	// before the commit marker is durable, and lets a broker rejection drop the event. Key by run,
	// publish after the marker, carry the step, chunk count and digest, and write an outbox row when
	// the produce fails.
	payload, _ := json.Marshal(map[string]any{"id": body.UploadID, "index": body.Index})
	if err := writer.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.UploadID), Value: payload}); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]string{"run_id": runID, "state": "committed"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/runs/{runId}/checkpoints", commit)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	kafka "github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "checkpoint.event",
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type CheckpointEvent struct {
	RunID  string \`json:"run_id"\`
	Step   int    \`json:"step"\`
	Chunks int    \`json:"chunks"\`
	Digest string \`json:"digest"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// writeCommitMarker records the marker a resume trusts, before any commit event is published.
func writeCommitMarker(ctx context.Context, runID string, step, chunks int, digest string) error {
	return nil
}

func publishEvent(ctx context.Context, runID string, event map[string]any) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(runID), Value: payload}); err != nil {
		return InsertOutbox(ctx, runID, event)
	}
	return nil
}

func commit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	runID := r.PathValue("runId")
	var body CheckpointEvent
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	if err := writeCommitMarker(r.Context(), runID, body.Step, body.Chunks, body.Digest); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "commit unavailable"})
		return
	}
	event := map[string]any{
		"id":     body.RunID,
		"step":   body.Step,
		"chunks": body.Chunks,
		"digest": body.Digest,
		"state":  "committed",
	}
	if err := publishEvent(r.Context(), runID, event); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "event queued in outbox"})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]string{"run_id": runID, "state": "committed"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/runs/{runId}/checkpoints", commit)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object Events {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  def commit(runId: String, uploadId: String, index: Int): Unit = {
    // TODO: this draft keys by upload id instead of the training run, publishes the commit event
    // before the commit marker is durable, and lets a broker rejection drop the event. Key by run,
    // publish after the marker, carry the step, chunk count and digest, and write an outbox row when
    // the produce fails.
    val record = new ProducerRecord[String, String]("checkpoint.event", uploadId, s"""{"id":"$uploadId","index":$index}""")
    producer.send(record)
    producer.flush()
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object Events {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  val producer = new KafkaProducer[String, String](props)

  /** The marker a resume trusts, recorded before the commit event leaves the service. */
  def writeCommitMarker(runId: String, step: Int, chunks: Int, digest: String): Unit = ()

  def publishEvent(runId: String, event: String): Unit = {
    try {
      val record = new ProducerRecord[String, String]("checkpoint.event", runId, event)
      producer.send(record)
      producer.flush()
    } catch {
      case _: org.apache.kafka.common.KafkaException => insertOutbox(runId, event)
    }
  }

  def commit(runId: String, step: Int, chunks: Int, digest: String): Unit = {
    writeCommitMarker(runId, step, chunks, digest)
    val event =
      s"""{"id":"$runId","step":$step,"chunks":$chunks,"digest":"$digest","state":"committed"}"""
    publishEvent(runId, event)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

void Commit(const std::string& runId, const std::string& uploadId, int index, RdKafka::Producer& producer) {
  // TODO: this draft keys by upload id instead of the training run, publishes the commit event
  // before the commit marker is durable, and lets a broker rejection drop the event. Key by run,
  // publish after the marker, carry the step, chunk count and digest, and write an outbox row when
  // the produce fails.
  const json event = {{"id", uploadId}, {"index", index}};
  const auto payload = event.dump();
  producer.produce("checkpoint.event", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                   const_cast<char*>(payload.data()), payload.size(), uploadId.c_str(), uploadId.size(), 0, nullptr);
  producer.flush(2000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

const std::string kCheckpointTopic = "checkpoint.event";

std::unique_ptr<RdKafka::Producer> MakeProducer() {
  std::string error;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", error);
  conf->set("enable.idempotence", "true", error);
  conf->set("acks", "all", error);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf, error));
}

/** The marker a resume trusts, recorded before the commit event leaves the service. */
void WriteCommitMarker(const std::string& runId, int step, int chunks, const std::string& digest);

void PublishEvent(const std::string& runId, const json& event, RdKafka::Producer& producer) {
  const auto payload = event.dump();
  const auto error = producer.produce(kCheckpointTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), runId.c_str(), runId.size(), 0, nullptr);
  if (error != RdKafka::ERR_NO_ERROR) {
    InsertOutbox(runId, event);
    return;
  }
  producer.flush(2000);
}

void Commit(const std::string& runId, int step, int chunks, const std::string& digest, RdKafka::Producer& producer) {
  WriteCommitMarker(runId, step, chunks, digest);
  const json event = {
      {"id", runId}, {"step", step}, {"chunks", chunks}, {"digest", digest}, {"state", "committed"}};
  PublishEvent(runId, event, producer);
}
`,
    },
  },
  hints: [
    'The message key is the partition key. Key it by the training run (`key=run_id`, `key: runId`, `Key: []byte(runID)`, `new ProducerRecord("checkpoint.event", runId, …)`) so a run’s commit and verification events share a partition and stay ordered.',
    'Order the two writes: the marker is what a resume trusts, so `writeCommitMarker(...)` runs first and `publishEvent(...)` after it. An event is a notification about durable state, never a substitute for it.',
    'Durability is three separate things: an idempotent producer with `acks=all` so a retry cannot duplicate a record, a key that stays the same across retries, and an outbox row when the broker rejects the produce. The outbox is what makes a broker outage a delay instead of a missing checkpoint record.',
  ],
  debrief: `The interviewer is testing whether you can review a generated event path for ordering and durability. The draft produces a record and the topic fills up, which is all a demo needs; what a platform needs is that the topic is a truthful, ordered log of committed state. That gives three rules: partition by the entity whose order matters (the run), publish after the durable state rather than before it, and never let a broker rejection delete an event. Real platforms add a schema registry so the payload cannot drift, a per-run event id for consumer-side deduplication, a relay that drains the outbox in key order, and retention per topic because checkpoint events outlive the checkpoints they describe.`,
};
