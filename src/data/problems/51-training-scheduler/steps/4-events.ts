import type {Step} from '@/lib/types';

export const trainingEventsStep: Step = {
  id: 'events',
  title: 'Run lifecycle events keyed by run',
  concept: 'kafka',
  file: 'events',
  focus: ['scheduler', 'kafka', 'consumer', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the event publisher: it builds
a payload, produces it to \`training.run\` and acks. It compiles, it serves the demo, and it hides
four production flaws that only surface once more than one run is training. Review it like the owner
of a topic whose consumer rebuilds a run's history, and prove the fix with the checks below.

Publish one event per transition of a run — \`queued\`, \`started\`, \`preempted\`, \`checkpointed\`,
\`finished\` — to the topic \`training.run\`.

- One publisher emits **every** transition, and the payload carries the run id, the transition, the
  **node count** and the **checkpoint id** where they apply. The draft publishes only \`started\` and
  \`finished\`, so a consumer never sees the queue entry, the preemption or the checkpoint it is
  supposed to act on.
- Every produce is **keyed by the run id** (\`key=run_id\`, \`key: runId\`, \`Key: []byte(runID)\`,
  \`ProducerRecord(topic, runId, payload)\`, the message key argument). The key chooses the partition,
  and the partition is what keeps one run's history ordered. The draft keys by priority band, so runs
  that share a band interleave and a run's own transitions can be consumed out of order.
- \`started\` is published **only after the worker confirms the start**: the \`StartRun\` reply is
  checked (\`accepted\`, node count) and the event follows it. The draft publishes \`started\` before it
  has even asked the worker, so a consumer believes a run is training on a fleet that refused it.
- The run's new state and an **outbox row** are written in **one transaction** (\`INSERT INTO
  training_outbox\`), and the produce follows the commit; when the broker rejects the produce the row
  stays pending and a **relay** republishes it. The draft has no outbox: a rejection is a throw nobody
  catches, and the transition is gone. A broker outage must leave recoverable events.
- The producer acknowledges with \`acks=all\` and runs **idempotently** (\`enable.idempotence\`,
  \`RequiredAcks: RequireAll\`), so a produce retried after a timeout cannot duplicate a transition.
  The draft leaves both at their defaults.

**Failure mode the checks target.** Ordering is the subtle one: keying by band looks harmless while
one run is training and turns into a consumer that applies a stale \`preempted\` after a \`finished\`,
because two runs in one band share a partition. Publishing \`started\` before the worker confirms is
the lie that costs GPU hours: the history says the run is training while the fleet never accepted it.
The missing outbox is the one that hides for months — invisible until the broker blinks, and then a
transition some checkpoint policy depends on is simply absent from the log.`,
  sequence: {
    participants: ['Training Scheduler', 'Training worker', 'run store · outbox', 'Kafka', 'Lifecycle consumer'],
    messages: [
      {from: 'Training Scheduler', to: 'Training worker', label: 'StartRun(run_id) · grace deadline', kind: 'sync'},
      {from: 'Training worker', to: 'Training Scheduler', label: 'confirmed · node count', kind: 'reply'},
      {
        from: 'Training Scheduler',
        to: 'run store · outbox',
        label: 'state + outbox row, one transaction',
        kind: 'sync',
      },
      {from: 'Training Scheduler', to: 'Kafka', label: 'produce training.run · key = run_id', kind: 'async'},
      {from: 'Kafka', to: 'Training Scheduler', label: 'ack / rejection', kind: 'reply'},
      {from: 'run store · outbox', to: 'Kafka', label: 'relay republishes pending rows', kind: 'async'},
      {from: 'Kafka', to: 'Lifecycle consumer', label: 'consume training.run · key = run_id', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'publish-transitions',
      title: 'One publisher emits every transition with node counts and checkpoint ids',
      detail:
        'Every transition of a run — `queued`, `started`, `preempted`, `checkpointed`, `finished` — goes to `training.run` from one publisher, and the payload carries the run id, the node count and the checkpoint id where they apply. The draft publishes only `started` and `finished`, so the consumer never sees the queue entry, the preemption or the checkpoint.',
      match: {
        python: {
          all: [
            /TOPIC\s*=\s*"training\.run"/,
            /publish_transition\(/,
            /"queued"/,
            /"started"/,
            /"preempted"/,
            /"checkpointed"/,
            /"finished"/,
            /"node_count"/,
            /"checkpoint_id"/,
          ],
        },
        typescript: {
          all: [
            /TOPIC\s*=\s*'training\.run'/,
            /publishTransition\(/,
            /'queued'/,
            /'started'/,
            /'preempted'/,
            /'checkpointed'/,
            /'finished'/,
            /node_count/,
            /checkpoint_id/,
          ],
        },
        go: {
          all: [
            /trainingRunTopic\s*=\s*"training\.run"/,
            /func publishTransition\(/,
            /"queued"/,
            /"started"/,
            /"preempted"/,
            /"checkpointed"/,
            /"finished"/,
            /"node_count"/,
            /"checkpoint_id"/,
          ],
        },
        scala: {
          all: [
            /TrainingRunTopic\s*=\s*"training\.run"/,
            /def publishTransition\(/,
            /"queued"/,
            /"started"/,
            /"preempted"/,
            /"checkpointed"/,
            /"finished"/,
            /"node_count"/,
            /"checkpoint_id"/,
          ],
        },
        cpp: {
          all: [
            /kTrainingRunTopic\s*=\s*"training\.run"/,
            /publish_transition\(/,
            /"queued"/,
            /"started"/,
            /"preempted"/,
            /"checkpointed"/,
            /"finished"/,
            /"node_count"/,
            /"checkpoint_id"/,
          ],
        },
      },
    },
    {
      id: 'key-by-run',
      title: 'Every event is keyed by the run id',
      detail:
        'The produce passes the run id as the message key (`key=run_id`, `key: runId`, `Key: []byte(runID)`, `ProducerRecord(topic, runId, …)`), so one run’s transitions land in one partition and stay ordered. The draft keys by priority band, so runs that share a band interleave and a run’s own history can reorder.',
      match: {
        python: {all: [/key=run_id/]},
        typescript: {all: [/key:\s*runId/]},
        go: {all: [/Key:\s*\[\]byte\(runID\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(TrainingRunTopic,\s*runId,/]},
        cpp: {all: [/run_id\.c_str\(\)/]},
      },
    },
    {
      id: 'started-after-confirm',
      title: 'started is published only after the worker confirms the start',
      detail:
        'The `StartRun` reply is checked first and the `started` event follows it, so the history never claims a run is training before the fleet accepted it. The draft publishes `started` and only then asks the worker, so a consumer that trusts the event acts on a start that never happened.',
      match: {
        python: {order: [/stub\.StartRun\(/, /"started"/]},
        typescript: {order: [/client\.StartRun\(/, /'started'/]},
        go: {order: [/stub\.StartRun\(/, /"started"/]},
        scala: {order: [/\.startRun\(/, /"started"/]},
        cpp: {order: [/stub->StartRun\(/, /"started"/]},
      },
    },
    {
      id: 'outbox-on-rejection',
      title: 'A rejected produce stays recoverable in the outbox',
      detail:
        'The run’s new state and an `INSERT INTO training_outbox` row commit in one transaction, the produce follows the commit, and a relay republishes whatever the broker rejected. The draft has no outbox: a rejection throws, nobody catches it, and the transition is lost until someone notices the gap in a run’s history.',
      match: {
        python: {all: [/INSERT INTO training_outbox/, /def relay_outbox\(/, /except KafkaException/]},
        typescript: {all: [/INSERT INTO training_outbox/, /relayOutbox\(/, /catch\s*\(/]},
        go: {all: [/INSERT INTO training_outbox/, /func relayOutbox\(/, /err != nil/]},
        scala: {all: [/INSERT INTO training_outbox/, /def relayOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/INSERT INTO training_outbox/, /relay_outbox\(/, /catch\s*\(/]},
      },
    },
    {
      id: 'acks-all',
      title: 'The producer is durable and idempotent, and never keys by band',
      detail:
        'The producer waits for every in-sync replica (`acks=all`, `RequiredAcks: RequireAll`) and suppresses duplicate retries with idempotence, so a produce retried after a timeout cannot duplicate a transition. The draft leaves both at their defaults and keys by band, which is exactly how a retry ends up on the wrong partition.',
      match: {
        python: {all: [/"acks":\s*"all"/, /"enable\.idempotence":\s*True/], none: [/key=[^\n]*band/]},
        typescript: {all: [/idempotent:\s*true/, /maxInFlightRequests:\s*1/], none: [/key:\s*[^\n]*\.band/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/], none: [/Key:\s*\[\]byte\([^\n]*Band\)/]},
        scala: {
          all: [/props\.put\("acks",\s*"all"\)/, /props\.put\("enable\.idempotence",\s*"true"\)/],
          none: [/ProducerRecord\[String, String\]\(TrainingRunTopic,\s*[^\n]*\.band/],
        },
        cpp: {
          all: [/conf->set\("acks",\s*"all"/, /conf->set\("enable\.idempotence",\s*"true"/],
          none: [/produce\([^\n]*band/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import grpc
from confluent_kafka import Producer
from fastapi import FastAPI
from fastapi.responses import JSONResponse

import worker_pb2
import worker_pb2_grpc

app = FastAPI()
logger = logging.getLogger("trainsched-events")

TOPIC = "training.run"
WORKER_ADDR = "worker:50051"
GRACE_DEADLINE_S = 30

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_state(run: dict, state: str) -> None:
    # TODO: this draft keys by the priority band, publishes \`started\` before the worker confirms,
    # publishes only two of the five transitions, and drops the event when the broker rejects the
    # produce. Review all four before a consumer rebuilds a run's history from this topic.
    payload = json.dumps({"type": "training.run", "run_id": run["run_id"], "state": state}).encode("utf-8")
    producer.produce(TOPIC, key=str(run["band"]).encode("utf-8"), value=payload)
    producer.flush()


@app.post("/v1/training/runs/{run_id}/start")
def start_run(run_id: str) -> JSONResponse:
    publish_state({"run_id": run_id, "band": 1}, "started")
    with grpc.insecure_channel(WORKER_ADDR) as channel:
        stub = worker_pb2_grpc.TrainingWorkerStub(channel)
        confirmation = stub.StartRun(worker_pb2.StartRunRequest(run_id=run_id), timeout=GRACE_DEADLINE_S)
    if not confirmation.accepted:
        return JSONResponse({"error": "worker did not confirm the start"}, status_code=503)
    logger.info("run started run_id=%s", run_id)
    return JSONResponse({"run_id": run_id, "state": "running"})


def finish_run(run: dict) -> None:
    publish_state(run, "finished")
`,
      solution: `import json
import logging

import grpc
from confluent_kafka import KafkaException, Producer
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

import worker_pb2
import worker_pb2_grpc

app = FastAPI()
logger = logging.getLogger("trainsched-events")

TOPIC = "training.run"
WORKER_ADDR = "worker:50051"
GRACE_DEADLINE_S = 30
OUTBOX_BATCH = 100

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


class RunStore:
    """The platform's run store: the state change and the outbox row share one transaction."""

    def transaction(self) -> "object":
        """The transaction that commits the run's new state together with the outbox row."""
        raise NotImplementedError

    def pending_outbox(self, limit: int) -> list[dict]:
        """Outbox rows a rejected produce left behind, oldest first."""
        raise NotImplementedError

    def mark_published(self, outbox_id: int) -> None:
        raise NotImplementedError


store = RunStore()


def transition_event(run_id: str, transition: str, node_count: int, checkpoint_id: str) -> dict:
    return {
        "type": "training.run",
        "run_id": run_id,
        "transition": transition,
        "node_count": node_count,
        "checkpoint_id": checkpoint_id,
    }


def publish_transition(run_id: str, transition: str, node_count: int = 0, checkpoint_id: str = "") -> None:
    """Keyed by the run id, so one run's transitions stay in one ordered partition."""
    payload = json.dumps(transition_event(run_id, transition, node_count, checkpoint_id)).encode("utf-8")
    producer.produce(TOPIC, key=run_id.encode("utf-8"), value=payload)
    producer.poll(0)


def record_transition(run_id: str, transition: str, node_count: int = 0, checkpoint_id: str = "") -> None:
    """The run's new state and its outbox row commit together, then the produce follows."""
    with store.transaction() as tx:
        tx.execute("UPDATE training_runs SET state = %s WHERE run_id = %s", (transition, run_id))
        tx.execute(
            "INSERT INTO training_outbox (run_id, transition, node_count, checkpoint_id) VALUES (%s, %s, %s, %s)",
            (run_id, transition, node_count, checkpoint_id),
        )
    try:
        publish_transition(run_id, transition, node_count, checkpoint_id)
    except KafkaException as err:
        logger.warning("event kept in the outbox run_id=%s transition=%s err=%s", run_id, transition, err)


def relay_outbox() -> None:
    """Republish what a broker outage left behind; a row is cleared only after the ack."""
    for row in store.pending_outbox(OUTBOX_BATCH):
        try:
            publish_transition(row["run_id"], row["transition"], row["node_count"], row["checkpoint_id"])
        except KafkaException:
            continue
        store.mark_published(row["id"])


def on_run_queued(run: dict) -> None:
    record_transition(run["run_id"], "queued")


def on_run_preempted(run_id: str, checkpoint_id: str) -> None:
    record_transition(run_id, "preempted", checkpoint_id=checkpoint_id)


def on_run_checkpointed(run_id: str, checkpoint_id: str) -> None:
    record_transition(run_id, "checkpointed", checkpoint_id=checkpoint_id)


def on_run_finished(run_id: str, node_count: int) -> None:
    record_transition(run_id, "finished", node_count=node_count)


@app.post("/v1/training/runs/{run_id}/start")
def start_run(run_id: str) -> JSONResponse:
    with grpc.insecure_channel(WORKER_ADDR) as channel:
        stub = worker_pb2_grpc.TrainingWorkerStub(channel)
        confirmation = stub.StartRun(worker_pb2.StartRunRequest(run_id=run_id), timeout=GRACE_DEADLINE_S)
    if not confirmation.accepted:
        raise HTTPException(status_code=503, detail="worker did not confirm the start")
    record_transition(run_id, "started", node_count=confirmation.node_count)
    logger.info("run started run_id=%s", run_id)
    return JSONResponse({"run_id": run_id, "state": "running"})
`,
    },
    typescript: {
      starter: `/** Run lifecycle events: a model-generated draft. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import {Kafka, type Producer} from 'kafkajs';

export const app = Fastify();

const TOPIC = 'training.run';
const WORKER_ADDR = 'worker:50051';
const GRACE_DEADLINE_S = 30;

const kafka = new Kafka({clientId: 'trainsched-events', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer();

interface WorkerClient {
  StartRun(request: {run_id: string}, options: {deadline: number}): Promise<{accepted: boolean; node_count: number}>;
}

// proto-loader's package object is untyped; this is the generated stub's shape.
const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('worker.proto')) as unknown as {
  trainsched: {TrainingWorker: new (target: string, credentials: grpc.ChannelCredentials) => WorkerClient};
};
const client = new pkg.trainsched.TrainingWorker(WORKER_ADDR, grpc.credentials.createInsecure());

async function publishState(runId: string, band: number, state: string): Promise<void> {
  // TODO: this draft keys by the priority band, publishes 'started' before the worker confirms,
  // publishes only two of the five transitions, and drops the event when the broker rejects the
  // produce. Review all four before a consumer rebuilds a run's history from this topic.
  await producer.send({
    topic: TOPIC,
    messages: [{key: String(band), value: JSON.stringify({type: 'training.run', run_id: runId, state})}],
  });
}

app.post('/v1/training/runs/:run_id/start', async (request, reply) => {
  const runId = (request.params as {run_id: string}).run_id;
  await publishState(runId, 1, 'started');
  const confirmation = await client.StartRun({run_id: runId}, {deadline: Date.now() + GRACE_DEADLINE_S * 1000});
  if (!confirmation.accepted) return reply.code(503).send({error: 'worker did not confirm the start'});
  request.log.info({run_id: runId}, 'run started');
  return reply.code(200).send({run_id: runId, state: 'running'});
});

app.post('/v1/training/runs/:run_id/finish', async (request, reply) => {
  const runId = (request.params as {run_id: string}).run_id;
  await publishState(runId, 1, 'finished');
  return reply.code(200).send({run_id: runId, state: 'finished'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Run lifecycle events: one ordered training.run record per transition, keyed by run id. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import {Kafka, type Producer} from 'kafkajs';

export const app = Fastify();

const TOPIC = 'training.run';
const WORKER_ADDR = 'worker:50051';
const GRACE_DEADLINE_S = 30;
const OUTBOX_BATCH = 100;

const kafka = new Kafka({clientId: 'trainsched-events', brokers: ['kafka:9092']});
// kafkajs acks=-1 with idempotence: a produce retried after a timeout cannot duplicate a transition.
const producer: Producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});

interface RunEvent {
  type: string;
  run_id: string;
  transition: string;
  node_count: number;
  checkpoint_id: string;
}

interface OutboxRow {
  id: string;
  event: RunEvent;
}

class RunStore {
  /** The run's new state and the training_outbox row share one transaction. */
  async transaction<T>(
    body: (tx: {query: (sql: string, params: unknown[]) => Promise<void>}) => Promise<T>,
  ): Promise<T> {
    return body({query: async () => {}});
  }

  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    void limit;
    return [];
  }

  async markPublished(outboxId: string): Promise<void> {
    void outboxId;
  }
}

const store = new RunStore();

function transitionEvent(runId: string, transition: string, nodeCount = 0, checkpointId = ''): RunEvent {
  return {type: 'training.run', run_id: runId, transition, node_count: nodeCount, checkpoint_id: checkpointId};
}

/** Keyed by the run id, so one run's transitions stay in one ordered partition. */
async function publishTransition(runId: string, transition: string, nodeCount = 0, checkpointId = ''): Promise<void> {
  await producer.send({
    topic: TOPIC,
    messages: [{key: runId, value: JSON.stringify(transitionEvent(runId, transition, nodeCount, checkpointId))}],
  });
}

/** The state change and the outbox row commit together, then the produce follows. */
async function recordTransition(runId: string, transition: string, nodeCount = 0, checkpointId = ''): Promise<void> {
  await store.transaction(async tx => {
    await tx.query('UPDATE training_runs SET state = $1 WHERE run_id = $2', [transition, runId]);
    await tx.query(
      'INSERT INTO training_outbox (run_id, transition, node_count, checkpoint_id) VALUES ($1, $2, $3, $4)',
      [runId, transition, nodeCount, checkpointId],
    );
  });
  try {
    await publishTransition(runId, transition, nodeCount, checkpointId);
  } catch (err) {
    request_log.warn({run_id: runId, transition, err}, 'event kept in the outbox for the relay');
  }
}

/** Republish what a broker outage left behind; a row is cleared only after the ack. */
async function relayOutbox(): Promise<void> {
  for (const row of await store.pendingOutbox(OUTBOX_BATCH)) {
    try {
      await publishTransition(row.event.run_id, row.event.transition, row.event.node_count, row.event.checkpoint_id);
    } catch {
      continue;
    }
    await store.markPublished(row.id);
  }
}

interface WorkerClient {
  StartRun(request: {run_id: string}, options: {deadline: number}): Promise<{accepted: boolean; node_count: number}>;
}

// proto-loader's package object is untyped; this is the generated stub's shape.
const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('worker.proto')) as unknown as {
  trainsched: {TrainingWorker: new (target: string, credentials: grpc.ChannelCredentials) => WorkerClient};
};
const client = new pkg.trainsched.TrainingWorker(WORKER_ADDR, grpc.credentials.createInsecure());

async function onRunQueued(runId: string): Promise<void> {
  await recordTransition(runId, 'queued');
}

async function onRunPreempted(runId: string, checkpointId: string): Promise<void> {
  await recordTransition(runId, 'preempted', 0, checkpointId);
}

async function onRunCheckpointed(runId: string, checkpointId: string): Promise<void> {
  await recordTransition(runId, 'checkpointed', 0, checkpointId);
}

async function onRunFinished(runId: string, nodeCount: number): Promise<void> {
  await recordTransition(runId, 'finished', nodeCount);
}

app.post('/v1/training/runs/:run_id/start', async (request, reply) => {
  const runId = (request.params as {run_id: string}).run_id;
  const confirmation = await client.StartRun({run_id: runId}, {deadline: Date.now() + GRACE_DEADLINE_S * 1000});
  if (!confirmation.accepted) return reply.code(503).send({error: 'worker did not confirm the start'});
  await recordTransition(runId, 'started', confirmation.node_count);
  request.log.info({run_id: runId, nodes: confirmation.node_count}, 'run started');
  return reply.code(200).send({run_id: runId, state: 'running'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/segmentio/kafka-go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	workerpb "trainsched/gen/worker"
)

const trainingRunTopic = "training.run"

var (
	writer  = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}}
	conn, _ = grpc.NewClient("worker:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	stub    = workerpb.NewTrainingWorkerClient(conn)
)

type runRef struct {
	RunID string \`json:"run_id"\`
	Band  int    \`json:"band"\`
}

func publishState(ctx context.Context, run runRef, state string) error {
	// TODO: this draft keys by the priority band, publishes "started" before the worker confirms,
	// publishes only two of the five transitions, and drops the event when the broker rejects the
	// produce. Review all four before a consumer rebuilds a run's history from this topic.
	payload, err := json.Marshal(map[string]any{"type": "training.run", "run_id": run.RunID, "state": state})
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Topic: trainingRunTopic, Key: []byte(strconv.Itoa(run.Band)), Value: payload})
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("run_id")
	if err := publishState(r.Context(), runRef{RunID: runID, Band: 1}, "started"); err != nil {
		http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
		return
	}
	reply, err := stub.StartRun(r.Context(), &workerpb.StartRunRequest{RunId: runID})
	if err != nil || !reply.GetAccepted() {
		http.Error(rw, "worker did not confirm the start", http.StatusServiceUnavailable)
		return
	}
	log.Printf("run started run_id=%s", runID)
	writeJSON(rw, http.StatusOK, map[string]any{"run_id": runID, "state": "running"})
}

func finishRun(rw http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("run_id")
	if err := publishState(r.Context(), runRef{RunID: runID, Band: 1}, "finished"); err != nil {
		http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"run_id": runID, "state": "finished"})
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/training/runs/{run_id}/start", startRun)
	mux.HandleFunc("POST /v1/training/runs/{run_id}/finish", finishRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/segmentio/kafka-go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	workerpb "trainsched/gen/worker"
)

const (
	trainingRunTopic = "training.run"
	graceDeadlineS   = 30
	outboxBatch      = 100
)

var (
	writer = &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
	}
	conn, _ = grpc.NewClient("worker:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	stub    = workerpb.NewTrainingWorkerClient(conn)
)

type runEvent struct {
	Type         string \`json:"type"\`
	RunID        string \`json:"run_id"\`
	Transition   string \`json:"transition"\`
	NodeCount    int    \`json:"node_count"\`
	CheckpointID string \`json:"checkpoint_id"\`
}

type outboxRow struct {
	ID           string
	RunID        string
	Transition   string
	NodeCount    int
	CheckpointID string
}

// RunStore and its transaction are the platform's; the state change and the outbox row share one.
type RunStore interface {
	Begin(ctx context.Context) (Transaction, error)
	PendingOutbox(ctx context.Context, limit int) ([]outboxRow, error)
	MarkPublished(ctx context.Context, outboxID string) error
}

type Transaction interface {
	Exec(ctx context.Context, sql string, params ...any) error
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

var store RunStore

func transitionEvent(runID, transition string, nodeCount int, checkpointID string) runEvent {
	return runEvent{
		Type:         "training.run",
		RunID:        runID,
		Transition:   transition,
		NodeCount:    nodeCount,
		CheckpointID: checkpointID,
	}
}

// publishTransition keys by the run id, so one run's transitions stay in one ordered partition.
func publishTransition(ctx context.Context, runID, transition string, nodeCount int, checkpointID string) error {
	payload, err := json.Marshal(transitionEvent(runID, transition, nodeCount, checkpointID))
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{
		Topic: trainingRunTopic,
		Key:   []byte(runID),
		Value: payload,
	})
}

// recordTransition commits the run's new state and the outbox row together, then publishes.
func recordTransition(ctx context.Context, runID, transition string, nodeCount int, checkpointID string) {
	tx, err := store.Begin(ctx)
	if err != nil {
		log.Printf("no transaction for run_id=%s: %v", runID, err)
		return
	}
	if err := tx.Exec(ctx, "UPDATE training_runs SET state = $1 WHERE run_id = $2", transition, runID); err != nil {
		_ = tx.Rollback(ctx)
		return
	}
	sql := "INSERT INTO training_outbox (run_id, transition, node_count, checkpoint_id) VALUES ($1, $2, $3, $4)"
	if err := tx.Exec(ctx, sql, runID, transition, nodeCount, checkpointID); err != nil {
		_ = tx.Rollback(ctx)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		return
	}
	if err := publishTransition(ctx, runID, transition, nodeCount, checkpointID); err != nil {
		log.Printf("event kept in the outbox run_id=%s transition=%s: %v", runID, transition, err)
	}
}

// relayOutbox republishes what a broker outage left behind; a row is cleared only after the ack.
func relayOutbox(ctx context.Context) {
	rows, err := store.PendingOutbox(ctx, outboxBatch)
	if err != nil {
		return
	}
	for _, row := range rows {
		if err := publishTransition(ctx, row.RunID, row.Transition, row.NodeCount, row.CheckpointID); err != nil {
			continue
		}
		store.MarkPublished(ctx, row.ID)
	}
}

func onRunQueued(ctx context.Context, runID string) {
	recordTransition(ctx, runID, "queued", 0, "")
}

func onRunPreempted(ctx context.Context, runID, checkpointID string) {
	recordTransition(ctx, runID, "preempted", 0, checkpointID)
}

func onRunCheckpointed(ctx context.Context, runID, checkpointID string) {
	recordTransition(ctx, runID, "checkpointed", 0, checkpointID)
}

func onRunFinished(ctx context.Context, runID string, nodeCount int) {
	recordTransition(ctx, runID, "finished", nodeCount, "")
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("run_id")
	reply, err := stub.StartRun(r.Context(), &workerpb.StartRunRequest{RunId: runID})
	if err != nil || !reply.GetAccepted() {
		http.Error(rw, "worker did not confirm the start", http.StatusServiceUnavailable)
		return
	}
	recordTransition(r.Context(), runID, "started", int(reply.GetNodeCount()), "")
	log.Printf("run started run_id=%s nodes=%d", runID, reply.GetNodeCount())
	writeJSON(rw, http.StatusOK, map[string]any{"run_id": runID, "state": "running"})
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/training/runs/{run_id}/start", startRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import trainsched.worker.{StartRunRequest, TrainingWorkerGrpc}

object Events {
  implicit val system: ActorSystem = ActorSystem("trainsched-events")

  val TrainingRunTopic = "training.run"
  val GraceDeadlineS = 30L

  val producer = new KafkaProducer[String, String](new Properties())
  private val channel = ManagedChannelBuilder.forAddress("worker", 50051).usePlaintext().build()
  private val stub = TrainingWorkerGrpc.blockingStub(channel)

  def publishState(runId: String, band: Int, state: String): Unit = {
    // TODO: this draft keys by the priority band, publishes "started" before the worker confirms,
    // publishes only two of the five transitions, and drops the event when the broker rejects the
    // produce. Review all four before a consumer rebuilds a run's history from this topic.
    val payload = """{"type":"training.run","run_id":"%s","state":"%s"}""".format(runId, state)
    producer.send(new ProducerRecord[String, String](TrainingRunTopic, band.toString, payload))
  }

  val route: Route =
    path("v1" / "training" / "runs" / Segment / "start") { runId =>
      post {
        publishState(runId, 1, "started")
        val reply = stub.withDeadlineAfter(GraceDeadlineS, TimeUnit.SECONDS).startRun(StartRunRequest(runId))
        if (!reply.accepted) {
          complete(StatusCodes.ServiceUnavailable, """{"error":"worker did not confirm the start"}""")
        } else {
          complete(StatusCodes.OK, """{"run_id":"%s","state":"running"}""".format(runId))
        }
      }
    }

  def finishRun(runId: String): Unit = publishState(runId, 1, "finished")

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import trainsched.worker.{StartRunRequest, TrainingWorkerGrpc}

final case class OutboxRow(id: String, runId: String, transition: String, nodeCount: Int, checkpointId: String)

/** The platform's transaction: the state change and the training_outbox row share it. */
trait Tx {
  def execute(sql: String, params: Any*): Unit
}

trait RunStore {
  def inTransaction(body: Tx => Unit): Unit
  def pendingOutbox(limit: Int): Seq[OutboxRow]
  def markPublished(outboxId: String): Unit
}

object Events {
  implicit val system: ActorSystem = ActorSystem("trainsched-events")

  val TrainingRunTopic = "training.run"
  val GraceDeadlineS = 30L
  val OutboxBatch = 100

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  val producer = new KafkaProducer[String, String](props)

  private val channel = ManagedChannelBuilder.forAddress("worker", 50051).usePlaintext().build()
  private val stub = TrainingWorkerGrpc.blockingStub(channel)

  private val store: RunStore = new RunStore {
    def inTransaction(body: Tx => Unit): Unit = ???
    def pendingOutbox(limit: Int): Seq[OutboxRow] = ???
    def markPublished(outboxId: String): Unit = ???
  }

  private def eventJson(runId: String, transition: String, nodeCount: Int, checkpointId: String): String =
    """{"type":"training.run","run_id":"%s","transition":"%s","node_count":%d,"checkpoint_id":"%s"}"""
      .format(runId, transition, nodeCount, checkpointId)

  /** Keyed by the run id, so one run's transitions stay in one ordered partition. */
  def publishTransition(runId: String, transition: String, nodeCount: Int, checkpointId: String): Unit = {
    val payload = eventJson(runId, transition, nodeCount, checkpointId)
    producer.send(new ProducerRecord[String, String](TrainingRunTopic, runId, payload))
  }

  /** The run's new state and its outbox row commit together, then the produce follows. */
  def recordTransition(runId: String, transition: String, nodeCount: Int, checkpointId: String): Unit = {
    store.inTransaction { tx =>
      tx.execute("UPDATE training_runs SET state = ? WHERE run_id = ?", transition, runId)
      tx.execute(
        "INSERT INTO training_outbox (run_id, transition, node_count, checkpoint_id) VALUES (?, ?, ?, ?)",
        runId,
        transition,
        nodeCount,
        checkpointId
      )
    }
    try {
      publishTransition(runId, transition, nodeCount, checkpointId)
    } catch {
      case err: Throwable =>
        system.log.warning("event kept in the outbox runId=%s transition=%s err=%s".format(runId, transition, err.getMessage))
    }
  }

  /** Republish what a broker outage left behind; a row is cleared only after the ack. */
  def relayOutbox(): Unit = {
    for (row <- store.pendingOutbox(OutboxBatch)) {
      try {
        publishTransition(row.runId, row.transition, row.nodeCount, row.checkpointId)
      } catch {
        case _: Throwable => () // the next pass picks the row up again
      }
      store.markPublished(row.id)
    }
  }

  def onRunQueued(runId: String): Unit = recordTransition(runId, "queued", 0, "")

  def onRunPreempted(runId: String, checkpointId: String): Unit = recordTransition(runId, "preempted", 0, checkpointId)

  def onRunCheckpointed(runId: String, checkpointId: String): Unit =
    recordTransition(runId, "checkpointed", 0, checkpointId)

  def onRunFinished(runId: String, nodeCount: Int): Unit = recordTransition(runId, "finished", nodeCount, "")

  val route: Route =
    path("v1" / "training" / "runs" / Segment / "start") { runId =>
      post {
        val reply = stub.withDeadlineAfter(GraceDeadlineS, TimeUnit.SECONDS).startRun(StartRunRequest(runId))
        if (!reply.accepted) {
          complete(StatusCodes.ServiceUnavailable, """{"error":"worker did not confirm the start"}""")
        } else {
          recordTransition(runId, "started", reply.nodeCount, "")
          complete(StatusCodes.OK, """{"run_id":"%s","state":"running"}""".format(runId))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdlib>
#include <string>

#include "worker.grpc.pb.h"

using json = nlohmann::json;

const std::string kTrainingRunTopic = "training.run";
constexpr int kGraceDeadlineS = 30;

struct RunRef {
  std::string run_id;
  int band = 1;
};

static void publish_state(RdKafka::Producer* producer, const RunRef& run, const std::string& state) {
  // TODO: this draft keys by the priority band, publishes "started" before the worker confirms,
  // publishes only two of the five transitions, and drops the event when the broker rejects the
  // produce. Review all four before a consumer rebuilds a run's history from this topic.
  const std::string payload = json{{"type", "training.run"}, {"run_id", run.run_id}, {"state", state}}.dump();
  const std::string key = std::to_string(run.band);
  producer->produce(kTrainingRunTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), key.c_str(), key.size(), 0, nullptr);
}

int main() {
  std::string errstr;
  auto* producer = RdKafka::Producer::create(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL), errstr);
  auto channel = grpc::CreateChannel("worker:50051", grpc::InsecureChannelCredentials());
  auto stub = trainsched::TrainingWorker::NewStub(channel);
  httplib::Server svr;

  svr.Post(R"(/v1/training/runs/([^/]+)/start)", [producer, &stub](const httplib::Request& req, httplib::Response& res) {
    const std::string run_id = req.matches[1];
    publish_state(producer, RunRef{run_id, 1}, "started");
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kGraceDeadlineS));
    trainsched::StartRunRequest request;
    request.set_run_id(run_id);
    trainsched::StartRunReply reply;
    const grpc::Status status = stub->StartRun(&context, request, &reply);
    if (!status.ok() || !reply.accepted()) {
      res.status = 503;
      res.set_content(R"({"error":"worker did not confirm the start"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"run_id", run_id}, {"state", "running"}}.dump(), "application/json");
  });

  svr.Post(R"(/v1/training/runs/([^/]+)/finish)", [producer](const httplib::Request& req, httplib::Response& res) {
    publish_state(producer, RunRef{req.matches[1], 1}, "finished");
    res.status = 200;
    res.set_content(R"({"state":"finished"})", "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <string>
#include <vector>

#include "worker.grpc.pb.h"

using json = nlohmann::json;

const std::string kTrainingRunTopic = "training.run";
constexpr int kGraceDeadlineS = 30;
constexpr int kOutboxBatch = 100;

struct OutboxRow {
  std::string id;
  std::string run_id;
  std::string transition;
  int node_count = 0;
  std::string checkpoint_id;
};

/** The platform's transaction: the state change and the training_outbox row share it. */
struct Transaction {
  void execute(const std::string& sql, const std::vector<std::string>& params);
  void commit();
};

struct RunStore {
  Transaction begin_transaction();
  std::vector<OutboxRow> pending_outbox(int limit);
  void mark_published(const std::string& outbox_id);
};

RunStore store;

/** Keyed by the run id, so one run's transitions stay in one ordered partition. */
static void publish_transition(RdKafka::Producer* producer, const std::string& run_id, const std::string& transition,
                               int node_count, const std::string& checkpoint_id) {
  const std::string payload =
      json{{"type", "training.run"},
           {"run_id", run_id},
           {"transition", transition},
           {"node_count", node_count},
           {"checkpoint_id", checkpoint_id}}
          .dump();
  producer->produce(kTrainingRunTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), run_id.c_str(), run_id.size(), 0, nullptr);
  producer->poll(0);
}

/** The run's new state and its outbox row commit together, then the produce follows. */
static void record_transition(RdKafka::Producer* producer, const std::string& run_id, const std::string& transition,
                              int node_count, const std::string& checkpoint_id) {
  {
    auto tx = store.begin_transaction();
    tx.execute("UPDATE training_runs SET state = $1 WHERE run_id = $2",
               {transition, run_id});
    tx.execute(
        "INSERT INTO training_outbox (run_id, transition, node_count, checkpoint_id) VALUES ($1, $2, $3, $4)",
        {run_id, transition, std::to_string(node_count), checkpoint_id});
    tx.commit();
  }
  try {
    publish_transition(producer, run_id, transition, node_count, checkpoint_id);
  } catch (const std::exception& err) {
    std::cerr << "event kept in the outbox run_id=" << run_id << " err=" << err.what() << "\\n";
  }
}

/** Republish what a broker outage left behind; a row is cleared only after the ack. */
static void relay_outbox(RdKafka::Producer* producer) {
  for (const OutboxRow& row : store.pending_outbox(kOutboxBatch)) {
    try {
      publish_transition(producer, row.run_id, row.transition, row.node_count, row.checkpoint_id);
    } catch (const std::exception&) {
      continue;
    }
    store.mark_published(row.id);
  }
}

static void on_run_queued(RdKafka::Producer* producer, const std::string& run_id) {
  record_transition(producer, run_id, "queued", 0, "");
}

static void on_run_preempted(RdKafka::Producer* producer, const std::string& run_id, const std::string& checkpoint_id) {
  record_transition(producer, run_id, "preempted", 0, checkpoint_id);
}

static void on_run_checkpointed(RdKafka::Producer* producer, const std::string& run_id, const std::string& checkpoint_id) {
  record_transition(producer, run_id, "checkpointed", 0, checkpoint_id);
}

static void on_run_finished(RdKafka::Producer* producer, const std::string& run_id, int node_count) {
  record_transition(producer, run_id, "finished", node_count, "");
}

int main() {
  std::string errstr;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("acks", "all", errstr);
  conf->set("enable.idempotence", "true", errstr);
  auto* producer = RdKafka::Producer::create(conf, errstr);
  auto channel = grpc::CreateChannel("worker:50051", grpc::InsecureChannelCredentials());
  auto stub = trainsched::TrainingWorker::NewStub(channel);
  httplib::Server svr;

  svr.Post(R"(/v1/training/runs/([^/]+)/start)", [producer, &stub](const httplib::Request& req, httplib::Response& res) {
    const std::string run_id = req.matches[1];
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kGraceDeadlineS));
    trainsched::StartRunRequest request;
    request.set_run_id(run_id);
    trainsched::StartRunReply reply;
    const grpc::Status status = stub->StartRun(&context, request, &reply);
    if (!status.ok() || !reply.accepted()) {
      res.status = 503;
      res.set_content(R"({"error":"worker did not confirm the start"})", "application/json");
      return;
    }
    record_transition(producer, run_id, "started", reply.node_count(), "");
    res.status = 200;
    res.set_content(json{{"run_id", run_id}, {"state", "running"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The message key decides the partition, and the partition decides the order a consumer replays. Key by `run_id` — the thing whose history must stay ordered — not by the priority band the run happens to sit in.',
    'A run’s history is only complete if every transition is on it: `queued`, `started`, `preempted`, `checkpointed`, `finished`, each carrying the node count and the checkpoint id the consumer needs. Two events out of five is a history with holes in exactly the places that cost GPU hours.',
    '`started` is a claim the worker has already confirmed, so check the `StartRun` reply and publish after it. Then treat the produce as part of the state change: the row and the outbox entry commit together, only the ack clears the entry, and `acks=all` plus idempotence keeps a retry from duplicating a transition.',
  ],
  debrief: `The interviewer is testing whether you understand a topic as a log ordered per key, and an event as a claim about something that already happened. The draft reads fine with one run, one producer and a healthy broker: it produces a valid payload, a valid key and a valid ack, and the flaws only appear when two runs share a band, when the worker refuses a start, or when the broker is unreachable for a minute. The checks cover exactly those: the run-id key (per-run ordering), the complete transition set with node counts and checkpoint ids (a history a consumer can replay), the ordering of started after the worker's confirmation (no claim ahead of the fact), the transactional outbox plus relay (recoverable on rejection) and acks=all with an idempotent producer (no duplicate on retry). Real systems add a schema registry with per-event versions, a consumer that stores the last applied transition so a replayed partition cannot move a run backwards, a retention window sized to the longest training run, and a relay that publishes in outbox order with a metric on its lag.`,
};
