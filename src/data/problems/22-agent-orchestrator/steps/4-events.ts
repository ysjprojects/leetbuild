import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Run events keyed by run, replayable',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'kafka', 'consumer', 'transcript'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces an \`agent.step\`
event on every step transition and the consumer appends it to the run's transcript, so the demo shows
a transcript growing. It compiles, it serves the happy path, and it hides four production flaws.
Review it like the service owner, fix it, and prove the fix with the checks below.

Implement the event path of the orchestrator: the step loop publishes **exactly one** \`agent.step\`
event per transition, and a **transcript consumer** in group \`transcript\` turns those events into the
per-run transcript.

- The record's **key is the run id**: one run, one partition, so every step of a run is consumed in
  order. Keying by the worker id interleaves the steps of every run that worker touched and lets two
  steps of the same run arrive out of order.
- The payload carries \`run_id\`, \`step_seq\` and the transition's state. \`step_seq\` is assigned by the
  state machine under the worker lease, so it is unique and monotonic within a run.
- The producer is **idempotent with \`acks=all\`** (\`enable.idempotence=true\` with \`"acks": "all"\`,
  KafkaJS's \`idempotent: true\` with \`acks: -1\`, or required acks \`all\` plus a hash balancer), so a
  producer retry cannot duplicate or reorder a step event.
- The transition is **committed before** the event is produced. Publishing first means a crash in
  that window loses the event while the state has already moved on, and the transcript is
  permanently missing a step the run actually took.
- When the broker rejects the produce, write an **outbox** row (\`insert_outbox(run_id, step_seq, event)\`)
  and let a relay republish it. Never drop the event, and never fail the step for a broker hiccup.
- The consumer dedupes by **\`(run_id, step_seq)\`**: build the idempotency key from the two fields,
  append only when the key was new, and **commit the offset only after** that work. A redelivery must
  add nothing to the transcript and nothing to the step counters.

**Failure mode the checks target.** Keying by the worker id scatters one run's steps across
partitions, so the transcript can be reassembled out of order — wrong in a way nobody notices until a
customer reads it. Producing before the state commit turns every crash in that window into a lost
step. A producer left at its defaults can duplicate or reorder on retry. A produce the broker rejects
is dropped, so the run took a step the transcript never recorded. And a consumer with no dedupe key
double-counts every redelivery: the same step appended twice and analytics one step higher than the
run's budget says.`,
  sequence: {
    participants: ['Worker', 'Run state', 'agent.step', 'Transcript consumer'],
    messages: [
      {from: 'Worker', to: 'Run state', label: 'COMMIT transition (run_id, step_seq)', kind: 'sync'},
      {from: 'Run state', to: 'Worker', label: 'state + step_seq', kind: 'reply'},
      {from: 'Worker', to: 'agent.step', label: 'produce · key = run id · acks = all', kind: 'sync'},
      {from: 'agent.step', to: 'Worker', label: 'ack / broker error', kind: 'reply'},
      {from: 'Worker', to: 'Worker', label: 'insert_outbox(run_id, step_seq) on failure', kind: 'sync'},
      {from: 'agent.step', to: 'Transcript consumer', label: 'consume · group transcript', kind: 'async'},
      {from: 'Transcript consumer', to: 'Transcript consumer', label: 'dedupe (run_id, step_seq)', kind: 'sync'},
      {from: 'Transcript consumer', to: 'agent.step', label: 'commit offset after the append', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'run-key',
      title: 'Keys every event by run id',
      detail:
        'The produced record is keyed by the **run id** — one run, one partition, so its steps are consumed in order. The draft keys by the worker id, so two steps of the same run can land in different partitions and the transcript is written out of order.',
      match: {
        python: {all: [/key=run_id/], none: [/key=worker_id/]},
        typescript: {all: [/key:\s*runId\b/, /run_id/], none: [/key:\s*workerId\b/]},
        go: {all: [/Key:\s*\[\]byte\(runID\)/], none: [/Key:\s*\[\]byte\(body\.WorkerID\)/]},
        scala: {all: [/ProducerRecord\("agent\.step",\s*runId/], none: [/ProducerRecord\("agent\.step",\s*workerId/]},
        cpp: {all: [/produce\([^;\n]*runId\.data\(\)/], none: [/produce\([^;\n]*workerId\.data\(\)/]},
      },
    },
    {
      id: 'acks-all',
      title: 'Produces idempotently with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` + `acks=all`, KafkaJS’s `idempotent: true` + `acks: -1`, or required acks `all` with a `Hash` balancer), so a retry of a produce cannot duplicate or reorder a step event. The draft leaves the producer at its defaults.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'state-first',
      title: 'Persists the transition before it publishes',
      detail:
        'The state transition is committed **before** the event is produced. The draft publishes first, so a crash between the two leaves the state advanced and the transcript permanently missing a step the run actually took.',
      match: {
        python: {order: [/store\.commit_transition\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.commitTransition\(/, /producer\.send\(/]},
        go: {order: [/store\.CommitTransition\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/StepStore\.commitTransition\(/, /producer\.send\(/]},
        cpp: {order: [/store\.commitTransition\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'Falls back to an outbox when the broker rejects the produce',
      detail:
        'A produce the broker rejects writes an **outbox** row (`insert_outbox`/`InsertOutbox`) for a relay to republish, instead of dropping the event or failing the step. The draft ignores the produce result entirely.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /except KafkaException/]},
        typescript: {all: [/store\.insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/store\.InsertOutbox\(/, /err != nil/]},
        scala: {all: [/StepStore\.insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/store\.insertOutbox\(/, /err != RdKafka::ERR_NO_ERROR/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Dedupes redeliveries by (run id, step seq)',
      detail:
        'The consumer builds an idempotency key from `(run_id, step_seq)`, applies the append only when the key is new, and commits the offset **after** that work, so a redelivery adds nothing. The draft appends and commits on every delivery, so one redelivery double-counts the step.',
      match: {
        python: {all: [/dedupe_key/, /event\['step_seq'\]/], order: [/r\.set\(/, /r\.rpush\(/, /consumer\.commit\(/]},
        typescript: {all: [/dedupeKey/, /event\.step_seq/], order: [/r\.set\(/, /r\.rpush\(/, /commitOffsets\(/]},
        go: {all: [/dedupeKey/, /event\.StepSeq/], order: [/SetNX\(/, /RPush\(/, /CommitMessages\(/]},
        scala: {all: [/dedupeKey/, /step_seq/], order: [/jedis\.set\(/, /jedis\.rpush\(/, /commitSync\(/]},
        cpp: {all: [/dedupeKey/, /step_seq/], order: [/redis->set\(/, /redis->rpush\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI

app = FastAPI()
logger = logging.getLogger("orchestrator")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "agent.step"


class RunStore:
    def commit_transition(self, run_id: str, step_seq: int, state: dict) -> None:
        """One atomic transition under the worker lease."""
        raise NotImplementedError

    def insert_outbox(self, run_id: str, step_seq: int, event: dict) -> None:
        """Durable row for an event the broker rejected; a relay republishes it."""
        raise NotImplementedError


store = RunStore()


@app.post("/v1/agent/runs/{run_id}/steps")
def advance(run_id: str, step_seq: int, worker_id: str, state: dict) -> dict:
    # TODO: the draft keys the event by the worker instead of the run, produces before the
    # transition is committed, has no dedupe key for redeliveries, and drops the event when the
    # broker rejects the produce.
    event = {"run_id": run_id, "step_seq": step_seq, "state": state}
    logger.info("step run=%s seq=%d worker=%s", run_id, step_seq, worker_id)
    producer.produce(TOPIC, key=worker_id, value=json.dumps(event))
    producer.flush()
    store.commit_transition(run_id, step_seq, state)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "transcript"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        r.rpush(f"transcript:{event['run_id']}", msg.value())
        consumer.commit(msg)
`,
      solution: `import json

import redis
from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI

app = FastAPI()

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
        "max.in.flight.requests.per.connection": 1,
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "agent.step"


class RunStore:
    def commit_transition(self, run_id: str, step_seq: int, state: dict) -> None:
        """One atomic transition under the worker lease."""
        raise NotImplementedError

    def insert_outbox(self, run_id: str, step_seq: int, event: dict) -> None:
        """Durable row for an event the broker rejected; a relay republishes it."""
        raise NotImplementedError


store = RunStore()


@app.post("/v1/agent/runs/{run_id}/steps")
def advance(run_id: str, step_seq: int, worker_id: str, state: dict) -> dict:
    # State first: the transition is durable before the event exists, so a produce the broker
    # rejects is replayed from the outbox instead of lost while the run moved on.
    store.commit_transition(run_id, step_seq, state)
    event = {"run_id": run_id, "step_seq": step_seq, "state": state}
    try:
        producer.produce(TOPIC, key=run_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(run_id, step_seq, event)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "transcript", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        dedupe_key = f"agent.step:{event['run_id']}:{event['step_seq']}"
        if r.set(dedupe_key, "1", nx=True, ex=86400) is None:
            consumer.commit(msg)
            continue
        r.rpush(f"transcript:{event['run_id']}", msg.value())
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** agent.step: a model-generated draft that keys by worker and publishes before the commit. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'orchestrator', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

const TOPIC = 'agent.step';

interface StepStore {
  /** One atomic transition under the worker lease. */
  commitTransition(runId: string, stepSeq: number, state: unknown): Promise<void>;
  /** Durable row for an event the broker rejected; a relay republishes it. */
  insertOutbox(runId: string, stepSeq: number, event: unknown): Promise<void>;
}

declare const store: StepStore;

app.post('/v1/agent/runs/:runId/steps', async (request, reply) => {
  // TODO: the draft keys the event by the worker instead of the run, produces before the transition
  // is committed, has no dedupe key for redeliveries, and drops the event when the broker rejects
  // the produce.
  const {runId} = request.params as {runId: string};
  const {step_seq: stepSeq, worker_id: workerId, state} = request.body as {
    step_seq: number;
    worker_id: string;
    state: unknown;
  };
  const event = {run_id: runId, step_seq: stepSeq, state};
  await producer.send({topic: TOPIC, messages: [{key: workerId, value: JSON.stringify(event)}]});
  await store.commitTransition(runId, stepSeq, state);
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'transcript'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {run_id: string};
      await r.rpush(\`transcript:\${event.run_id}\`, message.value?.toString() ?? '');
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** agent.step: run-keyed, idempotent produce after the commit, deduped on consume. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'orchestrator', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

const TOPIC = 'agent.step';

interface StepStore {
  /** One atomic transition under the worker lease. */
  commitTransition(runId: string, stepSeq: number, state: unknown): Promise<void>;
  /** Durable row for an event the broker rejected; a relay republishes it. */
  insertOutbox(runId: string, stepSeq: number, event: unknown): Promise<void>;
}

declare const store: StepStore;

app.post('/v1/agent/runs/:runId/steps', async (request, reply) => {
  const {runId} = request.params as {runId: string};
  const {step_seq: stepSeq, state} = request.body as {step_seq: number; state: unknown};
  // State first: the transition is durable before the event exists, so a produce the broker
  // rejects is replayed from the outbox instead of lost while the run moved on.
  await store.commitTransition(runId, stepSeq, state);
  const event = {run_id: runId, step_seq: stepSeq, state};
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: runId, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(runId, stepSeq, event);
  }
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'transcript'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        run_id: string;
        step_seq: number;
      };
      const dedupeKey = \`agent.step:\${event.run_id}:\${event.step_seq}\`;
      const first = await r.set(dedupeKey, '1', 'EX', 86400, 'NX');
      if (first !== 'OK') {
        await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
        return;
      }
      await r.rpush(\`transcript:\${event.run_id}\`, message.value?.toString() ?? '');
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const stepTopic = "agent.step"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: stepTopic}

var rdb *redis.Client

type RunStore struct{}

// CommitTransition takes the worker lease and writes one transition atomically.
func (s *RunStore) CommitTransition(ctx context.Context, runID string, stepSeq int, state map[string]any) error {
	return nil
}

// InsertOutbox keeps one durable row per event the broker rejected; a relay republishes it.
func (s *RunStore) InsertOutbox(ctx context.Context, runID string, stepSeq int, event map[string]any) error {
	return nil
}

var store = &RunStore{}

func advance(rw http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("run_id")
	body := struct {
		StepSeq  int            \`json:"step_seq"\`
		WorkerID string         \`json:"worker_id"\`
		State    map[string]any \`json:"state"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: the draft keys the event by the worker instead of the run, produces before the
	// transition is committed, has no dedupe key for redeliveries, and drops the event when the
	// broker rejects the produce.
	event := map[string]any{"run_id": runID, "step_seq": body.StepSeq, "state": body.State}
	payload, _ := json.Marshal(event)
	_ = writer.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.WorkerID), Value: payload})
	_ = store.CommitTransition(r.Context(), runID, body.StepSeq, body.State)
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   stepTopic,
		GroupID: "transcript",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			RunID   string \`json:"run_id"\`
			StepSeq int    \`json:"step_seq"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.RPush(ctx, "transcript:"+event.RunID, msg.Value)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const stepTopic = "agent.step"

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the record is acknowledged only once it is replicated, and a retry of the same key
// lands on the same partition instead of duplicating across them.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        stepTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var rdb *redis.Client

type RunStore struct{}

// CommitTransition takes the worker lease and writes one transition atomically.
func (s *RunStore) CommitTransition(ctx context.Context, runID string, stepSeq int, state map[string]any) error {
	return nil
}

// InsertOutbox keeps one durable row per event the broker rejected; a relay republishes it.
func (s *RunStore) InsertOutbox(ctx context.Context, runID string, stepSeq int, event map[string]any) error {
	return nil
}

var store = &RunStore{}

func advance(rw http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("run_id")
	body := struct {
		StepSeq int            \`json:"step_seq"\`
		State   map[string]any \`json:"state"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// State first: the transition is durable before the event exists, so a produce the broker
	// rejects is replayed from the outbox instead of lost while the run moved on.
	if err := store.CommitTransition(r.Context(), runID, body.StepSeq, body.State); err != nil {
		http.Error(rw, err.Error(), http.StatusConflict)
		return
	}
	event := map[string]any{"run_id": runID, "step_seq": body.StepSeq, "state": body.State}
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(r.Context(), kafka.Message{Key: []byte(runID), Value: payload}); err != nil {
		_ = store.InsertOutbox(r.Context(), runID, body.StepSeq, event)
	}
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   stepTopic,
		GroupID: "transcript",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			RunID   string \`json:"run_id"\`
			StepSeq int    \`json:"step_seq"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		dedupeKey := "agent.step:" + event.RunID + ":" + strconv.Itoa(event.StepSeq)
		first, _ := rdb.SetNX(ctx, dedupeKey, "1", 24*time.Hour).Result()
		if !first {
			_ = reader.CommitMessages(ctx, msg)
			continue
		}
		rdb.RPush(ctx, "transcript:"+event.RunID, msg.Value)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object StepEvents {
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: the draft keys the event by the worker instead of the run, produces before the transition
  // is committed, has no dedupe key for redeliveries, and drops the event when the broker rejects
  // the produce.
  def advance(runId: String, stepSeq: Int, workerId: String, state: String): Unit = {
    val payload = Map("run_id" -> runId, "step_seq" -> stepSeq, "state" -> state).toJson.compactPrint
    producer.send(new ProducerRecord("agent.step", workerId, payload))
    StepStore.commitTransition(runId, stepSeq, state)
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of("agent.step"))
    while (true) {
      val records = consumer.poll(Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val runId = event("run_id").convertTo[String]
        jedis.rpush(s"transcript:$runId", record.value())
        consumer.commitSync()
      }
    }
  }
}

object StepStore {
  def commitTransition(runId: String, stepSeq: Int, state: String): Unit =
    throw new UnsupportedOperationException

  def insertOutbox(runId: String, stepSeq: Int, payload: String): Unit =
    throw new UnsupportedOperationException
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json._

object StepEvents {
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def advance(runId: String, stepSeq: Int, state: String): Unit = {
    // State first: the transition is durable before the event exists, so a produce the broker
    // rejects is replayed from the outbox instead of lost while the run moved on.
    StepStore.commitTransition(runId, stepSeq, state)
    val payload = Map("run_id" -> runId, "step_seq" -> stepSeq, "state" -> state).toJson.compactPrint
    try {
      producer.send(new ProducerRecord("agent.step", runId, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        StepStore.insertOutbox(runId, stepSeq, payload)
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "transcript")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("agent.step"))
    while (true) {
      val records = consumer.poll(Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val runId = event("run_id").convertTo[String]
        val stepSeq = event("step_seq").convertTo[Int]
        val dedupeKey = s"agent.step:$runId:$stepSeq"
        val first = jedis.set(dedupeKey, "1", SetParams.setParams().nx().ex(86400))
        if (first == null) {
          consumer.commitSync()
        } else {
          jedis.rpush(s"transcript:$runId", record.value())
          consumer.commitSync()
        }
      }
    }
  }
}

object StepStore {
  def commitTransition(runId: String, stepSeq: Int, state: String): Unit =
    throw new UnsupportedOperationException

  def insertOutbox(runId: String, stepSeq: Int, payload: String): Unit =
    throw new UnsupportedOperationException
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kStepTopic = "agent.step";

std::unique_ptr<RdKafka::Producer> producer;

struct StepStore {
  // One atomic transition under the worker lease.
  void commitTransition(const std::string& runId, int stepSeq, const json& state);
  // Durable row for an event the broker rejected; a relay republishes it.
  void insertOutbox(const std::string& runId, int stepSeq, const json& event);
};

StepStore store;

// TODO: the draft keys the event by the worker instead of the run, produces before the transition is
// committed, has no dedupe key for redeliveries, and drops the event when the broker rejects the
// produce.
void advance(const std::string& runId, int stepSeq, const std::string& workerId, const json& state) {
  const json event = {{"run_id", runId}, {"step_seq", stepSeq}, {"state", state}};
  const auto payload = event.dump();
  producer->produce(kStepTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), workerId.data(), workerId.size(), 0, nullptr);
  producer->flush(2000);
  store.commitTransition(runId, stepSeq, state);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kStepTopic = "agent.step";

struct StepStore {
  // One atomic transition under the worker lease.
  void commitTransition(const std::string& runId, int stepSeq, const json& state);
  // Durable row for an event the broker rejected; a relay republishes it.
  void insertOutbox(const std::string& runId, int stepSeq, const json& event);
};

StepStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

void advance(const std::string& runId, int stepSeq, const json& state) {
  // State first: the transition is durable before the event exists, so a produce the broker rejects
  // is replayed from the outbox instead of lost while the run moved on.
  store.commitTransition(runId, stepSeq, state);
  const json event = {{"run_id", runId}, {"step_seq", stepSeq}, {"state", state}};
  const auto payload = event.dump();
  const auto err = producer->produce(kStepTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), runId.data(), runId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(runId, stepSeq, event);
  }
  producer->flush(2000);
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"agent.step"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    const auto runId = event["run_id"].get<std::string>();
    const auto stepSeq = event["step_seq"].get<int>();
    const auto dedupeKey = "agent.step:" + runId + ":" + std::to_string(stepSeq);
    const bool first = redis->set(dedupeKey, "1", std::chrono::seconds(86400), sw::redis::UpdateType::NOT_EXIST);
    if (!first) {
      consumer->commitSync(msg.get());
      continue;
    }
    redis->rpush("transcript:" + runId, msg->payload());
    consumer->commitSync();
  }
}
`,
    },
  },
  hints: [
    'The record key is the ordering contract: `key=run_id` (`Key: []byte(runID)`, `key: runId`, `ProducerRecord("agent.step", runId, …)`). Keyed by the worker id, two steps of one run land in different partitions and the transcript can be written out of order.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` with a `Hash` balancer. It only holds if the message key is stable across retries — the same fix as the run key.',
    'Order of operations is the check: commit the transition, *then* produce, and wrap the produce so a broker error writes an outbox row. In the consumer, build the dedupe key from `(run_id, step_seq)`, skip the append when it already exists, and commit the offset last — that is what makes a redelivery add nothing.',
  ],
  debrief: `The interviewer is testing whether you can review a generated Kafka path as a durability contract instead of a publish call. The draft looks fine because the demo runs in a quiet cluster: one run, one worker, no crash, no redelivery, no broker error. Five separate defects are being checked: a run-keyed partition (ordering), an idempotent producer with acks=all (retry safety), a produce that happens after the state transition commits (no step lost to a crash), an outbox row when the broker rejects the produce (no event dropped), and a consumer that dedupes on (run_id, step_seq) before it appends or commits (no double count on redelivery). The quiet one is the ordering of state and event: publish first and every crash in that window loses a step the run actually took, which stays invisible until someone replays a transcript. Real platforms add a schema registry for the payload, a dead-letter topic for events that fail to apply, an outbox relay with its own lag metric, and compaction so a transcript can be rebuilt from the log.`,
};
