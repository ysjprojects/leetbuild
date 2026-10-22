import type {Step} from '@/lib/types';

export const feedbackEvalStep: Step = {
  id: 'feedback-eval',
  title: 'query.feedback: the evaluation signals, per workspace',
  concept: 'kafka',
  file: 'feedback',
  focus: ['api', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a rating goes onto a topic
and a consumer moves a counter, so the dashboard shows numbers. Four production contracts are
broken: the event carries almost none of the signals the evaluation needs, it is keyed so that one
user's events scatter across partitions, the producer can duplicate on retry, and the consumer
commits before it writes. Find them, fix them, and prove the fix.

\`POST /v1/queries/{id}/feedback\` with body \`{"rating": 4}\` (1–5, **400** otherwise) is how the
product reports the outcome of a query, and the consumer turns those events into the per-workspace
numbers the source's evaluation tracks.

- Publish exactly one \`query.feedback\` event per call with the **user** as the message key, so
  one user's events stay ordered. The event carries the **signals** the source evaluates:
  \`query_id\`, \`user\`, \`workspace\` (the intent), \`tables_proposed\` (the table agent's pick),
  \`tables_acked\` (what the user confirmed), \`run_ok\`, \`has_output\` and \`rating\`. All of them
  come from the query record, not from the request body.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent) so a retried produce
  cannot duplicate a record. A broker failure is **503** to the caller — never a silently dropped
  event.
- The consumer (group \`eval\`, manual commits) computes the **table overlap**
  (\`table_overlap\`: \`|proposed ∩ acked| / |acked|\`, the source's 0–1 score — one of two
  required tables found is 0.5) and updates the hash \`eval:{workspace}\` with \`HINCRBY\` on
  \`queries\`, \`run_ok\`, \`has_output\`, \`overlap_milli\` (the score × 1000, so the field stays
  an integer) and \`rating_sum\`. Success rate and mean overlap per workspace fall out of the hash.
- Commit the offset **after** the Redis write. Commit first and one crash loses the update
  forever, because the offset already moved past the unprocessed record.

**Failure mode the checks target.** An event with only a rating cannot tell "the intent was
wrong" from "the tables were wrong" from "it ran but returned nothing" — the three distinct
failures the source's evaluation separates; keying by query id destroys per-user order; a plain
producer duplicates under retry and double-counts a workspace's success rate; and
commit-before-write is the crash that quietly makes the dashboard lie.`,
  sequence: {
    participants: ['querygen', 'query.feedback', 'Eval consumer', 'Redis'],
    messages: [
      {from: 'querygen', to: 'query.feedback', label: 'produce · key = user · acks = all · idempotent', kind: 'sync'},
      {from: 'query.feedback', to: 'querygen', label: 'ack / broker error → 503', kind: 'reply'},
      {from: 'query.feedback', to: 'Eval consumer', label: 'consume · group eval', kind: 'async'},
      {from: 'Eval consumer', to: 'Eval consumer', label: 'table_overlap(proposed, acked)', kind: 'sync'},
      {
        from: 'Eval consumer',
        to: 'Redis',
        label: 'HINCRBY eval:{workspace} queries · run_ok · has_output · overlap_milli',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Eval consumer', label: 'new counter values', kind: 'reply'},
      {from: 'Eval consumer', to: 'query.feedback', label: 'commit offset after the write', kind: 'async'},
    ],
  },
  hints: [
    'The event is assembled from the stored query record — workspace, `tables_proposed`, `tables_acked`, `run_ok`, `has_output` — plus the rating from the body. The message key is the user (`key=user`, `Key: []byte(user)`, `ProducerRecord(topic, user, …)`), not the query id.',
    'Idempotence is producer configuration: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` with `acks: -1`, or kafka-go’s `RequireAll` with a hash balancer. Catch the produce failure and answer 503 instead of returning `accepted`.',
    'Overlap is a set intersection over lower-cased names divided by the ACKed count; multiply by 1000 and truncate so `HINCRBY` can add it. Turn auto-commit off, do the five `HINCRBY`s on `eval:{workspace}`, and commit the message only after they succeed.',
  ],
  checks: [
    {
      id: 'user-key',
      title: 'Keyed by user, carries the query id',
      detail:
        'The message key is the user (one user’s events stay in one partition) and the event carries `query_id`. The draft keys by the query id, so one user’s events scatter across partitions.',
      match: {
        python: {all: [/key=user/, /query_id/]},
        typescript: {all: [/key:\s*user\b/, /query_id/]},
        go: {all: [/Key:\s*\[\]byte\(user\)/, /query_id/]},
        scala: {all: [/ProducerRecord\("query\.feedback",\s*user/, /query_id/]},
        cpp: {all: [/produce\([^;]*user\.data\(\)/, /query_id/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer — so a retried produce cannot double-count a workspace.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'signals',
      title: 'Carries the evaluation signals, not just a rating',
      detail:
        'The event has `tables_proposed`, `tables_acked`, `run_ok` and `has_output` beside the rating — the signals the source’s evaluation separates. The draft sends the rating alone.',
      match: {
        python: {all: [/tables_proposed/, /tables_acked/, /run_ok/, /has_output/]},
        typescript: {all: [/tables_proposed/, /tables_acked/, /run_ok/, /has_output/]},
        go: {all: [/tables_proposed/, /tables_acked/, /run_ok/, /has_output/]},
        scala: {all: [/tables_proposed/, /tables_acked/, /run_ok/, /has_output/]},
        cpp: {all: [/tables_proposed/, /tables_acked/, /run_ok/, /has_output/]},
      },
    },
    {
      id: 'overlap-score',
      title: 'Computes table overlap into eval:{workspace}',
      detail:
        '`table_overlap` scores `|proposed ∩ acked| / |acked|` and the consumer adds it as `overlap_milli` to the `eval:{workspace}` hash alongside the success counters. The draft counts ratings only.',
      match: {
        python: {all: [/def table_overlap\(/, /overlap_milli/, /eval:\{workspace\}/]},
        typescript: {all: [/function tableOverlap\(/, /overlap_milli/, /eval:\$\{workspace\}/]},
        go: {all: [/func tableOverlap\(/, /overlap_milli/, /"eval:"\s*\+\s*event\.Workspace/]},
        scala: {all: [/def tableOverlap\(/, /overlap_milli/, /eval:\$workspace/]},
        cpp: {all: [/tableOverlap\(/, /overlap_milli/, /"eval:"/]},
      },
    },
    {
      id: 'write-before-commit',
      title: 'Writes the counters before committing the offset',
      detail:
        'Auto-commit is off and the `HINCRBY`s run before the offset commit; committing first makes a crash lose the update forever. The draft commits first.',
      match: {
        python: {all: [/enable\.auto\.commit/], order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {all: [/autoCommit:\s*false/], order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /CommitMessages\(/]},
        scala: {all: [/ENABLE_AUTO_COMMIT_CONFIG|enable\.auto\.commit/], order: [/\.hincrBy\(/, /commitSync\(/]},
        cpp: {all: [/enable\.auto\.commit/], order: [/->hincrby\(|\.hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from query_store import store

app = FastAPI()
producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "query.feedback"


class FeedbackRequest(BaseModel):
    rating: int


@app.post("/v1/queries/{query_id}/feedback")
def feedback(query_id: str, body: FeedbackRequest, user: str = Header(alias="X-User-Id")) -> dict:
    # TODO: carry the evaluation signals from the query record, key by user instead of the query
    # id, configure the idempotent producer with acks=all, and answer 503 when the broker fails.
    record = store.get_query(query_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown query")
    event = {"query_id": query_id, "user": user, "rating": body.rating}
    producer.produce(TOPIC, key=query_id, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}


def consume() -> None:
    # TODO: compute the table overlap per workspace and commit only after the Redis write.
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "eval"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        r.hincrby("feedback:" + event["user"], "rating_sum", event["rating"])
`,
      solution: `import json

import redis
from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from query_store import store

app = FastAPI()
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "query.feedback"


class FeedbackRequest(BaseModel):
    rating: int


@app.post("/v1/queries/{query_id}/feedback")
def feedback(query_id: str, body: FeedbackRequest, user: str = Header(alias="X-User-Id")) -> dict:
    if not 1 <= body.rating <= 5:
        raise HTTPException(status_code=400, detail="rating must be 1..5")
    record = store.get_query(query_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown query")
    event = {
        "query_id": query_id,
        "user": user,
        "workspace": record["workspace"],
        "tables_proposed": record["tables_proposed"],
        "tables_acked": record["tables_acked"],
        "run_ok": bool(record.get("run_ok", False)),
        "has_output": bool(record.get("has_output", False)),
        "rating": body.rating,
    }
    try:
        producer.produce(TOPIC, key=user, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException as exc:
        raise HTTPException(status_code=503, detail="TRY_AGAIN") from exc
    return {"accepted": True}


def table_overlap(proposed: list[str], acked: list[str]) -> float:
    wanted = {name.lower() for name in acked}
    if not wanted:
        return 0.0
    found = wanted & {name.lower() for name in proposed}
    return len(found) / len(wanted)


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "eval", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        workspace = event["workspace"]
        key = f"eval:{workspace}"
        overlap = table_overlap(event["tables_proposed"], event["tables_acked"])
        pipe = r.pipeline()
        pipe.hincrby(key, "queries", 1)
        pipe.hincrby(key, "run_ok", int(event["run_ok"]))
        pipe.hincrby(key, "has_output", int(event["has_output"]))
        pipe.hincrby(key, "overlap_milli", int(overlap * 1000))
        pipe.hincrby(key, "rating_sum", int(event["rating"]))
        pipe.execute()
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** query.feedback: a model-generated draft that ships a rating keyed by query id and commits early. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'querygen', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

const TOPIC = 'query.feedback';

interface FeedbackBody {
  rating: number;
}

app.post('/v1/queries/:id/feedback', async (request, reply) => {
  // TODO: carry the evaluation signals from the query record, key by user instead of the query
  // id, configure the idempotent producer with acks=all, and answer 503 when the broker fails.
  const user = request.headers['x-user-id'] as string;
  const {id} = request.params as {id: string};
  const body = request.body as FeedbackBody;
  const record = await store.getQuery(id);
  if (record === null) return reply.code(404).send({error: 'unknown query'});
  const event = {query_id: id, user, rating: body.rating};
  await producer.send({topic: TOPIC, messages: [{key: id, value: JSON.stringify(event)}]});
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  // TODO: compute the table overlap per workspace and commit only after the Redis write.
  const consumer = kafka.consumer({groupId: 'eval'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {user: string; rating: number};
      await r.hincrby(\`feedback:\${event.user}\`, 'rating_sum', event.rating);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** query.feedback: one idempotent, user-keyed event with the evaluation signals; counters before commit. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'querygen', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

const TOPIC = 'query.feedback';

interface FeedbackBody {
  rating: number;
}

interface FeedbackEvent {
  query_id: string;
  user: string;
  workspace: string;
  tables_proposed: string[];
  tables_acked: string[];
  run_ok: boolean;
  has_output: boolean;
  rating: number;
}

app.post('/v1/queries/:id/feedback', async (request, reply) => {
  const user = request.headers['x-user-id'] as string;
  const {id} = request.params as {id: string};
  const body = request.body as Partial<FeedbackBody> | null;
  const rating = body?.rating;
  if (!Number.isInteger(rating) || rating === undefined || rating < 1 || rating > 5)
    return reply.code(400).send({error: 'rating must be 1..5'});
  const record = await store.getQuery(id);
  if (record === null) return reply.code(404).send({error: 'unknown query'});
  const event: FeedbackEvent = {
    query_id: id,
    user,
    workspace: record.workspace,
    tables_proposed: record.tables_proposed,
    tables_acked: record.tables_acked,
    run_ok: record.run_ok ?? false,
    has_output: record.has_output ?? false,
    rating,
  };
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: user, value: JSON.stringify(event)}]});
  } catch {
    return reply.code(503).send({error: 'TRY_AGAIN'});
  }
  return reply.code(202).send({accepted: true});
});

function tableOverlap(proposed: string[], acked: string[]): number {
  const wanted = new Set(acked.map(name => name.toLowerCase()));
  if (wanted.size === 0) return 0;
  let found = 0;
  for (const name of new Set(proposed.map(candidate => candidate.toLowerCase()))) if (wanted.has(name)) found += 1;
  return found / wanted.size;
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'eval'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as FeedbackEvent;
      const workspace = event.workspace;
      const key = \`eval:\${workspace}\`;
      const overlap = tableOverlap(event.tables_proposed, event.tables_acked);
      await r
        .multi()
        .hincrby(key, 'queries', 1)
        .hincrby(key, 'run_ok', event.run_ok ? 1 : 0)
        .hincrby(key, 'has_output', event.has_output ? 1 : 0)
        .hincrby(key, 'overlap_milli', Math.floor(overlap * 1000))
        .hincrby(key, 'rating_sum', event.rating)
        .exec();
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

	"querygen/store"
)

var (
	feedbackWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "query.feedback"}
	rdb            *redis.Client
)

type FeedbackRequest struct {
	Rating int \`json:"rating"\`
}

func feedback(rw http.ResponseWriter, r *http.Request) {
	// TODO: carry the evaluation signals from the query record, key by user instead of the query
	// id, configure acks=all / idempotence, and answer 503 when the broker fails.
	user := r.Header.Get("X-User-Id")
	id := r.PathValue("id")
	body := FeedbackRequest{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	record, err := store.GetQuery(r.Context(), id)
	if err != nil || record == nil {
		rw.WriteHeader(http.StatusNotFound)
		return
	}
	event := map[string]any{"query_id": id, "user": user, "rating": body.Rating}
	payload, _ := json.Marshal(event)
	_ = feedbackWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(id), Value: payload})
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	// TODO: compute the table overlap per workspace and commit only after the Redis write.
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "query.feedback",
		GroupID: "eval",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event struct {
			User   string \`json:"user"\`
			Rating int64  \`json:"rating"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.HIncrBy(ctx, "feedback:"+event.User, "rating_sum", event.Rating)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"querygen/store"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var feedbackWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "query.feedback",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var rdb *redis.Client

type FeedbackRequest struct {
	Rating int \`json:"rating"\`
}

type FeedbackEvent struct {
	QueryID        string   \`json:"query_id"\`
	User           string   \`json:"user"\`
	Workspace      string   \`json:"workspace"\`
	TablesProposed []string \`json:"tables_proposed"\`
	TablesAcked    []string \`json:"tables_acked"\`
	RunOK          bool     \`json:"run_ok"\`
	HasOutput      bool     \`json:"has_output"\`
	Rating         int      \`json:"rating"\`
}

func feedback(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	id := r.PathValue("id")
	body := FeedbackRequest{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Rating < 1 || body.Rating > 5 {
		rw.WriteHeader(http.StatusBadRequest)
		return
	}
	record, err := store.GetQuery(r.Context(), id)
	if err != nil || record == nil {
		rw.WriteHeader(http.StatusNotFound)
		return
	}
	event := FeedbackEvent{
		QueryID:        id,
		User:           user,
		Workspace:      record.Workspace,
		TablesProposed: record.TablesProposed,
		TablesAcked:    record.TablesAcked,
		RunOK:          record.RunOK,
		HasOutput:      record.HasOutput,
		Rating:         body.Rating,
	}
	payload, _ := json.Marshal(event)
	if err := feedbackWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(user), Value: payload}); err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	rw.WriteHeader(http.StatusAccepted)
}

func tableOverlap(proposed, acked []string) float64 {
	wanted := map[string]bool{}
	for _, name := range acked {
		wanted[strings.ToLower(name)] = true
	}
	if len(wanted) == 0 {
		return 0
	}
	found := map[string]bool{}
	for _, name := range proposed {
		if lowered := strings.ToLower(name); wanted[lowered] {
			found[lowered] = true
		}
	}
	return float64(len(found)) / float64(len(wanted))
}

func boolCount(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "query.feedback",
		GroupID: "eval",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event FeedbackEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			_ = reader.CommitMessages(ctx, msg)
			continue
		}
		key := "eval:" + event.Workspace
		overlap := tableOverlap(event.TablesProposed, event.TablesAcked)
		pipe := rdb.TxPipeline()
		pipe.HIncrBy(ctx, key, "queries", 1)
		pipe.HIncrBy(ctx, key, "run_ok", boolCount(event.RunOK))
		pipe.HIncrBy(ctx, key, "has_output", boolCount(event.HasOutput))
		pipe.HIncrBy(ctx, key, "overlap_milli", int64(overlap*1000))
		pipe.HIncrBy(ctx, key, "rating_sum", int64(event.Rating))
		if _, err := pipe.Exec(ctx); err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

object FeedbackApi {
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: carry the evaluation signals from the query record, key by user instead of the query
  // id, configure the idempotent producer with acks=all, and fail the caller when the broker does.
  def publish(user: String, queryId: String, rating: Int): Unit = {
    val payload = JsObject("query_id" -> JsString(queryId), "user" -> JsString(user), "rating" -> JsNumber(rating)).compactPrint
    producer.send(new ProducerRecord("query.feedback", queryId, payload))
  }

  // TODO: compute the table overlap per workspace and commit only after the Redis write.
  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of("query.feedback"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        jedis.hincrBy(s"feedback:\${event("user").convertTo[String]}", "rating_sum", event("rating").convertTo[Long])
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class QueryRecord(
    workspace: String,
    tables_proposed: Seq[String],
    tables_acked: Seq[String],
    run_ok: Boolean,
    has_output: Boolean
)

final case class FeedbackEvent(
    query_id: String,
    user: String,
    workspace: String,
    tables_proposed: Seq[String],
    tables_acked: Seq[String],
    run_ok: Boolean,
    has_output: Boolean,
    rating: Int
)

object FeedbackApi {
  implicit val eventFormat: RootJsonFormat[FeedbackEvent] = jsonFormat8(FeedbackEvent)

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def publish(user: String, queryId: String, record: QueryRecord, rating: Int): Unit = {
    require(rating >= 1 && rating <= 5, "rating must be 1..5")
    val event = FeedbackEvent(
      queryId,
      user,
      record.workspace,
      record.tables_proposed,
      record.tables_acked,
      record.run_ok,
      record.has_output,
      rating
    )
    producer.send(new ProducerRecord("query.feedback", user, event.toJson.compactPrint)).get()
  }

  def tableOverlap(proposed: Seq[String], acked: Seq[String]): Double = {
    val wanted = acked.map(_.toLowerCase).toSet
    if (wanted.isEmpty) 0.0
    else proposed.map(_.toLowerCase).toSet.intersect(wanted).size.toDouble / wanted.size
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "eval")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("query.feedback"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.convertTo[FeedbackEvent]
        val workspace = event.workspace
        val key = s"eval:$workspace"
        val overlap = tableOverlap(event.tables_proposed, event.tables_acked)
        val tx = jedis.multi()
        tx.hincrBy(key, "queries", 1L)
        tx.hincrBy(key, "run_ok", if (event.run_ok) 1L else 0L)
        tx.hincrBy(key, "has_output", if (event.has_output) 1L else 0L)
        tx.hincrBy(key, "overlap_milli", (overlap * 1000).toLong)
        tx.hincrBy(key, "rating_sum", event.rating.toLong)
        tx.exec()
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

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kFeedbackTopic = "query.feedback";

std::unique_ptr<RdKafka::Producer> producer;
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

// TODO: carry the evaluation signals from the query record, key by user instead of the query id,
// configure the idempotent producer with acks=all, and fail the caller when the broker does.
void publish(const std::string& user, const std::string& queryId, int rating) {
  const json event = {{"query_id", queryId}, {"user", user}, {"rating", rating}};
  const auto payload = event.dump();
  producer->produce(
      kFeedbackTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      queryId.data(),
      queryId.size(),
      0,
      nullptr);
  producer->flush(2000);
}

// TODO: compute the table overlap per workspace and commit only after the Redis write.
void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "eval", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kFeedbackTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync();
    const json event = json::parse(static_cast<const char*>(msg->payload()),
                                   static_cast<const char*>(msg->payload()) + msg->len());
    redis->hincrby("feedback:" + event["user"].get<std::string>(), "rating_sum", event["rating"].get<long long>());
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cctype>
#include <memory>
#include <nlohmann/json.hpp>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kFeedbackTopic = "query.feedback";

struct QueryRecord {
  std::string workspace;
  std::vector<std::string> tablesProposed;
  std::vector<std::string> tablesAcked;
  bool runOk = false;
  bool hasOutput = false;
};

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

void publish(const std::string& user, const std::string& queryId, const QueryRecord& record, int rating) {
  if (rating < 1 || rating > 5) throw std::invalid_argument("rating must be 1..5");
  const json event = {
      {"query_id", queryId},
      {"user", user},
      {"workspace", record.workspace},
      {"tables_proposed", record.tablesProposed},
      {"tables_acked", record.tablesAcked},
      {"run_ok", record.runOk},
      {"has_output", record.hasOutput},
      {"rating", rating},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(
      kFeedbackTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      user.data(),
      user.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) throw std::runtime_error("TRY_AGAIN: " + RdKafka::err2str(err));
  producer->flush(2000);
}

std::set<std::string> lowered(const std::vector<std::string>& names) {
  std::set<std::string> out;
  for (auto name : names) {
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return std::tolower(c); });
    out.insert(name);
  }
  return out;
}

double tableOverlap(const std::vector<std::string>& proposed, const std::vector<std::string>& acked) {
  const auto wanted = lowered(acked);
  if (wanted.empty()) return 0.0;
  std::size_t found = 0;
  for (const auto& name : lowered(proposed)) {
    if (wanted.count(name) != 0) found += 1;
  }
  return static_cast<double>(found) / static_cast<double>(wanted.size());
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "eval", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kFeedbackTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()),
                                   static_cast<const char*>(msg->payload()) + msg->len());
    const auto key = "eval:" + event["workspace"].get<std::string>();
    const auto overlap = tableOverlap(event["tables_proposed"].get<std::vector<std::string>>(),
                                      event["tables_acked"].get<std::vector<std::string>>());
    auto tx = redis->transaction();
    tx.hincrby(key, "queries", 1)
        .hincrby(key, "run_ok", event["run_ok"].get<bool>() ? 1 : 0)
        .hincrby(key, "has_output", event["has_output"].get<bool>() ? 1 : 0)
        .hincrby(key, "overlap_milli", static_cast<long long>(overlap * 1000))
        .hincrby(key, "rating_sum", event["rating"].get<long long>());
    tx.exec();
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking whether you understand what the evaluation is *for*. QueryGPT's evaluation captures five signals per question — intent, table overlap, successful run, run-has-output, and a judged similarity — because each one isolates a different component: the intent agent, the table agent, the generator, and the generator's taste in filter values. An event that carries only a rating collapses all of them into one number nobody can act on; an event with the tables proposed and ACKed lets the consumer compute the overlap score per workspace, which is the number that tells you which workspace's curation needs work. The Kafka half is the usual three contracts a generated snippet gets wrong: the key is an ordering contract (user, not query), the producer needs idempotence and acks=all so a retry cannot double-count a success, and the consumer writes before it commits or a crash loses the update. Real pipelines add the LLM-judged similarity against a golden query for the questions that have one, the vanilla/decoupled split so the generator can be scored with the true tables instead of the inferred ones, and a dead-letter topic for events that fail to parse.`,
};
