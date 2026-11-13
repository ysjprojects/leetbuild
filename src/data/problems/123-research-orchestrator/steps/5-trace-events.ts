import type {Step} from '@/lib/types';

export const traceEventsStep: Step = {
  id: 'trace-events',
  title: 'research.trace: decisions without content, an end-state eval that survives a crash',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'trace_events',
  focus: ['lead', 'kafka', 'evaluator', 'redis'],
  task: `## Task

**Starting point.** The starter is the trace pipeline. \`trace(decision)\` takes one decision of the
lead or a subagent (\`job_id\`, \`agent_id\`, \`tool\`, \`latency_ms\`, \`tokens\`, \`outcome\`, and the
\`query\` and \`findings\` it worked on), adds \`version\` (\`SERVICE_VERSION\` from \`research.jobs\`) and
produces the whole of it to \`research.trace\` keyed by the agent id, from a default producer.
\`run_eval()\` consumes the topic as group \`end-state-eval\` with auto-commit off, commits each record,
then, for a \`job.completed\` event, writes \`research:{job_id}:eval\`: \`completeness\` (results over plan
tasks, two decimals), \`tool_calls\` and \`version\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** One job's decisions land on three partitions and replay out of
order; customer queries and findings sit in a topic every team can read; a lost acknowledgement writes
a decision twice; a consumer crash between commit and write leaves a finished job unevaluated.

- The record key is the **job id**.
- The event carries \`TRACE_FIELDS\` (\`job_id\`, \`agent_id\`, \`tool\`, \`latency_ms\`, \`tokens\`,
  \`outcome\`) and \`version\`, nothing else.
- The producer is **idempotent** with \`acks=all\` (kafka-go has no idempotent mode: \`RequireAll\`).
- \`run_eval\` writes the evaluation **before** it commits the offset, and commits a record only once
  its write succeeded.`,
  sequence: {
    participants: ['Lead agent', 'research.trace', 'End-state eval', 'Redis'],
    messages: [
      {from: 'Lead agent', to: 'research.trace', label: 'produce key=job-1 · TRACE_FIELDS + version', kind: 'async'},
      {from: 'research.trace', to: 'Lead agent', label: 'ack (idempotent · acks=all)', kind: 'reply'},
      {from: 'research.trace', to: 'End-state eval', label: 'consume · group end-state-eval', kind: 'async'},
      {from: 'End-state eval', to: 'Redis', label: 'HGET plan · HLEN results · GET tools', kind: 'sync'},
      {from: 'End-state eval', to: 'Redis', label: 'HSET research:job-1:eval completeness 0.75', kind: 'sync'},
      {from: 'End-state eval', to: 'research.trace', label: 'commit offset (after the write)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'job-key',
      title: 'Keyed by job id',
      detail:
        "The record key is the job id, so one job's decisions stay on one partition, in order; keyed by agent they spread over all of them.",
      match: {
        python: {all: [/key\s*=\s*decision\[["']job_id["']\]/], none: [/key\s*=\s*decision\[["']agent_id["']\]/]},
        typescript: {all: [/key:\s*decision\.job_id\b/], none: [/key:\s*decision\.agent_id\b/]},
        go: {all: [/Key:\s*\[\]byte\(decision\.JobID\)/], none: [/Key:\s*\[\]byte\(decision\.AgentID\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(Topic,\s*jobId/],
          none: [/ProducerRecord\[String, String\]\(Topic,\s*agentId/],
        },
        cpp: {all: [/job_id\.c_str\(\),\s*job_id\.(size|length)\(\)/], none: [/agent_id\.c_str\(\)/]},
      },
    },
    {
      id: 'no-content',
      title: 'Ids and numbers only: no query or findings in the event',
      detail:
        'The event is built from `TRACE_FIELDS` plus `version`; the decision’s query and findings stay out of a topic that is retained, replicated and read by every team.',
      match: {
        python: {all: [/TRACE_FIELDS\s*=/, /in\s+TRACE_FIELDS/], none: [/\*\*decision/]},
        typescript: {all: [/TRACE_FIELDS\s*=/, /TRACE_FIELDS\.map\(|of\s+TRACE_FIELDS/], none: [/\.\.\.decision/]},
        go: {all: [/traceFields\s*=/, /range\s+traceFields/]},
        scala: {all: [/TraceFields\s*[:=]/, /TraceFields\.(flatMap|collect|map)/], none: [/decision\.fields\s*\+/]},
        cpp: {all: [/kTraceFields\s*=/, /:\s*kTraceFields\)/], none: [/json event = decision;/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer enables idempotence and waits for every in-sync replica, so a retry after a lost acknowledgement is written once and a leader failover keeps what was acknowledged (kafka-go: `RequireAll`, its strongest promise).',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/], none: [/acks:\s*1\b/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'commit-after-write',
      title: 'Writes the evaluation before committing the offset',
      detail:
        '`run_eval` writes `research:{job_id}:eval` and only then commits: no commit, explicit or automatic, covers a record whose evaluation is not written yet, and a record whose write fails stays uncommitted, so it is delivered again. A crash between a commit and the write loses the evaluation for good.',
      match: {
        python: {order: [/\.hset\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hset\(/, /commitOffsets\(/]},
        go: {order: [/\.HSet\(/, /\.CommitMessages\(/]},
        scala: {order: [/\.hset\(/, /\.commitSync\(/]},
        cpp: {order: [/redis\.hset\(/, /->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from research import jobs  # SERVICE_VERSION, job_key

TOPIC = "research.trace"
log = logging.getLogger("trace")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("trace event not delivered: %s", err)


def trace(decision: dict) -> dict:
    """Record one decision of the lead or a subagent on research.trace; returns the event sent."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    event = {**decision, "version": jobs.SERVICE_VERSION}
    producer.produce(TOPIC, key=decision["agent_id"], value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)
    return event


def end_state(job_id: str, version: str) -> dict:
    """The job's evaluation: the share of the plan with a result, the tool calls used, the version."""
    key = jobs.job_key(job_id)
    plan = json.loads(r.hget(key, "plan") or "[]")
    done = r.hlen(f"{key}:results")
    completeness = done / len(plan) if plan else 0.0
    return {"completeness": f"{completeness:.2f}", "tool_calls": r.get(f"{key}:tools") or "0", "version": version}


def run_eval() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "end-state-eval", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(msg, asynchronous=False)
        event = json.loads(msg.value())
        if event["outcome"] == "job.completed":
            r.hset(f"{jobs.job_key(event['job_id'])}:eval", mapping=end_state(event["job_id"], event["version"]))
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from research import jobs  # SERVICE_VERSION, job_key

TOPIC = "research.trace"
# Ids and numbers: what explains a run without carrying what the customer asked or what was found.
TRACE_FIELDS = ("job_id", "agent_id", "tool", "latency_ms", "tokens", "outcome")
log = logging.getLogger("trace")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("trace event not delivered: %s", err)


def trace(decision: dict) -> dict:
    """Record one decision of the lead or a subagent on research.trace; returns the event sent."""
    event = {name: decision[name] for name in TRACE_FIELDS}
    event["version"] = jobs.SERVICE_VERSION
    producer.produce(TOPIC, key=decision["job_id"], value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)
    return event


def end_state(job_id: str, version: str) -> dict:
    """The job's evaluation: the share of the plan with a result, the tool calls used, the version."""
    key = jobs.job_key(job_id)
    plan = json.loads(r.hget(key, "plan") or "[]")
    done = r.hlen(f"{key}:results")
    completeness = done / len(plan) if plan else 0.0
    return {"completeness": f"{completeness:.2f}", "tool_calls": r.get(f"{key}:tools") or "0", "version": version}


def run_eval() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "end-state-eval", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        if event["outcome"] == "job.completed":
            r.hset(f"{jobs.job_key(event['job_id'])}:eval", mapping=end_state(event["job_id"], event["version"]))
        consumer.commit(msg, asynchronous=False)  # after the write: a crash before this point redelivers
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {SERVICE_VERSION, jobKey} from 'research/jobs';

export const TOPIC = 'research.trace';

export interface Decision {
  job_id: string;
  agent_id: string;
  tool: string;
  latency_ms: number;
  tokens: number;
  outcome: string;
  query: string;
  findings: string;
}

const kafka = new Kafka({clientId: 'researchd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

/** Record one decision of the lead or a subagent on research.trace; returns the event sent. */
export async function trace(decision: Decision): Promise<Record<string, unknown>> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const event = {...decision, version: SERVICE_VERSION};
  await producer.send({topic: TOPIC, messages: [{key: decision.agent_id, value: JSON.stringify(event)}], acks: 1});
  return event;
}

/** The job's evaluation: the share of the plan with a result, the tool calls used, the version. */
async function endState(jobId: string, version: string): Promise<Record<string, string>> {
  const plan = JSON.parse((await redis.hget(jobKey(jobId), 'plan')) ?? '[]') as unknown[];
  const done = await redis.hlen(\`\${jobKey(jobId)}:results\`);
  const completeness = plan.length > 0 ? done / plan.length : 0;
  return {completeness: completeness.toFixed(2), tool_calls: (await redis.get(\`\${jobKey(jobId)}:tools\`)) ?? '0', version};
}

export async function runEval(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'end-state-eval'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {job_id: string; outcome: string; version: string};
      if (event.outcome === 'job.completed') await redis.hset(\`\${jobKey(event.job_id)}:eval\`, await endState(event.job_id, event.version));
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {SERVICE_VERSION, jobKey} from 'research/jobs';

export const TOPIC = 'research.trace';
// Ids and numbers: what explains a run without carrying what the customer asked or what was found.
export const TRACE_FIELDS = ['job_id', 'agent_id', 'tool', 'latency_ms', 'tokens', 'outcome'] as const;

export interface Decision {
  job_id: string;
  agent_id: string;
  tool: string;
  latency_ms: number;
  tokens: number;
  outcome: string;
  query: string;
  findings: string;
}

const kafka = new Kafka({clientId: 'researchd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true}); // idempotent implies acks -1 (all)
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

/** Record one decision of the lead or a subagent on research.trace; returns the event sent. */
export async function trace(decision: Decision): Promise<Record<string, unknown>> {
  const event: Record<string, unknown> = Object.fromEntries(TRACE_FIELDS.map(name => [name, decision[name]]));
  event.version = SERVICE_VERSION;
  await producer.send({topic: TOPIC, messages: [{key: decision.job_id, value: JSON.stringify(event)}], acks: -1});
  return event;
}

/** The job's evaluation: the share of the plan with a result, the tool calls used, the version. */
async function endState(jobId: string, version: string): Promise<Record<string, string>> {
  const plan = JSON.parse((await redis.hget(jobKey(jobId), 'plan')) ?? '[]') as unknown[];
  const done = await redis.hlen(\`\${jobKey(jobId)}:results\`);
  const completeness = plan.length > 0 ? done / plan.length : 0;
  return {completeness: completeness.toFixed(2), tool_calls: (await redis.get(\`\${jobKey(jobId)}:tools\`)) ?? '0', version};
}

export async function runEval(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'end-state-eval'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {job_id: string; outcome: string; version: string};
      if (event.outcome === 'job.completed') await redis.hset(\`\${jobKey(event.job_id)}:eval\`, await endState(event.job_id, event.version));
      // After the write: a crash before this point redelivers the record.
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"research/jobs" // jobs.ServiceVersion, jobs.JobKey, jobs.Task
)

const traceTopic = "research.trace"

// Decision is one decision of the lead or a subagent.
type Decision struct {
	JobID     string \`json:"job_id"\`
	AgentID   string \`json:"agent_id"\`
	Tool      string \`json:"tool"\`
	LatencyMs int    \`json:"latency_ms"\`
	Tokens    int    \`json:"tokens"\`
	Outcome   string \`json:"outcome"\`
	Query     string \`json:"query"\`
	Findings  string \`json:"findings"\`
}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        traceTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// trace records one decision on research.trace and returns the event sent.
func trace(ctx context.Context, decision Decision) (map[string]any, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	event := map[string]any{}
	raw, _ := json.Marshal(decision)
	json.Unmarshal(raw, &event)
	event["version"] = jobs.ServiceVersion
	value, _ := json.Marshal(event)
	return event, writer.WriteMessages(ctx, kafka.Message{Key: []byte(decision.AgentID), Value: value})
}

// endState is the job's evaluation: the share of the plan with a result, the tool calls used, the version.
func endState(ctx context.Context, jobID, version string) map[string]any {
	key := jobs.JobKey(jobID)
	var plan []jobs.Task
	json.Unmarshal([]byte(rdb.HGet(ctx, key, "plan").Val()), &plan)
	completeness := 0.0
	if len(plan) > 0 {
		completeness = float64(rdb.HLen(ctx, key+":results").Val()) / float64(len(plan))
	}
	tools := rdb.Get(ctx, key+":tools").Val()
	if tools == "" {
		tools = "0"
	}
	return map[string]any{"completeness": fmt.Sprintf("%.2f", completeness), "tool_calls": tools, "version": version}
}

func runEval(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "end-state-eval", Topic: traceTopic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event struct {
			JobID   string \`json:"job_id"\`
			Outcome string \`json:"outcome"\`
			Version string \`json:"version"\`
		}
		json.Unmarshal(msg.Value, &event)
		if event.Outcome == "job.completed" {
			if err := rdb.HSet(ctx, jobs.JobKey(event.JobID)+":eval", endState(ctx, event.JobID, event.Version)).Err(); err != nil {
				return err
			}
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"research/jobs" // jobs.ServiceVersion, jobs.JobKey, jobs.Task
)

const traceTopic = "research.trace"

// traceFields are ids and numbers: what explains a run without carrying what the customer asked or what was found.
var traceFields = []string{"job_id", "agent_id", "tool", "latency_ms", "tokens", "outcome"}

// Decision is one decision of the lead or a subagent.
type Decision struct {
	JobID     string \`json:"job_id"\`
	AgentID   string \`json:"agent_id"\`
	Tool      string \`json:"tool"\`
	LatencyMs int    \`json:"latency_ms"\`
	Tokens    int    \`json:"tokens"\`
	Outcome   string \`json:"outcome"\`
	Query     string \`json:"query"\`
	Findings  string \`json:"findings"\`
}

// RequireAll: the record is on every in-sync replica before the write returns. kafka-go has no
// idempotent producer, so a retry after a lost acknowledgement can duplicate; the evaluator
// tolerates it (it rewrites the same evaluation).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        traceTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// trace records one decision on research.trace and returns the event sent.
func trace(ctx context.Context, decision Decision) (map[string]any, error) {
	all := map[string]any{}
	raw, _ := json.Marshal(decision)
	json.Unmarshal(raw, &all)
	event := map[string]any{"version": jobs.ServiceVersion}
	for _, name := range traceFields {
		event[name] = all[name]
	}
	value, _ := json.Marshal(event)
	return event, writer.WriteMessages(ctx, kafka.Message{Key: []byte(decision.JobID), Value: value})
}

// endState is the job's evaluation: the share of the plan with a result, the tool calls used, the version.
func endState(ctx context.Context, jobID, version string) map[string]any {
	key := jobs.JobKey(jobID)
	var plan []jobs.Task
	json.Unmarshal([]byte(rdb.HGet(ctx, key, "plan").Val()), &plan)
	completeness := 0.0
	if len(plan) > 0 {
		completeness = float64(rdb.HLen(ctx, key+":results").Val()) / float64(len(plan))
	}
	tools := rdb.Get(ctx, key+":tools").Val()
	if tools == "" {
		tools = "0"
	}
	return map[string]any{"completeness": fmt.Sprintf("%.2f", completeness), "tool_calls": tools, "version": version}
}

func runEval(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "end-state-eval", Topic: traceTopic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event struct {
			JobID   string \`json:"job_id"\`
			Outcome string \`json:"outcome"\`
			Version string \`json:"version"\`
		}
		json.Unmarshal(msg.Value, &event)
		if event.Outcome == "job.completed" {
			if err := rdb.HSet(ctx, jobs.JobKey(event.JobID)+":eval", endState(ctx, event.JobID, event.Version)).Err(); err != nil {
				return err // not committed: the record is redelivered
			}
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import research.Jobs // Jobs.ServiceVersion, Jobs.jobKey

object TraceEvents {
  val Topic = "research.trace"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"trace event not delivered: \${exception.getMessage}")
  }

  /** Record one decision of the lead or a subagent (job_id, agent_id, tool, latency_ms, tokens, outcome, query, findings) on research.trace; returns the event sent. */
  def trace(decision: JsObject): JsObject = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val event = JsObject(decision.fields + ("version" -> JsString(Jobs.ServiceVersion)))
    val agentId = decision.fields("agent_id").convertTo[String](DefaultJsonProtocol.StringJsonFormat)
    producer.send(new ProducerRecord[String, String](Topic, agentId, event.compactPrint), onDelivery)
    event
  }

  /** The job's evaluation: the share of the plan with a result, the tool calls used, the version. */
  def endState(jobId: String, version: String): Map[String, String] = {
    val key = Jobs.jobKey(jobId)
    val planned = Option(jedis.hget(key, "plan")).map(_.parseJson.asInstanceOf[JsArray].elements.size).getOrElse(0)
    val completeness = if (planned > 0) jedis.hlen(s"$key:results").toDouble / planned else 0.0
    Map("completeness" -> f"$completeness%.2f", "tool_calls" -> Option(jedis.get(s"$key:tools")).getOrElse("0"), "version" -> version)
  }

  def runEval(): Unit = {
    val conf = new Properties()
    conf.put("bootstrap.servers", "kafka:9092")
    conf.put("group.id", "end-state-eval")
    conf.put("enable.auto.commit", "false")
    conf.put("auto.offset.reset", "earliest")
    val consumer = new KafkaConsumer[String, String](conf, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      for (record <- consumer.poll(Duration.ofSeconds(1)).asScala) {
        consumer.commitSync()
        val event = record.value.parseJson.asJsObject.fields
        if (event.get("outcome").contains(JsString("job.completed"))) {
          val jobId = event("job_id").asInstanceOf[JsString].value
          jedis.hset(s"\${Jobs.jobKey(jobId)}:eval", endState(jobId, event("version").asInstanceOf[JsString].value).asJava)
        }
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import research.Jobs // Jobs.ServiceVersion, Jobs.jobKey

object TraceEvents {
  val Topic = "research.trace"
  // Ids and numbers: what explains a run without carrying what the customer asked or what was found.
  val TraceFields: Seq[String] = Seq("job_id", "agent_id", "tool", "latency_ms", "tokens", "outcome")

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"trace event not delivered: \${exception.getMessage}")
  }

  /** Record one decision of the lead or a subagent (job_id, agent_id, tool, latency_ms, tokens, outcome, query, findings) on research.trace; returns the event sent. */
  def trace(decision: JsObject): JsObject = {
    val kept = TraceFields.flatMap(name => decision.fields.get(name).map(name -> _)).toMap
    val event = JsObject(kept + ("version" -> JsString(Jobs.ServiceVersion)))
    val jobId = decision.fields("job_id").convertTo[String](DefaultJsonProtocol.StringJsonFormat)
    producer.send(new ProducerRecord[String, String](Topic, jobId, event.compactPrint), onDelivery)
    event
  }

  /** The job's evaluation: the share of the plan with a result, the tool calls used, the version. */
  def endState(jobId: String, version: String): Map[String, String] = {
    val key = Jobs.jobKey(jobId)
    val planned = Option(jedis.hget(key, "plan")).map(_.parseJson.asInstanceOf[JsArray].elements.size).getOrElse(0)
    val completeness = if (planned > 0) jedis.hlen(s"$key:results").toDouble / planned else 0.0
    Map("completeness" -> f"$completeness%.2f", "tool_calls" -> Option(jedis.get(s"$key:tools")).getOrElse("0"), "version" -> version)
  }

  def runEval(): Unit = {
    val conf = new Properties()
    conf.put("bootstrap.servers", "kafka:9092")
    conf.put("group.id", "end-state-eval")
    conf.put("enable.auto.commit", "false")
    conf.put("auto.offset.reset", "earliest")
    val consumer = new KafkaConsumer[String, String](conf, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      for (record <- consumer.poll(Duration.ofSeconds(1)).asScala) {
        val event = record.value.parseJson.asJsObject.fields
        if (event.get("outcome").contains(JsString("job.completed"))) {
          val jobId = event("job_id").asInstanceOf[JsString].value
          jedis.hset(s"\${Jobs.jobKey(jobId)}:eval", endState(jobId, event("version").asInstanceOf[JsString].value).asJava)
        }
        // After the write: a crash before this point redelivers the record.
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <cstdio>
#include <iostream>
#include <memory>
#include <string>
#include <unordered_map>

#include "research/jobs.h"  // jobs::kServiceVersion, jobs::jobKey

using json = nlohmann::json;

const std::string kTopic = "research.trace";

sw::redis::Redis redis("tcp://redis:6379");

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "trace event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Record one decision of the lead or a subagent (job_id, agent_id, tool, latency_ms, tokens, outcome,
// query, findings) on research.trace; returns the event sent.
json trace(const json& decision) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  json event = decision;
  event["version"] = jobs::kServiceVersion;
  const std::string value = event.dump();
  const std::string agent_id = decision.value("agent_id", "");
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    agent_id.c_str(), agent_id.size(), 0, nullptr);
  producer->poll(0);
  return event;
}

// The job's evaluation: the share of the plan with a result, the tool calls used, the version.
std::unordered_map<std::string, std::string> endState(const std::string& job_id, const std::string& version) {
  const std::string key = jobs::jobKey(job_id);
  const auto plan = redis.hget(key, "plan");
  const size_t planned = plan ? json::parse(*plan).size() : 0;
  const double completeness = planned > 0 ? static_cast<double>(redis.hlen(key + ":results")) / planned : 0.0;
  char text[16];
  std::snprintf(text, sizeof text, "%.2f", completeness);
  return {{"completeness", text}, {"tool_calls", redis.get(key + ":tools").value_or("0")}, {"version", version}};
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "end-state-eval", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

void runEval() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object() || event.value("outcome", "") != "job.completed") continue;
    const auto fields = endState(event.value("job_id", ""), event.value("version", ""));
    redis.hset(jobs::jobKey(event.value("job_id", "")) + ":eval", fields.begin(), fields.end());
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <cstdio>
#include <iostream>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "research/jobs.h"  // jobs::kServiceVersion, jobs::jobKey

using json = nlohmann::json;

const std::string kTopic = "research.trace";
// Ids and numbers: what explains a run without carrying what the customer asked or what was found.
const std::vector<std::string> kTraceFields = {"job_id", "agent_id", "tool", "latency_ms", "tokens", "outcome"};

sw::redis::Redis redis("tcp://redis:6379");

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "trace event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Record one decision of the lead or a subagent (job_id, agent_id, tool, latency_ms, tokens, outcome,
// query, findings) on research.trace; returns the event sent.
json trace(const json& decision) {
  json event = json::object();
  for (const std::string& name : kTraceFields) event[name] = decision.value(name, json());
  event["version"] = jobs::kServiceVersion;
  const std::string value = event.dump();
  const std::string job_id = decision.value("job_id", "");
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    job_id.c_str(), job_id.size(), 0, nullptr);
  producer->poll(0);
  return event;
}

// The job's evaluation: the share of the plan with a result, the tool calls used, the version.
std::unordered_map<std::string, std::string> endState(const std::string& job_id, const std::string& version) {
  const std::string key = jobs::jobKey(job_id);
  const auto plan = redis.hget(key, "plan");
  const size_t planned = plan ? json::parse(*plan).size() : 0;
  const double completeness = planned > 0 ? static_cast<double>(redis.hlen(key + ":results")) / planned : 0.0;
  char text[16];
  std::snprintf(text, sizeof text, "%.2f", completeness);
  return {{"completeness", text}, {"tool_calls", redis.get(key + ":tools").value_or("0")}, {"version", version}};
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "end-state-eval", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

void runEval() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (event.is_object() && event.value("outcome", "") == "job.completed") {
      const auto fields = endState(event.value("job_id", ""), event.value("version", ""));
      redis.hset(jobs::jobKey(event.value("job_id", "")) + ":eval", fields.begin(), fields.end());
    }
    consumer->commitSync(msg.get());  // after the write: a crash before this point redelivers
  }
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "research.trace"
FIELDS = ["agent_id", "job_id", "latency_ms", "outcome", "tokens", "tool", "version"]
PLAN = [{"id": f"t-{i}", "objective": "o", "output_format": "f", "tools": ["search"], "boundaries": "b"} for i in (1, 2, 3, 4)]


def _decision(agent_id, outcome="tool.call", job_id="job-1"):
    return {
        "job_id": job_id,
        "agent_id": agent_id,
        "tool": "fetch",
        "latency_ms": 840,
        "tokens": 1200,
        "outcome": outcome,
        "query": "CANARY-QUERY board members of every bank in the index",
        "findings": "CANARY-FINDINGS chair: A. Jones",
        # A field added to decisions later: the event picks TRACE_FIELDS rather than dropping a known list.
        "prompt": "CANARY-PROMPT summarise every board member",
    }


def _trace(m, *decisions):
    events = [m.trace(d) for d in decisions]
    m.producer.flush()
    return events


def check_job_key(ctx):
    m = ctx.load("trace_events")
    _trace(m, _decision("lead"), _decision("sub-1"), _decision("sub-2"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three decisions produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"job-1"] * 3, f"records must be keyed by the job id, got {keys}: keyed by agent, one job's decisions spread over partitions and replay out of order"
    assert len({r.partition for r in records}) == 1, f"job-1's decisions landed on partitions {sorted({r.partition for r in records})}"


def check_no_content(ctx):
    m = ctx.load("trace_events")
    event = _trace(m, _decision("sub-1"))[0]
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one decision produced {len(records)} records on {TOPIC}"
    value = records[0].value.decode()
    assert "CANARY" not in value, f"the trace event carries the query, the findings or the prompt: {value}"
    payload = json.loads(value)
    assert sorted(payload) == FIELDS, f"the event carries the fields {sorted(payload)}, expected TRACE_FIELDS and version: {FIELDS}"
    assert payload["version"] == "2.3.0" and payload["latency_ms"] == 840 and payload["agent_id"] == "sub-1", f"the event must keep the ids, the numbers and the version, got {payload}"
    assert sorted(event) == FIELDS, f"trace returned {sorted(event)}, expected the event it sent"


def check_idempotent_producer(ctx):
    m = ctx.load("trace_events")
    ctx.kafka.lose_acks(TOPIC, 1)
    _trace(m, _decision("lead"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one decision whose acknowledgement was lost left {len(records)} records: the producer's retry wrote it twice. Enable idempotence (with acks=all)"
    _trace(m, _decision("sub-1"))
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: wait for every in-sync replica (acks=all)"


def check_commit_after_write(ctx):
    ctx.redis.hset("research:job-1", mapping={"status": "running", "plan": json.dumps(PLAN)})
    ctx.redis.hset("research:job-1:results", mapping={"t-1": "a", "t-2": "b", "t-3": "c"})
    ctx.redis.set("research:job-1:tools", 7)
    # job-2's evaluation key holds a string, so writing its evaluation fails (WRONGTYPE).
    ctx.redis.set("research:job-2:eval", "not a hash")
    for job_id, outcome in (("job-1", "tool.call"), ("job-1", "job.completed"), ("job-2", "job.completed")):
        event = {"job_id": job_id, "agent_id": "lead", "tool": "", "latency_ms": 10, "tokens": 0, "outcome": outcome, "version": "2.3.0"}
        ctx.kafka.seed(TOPIC, key="job-1", value=json.dumps(event))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((ctx.kafka.lag("end-state-eval", TOPIC), ctx.redis.hgetall("research:job-1:eval"))))
    # Six seconds pass while job-1 is evaluated: any timer-driven commit fires before the write.
    ctx.redis_after("research:job-1", lambda: ctx.clock.advance(6))
    m = ctx.load("trace_events")
    try:
        ctx.drain(m.run_eval)
    except Exception:
        pass  # job-2's failed write may end the loop; the record must then stay uncommitted
    assert at_commit, "the consumer never committed an offset"
    for lag, evaluation in at_commit:
        if lag <= 1:
            assert evaluation.get("completeness") == "0.75", f"when job-1's job.completed record was committed research:job-1:eval held {evaluation}: write the evaluation first, then commit, or a crash between the two loses it"
    evaluation = ctx.redis.hgetall("research:job-1:eval")
    assert evaluation == {"completeness": "0.75", "tool_calls": "7", "version": "2.3.0"}, f"research:job-1:eval is {evaluation}"
    lag = ctx.kafka.lag("end-state-eval", TOPIC)
    assert lag >= 1, "job-2's job.completed record was committed although writing its evaluation failed (WRONGTYPE): commit only after the write succeeded, so the record is delivered again"
    assert lag == 1, f"{lag} records are left uncommitted, expected only job-2's whose evaluation write failed: commit every record once handled"
`,
    typescript: `const TOPIC = 'research.trace';
const FIELDS = ['agent_id', 'job_id', 'latency_ms', 'outcome', 'tokens', 'tool', 'version'];
const PLAN = [1, 2, 3, 4].map(i => ({id: \`t-\${i}\`, objective: 'o', output_format: 'f', tools: ['search'], boundaries: 'b'}));

const decision = (agentId: string, outcome = 'tool.call') => ({
  job_id: 'job-1',
  agent_id: agentId,
  tool: 'fetch',
  latency_ms: 840,
  tokens: 1200,
  outcome,
  query: 'CANARY-QUERY board members of every bank in the index',
  findings: 'CANARY-FINDINGS chair: A. Jones',
  // A field added to decisions later: the event picks TRACE_FIELDS rather than dropping a known list.
  prompt: 'CANARY-PROMPT summarise every board member',
});

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_job_key(ctx) {
  const m = ctx.load('trace_events');
  for (const agent of ['lead', 'sub-1', 'sub-2']) await m.trace(decision(agent));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three decisions produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['job-1', 'job-1', 'job-1'], \`records must be keyed by the job id, got \${JSON.stringify(keys)}: keyed by agent, one job's decisions spread over partitions and replay out of order\`);
  assert.equal(new Set(records.map(r => r.partition)).size, 1, "job-1's decisions must land on one partition");
}

export async function check_no_content(ctx) {
  const m = ctx.load('trace_events');
  const event = await m.trace(decision('sub-1'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one decision produced \${records.length} records on \${TOPIC}\`);
  const value = records[0].value.toString();
  assert(!value.includes('CANARY'), \`the trace event carries the query, the findings or the prompt: \${value}\`);
  const payload = JSON.parse(value);
  assert.deepStrictEqual(Object.keys(payload).sort(), FIELDS, \`the event carries the fields \${JSON.stringify(Object.keys(payload).sort())}, expected TRACE_FIELDS and version\`);
  assert(payload.version === '2.3.0' && payload.latency_ms === 840 && payload.agent_id === 'sub-1', \`the event must keep the ids, the numbers and the version, got \${value}\`);
  assert.deepStrictEqual(Object.keys(event).sort(), FIELDS, 'trace must return the event it sent');
}

export async function check_idempotent_producer(ctx) {
  const m = ctx.load('trace_events');
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.trace(decision('lead'));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`one decision whose acknowledgement was lost left \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote it twice. Make the producer idempotent\`);
  await m.trace(decision('sub-1'));
  await settle();
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: wait for every in-sync replica (acks -1)\`);
}

export async function check_commit_after_write(ctx) {
  ctx.redis.hset('research:job-1', {status: 'running', plan: JSON.stringify(PLAN)});
  ctx.redis.hset('research:job-1:results', {'t-1': 'a', 't-2': 'b', 't-3': 'c'});
  ctx.redis.set('research:job-1:tools', '7');
  // job-2's evaluation key holds a string, so writing its evaluation fails (WRONGTYPE).
  ctx.redis.set('research:job-2:eval', 'not a hash');
  for (const [jobId, outcome] of [['job-1', 'tool.call'], ['job-1', 'job.completed'], ['job-2', 'job.completed']]) {
    const event = {job_id: jobId, agent_id: 'lead', tool: '', latency_ms: 10, tokens: 0, outcome, version: '2.3.0'};
    ctx.kafka.seed(TOPIC, {key: 'job-1', value: JSON.stringify(event)});
  }
  const atCommit: {lag: number; evaluation: Record<string, string>}[] = [];
  ctx.kafka.onCommit(() => atCommit.push({lag: ctx.kafka.lag('end-state-eval', TOPIC), evaluation: {...ctx.redis.hgetall('research:job-1:eval')}}));
  // Six seconds pass while job-1 is evaluated: any timer-driven commit fires before the write.
  ctx.redisAfter('research:job-1', () => ctx.clock.advance(6));
  const m = ctx.load('trace_events');
  try {
    await ctx.drain(m.runEval());
  } catch {
    // job-2's failed write may end the consumer; the record must then stay uncommitted
  }
  assert(atCommit.length > 0, 'the consumer never committed an offset');
  for (const {lag, evaluation} of atCommit) {
    if (lag <= 1) assert.equal(evaluation.completeness, '0.75', \`when job-1's job.completed record was committed research:job-1:eval held \${JSON.stringify(evaluation)}: write the evaluation first, then commit, or a crash between the two loses it\`);
  }
  assert.deepStrictEqual({...ctx.redis.hgetall('research:job-1:eval')}, {completeness: '0.75', tool_calls: '7', version: '2.3.0'}, 'research:job-1:eval');
  const lag = ctx.kafka.lag('end-state-eval', TOPIC);
  assert(lag >= 1, "job-2's job.completed record was committed although writing its evaluation failed (WRONGTYPE): commit only after the write succeeded, so the record is delivered again");
  assert.equal(lag, 1, \`\${lag} records are left uncommitted, expected only job-2's whose evaluation write failed: commit every record once handled\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"leetbuild/harness"
)

var traceBg = context.Background()

func decisionOf(agentID string) Decision {
	return Decision{JobID: "job-1", AgentID: agentID, Tool: "fetch", LatencyMs: 840, Tokens: 1200, Outcome: "tool.call",
		Query: "CANARY-QUERY board members of every bank in the index", Findings: "CANARY-FINDINGS chair: A. Jones"}
}

func mustTrace(ctx *harness.Ctx, agentID string) map[string]any {
	event, err := trace(traceBg, decisionOf(agentID))
	ctx.NoError(err, "trace(%s) failed", agentID)
	return event
}

func sortedKeys(m map[string]any) []string {
	keys := []string{}
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

var traceFieldsWant = []string{"agent_id", "job_id", "latency_ms", "outcome", "tokens", "tool", "version"}

func CheckJobKey(ctx *harness.Ctx) {
	for _, agent := range []string{"lead", "sub-1", "sub-2"} {
		mustTrace(ctx, agent)
	}
	records := ctx.Kafka.Records(traceTopic)
	ctx.Equal(len(records), 3, "three decisions; the records on %s", traceTopic)
	ctx.Equal(ctx.Kafka.Keys(traceTopic), []string{"job-1", "job-1", "job-1"}, "records must be keyed by the job id (keyed by agent, one job's decisions spread over partitions and replay out of order)")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "job-1's decisions landed on partitions %d, %d, %d: they must stay on one", records[0].Partition, records[1].Partition, records[2].Partition)
}

func CheckNoContent(ctx *harness.Ctx) {
	event := mustTrace(ctx, "sub-1")
	records := ctx.Kafka.Records(traceTopic)
	ctx.Equal(len(records), 1, "one decision; the records on %s", traceTopic)
	value := string(records[0].Value)
	ctx.Assert(!strings.Contains(value, "CANARY"), "the trace event carries the query or the findings: %s", value)
	var payload map[string]any
	ctx.NoError(json.Unmarshal([]byte(value), &payload), "the event is not JSON: %s", value)
	ctx.Equal(sortedKeys(payload), traceFieldsWant, "the event must carry traceFields and version only; its fields")
	ctx.Assert(payload["version"] == "2.3.0" && payload["latency_ms"] == 840.0 && payload["agent_id"] == "sub-1", "the event must keep the ids, the numbers and the version, got %s", value)
	ctx.Equal(sortedKeys(event), traceFieldsWant, "trace must return the event it sent; its fields")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	mustTrace(ctx, "lead")
	ctx.Equal(len(ctx.Kafka.Records(traceTopic)), 1, "one decision; the records")
	mustTrace(ctx, "sub-1")
	lost := ctx.Kafka.Failover(traceTopic)
	ctx.Equal(len(ctx.Kafka.Records(traceTopic)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged them. Use RequireAll; the records", lost)
}

func CheckCommitAfterWrite(ctx *harness.Ctx) {
	plan, _ := json.Marshal([]map[string]string{{"id": "t-1"}, {"id": "t-2"}, {"id": "t-3"}, {"id": "t-4"}})
	ctx.Redis.Do("HSET", "research:job-1", "status", "running", "plan", string(plan))
	ctx.Redis.Do("HSET", "research:job-1:results", "t-1", "a", "t-2", "b", "t-3", "c")
	ctx.Redis.Set("research:job-1:tools", "7")
	// job-2's evaluation key holds a string, so writing its evaluation fails (WRONGTYPE).
	ctx.Redis.Set("research:job-2:eval", "not a hash")
	for _, seed := range [][2]string{{"job-1", "tool.call"}, {"job-1", "job.completed"}, {"job-2", "job.completed"}} {
		value, _ := json.Marshal(map[string]any{"job_id": seed[0], "agent_id": "lead", "tool": "", "latency_ms": 10, "tokens": 0, "outcome": seed[1], "version": "2.3.0"})
		ctx.Kafka.Seed(traceTopic, "job-1", string(value))
	}
	type snapshot struct {
		lag        int64
		evaluation map[string]string
	}
	var atCommit []snapshot
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		atCommit = append(atCommit, snapshot{ctx.Kafka.Lag("end-state-eval", traceTopic), ctx.Redis.HGetAll("research:job-1:eval")})
	})
	// Six seconds pass while job-1 is evaluated: any timer-driven commit fires before the write.
	ctx.Redis.After("research:job-1", func() any {
		ctx.Clock.Advance(6)
		return nil
	})
	ctx.Drain(func() { runEval(traceBg) }) // job-2's failed write may end the loop; the record must then stay uncommitted
	ctx.Assert(len(atCommit) > 0, "the consumer never committed an offset")
	for _, at := range atCommit {
		if at.lag <= 1 {
			ctx.Equal(at.evaluation["completeness"], "0.75", "when job-1's job.completed record was committed research:job-1:eval held %v: write the evaluation first, then commit, or a crash between the two loses it; its completeness", at.evaluation)
		}
	}
	ctx.Equal(ctx.Redis.HGetAll("research:job-1:eval"), map[string]string{"completeness": "0.75", "tool_calls": "7", "version": "2.3.0"}, "research:job-1:eval")
	lag := ctx.Kafka.Lag("end-state-eval", traceTopic)
	ctx.Assert(lag >= 1, "job-2's job.completed record was committed although writing its evaluation failed (WRONGTYPE): commit only after the write succeeded, so the record is delivered again")
	ctx.Equal(lag, int64(1), "only job-2's record, whose evaluation write failed, may stay uncommitted: commit every record once handled; the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

const std::vector<std::string> kFields = {"agent_id", "job_id", "latency_ms", "outcome", "tokens", "tool", "version"};

json decisionOf(const std::string& agent_id) {
  return {{"job_id", "job-1"}, {"agent_id", agent_id}, {"tool", "fetch"}, {"latency_ms", 840}, {"tokens", 1200}, {"outcome", "tool.call"},
          {"query", "CANARY-QUERY board members of every bank in the index"}, {"findings", "CANARY-FINDINGS chair: A. Jones"},
          // A field added to decisions later: the event picks kTraceFields rather than dropping a known list.
          {"prompt", "CANARY-PROMPT summarise every board member"}};
}

json traced(harness::Ctx& ctx, const std::string& agent_id) {
  const json event = trace(decisionOf(agent_id));
  producer->flush(1000);
  ctx.Settle();
  return event;
}

std::vector<std::string> keysOf(const json& j) {
  std::vector<std::string> keys;
  for (const auto& [k, v] : j.items()) keys.push_back(k);
  std::sort(keys.begin(), keys.end());
  return keys;
}

}  // namespace

void CheckJobKey(harness::Ctx& ctx) {
  for (const std::string agent : {"lead", "sub-1", "sub-2"}) traced(ctx, agent);
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three decisions; the records on %s", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"job-1", "job-1", "job-1"}, "records must be keyed by the job id (keyed by agent, one job's decisions spread over partitions and replay out of order)");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
             "job-1's decisions landed on partitions %d, %d, %d: they must stay on one", records[0].Partition, records[1].Partition, records[2].Partition);
}

void CheckNoContent(harness::Ctx& ctx) {
  const json event = traced(ctx, "sub-1");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 1, "one decision; the records on %s", kTopic);
  const std::string value = records[0].Value.value_or("");
  ctx.Assert(value.find("CANARY") == std::string::npos, "the trace event carries the query, the findings or the prompt: %s", value);
  const json payload = json::parse(value, nullptr, false);
  ctx.Assert(payload.is_object(), "the event is not JSON: %s", value);
  ctx.Equal(keysOf(payload), kFields, "the event must carry kTraceFields and version only; its fields");
  ctx.Assert(payload.value("version", "") == "2.3.0" && payload.value("latency_ms", 0) == 840 && payload.value("agent_id", "") == "sub-1",
             "the event must keep the ids, the numbers and the version, got %s", value);
  ctx.Equal(keysOf(event), kFields, "trace must return the event it sent; its fields");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);
  traced(ctx, "lead");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one decision whose acknowledgement was lost: the producer's retry wrote it twice. Set enable.idempotence (with acks=all); the records");
  traced(ctx, "sub-1");
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: wait for every in-sync replica (acks=all); the records", lost);
}

void CheckCommitAfterWrite(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", "research:job-1", "status", "running", "plan", R"([{"id":"t-1"},{"id":"t-2"},{"id":"t-3"},{"id":"t-4"}])");
  ctx.Redis.Do("HSET", "research:job-1:results", "t-1", "a", "t-2", "b", "t-3", "c");
  ctx.Redis.Set("research:job-1:tools", "7");
  // job-2's evaluation key holds a string, so writing its evaluation fails (WRONGTYPE).
  ctx.Redis.Set("research:job-2:eval", "not a hash");
  for (const auto& [job_id, outcome] : std::vector<std::pair<std::string, std::string>>{{"job-1", "tool.call"}, {"job-1", "job.completed"}, {"job-2", "job.completed"}}) {
    const json event = {{"job_id", job_id}, {"agent_id", "lead"}, {"tool", ""}, {"latency_ms", 10}, {"tokens", 0}, {"outcome", outcome}, {"version", "2.3.0"}};
    ctx.Kafka.Seed(kTopic, "job-1", event.dump());
  }
  std::vector<std::pair<int64_t, std::map<std::string, std::string>>> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) {
    atCommit.emplace_back(ctx.Kafka.Lag("end-state-eval", kTopic), ctx.Redis.HGetAll("research:job-1:eval"));
  });
  // Six seconds pass while job-1 is evaluated: any timer-driven commit fires before the write.
  ctx.Redis.After("research:job-1", [&ctx] { ctx.Clock.Advance(6); });
  ctx.Drain([] {
    try {
      runEval();
    } catch (const std::exception&) {
      // job-2's failed write may end the loop; the record must then stay uncommitted
    }
  });
  ctx.Assert(!atCommit.empty(), "the consumer never committed an offset");
  for (const auto& [lag, evaluation] : atCommit) {
    if (lag > 1) continue;
    ctx.Assert(evaluation.count("completeness") && evaluation.at("completeness") == "0.75",
               "when job-1's job.completed record was committed research:job-1:eval held %v: write the evaluation first, then commit, or a crash between the two loses it", evaluation);
  }
  ctx.Equal(ctx.Redis.HGetAll("research:job-1:eval"), std::map<std::string, std::string>{{"completeness", "0.75"}, {"tool_calls", "7"}, {"version", "2.3.0"}},
            "research:job-1:eval");
  const int64_t lag = ctx.Kafka.Lag("end-state-eval", kTopic);
  ctx.Assert(lag >= 1, "job-2's job.completed record was committed although writing its evaluation failed (WRONGTYPE): commit only after the write succeeded, so the record is delivered again");
  ctx.Equal(lag, 1, "only job-2's record, whose evaluation write failed, may stay uncommitted: commit every record once handled; the lag");
}
`,
  },
  hints: [
    'Replay one job from the trace topic: its decisions come back from three partitions in the wrong order, a customer’s query is right there in the payload, and a job that finished during a consumer restart has no evaluation.',
    'The key is the agent id, so the partition follows the agent; the event is the whole decision plus a version; the producer has neither idempotence nor `acks=all`; `run_eval` commits each record before it writes the evaluation.',
    'Key by the decision’s job id; build the event from `TRACE_FIELDS` plus `version`; configure `enable.idempotence` with `acks=all`; in `run_eval`, write the evaluation first and commit after it has succeeded.',
  ],
  debrief: `A trace is for explaining a run after the fact, so it is keyed by the thing you replay, the job, and it carries the decisions as ids and numbers: which agent, which tool, how long, how many tokens. The query and the findings stay out because a topic is retained, replicated and readable by more teams than the job store is. Idempotence with \`acks=all\` makes a retried send land once and survive a leader change. The evaluator writes before it commits, so a crash costs one repeated evaluation instead of a missing one, and the evaluation is computed from the end state in Redis, not from anything the trace carried. Production systems add a judge model that scores the final report against a rubric, and sample traces rather than evaluate every job.`,
};
