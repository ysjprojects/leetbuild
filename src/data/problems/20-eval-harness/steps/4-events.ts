import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Per-sample results keyed by run',
  concept: 'kafka',
  file: 'events',
  focus: ['harness', 'kafka', 'worker', 'redis'],
  task: `## Task

**Starting point.** The starter implements \`publish_result\`, how a worker reports one scored
sample, and \`consume\`, which folds those events into the run's counters. The producer is built
with only \`bootstrap.servers\`; the handler logs the model output, puts \`output_text\` in the event,
produces to \`eval.sample\` keyed by the worker id and flushes. The consumer commits the offset,
then runs \`HINCRBY\` on \`evals:run:{run_id}\`. It compiles, serves the demo and hides 5 flaws.

**Failure mode the checks target.** Keying by worker id scatters one run's samples across
partitions; the bare producer duplicates a result on retry; the sample text is a leak retained with
the topic; a rejected produce silently loses the sample; and commit-before-fold loses the counter
update when the consumer crashes between the two, so the run reports fewer samples than it scored.

Requirements:

- Exactly one \`eval.sample\` event per sample with the **run id as the message key**, so one
  run's samples stay in order. The event **id is the sample id**; the payload carries \`run_id\`,
  \`model_version\`, \`outcome\` and \`score\`.
- No sample text or model output in the event or in a log line.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks
  \`all\` plus hashed, stable keys).
- When the broker rejects the produce (\`KafkaException\`), write the event to the **outbox** with
  \`insert_outbox\` instead of dropping it.
- The consumer runs \`HINCRBY evals:run:{run_id}\` first and commits the offset only afterwards.`,
  sequence: {
    participants: ['Eval worker', 'eval.sample', 'Progress consumer', 'Redis'],
    messages: [
      {from: 'Eval worker', to: 'eval.sample', label: 'produce · key = run_id · acks = all', kind: 'sync'},
      {from: 'eval.sample', to: 'Eval worker', label: 'ack / broker error', kind: 'reply'},
      {from: 'Eval worker', to: 'Eval worker', label: 'insertOutbox(run_id, event) on failure', kind: 'sync'},
      {from: 'eval.sample', to: 'Progress consumer', label: 'consume · group eval-progress', kind: 'async'},
      {from: 'Progress consumer', to: 'Redis', label: 'HINCRBY evals:run:{run_id}', kind: 'sync'},
      {from: 'Redis', to: 'Progress consumer', label: 'new counter value', kind: 'reply'},
      {from: 'Progress consumer', to: 'eval.sample', label: 'commit offset after folding', kind: 'async'},
    ],
  },
  hints: [
    'Symptom: after a broker restart a run stops short of its budget, the same sample id shows up twice in the topic, and a compliance scan finds golden-set text in `eval.sample` retained for seven days.',
    'Mechanism: the partition key is the worker, not the run; the producer config is bare, so retries are not deduplicated; the produce result is ignored; and the offset moves before the counters do.',
    'Fix: `Producer({…, "enable.idempotence": True, "acks": "all"})`, `key=body.run_id`, drop `output_text`, wrap produce in `except KafkaException` with `store.insert_outbox(...)`, and in `consume` run both `hincrby` calls before `consumer.commit(msg)`.',
  ],
  checks: [
    {
      id: 'run-key',
      title: 'Keyed by run id, event id is the sample id',
      detail:
        'The message key is the run id (partition by run) and the event carries the sample id as its id. The starter keys by worker id, so one run’s samples scatter across partitions and the replay order the counters rely on is gone.',
      match: {
        python: {all: [/eval\.sample/, /key=body\.run_id/]},
        typescript: {all: [/eval\.sample/, /key:\s*runId/]},
        go: {all: [/eval\.sample/, /Key:\s*\[\]byte\(runID\)/]},
        scala: {all: [/eval\.sample/, /"eval\.sample",\s*runId/]},
        cpp: {all: [/eval\.sample/, /runId\.c_str\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. A retried produce must not duplicate the result.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox`/`insertOutbox`/`InsertOutbox`) inside the error branch instead of dropping the sample. The starter ignores the broker result and lets the worker report success.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Folds the sample into the counters before committing',
      detail:
        'The consumer runs `HINCRBY` on the run’s counters before it commits the offset; committing first makes a crash lose the counter update forever. The starter commits first and folds afterwards.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/\.hincrBy\(/, /commitSync\(/]},
        cpp: {order: [/\.hincrby\(|->hincrby\(/, /commitSync\(/]},
      },
    },
    {
      id: 'no-text',
      title: 'No sample text in the event or the logs',
      detail:
        'Neither the event payload nor a log line carries the sample text or the model output. The starter logs the output and copies it into the event — a leak that is retained and replicated with the topic.',
      match: {
        python: {all: [/eval\.sample/], none: [/output_text|OutputText/]},
        typescript: {all: [/eval\.sample/], none: [/output_text|OutputText/]},
        go: {all: [/eval\.sample/], none: [/output_text|OutputText/]},
        scala: {all: [/eval\.sample/], none: [/output_text|OutputText/]},
        cpp: {all: [/eval\.sample/], none: [/output_text|OutputText/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("evals")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class SampleResult(BaseModel):
    run_id: str
    sample_id: str
    worker_id: str
    model_version: str
    outcome: str
    score: float
    output_text: str


class OutboxStore:
    def insert_outbox(self, run_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/evals/samples")
def publish_result(body: SampleResult, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    logger.info("sample tenant=%s output=%r", tenant, body.output_text)
    event = {
        "id": body.sample_id,
        "run_id": body.run_id,
        "worker_id": body.worker_id,
        "output_text": body.output_text,
    }
    producer.produce("eval.sample", key=body.worker_id, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "eval-progress"})
    consumer.subscribe(["eval.sample"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        key = f"evals:run:{event['run_id']}"
        r.hincrby(key, "scored", 1)
        r.hincrby(key, event["outcome"], 1)
`,
      solution: `import json

import redis
from confluent_kafka import Consumer, KafkaException, Producer
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


class SampleResult(BaseModel):
    run_id: str
    sample_id: str
    model_version: str
    outcome: str
    score: float


class OutboxStore:
    def insert_outbox(self, run_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/evals/samples")
def publish_result(body: SampleResult, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    event = {
        "id": body.sample_id,
        "run_id": body.run_id,
        "model_version": body.model_version,
        "outcome": body.outcome,
        "score": body.score,
    }
    try:
        producer.produce("eval.sample", key=body.run_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(body.run_id, event)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "eval-progress", "enable.auto.commit": False}
    )
    consumer.subscribe(["eval.sample"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        key = f"evals:run:{event['run_id']}"
        r.hincrby(key, "scored", 1)
        r.hincrby(key, event["outcome"], 1)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** publish_result: flawed code that keys by worker and commits too early. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'eval-harness', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

interface SampleResult {
  run_id: string;
  sample_id: string;
  worker_id: string;
  model_version: string;
  outcome: string;
  score: number;
  output_text: string;
}

app.post('/v1/evals/samples', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const body = request.body as SampleResult;
  request.log.info({run_id: body.run_id, output: body.output_text}, 'sample scored');
  const event = {
    id: body.sample_id,
    worker_id: body.worker_id,
    output_text: body.output_text,
  };
  await producer.send({
    topic: 'eval.sample',
    messages: [{key: body.worker_id, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'eval-progress'});
  await consumer.connect();
  await consumer.subscribe({topic: 'eval.sample'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {run_id: string; outcome: string};
      await r.hincrby(\`evals:run:\${event.run_id}\`, 'scored', 1);
      await r.hincrby(\`evals:run:\${event.run_id}\`, event.outcome, 1);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** publish_result: one idempotent, run-keyed event per sample; counters before the commit. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'eval-harness', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

interface SampleResult {
  run_id: string;
  sample_id: string;
  model_version: string;
  outcome: string;
  score: number;
}

app.post('/v1/evals/samples', async (request, reply) => {
  const body = request.body as SampleResult;
  const runId = body.run_id;
  const event = {
    id: body.sample_id,
    run_id: runId,
    model_version: body.model_version,
    outcome: body.outcome,
    score: body.score,
  };
  try {
    await producer.send({
      topic: 'eval.sample',
      acks: -1,
      messages: [{key: runId, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(runId, event);
  }
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'eval-progress'});
  await consumer.connect();
  await consumer.subscribe({topic: 'eval.sample'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        run_id: string;
        outcome: string;
      };
      await r.hincrby(\`evals:run:\${event.run_id}\`, 'scored', 1);
      await r.hincrby(\`evals:run:\${event.run_id}\`, event.outcome, 1);
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
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var feedbackWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "eval.sample"}

var rdb *redis.Client

type SampleResult struct {
	RunID      string  \`json:"run_id"\`
	SampleID   string  \`json:"sample_id"\`
	WorkerID   string  \`json:"worker_id"\`
	Outcome    string  \`json:"outcome"\`
	Score      float64 \`json:"score"\`
	OutputText string  \`json:"output_text"\`
}

func publishResult(rw http.ResponseWriter, r *http.Request) {
	body := SampleResult{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	log.Printf("sample run=%s output=%q", body.RunID, body.OutputText)
	event := map[string]any{"id": body.SampleID, "worker_id": body.WorkerID, "output_text": body.OutputText}
	payload, _ := json.Marshal(event)
	_ = feedbackWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.WorkerID), Value: payload})
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "eval.sample",
		GroupID: "eval-progress",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event struct {
			RunID   string \`json:"run_id"\`
			Outcome string \`json:"outcome"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.HIncrBy(ctx, "evals:run:"+event.RunID, "scored", 1)
		rdb.HIncrBy(ctx, "evals:run:"+event.RunID, event.Outcome, 1)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var sampleWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "eval.sample",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

var rdb *redis.Client

type SampleResult struct {
	RunID        string  \`json:"run_id"\`
	SampleID     string  \`json:"sample_id"\`
	ModelVersion string  \`json:"model_version"\`
	Outcome      string  \`json:"outcome"\`
	Score        float64 \`json:"score"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, runID string, payload []byte) error {
	return nil
}

var store = &OutboxStore{}

func publishResult(rw http.ResponseWriter, r *http.Request) {
	body := SampleResult{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	runID := body.RunID
	event := map[string]any{
		"id":            body.SampleID,
		"run_id":        runID,
		"model_version": body.ModelVersion,
		"outcome":       body.Outcome,
		"score":         body.Score,
	}
	payload, _ := json.Marshal(event)
	if err := sampleWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(runID), Value: payload}); err != nil {
		store.InsertOutbox(r.Context(), runID, payload)
	}
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "eval.sample",
		GroupID: "eval-progress",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			RunID   string \`json:"run_id"\`
			Outcome string \`json:"outcome"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.HIncrBy(ctx, "evals:run:"+event.RunID, "scored", 1)
		rdb.HIncrBy(ctx, "evals:run:"+event.RunID, event.Outcome, 1)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.Jedis

final case class SampleResult(
    run_id: String,
    sample_id: String,
    worker_id: String,
    outcome: String,
    output_text: String
)

object Results {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  val jedis = new Jedis("redis", 6379)

  def publishResult(body: SampleResult, tenant: String): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val payload = s"""{"id":"\${body.sample_id}","output_text":"\${body.output_text}"}"""
    producer.send(new ProducerRecord[String, String]("eval.sample", body.worker_id, payload))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("eval.sample"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      records.forEach { record =>
        consumer.commitSync()
        val runId = "run-1"
        jedis.hincrBy(s"evals:run:$runId", "scored", 1)
        jedis.hincrBy(s"evals:run:$runId", "passed", 1)
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.Jedis

final case class SampleResult(
    run_id: String,
    sample_id: String,
    model_version: String,
    outcome: String,
    score: Double
)

object Results {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  val jedis = new Jedis("redis", 6379)

  def publishResult(body: SampleResult, tenant: String): Unit = {
    val runId = body.run_id
    val payload =
      s"""{"id":"\${body.sample_id}","run_id":"$runId","model_version":"\${body.model_version}","outcome":"\${body.outcome}"}"""
    try {
      producer.send(new ProducerRecord[String, String]("eval.sample", runId, payload))
      producer.flush()
    } catch {
      case _: Exception =>
        insertOutbox(runId, payload)
    }
  }

  def insertOutbox(runId: String, payload: String): Unit = ()

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("eval.sample"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      records.forEach { record =>
        val runId = "run-1"
        jedis.hincrBy(s"evals:run:$runId", "scored", 1)
        jedis.hincrBy(s"evals:run:$runId", "passed", 1)
        consumer.commitSync()
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

#include <iostream>
#include <string>

using json = nlohmann::json;

struct SampleResult {
  std::string run_id;
  std::string sample_id;
  std::string worker_id;
  std::string outcome;
  std::string output_text;
};

void publishResult(RdKafka::Producer* producer, const SampleResult& result) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto payload =
      json{{"id", result.sample_id}, {"output_text", result.output_text}}.dump();
  std::cerr << "sample run=" << result.run_id << " output=" << result.output_text << "\\n";
  const auto workerId = result.worker_id;
  producer->produce(
      "eval.sample",
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.c_str()),
      payload.size(),
      workerId.c_str(),
      workerId.size(),
      0,
      nullptr);
}

void consume(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& redis) {
  while (true) {
    auto message = consumer->consume(500);
    if (message->err() != RdKafka::ERR_NO_ERROR) {
      delete message;
      continue;
    }
    consumer->commitSync(message);
    const auto event = json::parse(static_cast<RdKafka::Message*>(message)->payload(), nullptr, false);
    const auto key = "evals:run:" + event.value("run_id", std::string());
    redis.hincrby(key, "scored", 1);
    redis.hincrby(key, event.value("outcome", std::string()), 1);
    delete message;
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

struct SampleResult {
  std::string run_id;
  std::string sample_id;
  std::string model_version;
  std::string outcome;
  double score;
};

void insertOutbox(const std::string& runId, const std::string& payload);

RdKafka::Producer* makeProducer() {
  std::string errstr;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("enable.idempotence", "true", errstr);
  conf->set("acks", "all", errstr);
  return RdKafka::Producer::create(conf.get(), errstr);
}

void publishResult(RdKafka::Producer* producer, const SampleResult& result) {
  const auto runId = result.run_id;
  const auto payload = json{{"id", result.sample_id},
                            {"run_id", runId},
                            {"model_version", result.model_version},
                            {"outcome", result.outcome},
                            {"score", result.score}}
                           .dump();
  const auto error = producer->produce(
      "eval.sample",
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.c_str()),
      payload.size(),
      runId.c_str(),
      runId.size(),
      0,
      nullptr);
  if (error != RdKafka::ERR_NO_ERROR) insertOutbox(runId, payload);
  producer->flush(2000);
}

void consume(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& redis) {
  while (true) {
    auto message = consumer->consume(500);
    if (message->err() != RdKafka::ERR_NO_ERROR) {
      delete message;
      continue;
    }
    const auto event = json::parse(static_cast<RdKafka::Message*>(message)->payload(), nullptr, false);
    const auto key = "evals:run:" + event.value("run_id", std::string());
    redis.hincrby(key, "scored", 1);
    redis.hincrby(key, event.value("outcome", std::string()), 1);
    consumer->commitSync(message);
    delete message;
  }
}
`,
    },
  },
  debrief: `The fix has its shape because each contract lives in a different place: ordering is the message key, so it must be the run id and not whichever worker scored the sample; duplicate protection is producer configuration, not application code, which is why \`enable.idempotence\` and \`acks=all\` sit in the constructor; durability is the outbox row written only in the error branch; and the consumer's order of \`HINCRBY\` then \`commit\` turns a crash into a replay the step 2 dedupe key absorbs, instead of a lost fold. Keeping text out of the payload is the one fix with no runtime symptom. Production pipelines enforce the payload with a schema registry so a later producer cannot smuggle text back in, and alarm on consumer-group lag so a stalled fold is noticed before the release reads the counters.`,
};
