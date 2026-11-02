import type {Step} from '@/lib/types';

export const checkpointEventsStep: Step = {
  id: 'events',
  title: 'Checkpoint events keyed by training run',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/runs/{run_id}/checkpoints\`: it produces one
\`checkpoint.event\` keyed by \`upload_id\` with a payload of \`{id, index}\`, flushes, and answers
\`committed\`. The producer runs with default settings, no commit marker exists before the produce,
and a broker error escapes the request. It compiles, fills the topic in the demo, and hides five flaws.

**Failure mode the checks target.** A run-keyed topic is what makes per-run ordering possible;
publishing the commit before the marker lets a consumer act on a checkpoint a crash rolled back;
a produce path with no outbox turns every broker hiccup into a missing checkpoint record. All of it
is invisible while the broker is up.

- Every event is keyed by the **training run** (\`key=run_id\`), not the upload id, so a run's
  checkpoints and verifications share a partition and stay ordered.
- The event carries the **step number, chunk count and digest**, enough for a consumer to act
  without reading the weights.
- The commit event is published **only after the commit marker is durable**:
  \`write_commit_marker\` runs before \`publish_event\`.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent), so a retried produce
  cannot duplicate a record.
- When the broker rejects the produce, the event goes to the **outbox** (\`insert_outbox\`) instead
  of being dropped.`,
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
        'The message key is the training run, so one run’s events land in one partition and stay ordered. The starter keys by upload id, which scatters a run’s checkpoints across partitions.',
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
        'The commit marker is written first and the event is published after it, so the topic never announces a commit that a crash rolled back. The starter publishes first and persists the marker afterwards.',
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
        'A rejected produce writes an outbox row instead of losing the event. The starter lets the broker error escape the request, so an outage silently drops checkpoint records.',
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
        'The event payload holds the run’s step number, the chunk count and the digest, so a consumer can act without the weights. The starter publishes only an id and an index.',
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
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
      starter: `/** checkpoint.event: keys by upload id and publishes early. */
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
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    'A consumer sees a verification before the commit it belongs to, acts on a commit the API crashed before persisting, and after a short broker outage has no record of several checkpoints at all.',
    'The key is the upload id, so one run spans partitions; the produce happens before any marker exists; the payload has no step or digest; and a rejected produce raises straight out of the handler.',
    'Call `write_commit_marker` first, then `publish_event` with `key=run_id` and `step`, `chunks`, `digest` in the value; configure `enable.idempotence` and `acks: all`; on a broker error call `insert_outbox`.',
  ],
  debrief: `The fix treats the topic as a truthful, ordered log of committed state rather than a notification channel. Partitioning by the run is what makes "the latest commit for this run" a question with one answer, because Kafka orders only within a partition. Writing the marker before producing means the event describes state that already survived: a crash between the two leaves a committed checkpoint without an event, which is recoverable, instead of an event without a checkpoint. The idempotent producer and the outbox close the remaining gaps: a retried produce cannot duplicate, and a rejected one is deferred rather than lost. Production platforms add a schema registry so the payload cannot drift, a per-run event id for consumer-side deduplication, and a relay that drains the outbox in key order.`,
};
