import type {Step} from '@/lib/types';

export const feedbackEvalStep: Step = {
  id: 'feedback-eval',
  title: 'query.feedback: the evaluation signals, per workspace',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'feedback',
  focus: ['api', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter is the feedback pipeline. \`publish_feedback(record, rating)\` turns a
rated query record into \`build_event(record, rating)\` = \`{query_id, user, workspace, rating}\`,
produces it to \`query.feedback\` keyed by the query id with \`acks=1\`, waits up to 2 s for the delivery
report and returns whether it arrived. \`run_eval()\` consumes as group \`eval\` with auto-commit off,
commits each record, then runs \`HINCRBY eval:{workspace}\` on \`queries\` and \`rating_sum\`. It serves the
demo and hides 5 flaws.

**Failure mode the checks target.** A user's ratings scattered over partitions; a dashboard that
cannot say whether the intent, the tables or the run went wrong; a lost acknowledgement that counts
one query twice and a leader failover that loses one; a consumer crash between commit and write that
drops a rating.

Requirements:

- Key the record by the record's **user**.
- The event carries the signals the source evaluates: \`query_id\`, \`user\`, \`workspace\`, \`rating\`,
  \`tables_proposed\`, \`tables_acked\`, \`run_ok\`, \`has_output\`.
- The producer is **idempotent** with \`acks=all\` (Go uses confluent-kafka-go for this).
- \`run_eval\` adds \`queries\`, \`run_ok\`, \`has_output\` (0 or 1), \`rating_sum\` and \`overlap_milli\` =
  round(1000 × \`table_overlap\`), where \`table_overlap\` = |proposed ∩ acked| / |acked| (0 when nothing
  was ACKed), and commits only **after** the writes.`,
  sequence: {
    participants: ['querygen', 'query.feedback', 'Eval consumer', 'Redis'],
    messages: [
      {from: 'querygen', to: 'query.feedback', label: 'produce key = user · idempotent · acks = all', kind: 'sync'},
      {from: 'query.feedback', to: 'querygen', label: 'delivery report within 2 s → true / false', kind: 'reply'},
      {from: 'query.feedback', to: 'Eval consumer', label: 'consume · group eval', kind: 'async'},
      {from: 'Eval consumer', to: 'Eval consumer', label: 'table_overlap(proposed, acked)', kind: 'sync'},
      {
        from: 'Eval consumer',
        to: 'Redis',
        label: 'HINCRBY eval:{workspace} queries · run_ok · has_output · overlap_milli · rating_sum',
        kind: 'sync',
      },
      {from: 'Eval consumer', to: 'query.feedback', label: 'commit offset after the writes', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'user-key',
      title: 'Keys feedback by user',
      detail:
        "Three ratings from ana, ben and ana carry those keys, and ana's two land on one partition. The starter keys by query id, which scatters one user's feedback over every partition.",
      match: {
        python: {all: [/key\s*=\s*record\[["']user["']\]/]},
        typescript: {all: [/key:\s*record\.user/]},
        go: {all: [/Key:\s*\[\]byte\(\s*rec\.User\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*Config\.Topic\s*,\s*record\.user\s*,/]},
        cpp: {all: [/user\.c_str\(\)\s*,\s*user\.(size|length)\(\)/]},
      },
    },
    {
      id: 'signals',
      title: 'Carries the evaluation signals, not just a rating',
      detail:
        'The event holds query_id, user, workspace, rating, tables_proposed, tables_acked, run_ok and has_output, taken from the record. The starter sends the rating alone, so no one can tell a wrong table pick from an empty result.',
      match: {
        python: {all: [/["']tables_acked["']\s*:\s*record\[/, /["']has_output["']\s*:\s*record\[/]},
        typescript: {all: [/tables_acked:\s*record\.tables_acked/, /has_output:\s*record\.has_output/]},
        go: {all: [/"tables_acked":\s*rec\.TablesAcked/, /"has_output":\s*rec\.HasOutput/]},
        scala: {all: [/"tables_acked"\s*->/, /"has_output"\s*->\s*record\.has_output/]},
        cpp: {all: [/\{"tables_acked",\s*record/, /\{"has_output",\s*record/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover right after its acknowledgement. The starter sets acks=1 and no idempotence.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["'](all|-1)["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"(all|-1)"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"(all|-1)"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"(all|-1)"/]},
      },
    },
    {
      id: 'eval-counters',
      title: 'Aggregates the signals and the table overlap into eval:{workspace}',
      detail:
        'Three Mobility events leave queries 3, run_ok 2, has_output 1, rating_sum 8 and overlap_milli 2500 (overlaps 1, 0.5 and 1). The starter counts queries and ratings only.',
      match: {
        python: {all: [/table_overlap\(/, /["']overlap_milli["']/, /["']has_output["']\s*,\s*int\(/]},
        typescript: {all: [/tableOverlap\(/, /['"]overlap_milli['"]/]},
        go: {all: [/tableOverlap\(/, /"overlap_milli"/]},
        scala: {all: [/tableOverlap\(/, /"overlap_milli"/]},
        cpp: {all: [/table_overlap\(/, /"overlap_milli"/]},
      },
    },
    {
      id: 'write-before-commit',
      title: 'Writes the counters before committing the offset',
      detail:
        'At every commit the counters already include the committed record, and nothing is left uncommitted. The starter commits first, so a crash between the commit and the write loses that rating.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /\.CommitMessage\(/]},
        scala: {order: [/\.hincrBy\(/, /\.commitSync\(/]},
        cpp: {order: [/\.hincrby\(/, /->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from querygen.config import TOPIC

GROUP = "eval"
ACK_TIMEOUT_S = 2.0
log = logging.getLogger("querygen.feedback")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def build_event(record: dict, rating: int) -> dict:
    """The feedback event for a rated query."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    return {"query_id": record["query_id"], "user": record["user"], "workspace": record["workspace"], "rating": rating}


def publish_feedback(record: dict, rating: int) -> bool:
    """One event on query.feedback; True once the broker acknowledged it."""
    delivered = []

    def on_delivery(err, msg) -> None:
        if err is not None:
            log.warning("feedback for %s not delivered: %s", record["query_id"], err)
        delivered.append(err is None)

    producer.produce(TOPIC, key=record["query_id"], value=json.dumps(build_event(record, rating)), on_delivery=on_delivery)
    producer.flush(ACK_TIMEOUT_S)  # the delivery report fires here, delivered or refused
    return delivered == [True]


def run_eval() -> None:
    """Fold every feedback event into its workspace's counters."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(message=msg, asynchronous=False)
        event = json.loads(msg.value())
        key = f"eval:{event['workspace']}"
        r.hincrby(key, "queries", 1)
        r.hincrby(key, "rating_sum", int(event["rating"]))
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from querygen.config import TOPIC

GROUP = "eval"
ACK_TIMEOUT_S = 2.0
log = logging.getLogger("querygen.feedback")

# Idempotent with acks=all: a retry after a lost acknowledgement lands once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def build_event(record: dict, rating: int) -> dict:
    """The feedback event for a rated query: the rating and the signals that explain it."""
    return {
        "query_id": record["query_id"],
        "user": record["user"],
        "workspace": record["workspace"],
        "rating": rating,
        "tables_proposed": record["tables_proposed"],
        "tables_acked": record["tables_acked"],
        "run_ok": record["run_ok"],
        "has_output": record["has_output"],
    }


def publish_feedback(record: dict, rating: int) -> bool:
    """One event on query.feedback, keyed by user so one user's feedback stays in order; True once acknowledged."""
    delivered = []

    def on_delivery(err, msg) -> None:
        if err is not None:
            log.warning("feedback for %s not delivered: %s", record["query_id"], err)
        delivered.append(err is None)

    producer.produce(TOPIC, key=record["user"], value=json.dumps(build_event(record, rating)), on_delivery=on_delivery)
    producer.flush(ACK_TIMEOUT_S)  # the delivery report fires here, delivered or refused
    return delivered == [True]


def table_overlap(proposed: list[str], acked: list[str]) -> float:
    """How much of what the user ACKed the table agent had proposed: |proposed ∩ acked| / |acked|."""
    if not acked:
        return 0.0
    return len(set(proposed) & set(acked)) / len(set(acked))


def run_eval() -> None:
    """Fold every feedback event into its workspace's counters, then commit."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        key = f"eval:{event['workspace']}"
        r.hincrby(key, "queries", 1)
        r.hincrby(key, "run_ok", int(bool(event["run_ok"])))
        r.hincrby(key, "has_output", int(bool(event["has_output"])))
        r.hincrby(key, "rating_sum", int(event["rating"]))
        r.hincrby(key, "overlap_milli", round(1000 * table_overlap(event["tables_proposed"], event["tables_acked"])))
        # After the writes: a crash before this line replays the record instead of losing it.
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {TOPIC} from 'querygen/config';
import type {QueryRecord} from 'querygen/queries';

export const GROUP = 'eval';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'querygen', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

/** The feedback event for a rated query. */
export function buildEvent(record: QueryRecord, rating: number): Record<string, unknown> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  return {query_id: record.query_id, user: record.user, workspace: record.workspace, rating};
}

/** One event on query.feedback; true once the broker acknowledged it. */
export async function publishFeedback(record: QueryRecord, rating: number): Promise<boolean> {
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{key: record.query_id, value: JSON.stringify(buildEvent(record, rating))}],
      acks: 1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    console.warn(\`feedback for \${record.query_id} not delivered: \${(err as Error).message}\`);
    return false;
  }
}

/** Fold every feedback event into its workspace's counters. */
export async function runEval(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(String(message.value)) as {workspace: string; rating: number};
      const key = \`eval:\${event.workspace}\`;
      await redis.hincrby(key, 'queries', 1);
      await redis.hincrby(key, 'rating_sum', event.rating);
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {TOPIC} from 'querygen/config';
import type {QueryRecord} from 'querygen/queries';

export const GROUP = 'eval';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'querygen', brokers: ['kafka:9092']});
// Idempotent: a retry after a lost acknowledgement lands once (and needs acks: -1, every replica).
const producer = kafka.producer({idempotent: true});
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

interface FeedbackEvent {
  query_id: string;
  user: string;
  workspace: string;
  rating: number;
  tables_proposed: string[];
  tables_acked: string[];
  run_ok: boolean;
  has_output: boolean;
}

/** The feedback event for a rated query: the rating and the signals that explain it. */
export function buildEvent(record: QueryRecord, rating: number): FeedbackEvent {
  return {
    query_id: record.query_id,
    user: record.user,
    workspace: record.workspace,
    rating,
    tables_proposed: record.tables_proposed,
    tables_acked: record.tables_acked,
    run_ok: record.run_ok,
    has_output: record.has_output,
  };
}

/** One event on query.feedback, keyed by user so one user's feedback stays in order; true once acknowledged. */
export async function publishFeedback(record: QueryRecord, rating: number): Promise<boolean> {
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{key: record.user, value: JSON.stringify(buildEvent(record, rating))}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    console.warn(\`feedback for \${record.query_id} not delivered: \${(err as Error).message}\`);
    return false;
  }
}

/** How much of what the user ACKed the table agent had proposed: |proposed ∩ acked| / |acked|. */
export function tableOverlap(proposed: string[], acked: string[]): number {
  const ackedSet = new Set(acked);
  if (ackedSet.size === 0) return 0;
  return new Set(proposed.filter(t => ackedSet.has(t))).size / ackedSet.size;
}

/** Fold every feedback event into its workspace's counters, then commit. */
export async function runEval(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(String(message.value)) as FeedbackEvent;
      const key = \`eval:\${event.workspace}\`;
      await redis.hincrby(key, 'queries', 1);
      await redis.hincrby(key, 'run_ok', event.run_ok ? 1 : 0);
      await redis.hincrby(key, 'has_output', event.has_output ? 1 : 0);
      await redis.hincrby(key, 'rating_sum', event.rating);
      await redis.hincrby(key, 'overlap_milli', Math.round(1000 * tableOverlap(event.tables_proposed, event.tables_acked)));
      // After the writes: a crash before this line replays the record instead of losing it.
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
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"

	"querygen/config"  // config.Topic — provided
	"querygen/queries" // queries.Record — provided
)

const (
	group      = "eval"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// buildEvent is the feedback event for a rated query.
func buildEvent(rec queries.Record, rating int) map[string]any {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	return map[string]any{"query_id": rec.QueryID, "user": rec.User, "workspace": rec.Workspace, "rating": rating}
}

// publishFeedback puts one event on query.feedback; true once the broker acknowledged it.
func publishFeedback(ctx context.Context, rec queries.Record, rating int) bool {
	value, _ := json.Marshal(buildEvent(rec, rating))
	t := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(rec.QueryID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error // the delivery report: acknowledged or refused
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded
		}
	}
	if err != nil {
		log.Printf("feedback for %s not delivered: %v", rec.QueryID, err)
		return false
	}
	return true
}

// runEval folds every feedback event into its workspace's counters.
func runEval(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": group, "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		return err
	}
	if err := consumer.SubscribeTopics([]string{config.Topic}, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
		var event struct {
			Workspace string \`json:"workspace"\`
			Rating    int64  \`json:"rating"\`
		}
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		key := "eval:" + event.Workspace
		rdb.HIncrBy(ctx, key, "queries", 1)
		rdb.HIncrBy(ctx, key, "rating_sum", event.Rating)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"

	"querygen/config"  // config.Topic — provided
	"querygen/queries" // queries.Record — provided
)

const (
	group      = "eval"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// feedbackEvent is the rating and the signals that explain it.
type feedbackEvent struct {
	QueryID        string   \`json:"query_id"\`
	User           string   \`json:"user"\`
	Workspace      string   \`json:"workspace"\`
	Rating         int64    \`json:"rating"\`
	TablesProposed []string \`json:"tables_proposed"\`
	TablesAcked    []string \`json:"tables_acked"\`
	RunOK          bool     \`json:"run_ok"\`
	HasOutput      bool     \`json:"has_output"\`
}

// buildEvent is the feedback event for a rated query: the rating and the signals that explain it.
func buildEvent(rec queries.Record, rating int) map[string]any {
	return map[string]any{
		"query_id":        rec.QueryID,
		"user":            rec.User,
		"workspace":       rec.Workspace,
		"rating":          rating,
		"tables_proposed": rec.TablesProposed,
		"tables_acked":    rec.TablesAcked,
		"run_ok":          rec.RunOK,
		"has_output":      rec.HasOutput,
	}
}

// publishFeedback puts one event on query.feedback, keyed by user so one user's feedback stays in
// order; true once the broker acknowledged it.
func publishFeedback(ctx context.Context, rec queries.Record, rating int) bool {
	value, _ := json.Marshal(buildEvent(rec, rating))
	t := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(rec.User), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error // the delivery report: acknowledged or refused
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded
		}
	}
	if err != nil {
		log.Printf("feedback for %s not delivered: %v", rec.QueryID, err)
		return false
	}
	return true
}

// tableOverlap is how much of what the user ACKed the table agent had proposed: |proposed ∩ acked| / |acked|.
func tableOverlap(proposed, acked []string) float64 {
	ackedSet := map[string]bool{}
	for _, t := range acked {
		ackedSet[t] = true
	}
	if len(ackedSet) == 0 {
		return 0
	}
	both := map[string]bool{}
	for _, t := range proposed {
		if ackedSet[t] {
			both[t] = true
		}
	}
	return float64(len(both)) / float64(len(ackedSet))
}

func flag(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// runEval folds every feedback event into its workspace's counters, then commits.
func runEval(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": group, "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		return err
	}
	if err := consumer.SubscribeTopics([]string{config.Topic}, nil); err != nil {
		return err
	}
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		var event feedbackEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			consumer.CommitMessage(msg) // malformed: skip it, do not replay it for ever
			continue
		}
		key := "eval:" + event.Workspace
		rdb.HIncrBy(ctx, key, "queries", 1)
		rdb.HIncrBy(ctx, key, "run_ok", flag(event.RunOK))
		rdb.HIncrBy(ctx, key, "has_output", flag(event.HasOutput))
		rdb.HIncrBy(ctx, key, "rating_sum", event.Rating)
		rdb.HIncrBy(ctx, key, "overlap_milli", int64(math.Round(1000*tableOverlap(event.TablesProposed, event.TablesAcked))))
		// After the writes: a crash before this line replays the record instead of losing it.
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import scala.concurrent.duration._
import scala.concurrent.{Await, Promise}
import scala.jdk.CollectionConverters._

import querygen.{Config, QueryRecord}

object Feedback {
  val Group = "eval"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }
  private val jedis = new JedisPooled("redis", 6379)

  /** The feedback event for a rated query. */
  def buildEvent(record: QueryRecord, rating: Int): ujson.Obj =
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    ujson.Obj("query_id" -> record.query_id, "user" -> record.user, "workspace" -> record.workspace, "rating" -> rating)

  /** One event on query.feedback; true once the broker acknowledged it. */
  def publishFeedback(record: QueryRecord, rating: Int): Boolean = {
    val delivered = Promise[Boolean]()
    val report: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit = {
        if (exception != null) System.err.println(s"feedback for \${record.query_id} not delivered: \${exception.getMessage}")
        delivered.trySuccess(exception == null)
      }
    }
    producer.send(new ProducerRecord[String, String](Config.Topic, record.query_id, ujson.write(buildEvent(record, rating))), report)
    producer.flush()
    Await.result(delivered.future, 2.seconds)
  }

  /** Fold every feedback event into its workspace's counters. */
  def runEval(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.Topic).asJava)
    while (true)
      consumer.poll(java.time.Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
        val event = ujson.read(record.value())
        val key = s"eval:\${event("workspace").str}"
        jedis.hincrBy(key, "queries", 1L)
        jedis.hincrBy(key, "rating_sum", event("rating").num.toLong)
      }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import scala.concurrent.duration._
import scala.concurrent.{Await, Promise}
import scala.jdk.CollectionConverters._

import querygen.{Config, QueryRecord}

object Feedback {
  val Group = "eval"

  // Idempotent with acks=all: a retry after a lost acknowledgement lands once, on every replica.
  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all")
    props.put("enable.idempotence", "true")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }
  private val jedis = new JedisPooled("redis", 6379)

  private def strings(values: List[String]): ujson.Arr = ujson.Arr.from(values.map(ujson.Str(_)))

  /** The feedback event for a rated query: the rating and the signals that explain it. */
  def buildEvent(record: QueryRecord, rating: Int): ujson.Obj = ujson.Obj(
    "query_id" -> record.query_id,
    "user" -> record.user,
    "workspace" -> record.workspace,
    "rating" -> rating,
    "tables_proposed" -> strings(record.tables_proposed),
    "tables_acked" -> strings(record.tables_acked),
    "run_ok" -> record.run_ok,
    "has_output" -> record.has_output
  )

  /** One event on query.feedback, keyed by user so one user's feedback stays in order; true once acknowledged. */
  def publishFeedback(record: QueryRecord, rating: Int): Boolean = {
    val delivered = Promise[Boolean]()
    val report: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit = {
        if (exception != null) System.err.println(s"feedback for \${record.query_id} not delivered: \${exception.getMessage}")
        delivered.trySuccess(exception == null)
      }
    }
    producer.send(new ProducerRecord[String, String](Config.Topic, record.user, ujson.write(buildEvent(record, rating))), report)
    producer.flush()
    Await.result(delivered.future, 2.seconds)
  }

  /** How much of what the user ACKed the table agent had proposed: |proposed ∩ acked| / |acked|. */
  def tableOverlap(proposed: Seq[String], acked: Seq[String]): Double = {
    val ackedSet = acked.toSet
    if (ackedSet.isEmpty) 0.0 else (proposed.toSet & ackedSet).size.toDouble / ackedSet.size
  }

  /** Fold every feedback event into its workspace's counters, then commit. */
  def runEval(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.Topic).asJava)
    while (true)
      consumer.poll(java.time.Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = ujson.read(record.value())
        val key = s"eval:\${event("workspace").str}"
        val overlap = tableOverlap(event("tables_proposed").arr.map(_.str).toList, event("tables_acked").arr.map(_.str).toList)
        jedis.hincrBy(key, "queries", 1L)
        jedis.hincrBy(key, "run_ok", if (event("run_ok").bool) 1L else 0L)
        jedis.hincrBy(key, "has_output", if (event("has_output").bool) 1L else 0L)
        jedis.hincrBy(key, "rating_sum", event("rating").num.toLong)
        jedis.hincrBy(key, "overlap_milli", math.round(1000 * overlap))
        // After the writes: a crash before this line replays the record instead of losing it.
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
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
#include <memory>
#include <string>

#include "querygen/config.h"  // config::kTopic — provided

using json = nlohmann::json;

const std::string kGroup = "eval";
constexpr int kAckTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report: whether the broker acknowledged the last record.
class Deliveries : public RdKafka::DeliveryReportCb {
 public:
  bool delivered = false;
  void dr_cb(RdKafka::Message& message) override {
    delivered = message.err() == RdKafka::ERR_NO_ERROR;
    if (!delivered) std::cerr << "feedback not delivered: " << message.errstr() << "\\n";
  }
};

Deliveries deliveries;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &deliveries, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// The feedback event for a rated query.
json build_event(const json& record, int rating) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  return json{{"query_id", record["query_id"]}, {"user", record["user"]}, {"workspace", record["workspace"]}, {"rating", rating}};
}

// One event on query.feedback; true once the broker acknowledged it.
bool publish_feedback(const json& record, int rating) {
  const std::string value = build_event(record, rating).dump();
  const std::string key = record.value("query_id", "");
  deliveries.delivered = false;
  const RdKafka::ErrorCode queued =
      producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), key.c_str(), key.size(), 0, nullptr);
  if (queued != RdKafka::ERR_NO_ERROR) return false;
  producer->flush(kAckTimeoutMs);  // the delivery report fires here, delivered or refused
  return deliveries.delivered;
}

// Fold every feedback event into its workspace's counters.
void run_eval() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) continue;
    const std::string key = "eval:" + event.value("workspace", "");
    redis.hincrby(key, "queries", 1);
    redis.hincrby(key, "rating_sum", event.value("rating", 0));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <cmath>
#include <iostream>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "querygen/config.h"  // config::kTopic — provided

using json = nlohmann::json;

const std::string kGroup = "eval";
constexpr int kAckTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report: whether the broker acknowledged the last record.
class Deliveries : public RdKafka::DeliveryReportCb {
 public:
  bool delivered = false;
  void dr_cb(RdKafka::Message& message) override {
    delivered = message.err() == RdKafka::ERR_NO_ERROR;
    if (!delivered) std::cerr << "feedback not delivered: " << message.errstr() << "\\n";
  }
};

Deliveries deliveries;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                 // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &deliveries, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// The feedback event for a rated query: the rating and the signals that explain it.
json build_event(const json& record, int rating) {
  return json{{"query_id", record["query_id"]},
              {"user", record["user"]},
              {"workspace", record["workspace"]},
              {"rating", rating},
              {"tables_proposed", record["tables_proposed"]},
              {"tables_acked", record["tables_acked"]},
              {"run_ok", record["run_ok"]},
              {"has_output", record["has_output"]}};
}

// One event on query.feedback, keyed by user so one user's feedback stays in order; true once acknowledged.
bool publish_feedback(const json& record, int rating) {
  const std::string value = build_event(record, rating).dump();
  const std::string user = record.value("user", "");
  deliveries.delivered = false;
  const RdKafka::ErrorCode queued =
      producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), user.c_str(), user.size(), 0, nullptr);
  if (queued != RdKafka::ERR_NO_ERROR) return false;
  producer->flush(kAckTimeoutMs);  // the delivery report fires here, delivered or refused
  return deliveries.delivered;
}

// How much of what the user ACKed the table agent had proposed: |proposed ∩ acked| / |acked|.
double table_overlap(const std::vector<std::string>& proposed, const std::vector<std::string>& acked) {
  const std::set<std::string> acked_set(acked.begin(), acked.end());
  if (acked_set.empty()) return 0;
  std::set<std::string> both;
  for (const auto& t : proposed)
    if (acked_set.count(t) > 0) both.insert(t);
  return static_cast<double>(both.size()) / static_cast<double>(acked_set.size());
}

// Fold every feedback event into its workspace's counters, then commit.
void run_eval() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) {
      consumer->commitSync(msg.get());  // malformed: skip it, do not replay it for ever
      continue;
    }
    const std::string key = "eval:" + event.value("workspace", "");
    const double overlap = table_overlap(event.value("tables_proposed", std::vector<std::string>{}), event.value("tables_acked", std::vector<std::string>{}));
    redis.hincrby(key, "queries", 1);
    redis.hincrby(key, "run_ok", event.value("run_ok", false) ? 1 : 0);
    redis.hincrby(key, "has_output", event.value("has_output", false) ? 1 : 0);
    redis.hincrby(key, "rating_sum", event.value("rating", 0));
    redis.hincrby(key, "overlap_milli", std::llround(1000 * overlap));
    // After the writes: a crash before this line replays the record instead of losing it.
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "query.feedback"
SIGNALS = ["has_output", "query_id", "rating", "run_ok", "tables_acked", "tables_proposed", "user", "workspace"]


def _record(query_id="q1", user="ana", workspace="mobility", proposed=("trips", "drivers"), acked=("trips",), run_ok=True, has_output=True):
    return {
        "query_id": query_id, "user": user, "workspace": workspace, "question": "How many trips yesterday?", "status": "ran",
        "tables_proposed": list(proposed), "tables_acked": list(acked), "sql": "SELECT 1", "run_ok": run_ok, "has_output": has_output,
    }


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _seed_events(ctx):
    events = [
        dict(query_id="q1", user="ana", workspace="mobility", rating=5, tables_proposed=["trips", "drivers"], tables_acked=["trips"], run_ok=True, has_output=True),
        dict(query_id="q2", user="ben", workspace="mobility", rating=2, tables_proposed=["trips"], tables_acked=["trips", "cities"], run_ok=True, has_output=False),
        dict(query_id="q3", user="ana", workspace="mobility", rating=1, tables_proposed=["trips"], tables_acked=["trips"], run_ok=False, has_output=False),
        dict(query_id="q4", user="cy", workspace="ads", rating=4, tables_proposed=["ad_campaigns"], tables_acked=["ad_campaigns"], run_ok=True, has_output=True),
    ]
    for event in events:
        ctx.kafka.seed(TOPIC, key=event["user"], value=json.dumps(event))


def _counters(ctx, workspace="mobility"):
    return {k: int(v) for k, v in ctx.redis.hgetall(f"eval:{workspace}").items()}


def check_user_key(ctx):
    m = ctx.load("feedback")
    for query_id, user in (("q1", "ana"), ("q2", "ben"), ("q3", "ana")):
        assert m.publish_feedback(_record(query_id, user), 4) is True, f"publish_feedback for {query_id} must return True once the broker acknowledged it"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three ratings produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"ana", b"ben", b"ana"], f"records must be keyed by the user, got {keys}"
    assert records[0].partition == records[2].partition, "one user's feedback must land on one partition so it stays in order"


def check_signals(ctx):
    m = ctx.load("feedback")
    record = _record("q9", "ana", proposed=("trips", "drivers"), acked=("trips",), run_ok=True, has_output=False)
    assert m.publish_feedback(record, 2) is True, "publish_feedback must return True once the broker acknowledged it"
    events = _events(ctx)
    assert len(events) == 1, f"one rating produced {len(events)} events"
    event = events[0]
    assert sorted(event) == SIGNALS, f"the event must carry exactly {SIGNALS}, it carries {sorted(event)}"
    assert event["tables_proposed"] == ["trips", "drivers"] and event["tables_acked"] == ["trips"], f"the table lists come from the record: {event}"
    assert event["run_ok"] is True and event["has_output"] is False and event["rating"] == 2, f"run_ok, has_output and rating come from the record and the call: {event}"


def check_idempotent_acks(ctx):
    m = ctx.load("feedback")
    ctx.kafka.lose_acks(TOPIC, 1)
    assert m.publish_feedback(_record("q1"), 5) is True, "a lost acknowledgement is retried by the client, not reported: publish_feedback must return True"
    ids = [e["query_id"] for e in _events(ctx)]
    assert ids == ["q1"], f"after one lost acknowledgement the topic holds {ids}: the retry wrote the rating twice (enable idempotence)"
    m.publish_feedback(_record("q2"), 3)
    ctx.kafka.failover(TOPIC)
    ids = [e["query_id"] for e in _events(ctx)]
    assert "q2" in ids, f"a leader failover right after the acknowledgement lost the rating, the topic holds {ids}: wait for all in-sync replicas (acks=all)"


def check_eval_counters(ctx):
    _seed_events(ctx)
    m = ctx.load("feedback")
    ctx.drain(m.run_eval)
    counters = _counters(ctx)
    expected = {"queries": 3, "run_ok": 2, "has_output": 1, "rating_sum": 8, "overlap_milli": 2500}
    assert counters == expected, f"eval:mobility is {counters}, expected {expected} (overlaps 1, 0.5 and 1)"
    assert _counters(ctx, "ads").get("queries") == 1, f"the Ads event counts in eval:ads, which is {_counters(ctx, 'ads')}"


def check_write_before_commit(ctx):
    _seed_events(ctx)
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(sum(_counters(ctx, w).get("queries", 0) for w in ("mobility", "ads"))))
    m = ctx.load("feedback")
    ctx.drain(m.run_eval)
    assert at_commit, "the consumer never committed an offset"
    assert at_commit == [1, 2, 3, 4], f"queries counted at each commit: {at_commit}, expected [1, 2, 3, 4]: write the counters before the commit, or a crash in between loses the rating"
    assert ctx.kafka.lag("eval", TOPIC) == 0, f"the consumer left {ctx.kafka.lag('eval', TOPIC)} record(s) uncommitted"
`,
    typescript: `const TOPIC = 'query.feedback';
const SIGNALS = ['has_output', 'query_id', 'rating', 'run_ok', 'tables_acked', 'tables_proposed', 'user', 'workspace'];

function record(queryId = 'q1', user = 'ana', {workspace = 'mobility', proposed = ['trips', 'drivers'], acked = ['trips'], runOk = true, hasOutput = true} = {}) {
  return {
    query_id: queryId, user, workspace, question: 'How many trips yesterday?', status: 'ran',
    tables_proposed: proposed, tables_acked: acked, sql: 'SELECT 1', run_ok: runOk, has_output: hasOutput,
  };
}

const events = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));

function seedEvents(ctx) {
  const all = [
    {query_id: 'q1', user: 'ana', workspace: 'mobility', rating: 5, tables_proposed: ['trips', 'drivers'], tables_acked: ['trips'], run_ok: true, has_output: true},
    {query_id: 'q2', user: 'ben', workspace: 'mobility', rating: 2, tables_proposed: ['trips'], tables_acked: ['trips', 'cities'], run_ok: true, has_output: false},
    {query_id: 'q3', user: 'ana', workspace: 'mobility', rating: 1, tables_proposed: ['trips'], tables_acked: ['trips'], run_ok: false, has_output: false},
    {query_id: 'q4', user: 'cy', workspace: 'ads', rating: 4, tables_proposed: ['ad_campaigns'], tables_acked: ['ad_campaigns'], run_ok: true, has_output: true},
  ];
  for (const event of all) ctx.kafka.seed(TOPIC, {key: event.user, value: JSON.stringify(event)});
}

const counters = (ctx, workspace = 'mobility'): Record<string, number> =>
  Object.fromEntries(Object.entries(ctx.redis.hgetall(\`eval:\${workspace}\`) as Record<string, string>).map(([k, v]) => [k, Number(v)]));

export async function check_user_key(ctx) {
  const m = ctx.load('feedback');
  for (const [queryId, user] of [['q1', 'ana'], ['q2', 'ben'], ['q3', 'ana']]) {
    assert.equal(await m.publishFeedback(record(queryId, user), 4), true, \`publishFeedback for \${queryId} must resolve true once the broker acknowledged it\`);
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three ratings produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['ana', 'ben', 'ana'], \`records must be keyed by the user, got \${JSON.stringify(keys)}\`);
  assert.equal(records[0].partition, records[2].partition, "one user's feedback must land on one partition so it stays in order");
}

export async function check_signals(ctx) {
  const m = ctx.load('feedback');
  assert.equal(await m.publishFeedback(record('q9', 'ana', {hasOutput: false}), 2), true, 'publishFeedback must resolve true once the broker acknowledged it');
  const all = events(ctx);
  assert.equal(all.length, 1, \`one rating produced \${all.length} events\`);
  const event = all[0];
  assert.deepStrictEqual(Object.keys(event).sort(), SIGNALS, \`the event must carry exactly \${SIGNALS.join(', ')}, it carries \${Object.keys(event).sort().join(', ')}\`);
  assert(JSON.stringify(event.tables_proposed) === '["trips","drivers"]' && JSON.stringify(event.tables_acked) === '["trips"]', \`the table lists come from the record: \${JSON.stringify(event)}\`);
  assert(event.run_ok === true && event.has_output === false && event.rating === 2, \`run_ok, has_output and rating come from the record and the call: \${JSON.stringify(event)}\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('feedback');
  ctx.kafka.loseAcks(TOPIC, 1);
  assert.equal(await m.publishFeedback(record('q1'), 5), true, 'a lost acknowledgement is retried by the client, not reported: publishFeedback must resolve true');
  let ids = events(ctx).map(e => e.query_id);
  assert.deepStrictEqual(ids, ['q1'], \`after one lost acknowledgement the topic holds \${JSON.stringify(ids)}: the retry wrote the rating twice (idempotent: true)\`);
  await m.publishFeedback(record('q2'), 3);
  ctx.kafka.failover(TOPIC);
  ids = events(ctx).map(e => e.query_id);
  assert(ids.includes('q2'), \`a leader failover right after the acknowledgement lost the rating, the topic holds \${JSON.stringify(ids)}: wait for all in-sync replicas (acks: -1)\`);
}

export async function check_eval_counters(ctx) {
  seedEvents(ctx);
  const m = ctx.load('feedback');
  await ctx.drain(m.runEval());
  const expected = {queries: 3, run_ok: 2, has_output: 1, rating_sum: 8, overlap_milli: 2500};
  const got = counters(ctx);
  const sorted = (o: Record<string, number>) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
  assert.equal(sorted(got), sorted(expected), \`eval:mobility is \${JSON.stringify(got)}, expected \${JSON.stringify(expected)} (overlaps 1, 0.5 and 1)\`);
  assert.equal(counters(ctx, 'ads').queries, 1, \`the Ads event counts in eval:ads, which is \${JSON.stringify(counters(ctx, 'ads'))}\`);
}

export async function check_write_before_commit(ctx) {
  seedEvents(ctx);
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push((counters(ctx).queries ?? 0) + (counters(ctx, 'ads').queries ?? 0)));
  const m = ctx.load('feedback');
  await ctx.drain(m.runEval());
  assert(atCommit.length > 0, 'the consumer never committed an offset');
  assert.deepStrictEqual(atCommit, [1, 2, 3, 4], \`queries counted at each commit: \${JSON.stringify(atCommit)}, expected [1,2,3,4]: write the counters before the commit, or a crash in between loses the rating\`);
  assert.equal(ctx.kafka.lag('eval', TOPIC), 0, \`the consumer left \${ctx.kafka.lag('eval', TOPIC)} record(s) uncommitted\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"

	"querygen/queries"

	"leetbuild/harness"
)

const feedbackTopic = "query.feedback"

var feedbackSignals = []string{"has_output", "query_id", "rating", "run_ok", "tables_acked", "tables_proposed", "user", "workspace"}

func feedbackRecord(id, user string, hasOutput bool) queries.Record {
	return queries.Record{QueryID: id, User: user, Workspace: "mobility", Question: "How many trips yesterday?", Status: "ran", TablesProposed: []string{"trips", "drivers"}, TablesAcked: []string{"trips"}, SQL: "SELECT 1", RunOK: true, HasOutput: hasOutput}
}

func feedbackEvents(ctx *harness.Ctx) []map[string]any {
	var events []map[string]any
	for _, r := range ctx.Kafka.Records(feedbackTopic) {
		var event map[string]any
		json.Unmarshal(r.Value, &event)
		events = append(events, event)
	}
	return events
}

func feedbackSeed(ctx *harness.Ctx) {
	events := []map[string]any{
		{"query_id": "q1", "user": "ana", "workspace": "mobility", "rating": 5, "tables_proposed": []string{"trips", "drivers"}, "tables_acked": []string{"trips"}, "run_ok": true, "has_output": true},
		{"query_id": "q2", "user": "ben", "workspace": "mobility", "rating": 2, "tables_proposed": []string{"trips"}, "tables_acked": []string{"trips", "cities"}, "run_ok": true, "has_output": false},
		{"query_id": "q3", "user": "ana", "workspace": "mobility", "rating": 1, "tables_proposed": []string{"trips"}, "tables_acked": []string{"trips"}, "run_ok": false, "has_output": false},
		{"query_id": "q4", "user": "cy", "workspace": "ads", "rating": 4, "tables_proposed": []string{"ad_campaigns"}, "tables_acked": []string{"ad_campaigns"}, "run_ok": true, "has_output": true},
	}
	for _, event := range events {
		raw, _ := json.Marshal(event)
		ctx.Kafka.Seed(feedbackTopic, event["user"], string(raw))
	}
}

func feedbackCounters(ctx *harness.Ctx, workspace string) map[string]int64 {
	out := map[string]int64{}
	for k, v := range ctx.Redis.HGetAll("eval:" + workspace) {
		n, _ := strconv.ParseInt(v, 10, 64)
		out[k] = n
	}
	return out
}

func CheckUserKey(ctx *harness.Ctx) {
	for _, r := range [][2]string{{"q1", "ana"}, {"q2", "ben"}, {"q3", "ana"}} {
		ctx.Equal(publishFeedback(context.Background(), feedbackRecord(r[0], r[1], true), 4), true, "publishFeedback for %s once the broker acknowledged it", r[0])
	}
	ctx.Settle()
	records := ctx.Kafka.Records(feedbackTopic)
	ctx.Equal(len(records), 3, "three ratings; records on %s", feedbackTopic)
	keys := ctx.Kafka.Keys(feedbackTopic)
	sort.Strings(keys)
	ctx.Equal(keys, []string{"ana", "ana", "ben"}, "records must be keyed by the user")
	var ana []int
	for _, r := range records {
		if string(r.Key) == "ana" {
			ana = append(ana, r.Partition)
		}
	}
	ctx.Assert(len(ana) == 2 && ana[0] == ana[1], "one user's feedback must land on one partition so it stays in order; ana's partitions %v", ana)
}

func CheckSignals(ctx *harness.Ctx) {
	ctx.Equal(publishFeedback(context.Background(), feedbackRecord("q9", "ana", false), 2), true, "publishFeedback once the broker acknowledged it")
	ctx.Settle()
	events := feedbackEvents(ctx)
	ctx.Equal(len(events), 1, "one rating; events")
	var fields []string
	for k := range events[0] {
		fields = append(fields, k)
	}
	sort.Strings(fields)
	ctx.Equal(fields, feedbackSignals, "the event's fields")
	event := events[0]
	ctx.Equal(event["tables_proposed"], []any{"trips", "drivers"}, "tables_proposed comes from the record")
	ctx.Equal(event["tables_acked"], []any{"trips"}, "tables_acked comes from the record")
	ctx.Assert(event["run_ok"] == true && event["has_output"] == false && event["rating"] == float64(2), "run_ok, has_output and rating come from the record and the call: %v", event)
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(feedbackTopic, 1)
	ctx.Equal(publishFeedback(context.Background(), feedbackRecord("q1", "ana", true), 5), true, "a lost acknowledgement is retried by the client, not reported; publishFeedback")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(feedbackTopic)), 1, "after one lost acknowledgement the retry wrote the rating twice (enable.idempotence); the records")
	publishFeedback(context.Background(), feedbackRecord("q2", "ana", true), 3)
	ctx.Settle()
	ctx.Kafka.Failover(feedbackTopic)
	ctx.Equal(len(ctx.Kafka.Records(feedbackTopic)), 2, "after a leader failover both ratings must still be on the topic (acks=all); the records")
}

func CheckEvalCounters(ctx *harness.Ctx) {
	feedbackSeed(ctx)
	ctx.Drain(func() { runEval(context.Background()) })
	ctx.Equal(feedbackCounters(ctx, "mobility"), map[string]int64{"queries": 3, "run_ok": 2, "has_output": 1, "rating_sum": 8, "overlap_milli": 2500}, "eval:mobility (overlaps 1, 0.5 and 1)")
	ctx.Equal(feedbackCounters(ctx, "ads")["queries"], int64(1), "the Ads event counts in eval:ads; queries")
}

func CheckWriteBeforeCommit(ctx *harness.Ctx) {
	feedbackSeed(ctx)
	var atCommit []int64
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		atCommit = append(atCommit, feedbackCounters(ctx, "mobility")["queries"]+feedbackCounters(ctx, "ads")["queries"])
	})
	ctx.Drain(func() { runEval(context.Background()) })
	ctx.Assert(len(atCommit) > 0, "the consumer never committed an offset")
	ctx.Equal(atCommit, []int64{1, 2, 3, 4}, "queries counted at each commit (write the counters before the commit, or a crash in between loses the rating)")
	ctx.Equal(ctx.Kafka.Lag("eval", feedbackTopic), int64(0), "records the consumer left uncommitted")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const std::string kFeedbackTopic = "query.feedback";

json feedbackRecord(const std::string& id, const std::string& user, bool has_output = true) {
  return {{"query_id", id}, {"user", user}, {"workspace", "mobility"}, {"question", "How many trips yesterday?"}, {"status", "ran"},
          {"tables_proposed", {"trips", "drivers"}}, {"tables_acked", {"trips"}}, {"sql", "SELECT 1"}, {"run_ok", true}, {"has_output", has_output}};
}

std::vector<json> feedbackEvents(harness::Ctx& ctx) {
  std::vector<json> events;
  for (const auto& r : ctx.Kafka.Records(kFeedbackTopic)) events.push_back(json::parse(r.Value.value_or(""), nullptr, false));
  return events;
}

void feedbackSeed(harness::Ctx& ctx) {
  const std::vector<json> events = {
      {{"query_id", "q1"}, {"user", "ana"}, {"workspace", "mobility"}, {"rating", 5}, {"tables_proposed", {"trips", "drivers"}}, {"tables_acked", {"trips"}}, {"run_ok", true}, {"has_output", true}},
      {{"query_id", "q2"}, {"user", "ben"}, {"workspace", "mobility"}, {"rating", 2}, {"tables_proposed", {"trips"}}, {"tables_acked", {"trips", "cities"}}, {"run_ok", true}, {"has_output", false}},
      {{"query_id", "q3"}, {"user", "ana"}, {"workspace", "mobility"}, {"rating", 1}, {"tables_proposed", {"trips"}}, {"tables_acked", {"trips"}}, {"run_ok", false}, {"has_output", false}},
      {{"query_id", "q4"}, {"user", "cy"}, {"workspace", "ads"}, {"rating", 4}, {"tables_proposed", {"ad_campaigns"}}, {"tables_acked", {"ad_campaigns"}}, {"run_ok", true}, {"has_output", true}},
  };
  for (const auto& event : events) ctx.Kafka.Seed(kFeedbackTopic, event["user"].get<std::string>(), event.dump());
}

std::map<std::string, long long> feedbackCounters(harness::Ctx& ctx, const std::string& workspace) {
  std::map<std::string, long long> out;
  for (const auto& [k, v] : ctx.Redis.HGetAll("eval:" + workspace)) out[k] = std::atoll(v.c_str());
  return out;
}

}  // namespace

void CheckUserKey(harness::Ctx& ctx) {
  for (const auto& [id, user] : std::vector<std::pair<std::string, std::string>>{{"q1", "ana"}, {"q2", "ben"}, {"q3", "ana"}}) {
    ctx.Equal(publish_feedback(feedbackRecord(id, user), 4), true, "publish_feedback for %s once the broker acknowledged it", id);
  }
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kFeedbackTopic);
  ctx.Equal(records.size(), 3, "three ratings; records on query.feedback");
  ctx.Equal(ctx.Kafka.Keys(kFeedbackTopic), {"ana", "ben", "ana"}, "records must be keyed by the user");
  ctx.Equal(records[0].Partition, records[2].Partition, "one user's feedback must land on one partition so it stays in order; ana's partitions");
}

void CheckSignals(harness::Ctx& ctx) {
  ctx.Equal(publish_feedback(feedbackRecord("q9", "ana", false), 2), true, "publish_feedback once the broker acknowledged it");
  ctx.Settle();
  const auto events = feedbackEvents(ctx);
  ctx.Equal(events.size(), 1, "one rating; events");
  const json& event = events[0];
  std::vector<std::string> fields;
  if (event.is_object())
    for (const auto& item : event.items()) fields.push_back(item.key());
  std::sort(fields.begin(), fields.end());
  ctx.Equal(fields, std::vector<std::string>{"has_output", "query_id", "rating", "run_ok", "tables_acked", "tables_proposed", "user", "workspace"}, "the event's fields");
  ctx.Assert(event["tables_proposed"] == json({"trips", "drivers"}) && event["tables_acked"] == json({"trips"}), "the table lists come from the record: %s", event.dump());
  ctx.Assert(event["run_ok"] == true && event["has_output"] == false && event["rating"] == 2, "run_ok, has_output and rating come from the record and the call: %s", event.dump());
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kFeedbackTopic, 1);
  ctx.Equal(publish_feedback(feedbackRecord("q1", "ana"), 5), true, "a lost acknowledgement is retried by the client, not reported; publish_feedback");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kFeedbackTopic).size(), 1, "after one lost acknowledgement the retry wrote the rating twice (enable.idempotence); the records");
  publish_feedback(feedbackRecord("q2", "ana"), 3);
  ctx.Settle();
  ctx.Kafka.Failover(kFeedbackTopic);
  ctx.Equal(ctx.Kafka.Records(kFeedbackTopic).size(), 2, "after a leader failover both ratings must still be on the topic (acks=all); the records");
}

void CheckEvalCounters(harness::Ctx& ctx) {
  feedbackSeed(ctx);
  ctx.Drain([] { run_eval(); });
  const std::map<std::string, long long> expected = {{"queries", 3}, {"run_ok", 2}, {"has_output", 1}, {"rating_sum", 8}, {"overlap_milli", 2500}};
  ctx.Equal(feedbackCounters(ctx, "mobility"), expected, "eval:mobility (overlaps 1, 0.5 and 1)");
  ctx.Equal(feedbackCounters(ctx, "ads")["queries"], 1, "the Ads event counts in eval:ads; queries");
}

void CheckWriteBeforeCommit(harness::Ctx& ctx) {
  feedbackSeed(ctx);
  auto atCommit = std::make_shared<std::vector<long long>>();
  ctx.Kafka.OnCommit([&ctx, atCommit](const std::string&, const harness::KafkaOffsets&) {
    atCommit->push_back(feedbackCounters(ctx, "mobility")["queries"] + feedbackCounters(ctx, "ads")["queries"]);
  });
  ctx.Drain([] { run_eval(); });
  ctx.Assert(!atCommit->empty(), "the consumer never committed an offset");
  ctx.Equal(*atCommit, std::vector<long long>{1, 2, 3, 4}, "queries counted at each commit (write the counters before the commit, or a crash in between loses the rating)");
  ctx.Equal(ctx.Kafka.Lag("eval", kFeedbackTopic), 0, "records the consumer left uncommitted");
}
`,
  },
  hints: [
    "Symptom: one user's ratings arrive out of order, the dashboard cannot say whether a bad rating came from the tables or an empty result, a broker hiccup counts one query twice, and a consumer restart loses a rating.",
    'Mechanism: the key is the query id; `build_event` copies four fields; the producer has `acks=1` and no idempotence, so a lost acknowledgement is rewritten; `run_eval` commits before its `HINCRBY`s and never computes the overlap.',
    'Change: `key=record["user"]`; copy `tables_proposed`, `tables_acked`, `run_ok`, `has_output`; `enable.idempotence` + `acks=all`; in `run_eval`, HINCRBY `queries`, `run_ok`, `has_output`, `rating_sum`, `overlap_milli = round(1000 * table_overlap(...))`, then commit.',
  ],
  debrief: `A rating alone says a user was unhappy; the signals say why. Table overlap measures the table agent against what the user ACKed, \`run_ok\` and \`has_output\` separate SQL that failed from SQL that ran and found nothing, and together they point at the agent to fix, the split QueryGPT's evaluation draws. Keying by user keeps one user's feedback in order; idempotence with \`acks=all\` makes a retry land once and a failover keep what was acknowledged; writing before the commit means a crash replays a rating rather than losing it. The replay can still count a rating twice; a consumer that remembers the query ids it has folded in, with a SET NX beside the counters, closes that gap.`,
};
