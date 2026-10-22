import type {Step} from '@/lib/types';

export const traceEventsStep: Step = {
  id: 'trace-events',
  title: 'research.trace: decisions without content, end-state eval, version pins',
  concept: 'kafka',
  file: 'trace_events',
  focus: ['lead', 'kafka', 'evaluator', 'judge'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: every decision produces an
event, and a consumer marks finished jobs good or bad, so the dashboard shows numbers moving. Four
production contracts are broken. Find them, fix them, and prove the fix.

\`trace(...)\` is how the lead and the subagents report every decision — a subagent spawned, a tool
called, a job finished — and the end-state evaluation consumer turns finished jobs into scores.

- Publish one \`research.trace\` event per decision with the **job id as the message key**, so one
  job's decisions stay ordered on one partition. The payload is **ids and numbers only**: job id,
  agent id, tool, latency, tokens, outcome and the service version. The source traces agent
  decision patterns and interaction structure precisely so that it can debug failures **without
  reading the contents of conversations**; the query, the findings and any tool text never enter the
  event or a log line.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent), so a retried
  produce cannot duplicate a decision.
- The consumer (group \`end-state-eval\`) reacts to \`job.completed\` events only. It asks the
  judge to score the job's final report against the **rubric** — \`factual_accuracy\`,
  \`citation_accuracy\`, \`completeness\`, \`source_quality\`, \`tool_efficiency\`, each 0.0–1.0 with
  a pass/fail grade — writes the scores to \`research:{job_id}:eval\` and **only then** commits the
  offset. The judge reads the report from the job store by id; the report is not in the event.
- The job record carries the **service version** that started it (\`SERVICE_VERSION\`), the trace
  event repeats it, and \`claim_job\` refuses a job pinned to another version. That is the rainbow
  deployment the source describes: old and new versions run side by side and an in-flight job
  finishes on the code that started it instead of being handed to a worker that may read its
  checkpoints differently.

**Failure mode the checks target.** Keying by agent id scatters one job's decisions across
partitions; the query and findings in the event are retained and replicated for as long as the
topic is, far beyond the job; an unconfigured producer duplicates on retry; commit-before-write
loses the evaluation on a crash and the job is never scored; and a job without a version pin is
silently picked up by whichever worker restarts first after a deploy.`,
  sequence: {
    participants: ['Lead agent', 'research.trace', 'End-state eval', 'LLM judge', 'Redis'],
    messages: [
      {
        from: 'Lead agent',
        to: 'research.trace',
        label: 'produce · key = job_id · ids, latency, tokens, version',
        kind: 'sync',
      },
      {from: 'research.trace', to: 'Lead agent', label: 'ack (idempotent · acks = all)', kind: 'reply'},
      {from: 'research.trace', to: 'End-state eval', label: 'consume · group end-state-eval', kind: 'async'},
      {from: 'End-state eval', to: 'End-state eval', label: 'outcome == job.completed?', kind: 'sync'},
      {from: 'End-state eval', to: 'LLM judge', label: 'score(job_id, RUBRIC)', kind: 'sync'},
      {from: 'LLM judge', to: 'End-state eval', label: '{scores 0.0–1.0, passed}', kind: 'reply'},
      {from: 'End-state eval', to: 'Redis', label: 'HSET research:{job_id}:eval', kind: 'sync'},
      {from: 'End-state eval', to: 'research.trace', label: 'commit offset after the write', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=job_id` (or `Key: []byte(jobID)`, `key: jobId`, `ProducerRecord(topic, jobId, …)`). Idempotence is producer configuration: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true`, kafka-go’s `RequireAll` with a hash balancer.',
    'The event schema is a contract: job id, agent id, tool, latency, tokens, outcome, version — delete the two text fields and the log line that prints them. If a word for conversation content appears anywhere in this file, it is leaking.',
    'In the consumer: `judge.score(job_id, RUBRIC)`, `HSET research:{job_id}:eval`, then `commit`. `claim_job` is one comparison — `job["version"] == SERVICE_VERSION` — and the version goes into every event so the trace can tell which code made the decision.',
  ],
  checks: [
    {
      id: 'job-key-idempotent',
      title: 'Keyed by job id from an idempotent producer with acks=all',
      detail:
        'The message key is the job id and the producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. The draft keys by agent id from a default producer.',
      match: {
        python: {all: [/key=job_id/, /enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/key:\s*jobId\b/, /idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/Key:\s*\[\]byte\(jobID\)/, /RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/ProducerRecord\("research\.trace",\s*jobId/, /enable\.idempotence/, /"acks"/]},
        cpp: {all: [/produce\([^;]*jobId\.data\(\)/, /enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-content',
      title: 'No query, findings or tool text in the event or logs',
      detail:
        'The event carries ids, tool name, latency, tokens, outcome and version; no field or log line carries the query, the findings or fetched text. The draft copies both into the event and logs them.',
      match: {
        python: {none: [/\bquery\b/i, /\bfindings\b/i]},
        typescript: {none: [/\bquery\b/i, /\bfindings\b/i]},
        go: {none: [/\bquery\b/i, /\bfindings\b/i]},
        scala: {none: [/\bquery\b/i, /\bfindings\b/i]},
        cpp: {none: [/\bquery\b/i, /\bfindings\b/i]},
      },
    },
    {
      id: 'rubric-eval',
      title: 'Scores completed jobs against the five-part rubric',
      detail:
        'The consumer calls the judge with `RUBRIC` — factual accuracy, citation accuracy, completeness, source quality, tool efficiency — and stores each score and the pass/fail grade. The draft asks for a single yes/no.',
      match: {
        python: {all: [/RUBRIC/, /citation_accuracy/, /tool_efficiency/, /judge\.score\(/]},
        typescript: {all: [/RUBRIC/, /citation_accuracy/, /tool_efficiency/, /judge\.score\(/]},
        go: {all: [/rubric/, /citation_accuracy/, /tool_efficiency/, /judge\.Score\(/]},
        scala: {all: [/Rubric/, /citation_accuracy/, /tool_efficiency/, /judge\.score\(/]},
        cpp: {all: [/kRubric/, /citation_accuracy/, /tool_efficiency/, /judge\.score\(/]},
      },
    },
    {
      id: 'write-before-commit',
      title: 'Writes the evaluation before committing the offset',
      detail:
        'The consumer writes `research:{job_id}:eval` with `HSET` before committing the offset; committing first makes a crash lose the evaluation forever. The draft commits first.',
      match: {
        python: {order: [/\.hset\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hset\(/, /commitOffsets\(/]},
        go: {order: [/\.HSet\(/, /CommitMessages\(/]},
        scala: {order: [/\.hset\(/, /commitSync\(/]},
        cpp: {order: [/\.hset\(|->hset\(/, /commitSync\(/]},
      },
    },
    {
      id: 'version-pin',
      title: 'Pins each job to the version that started it',
      detail:
        'Every event carries `SERVICE_VERSION` under `version`, and `claim_job` runs a job only when its record’s version matches — the rainbow deployment contract. The draft claims every job and records no version.',
      match: {
        python: {all: [/SERVICE_VERSION/, /"version"/, /def claim_job\(/]},
        typescript: {all: [/SERVICE_VERSION/, /\bversion\b/, /function claimJob\(/]},
        go: {all: [/serviceVersion/, /"version"/, /func claimJob\(/]},
        scala: {all: [/ServiceVersion/, /"version"/, /def claimJob\(/]},
        cpp: {all: [/kServiceVersion/, /"version"/, /claimJob\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

logger = logging.getLogger("trace")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Judge:
    def looks_good(self, job_id: str) -> bool:
        """One model call: is the job's final report acceptable?"""
        raise NotImplementedError


judge = Judge()


def trace(
    job_id: str,
    agent_id: str,
    tool: str,
    latency_ms: int,
    tokens: int,
    outcome: str,
    query: str,
    findings: str,
) -> None:
    # TODO: key by job id from an idempotent producer with acks=all, keep the query and the
    # findings out of the event and the logs, score completed jobs with the rubric before the
    # commit, and pin jobs to the service version. Review all four.
    logger.info("trace job=%s agent=%s findings=%r", job_id, agent_id, findings)
    event = {
        "job_id": job_id,
        "agent_id": agent_id,
        "tool": tool,
        "latency_ms": latency_ms,
        "tokens": tokens,
        "outcome": outcome,
        "query": query,
        "findings": findings,
    }
    producer.produce("research.trace", key=agent_id, value=json.dumps(event))
    producer.flush()


def claim_job(job: dict) -> bool:
    return True


def evaluate() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "end-state-eval"})
    consumer.subscribe(["research.trace"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        if event["outcome"] != "job.completed":
            continue
        r.hset(f"research:{event['job_id']}:eval", "pass", int(judge.looks_good(event["job_id"])))
`,
      solution: `import json
from dataclasses import dataclass

import redis
from confluent_kafka import Consumer, Producer

SERVICE_VERSION = "2.3.0"
RUBRIC = ("factual_accuracy", "citation_accuracy", "completeness", "source_quality", "tool_efficiency")

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@dataclass
class Verdict:
    scores: dict[str, float]
    passed: bool


class Judge:
    def score(self, job_id: str, rubric: tuple[str, ...]) -> Verdict:
        """One model call over the job's final report, read from the job store by id: 0.0–1.0 per criterion and a pass/fail grade."""
        raise NotImplementedError


judge = Judge()


def trace(job_id: str, agent_id: str, tool: str, latency_ms: int, tokens: int, outcome: str) -> None:
    event = {
        "job_id": job_id,
        "agent_id": agent_id,
        "tool": tool,
        "latency_ms": latency_ms,
        "tokens": tokens,
        "outcome": outcome,
        "version": SERVICE_VERSION,
    }
    producer.produce("research.trace", key=job_id, value=json.dumps(event))
    producer.poll(0)


def claim_job(job: dict) -> bool:
    """A job runs to completion on the version that started it; another version leaves it alone."""
    return job["version"] == SERVICE_VERSION


def evaluate() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "end-state-eval", "enable.auto.commit": False}
    )
    consumer.subscribe(["research.trace"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        if event["outcome"] == "job.completed":
            verdict = judge.score(event["job_id"], RUBRIC)
            fields = {name: str(verdict.scores[name]) for name in RUBRIC}
            fields["passed"] = str(int(verdict.passed))
            fields["version"] = event["version"]
            r.hset(f"research:{event['job_id']}:eval", mapping=fields)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** research.trace: a model-generated draft that keys by agent, ships content, and commits too early. */
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

import {judge} from './judge';

const kafka = new Kafka({clientId: 'researchd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

export interface Decision {
  jobId: string;
  agentId: string;
  tool: string;
  latencyMs: number;
  tokens: number;
  outcome: string;
  query: string;
  findings: string;
}

export async function trace(decision: Decision): Promise<void> {
  // TODO: key by job id from an idempotent producer with acks=all, keep the query and the
  // findings out of the event and the logs, score completed jobs with the rubric before the
  // commit, and pin jobs to the service version. Review all four.
  console.log(\`trace job=\${decision.jobId} agent=\${decision.agentId} findings=\${decision.findings}\`);
  const event = {
    job_id: decision.jobId,
    agent_id: decision.agentId,
    tool: decision.tool,
    latency_ms: decision.latencyMs,
    tokens: decision.tokens,
    outcome: decision.outcome,
    query: decision.query,
    findings: decision.findings,
  };
  await producer.send({
    topic: 'research.trace',
    messages: [{key: decision.agentId, value: JSON.stringify(event)}],
  });
}

export function claimJob(job: {job_id: string}): boolean {
  return job.job_id !== '';
}

export async function evaluate(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'end-state-eval'});
  await consumer.connect();
  await consumer.subscribe({topic: 'research.trace'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {job_id: string; outcome: string};
      if (event.outcome !== 'job.completed') return;
      const looksGood = await judge.looksGood(event.job_id);
      await r.hset(\`research:\${event.job_id}:eval\`, 'pass', looksGood ? 1 : 0);
    },
  });
}
`,
      solution: `/** research.trace: job-keyed decisions without content; rubric scores written before the commit; version pins. */
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

import {judge} from './judge';

const SERVICE_VERSION = '2.3.0';
const RUBRIC = ['factual_accuracy', 'citation_accuracy', 'completeness', 'source_quality', 'tool_efficiency'] as const;

const kafka = new Kafka({clientId: 'researchd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

export interface Decision {
  jobId: string;
  agentId: string;
  tool: string;
  latencyMs: number;
  tokens: number;
  outcome: string;
}

export async function trace(decision: Decision): Promise<void> {
  const {jobId} = decision;
  const event = {
    job_id: jobId,
    agent_id: decision.agentId,
    tool: decision.tool,
    latency_ms: decision.latencyMs,
    tokens: decision.tokens,
    outcome: decision.outcome,
    version: SERVICE_VERSION,
  };
  await producer.send({
    topic: 'research.trace',
    acks: -1,
    messages: [{key: jobId, value: JSON.stringify(event)}],
  });
}

/** A job runs to completion on the version that started it; another version leaves it alone. */
export function claimJob(job: {job_id: string; version: string}): boolean {
  return job.version === SERVICE_VERSION;
}

export async function evaluate(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'end-state-eval'});
  await consumer.connect();
  await consumer.subscribe({topic: 'research.trace'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        job_id: string;
        outcome: string;
        version: string;
      };
      if (event.outcome === 'job.completed') {
        const verdict = await judge.score(event.job_id, RUBRIC);
        const fields: Record<string, string> = {passed: verdict.passed ? '1' : '0', version: event.version};
        for (const name of RUBRIC) fields[name] = String(verdict.scores[name]);
        await r.hset(\`research:\${event.job_id}:eval\`, fields);
      }
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
	"log"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var (
	traceWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "research.trace"}
	rdb         *redis.Client
)

type Judge struct{}

// LooksGood is one model call: is the job's final report acceptable?
func (j *Judge) LooksGood(ctx context.Context, jobID string) (bool, error) { return false, nil }

var judge = &Judge{}

// TODO: key by job id from an idempotent producer with acks=all, keep the query and the
// findings out of the event and the logs, score completed jobs with the rubric before the
// commit, and pin jobs to the service version. Review all four.
func trace(ctx context.Context, jobID, agentID, tool string, latencyMS, tokens int, outcome, query, findings string) {
	log.Printf("trace job=%s agent=%s findings=%q", jobID, agentID, findings)
	event := map[string]any{
		"job_id":     jobID,
		"agent_id":   agentID,
		"tool":       tool,
		"latency_ms": latencyMS,
		"tokens":     tokens,
		"outcome":    outcome,
		"query":      query,
		"findings":   findings,
	}
	payload, _ := json.Marshal(event)
	_ = traceWriter.WriteMessages(ctx, kafka.Message{Key: []byte(agentID), Value: payload})
}

func claimJob(job map[string]string) bool {
	return job["job_id"] != ""
}

func evaluate(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "research.trace",
		GroupID: "end-state-eval",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event struct {
			JobID   string \`json:"job_id"\`
			Outcome string \`json:"outcome"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		if event.Outcome != "job.completed" {
			continue
		}
		good, _ := judge.LooksGood(ctx, event.JobID)
		pass := 0
		if good {
			pass = 1
		}
		rdb.HSet(ctx, "research:"+event.JobID+":eval", "pass", pass)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const serviceVersion = "2.3.0"

var rubric = []string{"factual_accuracy", "citation_accuracy", "completeness", "source_quality", "tool_efficiency"}

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var traceWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "research.trace",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var rdb *redis.Client

type Verdict struct {
	Scores map[string]float64
	Passed bool
}

type Judge struct{}

// Score is one model call over the job's final report, read from the job store by id:
// 0.0–1.0 per criterion and a pass/fail grade.
func (j *Judge) Score(ctx context.Context, jobID string, rubric []string) (Verdict, error) {
	return Verdict{}, nil
}

var judge = &Judge{}

func trace(ctx context.Context, jobID, agentID, tool string, latencyMS, tokens int, outcome string) error {
	event := map[string]any{
		"job_id":     jobID,
		"agent_id":   agentID,
		"tool":       tool,
		"latency_ms": latencyMS,
		"tokens":     tokens,
		"outcome":    outcome,
		"version":    serviceVersion,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return traceWriter.WriteMessages(ctx, kafka.Message{Key: []byte(jobID), Value: payload})
}

// claimJob is true when the job runs on the version that started it; another version leaves it alone.
func claimJob(job map[string]string) bool {
	return job["version"] == serviceVersion
}

func evaluate(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "research.trace",
		GroupID: "end-state-eval",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			JobID   string \`json:"job_id"\`
			Outcome string \`json:"outcome"\`
			Version string \`json:"version"\`
		}
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		if event.Outcome == "job.completed" {
			verdict, err := judge.Score(ctx, event.JobID, rubric)
			if err != nil {
				continue
			}
			fields := map[string]any{"passed": verdict.Passed, "version": event.Version}
			for _, name := range rubric {
				fields[name] = strconv.FormatFloat(verdict.Scores[name], 'f', 2, 64)
			}
			if err := rdb.HSet(ctx, "research:"+event.JobID+":eval", fields).Err(); err != nil {
				continue
			}
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

object TraceEvents {
  private val log = Logger.getLogger("trace")
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: key by job id from an idempotent producer with acks=all, keep the query and the
  // findings out of the event and the logs, score completed jobs with the rubric before the
  // commit, and pin jobs to the service version. Review all four.
  def trace(
      jobId: String,
      agentId: String,
      tool: String,
      latencyMs: Long,
      tokens: Long,
      outcome: String,
      query: String,
      findings: String
  ): Unit = {
    log.info(s"trace job=$jobId agent=$agentId findings=$findings")
    val event = JsObject(
      "job_id" -> JsString(jobId),
      "agent_id" -> JsString(agentId),
      "tool" -> JsString(tool),
      "latency_ms" -> JsNumber(latencyMs),
      "tokens" -> JsNumber(tokens),
      "outcome" -> JsString(outcome),
      "query" -> JsString(query),
      "findings" -> JsString(findings)
    )
    producer.send(new ProducerRecord("research.trace", agentId, event.compactPrint))
  }

  def claimJob(job: Map[String, String]): Boolean = job.contains("job_id")

  def evaluate(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of("research.trace"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        val jobId = event("job_id").convertTo[String]
        if (event("outcome").convertTo[String] == "job.completed") {
          jedis.hset(s"research:$jobId:eval", "pass", if (Judge.looksGood(jobId)) "1" else "0")
        }
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import scala.jdk.CollectionConverters._

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Verdict(scores: Map[String, Double], passed: Boolean)

/** One model call over the job's final report, read from the job store by id: 0.0–1.0 per criterion and a pass/fail grade. */
trait Judge {
  def score(jobId: String, rubric: Seq[String]): Verdict
}

object TraceEvents {
  val ServiceVersion = "2.3.0"
  val Rubric = Seq("factual_accuracy", "citation_accuracy", "completeness", "source_quality", "tool_efficiency")

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)
  val judge: Judge = JudgeClient.open()

  def trace(jobId: String, agentId: String, tool: String, latencyMs: Long, tokens: Long, outcome: String): Unit = {
    val event = JsObject(
      "job_id" -> JsString(jobId),
      "agent_id" -> JsString(agentId),
      "tool" -> JsString(tool),
      "latency_ms" -> JsNumber(latencyMs),
      "tokens" -> JsNumber(tokens),
      "outcome" -> JsString(outcome),
      "version" -> JsString(ServiceVersion)
    )
    producer.send(new ProducerRecord("research.trace", jobId, event.compactPrint))
  }

  /** A job runs to completion on the version that started it; another version leaves it alone. */
  def claimJob(job: Map[String, String]): Boolean = job.get("version").contains(ServiceVersion)

  def evaluate(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "end-state-eval")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("research.trace"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val jobId = event("job_id").convertTo[String]
        if (event("outcome").convertTo[String] == "job.completed") {
          val verdict = judge.score(jobId, Rubric)
          val fields = Rubric.map(name => name -> verdict.scores(name).toString).toMap +
            ("passed" -> (if (verdict.passed) "1" else "0")) +
            ("version" -> event("version").convertTo[String])
          jedis.hset(s"research:$jobId:eval", fields.asJava)
        }
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kTraceTopic = "research.trace";

struct Judge {
  // One model call: is the job's final report acceptable?
  bool looksGood(const std::string& jobId);
};

Judge judge;
std::unique_ptr<RdKafka::Producer> producer;
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

// TODO: key by job id from an idempotent producer with acks=all, keep the query and the
// findings out of the event and the logs, score completed jobs with the rubric before the
// commit, and pin jobs to the service version. Review all four.
void trace(const std::string& jobId, const std::string& agentId, const std::string& tool, long latencyMs, long tokens, const std::string& outcome, const std::string& query, const std::string& findings) {
  std::cerr << "trace job=" << jobId << " agent=" << agentId << " findings=" << findings << "\\n";
  const json event = {
      {"job_id", jobId},
      {"agent_id", agentId},
      {"tool", tool},
      {"latency_ms", latencyMs},
      {"tokens", tokens},
      {"outcome", outcome},
      {"query", query},
      {"findings", findings},
  };
  const auto payload = event.dump();
  producer->produce(kTraceTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), agentId.data(), agentId.size(), 0, nullptr);
  producer->flush(2000);
}

bool claimJob(const json& job) { return job.contains("job_id"); }

void evaluate() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "end-state-eval", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTraceTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync();
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    if (event["outcome"] != "job.completed") continue;
    const auto jobId = event["job_id"].get<std::string>();
    redis->hset("research:" + jobId + ":eval", "pass", judge.looksGood(jobId) ? "1" : "0");
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTraceTopic = "research.trace";
const std::string kServiceVersion = "2.3.0";
const std::vector<std::string> kRubric = {
    "factual_accuracy", "citation_accuracy", "completeness", "source_quality", "tool_efficiency"};

struct Verdict {
  std::map<std::string, double> scores;
  bool passed;
};

struct Judge {
  // One model call over the job's final report, read from the job store by id: 0.0–1.0 per
  // criterion and a pass/fail grade.
  Verdict score(const std::string& jobId, const std::vector<std::string>& rubric);
};

Judge judge;

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

void trace(const std::string& jobId, const std::string& agentId, const std::string& tool, long latencyMs, long tokens, const std::string& outcome) {
  const json event = {
      {"job_id", jobId},
      {"agent_id", agentId},
      {"tool", tool},
      {"latency_ms", latencyMs},
      {"tokens", tokens},
      {"outcome", outcome},
      {"version", kServiceVersion},
  };
  const auto payload = event.dump();
  producer->produce(kTraceTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), jobId.data(), jobId.size(), 0, nullptr);
  producer->poll(0);
}

// A job runs to completion on the version that started it; another version leaves it alone.
bool claimJob(const json& job) { return job.value("version", std::string()) == kServiceVersion; }

void evaluate() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "end-state-eval", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTraceTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    if (event["outcome"] == "job.completed") {
      const auto jobId = event["job_id"].get<std::string>();
      const Verdict verdict = judge.score(jobId, kRubric);
      std::map<std::string, std::string> fields = {
          {"passed", verdict.passed ? "1" : "0"}, {"version", event.value("version", std::string())}};
      for (const auto& name : kRubric) fields[name] = std::to_string(verdict.scores.at(name));
      redis->hset("research:" + jobId + ":eval", fields.begin(), fields.end());
    }
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking four things a generated tracing snippet gets wrong, and all four come straight from the source's production chapter. First, the message key is an ordering contract: keyed by job, one job's decisions arrive in order and can be replayed as a story; keyed by agent they cannot. Second, observability without content: the source monitors decision patterns and interaction structures and deliberately not the contents of conversations, because a trace topic is retained, replicated and read by people the user never agreed to share with — ids, counts and latencies explain a bad answer, the text does not need to be there. Third, exactly-once-looking code is not exactly-once: the producer needs idempotence and acks=all, and the consumer must write the evaluation before the commit, or a crash between the two loses the only score that job will ever get. Fourth, the version pin is what makes a rainbow deployment safe: old and new workers run together, and a job keeps running on the version whose checkpoints it wrote. The end-state evaluation is the source's answer to grading agents that take different valid paths — judge the final report with one rubric call, not the steps. Real systems add schema registries for the event, a sampled copy of the full trace for debugging under explicit consent, and a drift alarm when the pass rate of a new version falls below the old one.`,
};
