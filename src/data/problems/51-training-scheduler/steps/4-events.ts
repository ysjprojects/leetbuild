import type {Step} from '@/lib/types';

export const trainingEventsStep: Step = {
  id: 'events',
  title: 'Run lifecycle events keyed by run',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['scheduler', 'kafka', 'consumer', 'worker'],
  task: `## Task

**Starting point.** The starter is the lifecycle publisher: \`publish_transition(run_id, transition)\`
builds \`{run_id, transition, band, nodes, checkpoint_id}\` from the run row, produces it to
\`training.run\` keyed by the run's band from a producer with \`acks=1\`, and returns \`True\`;
\`start_run(run_id, worker)\` publishes \`started\`, then calls the worker's \`StartRun\`,
\`queue.confirm_start\` and \`runs.set_nodes\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Three keys carry the whole fleet, so one run's history is mixed
into its band's; the history says a run started on a worker that refused it; a broker blip loses a
transition while the caller hears \`True\`; and a produce retried after a lost acknowledgement lands
twice, while a leader failover loses one.

- Key every record by the run id.
- \`start_run\` publishes \`started\` only once \`StartRun\` answered \`accepted\` and
  \`queue.confirm_start\` returned true, after \`runs.set_nodes\` recorded the reply's nodes; a refusal
  returns \`False\` and publishes nothing.
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` (2 s); a failed or missing acknowledgement
  inserts an outbox row (\`outbox.insert(TOPIC, run_id, payload)\`) and returns \`False\`.
- The producer runs with \`acks=all\` and \`enable.idempotence\` (Go uses confluent-kafka-go, whose
  producer can be idempotent).`,
  sequence: {
    participants: ['Scheduler', 'Worker', 'Redis', 'Kafka training.run', 'Outbox'],
    messages: [
      {from: 'Scheduler', to: 'Worker', label: 'StartRun(run_id, recipe, dataset, checkpoint)', kind: 'sync'},
      {from: 'Worker', to: 'Scheduler', label: 'accepted · nodes, or refused → False, no event', kind: 'reply'},
      {from: 'Scheduler', to: 'Redis', label: 'confirm_start · set_nodes', kind: 'sync'},
      {
        from: 'Scheduler',
        to: 'Kafka training.run',
        label: 'started · key = run_id · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'Kafka training.run', to: 'Scheduler', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'Scheduler', to: 'Outbox', label: 'no ack / failed → insert(topic, key, payload) → False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'run-key',
      title: 'Keys training.run by the run id',
      detail:
        'Three transitions for run-a, run-b, run-a carry those keys and the two run-a records share a partition. The starter keys by band, so every run of a band shares one key.',
      match: {
        python: {all: [/producer\.produce\([^\n]*key\s*=\s*run_id/]},
        typescript: {all: [/key:\s*runId/]},
        go: {all: [/Key:\s*\[\]byte\(\s*runID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*Topic\s*,\s*runId\s*,/]},
        cpp: {all: [/run_id\.c_str\(\)\s*,\s*run_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'started-after-confirm',
      title: 'Publishes started only for a start the worker accepted',
      detail:
        'A run the worker refuses gets no `started` record and stays `starting`; an accepted run gets exactly one, carrying the nodes from the reply. The starter publishes `started` before it asks.',
      match: {
        python: {
          order: [/worker\.StartRun\(/, /not reply\.accepted/, /publish_transition\(\s*run_id,\s*["']started["']\)/],
        },
        typescript: {
          order: [/worker\.StartRun\(/, /!reply\.accepted/, /publishTransition\(\s*runId,\s*['"]started['"]\)/],
        },
        go: {
          order: [
            /worker\.StartRun\(/,
            /!reply\.GetAccepted\(\)|!reply\.Accepted/,
            /publishTransition\([^\n]*"started"\)/,
          ],
        },
        scala: {order: [/\.startRun\(/, /!reply\.accepted/, /publishTransition\([^\n]*"started"\)/]},
        cpp: {order: [/worker->StartRun\(/, /!reply\.accepted\(\)/, /publishTransition\([^\n]*"started"\)/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the ack and falls back to the outbox',
      detail:
        'A failed delivery, or no acknowledgement within 2 s, leaves an outbox row with the topic, the run id and the payload, and the call returns false. The starter fires and forgets.',
      match: {
        python: {all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/outbox\.insert\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insert\(/, /\.get\(\s*[^\n]*TimeUnit/, /Failure|catch|isFailure/]},
        cpp: {all: [/outbox::insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A produce whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc
from confluent_kafka import Producer

import trainsched_pb2
import trainsched_pb2_grpc
from trainsched import outbox, queue, runs  # runs.get, set_nodes; queue.confirm_start; outbox.insert

TOPIC = "training.run"
START_TIMEOUT_S = 10

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})
worker = trainsched_pb2_grpc.WorkerStub(grpc.insecure_channel("worker:9000"))


def transition_payload(run: dict, transition: str) -> dict:
    return {"run_id": run["run_id"], "transition": transition, "band": run["band"], "nodes": run["nodes"], "checkpoint_id": run["checkpoint_id"]}


def publish_transition(run_id: str, transition: str) -> bool:
    """Tell the run-history consumers about a transition; True when the event is on its way."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = transition_payload(runs.get(run_id), transition)
    producer.produce(TOPIC, key=str(payload["band"]), value=json.dumps(payload))
    producer.poll(0)
    return True


def start_run(run_id: str, worker_name: str) -> bool:
    """Launch a claimed run on worker_name; True when it is running."""
    run = runs.get(run_id)
    publish_transition(run_id, "started")
    reply = worker.StartRun(
        trainsched_pb2.StartRunRequest(
            run_id=run_id, recipe_version=run["recipe_version"], dataset_version=run["dataset_version"], checkpoint_id=run["checkpoint_id"]
        ),
        timeout=START_TIMEOUT_S,
    )
    queue.confirm_start(run_id, worker_name)
    runs.set_nodes(run_id, list(reply.nodes))
    return reply.accepted
`,
      solution: `import json

import grpc
from confluent_kafka import Producer

import trainsched_pb2
import trainsched_pb2_grpc
from trainsched import outbox, queue, runs  # runs.get, set_nodes; queue.confirm_start; outbox.insert

TOPIC = "training.run"
START_TIMEOUT_S = 10
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a produce retried after a lost acknowledgement lands once
})
worker = trainsched_pb2_grpc.WorkerStub(grpc.insecure_channel("worker:9000"))


def transition_payload(run: dict, transition: str) -> dict:
    return {"run_id": run["run_id"], "transition": transition, "band": run["band"], "nodes": run["nodes"], "checkpoint_id": run["checkpoint_id"]}


def publish_transition(run_id: str, transition: str) -> bool:
    """Tell the run-history consumers about a transition; True once the broker acknowledged it."""
    payload = transition_payload(runs.get(run_id), transition)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    # One key per run: its transitions share a partition, so a consumer reads them in order.
    producer.produce(TOPIC, key=run_id, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the history is late, not wrong.
        outbox.insert(TOPIC, run_id, payload)
        return False
    return True


def start_run(run_id: str, worker_name: str) -> bool:
    """Launch a claimed run on worker_name; True when it is running."""
    run = runs.get(run_id)
    reply = worker.StartRun(
        trainsched_pb2.StartRunRequest(
            run_id=run_id, recipe_version=run["recipe_version"], dataset_version=run["dataset_version"], checkpoint_id=run["checkpoint_id"]
        ),
        timeout=START_TIMEOUT_S,
    )
    if not reply.accepted:
        return False  # its lease runs out and the reaper queues it again
    if not queue.confirm_start(run_id, worker_name):
        return False  # the lease ran out first: the run belongs to another start
    runs.set_nodes(run_id, list(reply.nodes))
    publish_transition(run_id, "started")
    return True
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Kafka} from 'kafkajs';

import * as outbox from 'trainsched/outbox';
import {confirmStart} from 'trainsched/queue';
import {type Run, get, setNodes} from 'trainsched/runs';

export const TOPIC = 'training.run';
export const START_TIMEOUT_MS = 10_000;

const kafka = new Kafka({clientId: 'trainsched', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('trainsched.proto')) as unknown as {
  trainsched: {Worker: grpc.ServiceClientConstructor};
};
const worker = new pkg.trainsched.Worker('worker:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  StartRun(
    request: {run_id: string; recipe_version: string; dataset_version: string; checkpoint_id: string},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): Promise<{accepted: boolean; nodes: string[]; reason: string}>;
};

export const transitionPayload = (run: Run, transition: string) => ({
  run_id: run.run_id,
  transition,
  band: run.band,
  nodes: run.nodes,
  checkpoint_id: run.checkpoint_id,
});

/** Tell the run-history consumers about a transition; true when the event is on its way. */
export async function publishTransition(runId: string, transition: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = transitionPayload((await get(runId)) as Run, transition);
  void producer.send({topic: TOPIC, messages: [{key: String(payload.band), value: JSON.stringify(payload)}], acks: 1});
  return true;
}

/** Launch a claimed run on workerName; true when it is running. */
export async function startRun(runId: string, workerName: string): Promise<boolean> {
  const run = (await get(runId)) as Run;
  await publishTransition(runId, 'started');
  const reply = await worker.StartRun(
    {run_id: runId, recipe_version: run.recipe_version, dataset_version: run.dataset_version, checkpoint_id: run.checkpoint_id},
    new grpc.Metadata(),
    {deadline: Date.now() + START_TIMEOUT_MS},
  );
  await confirmStart(runId, workerName);
  await setNodes(runId, reply.nodes);
  return reply.accepted;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Kafka} from 'kafkajs';

import * as outbox from 'trainsched/outbox';
import {confirmStart} from 'trainsched/queue';
import {type Run, get, setNodes} from 'trainsched/runs';

export const TOPIC = 'training.run';
export const START_TIMEOUT_MS = 10_000;
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'trainsched', brokers: ['kafka:9092']});
// Idempotent: a produce retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('trainsched.proto')) as unknown as {
  trainsched: {Worker: grpc.ServiceClientConstructor};
};
const worker = new pkg.trainsched.Worker('worker:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  StartRun(
    request: {run_id: string; recipe_version: string; dataset_version: string; checkpoint_id: string},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): Promise<{accepted: boolean; nodes: string[]; reason: string}>;
};

export const transitionPayload = (run: Run, transition: string) => ({
  run_id: run.run_id,
  transition,
  band: run.band,
  nodes: run.nodes,
  checkpoint_id: run.checkpoint_id,
});

/** Tell the run-history consumers about a transition; true once the broker acknowledged it. */
export async function publishTransition(runId: string, transition: string): Promise<boolean> {
  const payload = transitionPayload((await get(runId)) as Run, transition);
  try {
    // One key per run: its transitions share a partition, so a consumer reads them in order.
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: runId, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the history is late, not wrong.
    await outbox.insert(TOPIC, runId, payload);
    return false;
  }
}

/** Launch a claimed run on workerName; true when it is running. */
export async function startRun(runId: string, workerName: string): Promise<boolean> {
  const run = (await get(runId)) as Run;
  const reply = await worker.StartRun(
    {run_id: runId, recipe_version: run.recipe_version, dataset_version: run.dataset_version, checkpoint_id: run.checkpoint_id},
    new grpc.Metadata(),
    {deadline: Date.now() + START_TIMEOUT_MS},
  );
  if (!reply.accepted) return false; // its lease runs out and the reaper queues it again
  if (!(await confirmStart(runId, workerName))) return false; // the lease ran out first: the run belongs to another start
  await setNodes(runId, reply.nodes);
  await publishTransition(runId, 'started');
  return true;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "trainsched/gen/trainsched"
	"trainsched/queue" // queue.ConfirmStart
	"trainsched/runs"  // runs.Get, SetNodes
)

const (
	topic        = "training.run"
	startTimeout = 10 * time.Second
)

var producer = newProducer()

var (
	workerConn, _ = grpc.NewClient("worker:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	worker        = pb.NewWorkerClient(workerConn)
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func transitionPayload(run *runs.Run, transition string) map[string]any {
	return map[string]any{"run_id": run.RunID, "transition": transition, "band": run.Band, "nodes": run.Nodes, "checkpoint_id": run.CheckpointID}
}

// publishTransition tells the run-history consumers about a transition; true when the event is on its way.
func publishTransition(ctx context.Context, runID, transition string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	run := runs.Get(ctx, runID)
	if run == nil {
		return false, fmt.Errorf("no run %s", runID)
	}
	value, _ := json.Marshal(transitionPayload(run, transition))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(strconv.Itoa(run.Band)), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	return true, nil
}

// startRun launches a claimed run on workerName; true when it is running.
func startRun(ctx context.Context, runID, workerName string) (bool, error) {
	run := runs.Get(ctx, runID)
	if run == nil {
		return false, fmt.Errorf("no run %s", runID)
	}
	publishTransition(ctx, runID, "started")
	callCtx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()
	reply, err := worker.StartRun(callCtx, &pb.StartRunRequest{RunId: runID, RecipeVersion: run.RecipeVersion, DatasetVersion: run.DatasetVersion, CheckpointId: run.CheckpointID})
	if err != nil {
		return false, err
	}
	queue.ConfirmStart(ctx, runID, workerName)
	runs.SetNodes(ctx, runID, reply.GetNodes())
	return reply.GetAccepted(), nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "trainsched/gen/trainsched"
	"trainsched/outbox" // outbox.Insert
	"trainsched/queue"  // queue.ConfirmStart
	"trainsched/runs"   // runs.Get, SetNodes
)

const (
	topic        = "training.run"
	startTimeout = 10 * time.Second
	ackTimeout   = 2 * time.Second
)

var producer = newProducer()

var (
	workerConn, _ = grpc.NewClient("worker:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	worker        = pb.NewWorkerClient(workerConn)
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a produce retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

func transitionPayload(run *runs.Run, transition string) map[string]any {
	return map[string]any{"run_id": run.RunID, "transition": transition, "band": run.Band, "nodes": run.Nodes, "checkpoint_id": run.CheckpointID}
}

// publishTransition tells the run-history consumers about a transition; true once the broker acknowledged it.
func publishTransition(ctx context.Context, runID, transition string) (bool, error) {
	run := runs.Get(ctx, runID)
	if run == nil {
		return false, fmt.Errorf("no run %s", runID)
	}
	payload := transitionPayload(run, transition)
	value, _ := json.Marshal(payload)
	t := topic
	// One key per run: its transitions share a partition, so a consumer reads them in order.
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(runID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no acknowledgement within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the history is late, not wrong.
		return false, outbox.Insert(ctx, topic, runID, payload)
	}
	return true, nil
}

// startRun launches a claimed run on workerName; true when it is running.
func startRun(ctx context.Context, runID, workerName string) (bool, error) {
	run := runs.Get(ctx, runID)
	if run == nil {
		return false, fmt.Errorf("no run %s", runID)
	}
	callCtx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()
	reply, err := worker.StartRun(callCtx, &pb.StartRunRequest{RunId: runID, RecipeVersion: run.RecipeVersion, DatasetVersion: run.DatasetVersion, CheckpointId: run.CheckpointID})
	if err != nil {
		return false, err
	}
	if !reply.GetAccepted() {
		return false, nil // its lease runs out and the reaper queues it again
	}
	confirmed, err := queue.ConfirmStart(ctx, runID, workerName)
	if err != nil || !confirmed {
		return false, err // the lease ran out first: the run belongs to another start
	}
	if err := runs.SetNodes(ctx, runID, reply.GetNodes()); err != nil {
		return false, err
	}
	_, err = publishTransition(ctx, runID, "started")
	return true, err
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import trainsched.{Outbox, Queue, Runs} // Runs.get, setNodes; Queue.confirmStart; Outbox.insert
import trainsched.trainsched.{StartRunRequest, WorkerGrpc}

object RunEvents {
  val Topic = "training.run"
  val StartTimeoutS = 10L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  private val worker = WorkerGrpc.blockingStub(ManagedChannelBuilder.forAddress("worker", 9000).usePlaintext().build())

  def transitionPayload(run: Runs.Run, transition: String): JsObject =
    JsObject(
      "run_id" -> JsString(run.runId),
      "transition" -> JsString(transition),
      "band" -> JsNumber(run.band),
      "nodes" -> JsArray(run.nodes.map(JsString(_)).toVector),
      "checkpoint_id" -> JsString(run.checkpointId)
    )

  /** Tell the run-history consumers about a transition; true when the event is on its way. */
  def publishTransition(runId: String, transition: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val run = Runs.get(runId).get
    producer.send(new ProducerRecord[String, String](Topic, run.band.toString, transitionPayload(run, transition).compactPrint))
    true
  }

  /** Launch a claimed run on workerName; true when it is running. */
  def startRun(runId: String, workerName: String): Boolean = {
    val run = Runs.get(runId).get
    publishTransition(runId, "started")
    val reply = worker
      .withDeadlineAfter(StartTimeoutS, TimeUnit.SECONDS)
      .startRun(StartRunRequest(runId = runId, recipeVersion = run.recipeVersion, datasetVersion = run.datasetVersion, checkpointId = run.checkpointId))
    Queue.confirmStart(runId, workerName)
    Runs.setNodes(runId, reply.nodes)
    reply.accepted
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import io.grpc.ManagedChannelBuilder
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import trainsched.{Outbox, Queue, Runs} // Runs.get, setNodes; Queue.confirmStart; Outbox.insert
import trainsched.trainsched.{StartRunRequest, WorkerGrpc}

object RunEvents {
  val Topic = "training.run"
  val StartTimeoutS = 10L
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a produce retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  private val worker = WorkerGrpc.blockingStub(ManagedChannelBuilder.forAddress("worker", 9000).usePlaintext().build())

  def transitionPayload(run: Runs.Run, transition: String): JsObject =
    JsObject(
      "run_id" -> JsString(run.runId),
      "transition" -> JsString(transition),
      "band" -> JsNumber(run.band),
      "nodes" -> JsArray(run.nodes.map(JsString(_)).toVector),
      "checkpoint_id" -> JsString(run.checkpointId)
    )

  /** Tell the run-history consumers about a transition; true once the broker acknowledged it. */
  def publishTransition(runId: String, transition: String): Boolean = {
    val payload = transitionPayload(Runs.get(runId).get, transition)
    // One key per run: its transitions share a partition, so a consumer reads them in order.
    val record = new ProducerRecord[String, String](Topic, runId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the history is late, not wrong.
      Outbox.insert(Topic, runId, payload)
    }
    acked.isSuccess
  }

  /** Launch a claimed run on workerName; true when it is running. */
  def startRun(runId: String, workerName: String): Boolean = {
    val run = Runs.get(runId).get
    val reply = worker
      .withDeadlineAfter(StartTimeoutS, TimeUnit.SECONDS)
      .startRun(StartRunRequest(runId = runId, recipeVersion = run.recipeVersion, datasetVersion = run.datasetVersion, checkpointId = run.checkpointId))
    if (!reply.accepted) false // its lease runs out and the reaper queues it again
    else if (!Queue.confirmStart(runId, workerName)) false // the lease ran out first: the run belongs to another start
    else {
      Runs.setNodes(runId, reply.nodes)
      publishTransition(runId, "started")
      true
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "trainsched.grpc.pb.h"
#include "trainsched/outbox.h"  // outbox::insert
#include "trainsched/queue.h"   // queue::confirmStart
#include "trainsched/runs.h"    // runs::get, setNodes

using json = nlohmann::json;

const std::string kTopic = "training.run";
constexpr int kStartTimeoutS = 10;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();
auto worker = trainsched::Worker::NewStub(grpc::CreateChannel("worker:9000", grpc::InsecureChannelCredentials()));

json transitionPayload(const runs::Run& run, const std::string& transition) {
  return json{{"run_id", run.run_id}, {"transition", transition}, {"band", run.band}, {"nodes", run.nodes}, {"checkpoint_id", run.checkpoint_id}};
}

// Tell the run-history consumers about a transition; true when the event is on its way.
bool publishTransition(const std::string& run_id, const std::string& transition) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto run = runs::get(run_id);
  if (!run) throw std::runtime_error("no run " + run_id);
  const std::string value = transitionPayload(*run, transition).dump();
  const std::string key = std::to_string(run->band);
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    key.c_str(), key.size(), 0, nullptr);
  producer->poll(0);
  return true;
}

// Launch a claimed run on worker_name; true when it is running.
bool startRun(const std::string& run_id, const std::string& worker_name) {
  const auto run = runs::get(run_id);
  if (!run) throw std::runtime_error("no run " + run_id);
  publishTransition(run_id, "started");
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds{kStartTimeoutS});
  trainsched::StartRunRequest request;
  request.set_run_id(run_id);
  request.set_recipe_version(run->recipe_version);
  request.set_dataset_version(run->dataset_version);
  request.set_checkpoint_id(run->checkpoint_id);
  trainsched::StartRunReply reply;
  const grpc::Status status = worker->StartRun(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("start: " + status.error_message());
  queue::confirmStart(run_id, worker_name);
  runs::setNodes(run_id, std::vector<std::string>(reply.nodes().begin(), reply.nodes().end()));
  return reply.accepted();
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "trainsched.grpc.pb.h"
#include "trainsched/outbox.h"  // outbox::insert
#include "trainsched/queue.h"   // queue::confirmStart
#include "trainsched/runs.h"    // runs::get, setNodes

using json = nlohmann::json;

const std::string kTopic = "training.run";
constexpr int kStartTimeoutS = 10;
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishTransition produces one record and waits for it.
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
  conf->set("enable.idempotence", "true", err);  // a produce retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();
auto worker = trainsched::Worker::NewStub(grpc::CreateChannel("worker:9000", grpc::InsecureChannelCredentials()));

json transitionPayload(const runs::Run& run, const std::string& transition) {
  return json{{"run_id", run.run_id}, {"transition", transition}, {"band", run.band}, {"nodes", run.nodes}, {"checkpoint_id", run.checkpoint_id}};
}

// Tell the run-history consumers about a transition; true once the broker acknowledged it.
bool publishTransition(const std::string& run_id, const std::string& transition) {
  const auto run = runs::get(run_id);
  if (!run) throw std::runtime_error("no run " + run_id);
  const json payload = transitionPayload(*run, transition);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  // One key per run: its transitions share a partition, so a consumer reads them in order.
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), run_id.c_str(), run_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the history is late, not wrong.
    outbox::insert(kTopic, run_id, payload);
    return false;
  }
  return true;
}

// Launch a claimed run on worker_name; true when it is running.
bool startRun(const std::string& run_id, const std::string& worker_name) {
  const auto run = runs::get(run_id);
  if (!run) throw std::runtime_error("no run " + run_id);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds{kStartTimeoutS});
  trainsched::StartRunRequest request;
  request.set_run_id(run_id);
  request.set_recipe_version(run->recipe_version);
  request.set_dataset_version(run->dataset_version);
  request.set_checkpoint_id(run->checkpoint_id);
  trainsched::StartRunReply reply;
  const grpc::Status status = worker->StartRun(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("start: " + status.error_message());
  if (!reply.accepted()) return false;                            // its lease runs out and the reaper queues it again
  if (!queue::confirmStart(run_id, worker_name)) return false;  // the lease ran out first: the run belongs to another start
  runs::setNodes(run_id, std::vector<std::string>(reply.nodes().begin(), reply.nodes().end()));
  publishTransition(run_id, "started");
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

import trainsched_pb2
import trainsched_pb2_grpc
from trainsched import queue, runs

TOPIC = "training.run"


class Worker(trainsched_pb2_grpc.WorkerServicer):
    """A worker agent that launches every run on n3 and n4, except those in reject."""

    def __init__(self):
        self.reject = set()

    def StartRun(self, request, context):
        if request.run_id in self.reject:
            return trainsched_pb2.StartRunReply(accepted=False, reason="no free GPUs on this node")
        return trainsched_pb2.StartRunReply(accepted=True, nodes=["n3", "n4"])


def _setup(ctx):
    worker = Worker()
    ctx.grpc.serve(trainsched_pb2_grpc.add_WorkerServicer_to_server, worker)
    return ctx.load("events"), worker


def _queued(ctx, run_id, band=1):
    now = int(ctx.clock.time() * 1000)
    runs.put({"run_id": run_id, "tenant": "t1", "recipe_version": "llama-ft-v3", "dataset_version": "ds-1", "priority": 8 - 3 * band,
              "band": band, "state": "queued", "enqueued_at_ms": now, "checkpoint_id": "ckpt-7"})
    queue.enqueue(run_id, band, now)
    return now


def _payloads(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_run_key(ctx):
    m, _ = _setup(ctx)
    _queued(ctx, "run-a")
    _queued(ctx, "run-b")
    m.publish_transition("run-a", "queued")
    m.publish_transition("run-b", "queued")
    m.publish_transition("run-a", "preempted")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_transition calls produced {len(records)} records on training.run"
    keys = [r.key for r in records]
    assert keys == [b"run-a", b"run-b", b"run-a"], f"the records are keyed {keys}, expected the run ids run-a, run-b, run-a"
    assert records[0].partition == records[2].partition, "both run-a records must land on one partition, or a consumer reads one run's history out of order"


def check_started_after_confirm(ctx):
    m, worker = _setup(ctx)
    now = _queued(ctx, "run-a")
    _queued(ctx, "run-b")
    assert queue.claim_next("w-1", now) == "run-a" and queue.claim_next("w-2", now) == "run-b", "both runs must be claimable"
    worker.reject.add("run-a")
    refused = m.start_run("run-a", "w-1")
    assert refused is False, f"start_run returned {refused!r} for a run the worker refused, expected False"
    started = [p for p in _payloads(ctx) if p.get("transition") == "started"]
    assert not [p for p in started if p.get("run_id") == "run-a"], f"training.run says run-a started, but the worker refused it: {started}"
    assert runs.get("run-a")["state"] == "starting", f"a refused run reads {runs.get('run-a')['state']!r}: it stays starting until its lease runs out"
    assert m.start_run("run-b", "w-2") is True, "start_run must return True for a run the worker accepted"
    started = [p for p in _payloads(ctx) if p.get("transition") == "started"]
    assert len(started) == 1 and started[0].get("run_id") == "run-b", f"one accepted start must publish one started record for run-b, got {started}"
    assert started[0].get("nodes") == ["n3", "n4"], f"the started record carries nodes {started[0].get('nodes')}, the worker placed it on ['n3', 'n4']"
    assert runs.get("run-b")["state"] == "running", f"an accepted run reads {runs.get('run-b')['state']!r}, expected running"


def check_outbox_on_failure(ctx):
    m, _ = _setup(ctx)
    _queued(ctx, "run-a")
    _queued(ctx, "run-b")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_transition("run-a", "queued")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the transition is missing from every run history"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "run-a" and rows[0].get("payload", {}).get("transition") == "queued", f"the outbox row is {rows[0]}, expected the topic, the key run-a and the payload"
    assert ok is False, f"publish_transition returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_transition("run-b", "queued")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_transition waited {waited:.0f} s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("key") == "run-b", f"no acknowledgement within the window and the outbox holds {rows}"
    assert ok is False, f"publish_transition returned {ok!r} without an acknowledgement, expected False"


def check_acks_idempotent(ctx):
    m, _ = _setup(ctx)
    _queued(ctx, "run-a")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_transition("run-a", "queued")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the transition twice. Enable idempotence"
    m.publish_transition("run-a", "preempted")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"
`,
    typescript: `const TOPIC = 'training.run';

function setup(ctx) {
  const pkg = ctx.proto('trainsched.proto');
  const reject = new Set<string>();
  ctx.grpc.serve(pkg.trainsched.Worker.service, {
    StartRun(call, callback) {
      if (reject.has(call.request.run_id)) return callback(null, {accepted: false, nodes: [], reason: 'no free GPUs on this node'});
      callback(null, {accepted: true, nodes: ['n3', 'n4'], reason: ''});
    },
  });
  return {m: ctx.load('events'), reject, runs: ctx.load('/support/trainsched/runs.ts'), queue: ctx.load('/support/trainsched/queue.ts')};
}

async function queued(ctx, runs, queue, runId: string, band = 1): Promise<number> {
  const now = ctx.clock.now();
  await runs.put({run_id: runId, tenant: 't1', recipe_version: 'llama-ft-v3', dataset_version: 'ds-1', priority: 8 - 3 * band, band, state: 'queued', enqueued_at_ms: now, worker: '', nodes: [], checkpoint_id: 'ckpt-7'});
  await queue.enqueue(runId, band, now);
  return now;
}

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const payloads = ctx => ctx.kafka.values(TOPIC).map(v => JSON.parse(v));
const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

export async function check_run_key(ctx) {
  const {m, runs, queue} = setup(ctx);
  await queued(ctx, runs, queue, 'run-a');
  await queued(ctx, runs, queue, 'run-b');
  await m.publishTransition('run-a', 'queued');
  await m.publishTransition('run-b', 'queued');
  await m.publishTransition('run-a', 'preempted');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishTransition calls produced \${records.length} records on training.run\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['run-a', 'run-b', 'run-a'], \`the records are keyed \${JSON.stringify(keys)}, expected the run ids run-a, run-b, run-a\`);
  assert.equal(records[0].partition, records[2].partition, "both run-a records must land on one partition, or a consumer reads one run's history out of order");
}

export async function check_started_after_confirm(ctx) {
  const {m, reject, runs, queue} = setup(ctx);
  const now = await queued(ctx, runs, queue, 'run-a');
  await queued(ctx, runs, queue, 'run-b');
  assert((await queue.claimNext('w-1', now)) === 'run-a' && (await queue.claimNext('w-2', now)) === 'run-b', 'both runs must be claimable');
  reject.add('run-a');
  const refused = await m.startRun('run-a', 'w-1');
  await settle();
  assert.equal(refused, false, \`startRun returned \${refused} for a run the worker refused, expected false\`);
  let started = payloads(ctx).filter(p => p.transition === 'started');
  assert.equal(started.filter(p => p.run_id === 'run-a').length, 0, \`training.run says run-a started, but the worker refused it: \${JSON.stringify(started)}\`);
  assert.equal((await runs.get('run-a')).state, 'starting', 'a refused run stays starting until its lease runs out');
  assert.equal(await m.startRun('run-b', 'w-2'), true, 'startRun must return true for a run the worker accepted');
  await settle();
  started = payloads(ctx).filter(p => p.transition === 'started');
  assert(started.length === 1 && started[0].run_id === 'run-b', \`one accepted start must publish one started record for run-b, got \${JSON.stringify(started)}\`);
  assert.deepEqual(started[0].nodes, ['n3', 'n4'], \`the started record carries nodes \${JSON.stringify(started[0].nodes)}, the worker placed it on ["n3","n4"]\`);
  assert.equal((await runs.get('run-b')).state, 'running', 'an accepted run must read running');
}

export async function check_outbox_on_failure(ctx) {
  const {m, runs, queue} = setup(ctx);
  await queued(ctx, runs, queue, 'run-a');
  await queued(ctx, runs, queue, 'run-b');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishTransition('run-a', 'queued');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the transition is missing from every run history\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'run-a' && rows[0].payload?.transition === 'queued', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key run-a and the payload\`);
  assert.equal(ok, false, \`publishTransition resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishTransition('run-b', 'queued');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishTransition waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].key === 'run-b', \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishTransition resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}

export async function check_acks_idempotent(ctx) {
  const {m, runs, queue} = setup(ctx);
  await queued(ctx, runs, queue, 'run-a');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishTransition('run-a', 'queued');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the transition twice. Enable idempotence\`);
  await m.publishTransition('run-a', 'preempted');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	pb "trainsched/gen/trainsched"
	"trainsched/queue"
	"trainsched/runs"

	"leetbuild/harness"
)

const eventsTopic = "training.run"

var eventsBg = context.Background()

// startPeer is a worker agent that launches every run on n3 and n4, except those in reject.
type startPeer struct {
	pb.UnimplementedWorkerServer
	reject map[string]bool
}

func (w *startPeer) StartRun(_ context.Context, req *pb.StartRunRequest) (*pb.StartRunReply, error) {
	if w.reject[req.GetRunId()] {
		return &pb.StartRunReply{Accepted: false, Reason: "no free GPUs on this node"}, nil
	}
	return &pb.StartRunReply{Accepted: true, Nodes: []string{"n3", "n4"}}, nil
}

func eventsSetup(ctx *harness.Ctx) *startPeer {
	w := &startPeer{reject: map[string]bool{}}
	pb.RegisterWorkerServer(ctx.GRPC.Server(""), w)
	return w
}

func eventsQueued(ctx *harness.Ctx, runID string) int64 {
	now := ctx.Clock.Now()
	ctx.NoError(runs.Put(eventsBg, &runs.Run{RunID: runID, Tenant: "t1", RecipeVersion: "llama-ft-v3", DatasetVersion: "ds-1", Priority: 5, Band: 1, State: "queued", EnqueuedAtMs: now, CheckpointID: "ckpt-7"}), "runs.Put")
	ctx.NoError(queue.Enqueue(eventsBg, runID, 1, now), "queue.Enqueue")
	return now
}

func eventsPublish(ctx *harness.Ctx, runID, transition string) bool {
	ok, err := publishTransition(eventsBg, runID, transition)
	ctx.NoError(err, "publishTransition(%s, %s)", runID, transition)
	return ok
}

type transitionRecord struct {
	RunID      string   \`json:"run_id"\`
	Transition string   \`json:"transition"\`
	Nodes      []string \`json:"nodes"\`
}

func startedRecords(ctx *harness.Ctx) []transitionRecord {
	out := []transitionRecord{}
	for _, v := range ctx.Kafka.Values(eventsTopic) {
		var r transitionRecord
		ctx.NoError(json.Unmarshal([]byte(v), &r), "a training.run record must be JSON")
		if r.Transition == "started" {
			out = append(out, r)
		}
	}
	return out
}

type outboxRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func outboxRows(ctx *harness.Ctx) []outboxRow {
	rows := []outboxRow{}
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row outboxRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckRunKey(ctx *harness.Ctx) {
	eventsSetup(ctx)
	eventsQueued(ctx, "run-a")
	eventsQueued(ctx, "run-b")
	eventsPublish(ctx, "run-a", "queued")
	eventsPublish(ctx, "run-b", "queued")
	eventsPublish(ctx, "run-a", "preempted")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three publishTransition calls must produce three records on training.run; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"run-a", "run-b", "run-a"}, "the records must be keyed by the run ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both run-a records must land on one partition, or a consumer reads one run's history out of order; the partitions")
}

func CheckStartedAfterConfirm(ctx *harness.Ctx) {
	w := eventsSetup(ctx)
	now := eventsQueued(ctx, "run-a")
	eventsQueued(ctx, "run-b")
	first, _ := queue.ClaimNext(eventsBg, "w-1", now)
	second, _ := queue.ClaimNext(eventsBg, "w-2", now)
	ctx.Assert(first == "run-a" && second == "run-b", "both runs must be claimable")
	w.reject["run-a"] = true
	refused, err := startRun(eventsBg, "run-a", "w-1")
	ctx.NoError(err, "startRun(run-a)")
	ctx.Settle()
	ctx.Equal(refused, false, "startRun's result for a run the worker refused")
	for _, r := range startedRecords(ctx) {
		ctx.Assert(r.RunID != "run-a", "training.run says run-a started, but the worker refused it")
	}
	ctx.Equal(runs.Get(eventsBg, "run-a").State, "starting", "a refused run stays starting until its lease runs out; its state")
	accepted, err := startRun(eventsBg, "run-b", "w-2")
	ctx.NoError(err, "startRun(run-b)")
	ctx.Settle()
	ctx.Equal(accepted, true, "startRun's result for a run the worker accepted")
	started := startedRecords(ctx)
	ctx.Assert(len(started) == 1 && started[0].RunID == "run-b", "one accepted start must publish one started record for run-b, got %+v", started)
	ctx.Equal(started[0].Nodes, []string{"n3", "n4"}, "the started record's nodes (the worker placed it on n3, n4)")
	ctx.Equal(runs.Get(eventsBg, "run-b").State, "running", "an accepted run's state")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	eventsSetup(ctx)
	eventsQueued(ctx, "run-a")
	eventsQueued(ctx, "run-b")
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, "run-a", "queued")
	ctx.Settle()
	rows := outboxRows(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the transition is missing from every run history; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "run-a" && rows[0].Payload["transition"] == "queued", "the outbox row is %+v, expected the topic, the key run-a and the payload", rows[0])
	ctx.Equal(ok, false, "publishTransition's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, "run-b", "queued")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishTransition waited %.0f s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row", waited)
	rows = outboxRows(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Key == "run-b", "no acknowledgement within the window and the outbox holds %+v", rows)
	ctx.Equal(ok, false, "publishTransition's result without an acknowledgement")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	eventsSetup(ctx)
	eventsQueued(ctx, "run-a")
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, "run-a", "queued")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the transition twice (enable.idempotence); the records")
	eventsPublish(ctx, "run-a", "preempted")
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "training.run";

// A worker agent that launches every run on n3 and n4, except those in reject.
class StartPeer final : public trainsched::Worker::Service {
 public:
  std::set<std::string> reject;
  grpc::Status StartRun(grpc::ServerContext*, const trainsched::StartRunRequest* req, trainsched::StartRunReply* out) override {
    if (reject.count(req->run_id())) {
      out->set_accepted(false);
      out->set_reason("no free GPUs on this node");
      return grpc::Status::OK;
    }
    out->set_accepted(true);
    out->add_nodes("n3");
    out->add_nodes("n4");
    return grpc::Status::OK;
  }
};

StartPeer& eventsSetup(harness::Ctx& ctx) {
  static StartPeer* peer = nullptr;
  delete peer;
  peer = new StartPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

long long eventsQueued(harness::Ctx& ctx, const std::string& run_id) {
  const long long now = ctx.Clock.Now();
  runs::Run run;
  run.run_id = run_id;
  run.tenant = "t1";
  run.recipe_version = "llama-ft-v3";
  run.dataset_version = "ds-1";
  run.priority = 5;
  run.band = 1;
  run.state = "queued";
  run.enqueued_at_ms = now;
  run.checkpoint_id = "ckpt-7";
  runs::put(run);
  queue::enqueue(run_id, 1, now);
  return now;
}

std::string text(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

std::vector<nlohmann::json> startedRecords(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& v : ctx.Kafka.Values(kEventsTopic)) {
    const auto record = nlohmann::json::parse(v, nullptr, false);
    if (text(record, "transition") == "started") out.push_back(record);
  }
  return out;
}

std::vector<nlohmann::json> outboxRows(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& row : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto parsed = nlohmann::json::parse(row, nullptr, false);
    ctx.Assert(parsed.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", row);
    rows.push_back(parsed);
  }
  return rows;
}

}  // namespace

void CheckRunKey(harness::Ctx& ctx) {
  eventsSetup(ctx);
  eventsQueued(ctx, "run-a");
  eventsQueued(ctx, "run-b");
  publishTransition("run-a", "queued");
  publishTransition("run-b", "queued");
  publishTransition("run-a", "preempted");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three publishTransition calls must produce three records on training.run; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"run-a", "run-b", "run-a"}, "the records must be keyed by the run ids");
  ctx.Equal(records[0].Partition, records[2].Partition, "both run-a records must land on one partition, or a consumer reads one run's history out of order; the partitions");
}

void CheckStartedAfterConfirm(harness::Ctx& ctx) {
  auto& w = eventsSetup(ctx);
  const long long now = eventsQueued(ctx, "run-a");
  eventsQueued(ctx, "run-b");
  const auto first = queue::claimNext("w-1", now);
  const auto second = queue::claimNext("w-2", now);
  ctx.Assert(first == std::optional<std::string>("run-a") && second == std::optional<std::string>("run-b"), "both runs must be claimable");
  w.reject.insert("run-a");
  const bool refused = startRun("run-a", "w-1");
  ctx.Settle();
  ctx.Equal(refused, false, "startRun's result for a run the worker refused");
  for (const auto& r : startedRecords(ctx)) ctx.Assert(text(r, "run_id") != "run-a", "training.run says run-a started, but the worker refused it");
  ctx.Equal(runs::get("run-a")->state, "starting", "a refused run stays starting until its lease runs out; its state");
  ctx.Equal(startRun("run-b", "w-2"), true, "startRun's result for a run the worker accepted");
  ctx.Settle();
  const auto started = startedRecords(ctx);
  ctx.Assert(started.size() == 1 && text(started[0], "run_id") == "run-b", "one accepted start must publish one started record for run-b, got %d", started.size());
  ctx.Equal(started[0]["nodes"], nlohmann::json{"n3", "n4"}, "the started record's nodes (the worker placed it on n3, n4)");
  ctx.Equal(runs::get("run-b")->state, "running", "an accepted run's state");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  eventsSetup(ctx);
  eventsQueued(ctx, "run-a");
  eventsQueued(ctx, "run-b");
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishTransition("run-a", "queued");
  ctx.Settle();
  auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the transition is missing from every run history; the rows");
  ctx.Assert(text(rows[0], "topic") == kEventsTopic && text(rows[0], "key") == "run-a" && rows[0].contains("payload") && text(rows[0]["payload"], "transition") == "queued",
             "the outbox row is %s, expected the topic, the key run-a and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishTransition's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const long long before = ctx.Clock.Now();
  ok = publishTransition("run-b", "queued");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishTransition waited %.0f s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row", waited);
  rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 2 && text(rows[1], "key") == "run-b", "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishTransition's result without an acknowledgement");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  eventsSetup(ctx);
  eventsQueued(ctx, "run-a");
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishTransition("run-a", "queued");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the transition twice (enable.idempotence); the records");
  publishTransition("run-a", "preempted");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}
`,
  },
  hints: [
    'The run history shows a run training on a worker that refused it, a preemption that never appears after a broker restart, and once a duplicated `queued` event.',
    'The key is the band, so whole bands share a key; `started` is published before `StartRun` answers; a produce that is not awaited can fail after the caller returned, and `acks=1` without idempotence duplicates or drops.',
    'Key by `run_id`; in `start_run`, check `reply.accepted` and `confirm_start` first, `set_nodes`, then publish `started`; produce with `on_delivery`, `flush(ACK_TIMEOUT_S)`, `outbox.insert` on failure; set `acks=all` and `enable.idempotence`.',
  ],
  debrief: `An event states a fact, so \`started\` waits for the two facts it depends on: the worker accepted the run and this scheduler still held its lease. The run id as key is what lets a consumer, or a compacted topic, keep one history per run; a band key hands every run of a band one partition and one compaction slot. Waiting for the delivery report gives the return value its meaning, and the outbox turns a broker outage into a late history instead of a hole in it; idempotence with \`acks=all\` closes the retry gap that waiting opens. Production schedulers write the outbox row in the same transaction as the state change and let a relay do every produce, and they put a sequence number per run in the payload so consumers can drop a replay.`,
};
