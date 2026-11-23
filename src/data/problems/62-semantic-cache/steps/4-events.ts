import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Result events keyed by tenant, with an outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['cache', 'kafka', 'stats', 'redis'],
  task: `## Task

**Starting point.** The starter is the result stream. \`publish_result(tenant, result)\` puts one
\`semantic-cache.result\` event per lookup on the topic, keyed by the similarity band, and copies the
served answer into it from the entry hash so dashboards can show examples; \`consume_results\` folds
events into \`stats:{tenant}:{model_version}\` with \`HINCRBY\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** The dashboard's hit rate for one tenant swings between 91% and
4% inside a minute: its hits and misses arrive through partitions that lag differently, so the two
counters describe different moments. Compliance finds cached answers in a retained topic. And a
produce the broker rejects is logged and forgotten, so a miss wave leaves no trace.

- The message key is the tenant: one tenant's events share a partition, so the counters read at
  one instant describe one prefix of its history.
- The payload is \`{outcome, entry_id, similarity, policy_version, model_version, client_class,
  entry_age_seconds}\` from the \`result\` the lookup passed, and nothing from the entry hash.
- The producer is idempotent with \`acks=all\` (kafka-go: \`RequireAll\` with a hash balancer; it has
  no idempotence setting).
- A rejected produce appends \`{"key", "payload"}\` to the Redis list \`outbox:semantic-cache.result\`,
  increments \`cache_result_produce_failures\`, then raises \`ProduceRejected\`: the lookup knows its
  outcome was not recorded, and a relay republishes the row.
- The consumer reads the tenant from the message key, updates \`hits_total\` or \`misses_total\`,
  \`similarity_sum\`, \`automated_total\` and \`automated_hits\` (\`client_class\` \`automated\`), and
  \`hits_older_than_1h\` (\`entry_age_seconds\` over \`HIT_FRESHNESS_SECONDS\` = 3600), then commits.`,
  sequence: {
    participants: ['Semantic Cache', 'semantic-cache.result', 'Redis', 'stats consumer'],
    messages: [
      {
        from: 'Semantic Cache',
        to: 'semantic-cache.result',
        label:
          'produce key=tenant · {outcome, entry_id, similarity, policy_version, model_version, client_class, entry_age_seconds}',
        kind: 'sync',
      },
      {from: 'semantic-cache.result', to: 'Semantic Cache', label: 'acks=all · delivered, or rejected', kind: 'reply'},
      {
        from: 'Semantic Cache',
        to: 'Redis',
        label: 'on rejection: RPUSH outbox:semantic-cache.result · INCR cache_result_produce_failures',
        kind: 'sync',
      },
      {from: 'Semantic Cache', to: 'Semantic Cache', label: 'raise ProduceRejected', kind: 'sync'},
      {
        from: 'semantic-cache.result',
        to: 'stats consumer',
        label: 'consume · group semantic-cache-stats',
        kind: 'async',
      },
      {
        from: 'stats consumer',
        to: 'Redis',
        label: 'HINCRBY stats:{tenant}:{model_version} · then commit',
        kind: 'sync',
      },
    ],
  },
  hints: [
    "One tenant's hit rate flickers inside a minute, its cached answers turn up in the topic, and the stats are missing the misses from the hour the broker was restarting.",
    'The key picks the partition, so a band key spreads one tenant over partitions the consumer drains at different speeds; the publisher reads the answer back from the entry hash; the delivery report is only logged, so a rejection changes nothing.',
    'Key by tenant, serialise only the seven result fields, configure `acks=all` with idempotence, and in the rejection branch RPUSH the outbox row, INCR `cache_result_produce_failures` and raise `ProduceRejected`.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Publishes semantic-cache.result keyed by tenant',
      detail:
        "One event per lookup, keyed by the tenant, so one tenant's hits and misses land on one partition and the consumer's two counters describe one prefix of its history. The consumer's counters are checked too: `automated_hits` counts only automated hits, and `hits_older_than_1h` only hits over 3600 s old. The starter keys by similarity band.",
      match: {
        python: {all: [/key\s*=\s*tenant(\.encode\([^)]*\))?\s*[,)]/]},
        typescript: {all: [/key:\s*tenant\b/]},
        go: {all: [/Key:\s*\[\]byte\(tenant\)/]},
        cpp: {all: [/tenant\.c_str\(\)\s*,\s*tenant\.(size|length)\(\)/]},
      },
    },
    {
      id: 'no-text',
      title: 'The payload carries the entry id, never the answer',
      detail:
        'The event is `{outcome, entry_id, similarity, policy_version, model_version, client_class, entry_age_seconds}`; the answer text stays in the store. The starter reads the answer from the entry hash and ships it in a retained, replicated topic.',
      match: {
        python: {all: [/entry_id/], none: [/\.hget\(/, /["']answer["']/]},
        typescript: {all: [/entry_id/], none: [/\.hget\(/, /\banswer\b/]},
        go: {all: [/entry_id/], none: [/\.HGet\(/, /"answer"/]},
        cpp: {all: [/entry_id/], none: [/\.hget\(/, /"answer"/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce leaves an outbox row',
      detail:
        'When the broker rejects the produce, `{"key", "payload"}` is appended to the Redis list `outbox:semantic-cache.result` so a relay can republish it; the payload is the event itself, with no answer text. The starter logs the delivery error and drops the event.',
      match: {
        python: {all: [/outbox/, /\.rpush\(/]},
        typescript: {all: [/outbox/, /\.rpush\(/]},
        go: {all: [/outbox/, /\.RPush\(/]},
        cpp: {all: [/outbox/, /\.rpush\(/]},
      },
    },
    {
      id: 'delivery',
      title: 'Idempotent producer with acks=all',
      detail:
        'A retry after a lost acknowledgement must not duplicate the record (`enable.idempotence`, KafkaJS `idempotent: true`) and a leader failover must not lose it (`acks=all`; kafka-go: `RequiredAcks: kafka.RequireAll`, a synchronous write). The starter uses one ack and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["']all["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/idempotent:\s*true/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/], none: [/Async:\s*true/]},
        cpp: {all: [/set\("acks",\s*"all"/, /enable\.idempotence/]},
      },
    },
    {
      id: 'produce-failure',
      title: 'A rejected produce is counted and surfaced',
      detail:
        'After the outbox row, the rejection increments `cache_result_produce_failures` and raises `ProduceRejected`, so the lookup knows its outcome was not recorded. The starter reports success whatever the broker said.',
      match: {
        python: {all: [/cache_result_produce_failures/, /raise ProduceRejected\(/]},
        typescript: {all: [/cache_result_produce_failures/, /throw new ProduceRejected\(/]},
        go: {all: [/cache_result_produce_failures/, /return [^\n]*ErrProduceRejected/]},
        cpp: {all: [/cache_result_produce_failures/, /throw ProduceRejected\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""semantic-cache.result: one event per lookup, and the stats consumer that folds them into Redis."""
import json
import logging

import redis
from confluent_kafka import Consumer, KafkaError, Message, Producer

TOPIC = "semantic-cache.result"
GROUP = "semantic-cache-stats"
HIT_FRESHNESS_SECONDS = 3600

logger = logging.getLogger("semantic-cache.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


class ProduceRejected(Exception):
    """The broker rejected the produce: the event is in the outbox, not on the topic."""


def stats_key(tenant: str, model_version: str) -> str:
    return f"stats:{tenant}:{model_version}"


def on_delivery(err: KafkaError | None, msg: Message) -> None:
    if err is not None:
        logger.warning("result event not delivered: %s", err)


def publish_result(tenant: str, result: dict) -> None:
    """One event per lookup. result: {outcome, entry_id, similarity, policy_version, model_version, client_class, entry_age_seconds}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = dict(result, tenant=tenant)
    if result["entry_id"]:
        payload["answer"] = r.hget(f"entry:{tenant}:{result['model_version']}:{result['entry_id']}", "answer")
    band = "miss" if result["similarity"] is None else f"{result['similarity']:.1f}"
    producer.produce(TOPIC, key=band, value=json.dumps(payload), on_delivery=on_delivery)
    producer.poll(0)


def apply_result(tenant: str, event: dict) -> None:
    """Fold one event into the tenant and model version counters."""
    key = stats_key(tenant, event["model_version"])
    hit = event["outcome"] == "hit"
    r.hincrby(key, "hits_total" if hit else "misses_total", 1)
    if event.get("client_class") == "automated":
        r.hincrby(key, "automated_total", 1)
        if hit:
            r.hincrby(key, "automated_hits", 1)
    if hit:
        r.hincrbyfloat(key, "similarity_sum", float(event["similarity"] or 0.0))
        if int(event.get("entry_age_seconds", 0)) > HIT_FRESHNESS_SECONDS:
            r.hincrby(key, "hits_older_than_1h", 1)


def consume_results() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            logger.error("consumer error: %s", msg.error())
            continue
        event = json.loads(msg.value())
        apply_result(event["tenant"], event)
        consumer.commit(message=msg, asynchronous=False)
`,
      solution: `"""semantic-cache.result: one event per lookup keyed by tenant, and the stats consumer that folds them into Redis."""
import json
import logging

import redis
from confluent_kafka import Consumer, KafkaError, Message, Producer

TOPIC = "semantic-cache.result"
GROUP = "semantic-cache-stats"
OUTBOX_KEY = "outbox:semantic-cache.result"
FAILURES_KEY = "cache_result_produce_failures"
HIT_FRESHNESS_SECONDS = 3600
PRODUCE_TIMEOUT_S = 2.0
WIRE_FIELDS = ("outcome", "entry_id", "similarity", "policy_version", "model_version", "client_class", "entry_age_seconds")

logger = logging.getLogger("semantic-cache.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


class ProduceRejected(Exception):
    """The broker rejected the produce: the event is in the outbox, not on the topic."""


def stats_key(tenant: str, model_version: str) -> str:
    return f"stats:{tenant}:{model_version}"


def publish_result(tenant: str, result: dict) -> None:
    """One event per lookup. result: {outcome, entry_id, similarity, policy_version, model_version, client_class, entry_age_seconds}."""
    payload = json.dumps({field: result[field] for field in WIRE_FIELDS})
    rejected: list[KafkaError] = []

    def on_delivery(err: KafkaError | None, msg: Message) -> None:
        if err is not None:
            rejected.append(err)

    producer.produce(TOPIC, key=tenant, value=payload, on_delivery=on_delivery)
    producer.flush(PRODUCE_TIMEOUT_S)  # the delivery report fires here, delivered or rejected
    if rejected:
        r.rpush(OUTBOX_KEY, json.dumps({"key": tenant, "payload": payload}))
        r.incr(FAILURES_KEY)
        logger.warning("result event for %s rejected: %s", tenant, rejected[0])
        raise ProduceRejected(str(rejected[0]))


def apply_result(tenant: str, event: dict) -> None:
    """Fold one event into the tenant and model version counters."""
    key = stats_key(tenant, event["model_version"])
    hit = event["outcome"] == "hit"
    r.hincrby(key, "hits_total" if hit else "misses_total", 1)
    if event.get("client_class") == "automated":
        r.hincrby(key, "automated_total", 1)
        if hit:
            r.hincrby(key, "automated_hits", 1)
    if hit:
        r.hincrbyfloat(key, "similarity_sum", float(event["similarity"] or 0.0))
        if int(event.get("entry_age_seconds", 0)) > HIT_FRESHNESS_SECONDS:
            r.hincrby(key, "hits_older_than_1h", 1)


def consume_results() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            logger.error("consumer error: %s", msg.error())
            continue
        tenant = msg.key().decode() if msg.key() else ""
        apply_result(tenant, json.loads(msg.value()))
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `/** semantic-cache.result: one event per lookup, and the stats consumer that folds them into Redis. */
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const TOPIC = 'semantic-cache.result';
export const GROUP = 'semantic-cache-stats';
export const HIT_FRESHNESS_SECONDS = 3600;

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'semcached', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** What the lookup knows when it answers. */
export interface ResultEvent {
  outcome: 'hit' | 'miss';
  entry_id: string;
  similarity: number | null;
  policy_version: string;
  model_version: string;
  client_class: string;
  entry_age_seconds: number;
}

/** The broker rejected the produce: the event is in the outbox, not on the topic. */
export class ProduceRejected extends Error {}

export function statsKey(tenant: string, modelVersion: string): string {
  return \`stats:\${tenant}:\${modelVersion}\`;
}

/** One event per lookup. */
export async function publishResult(tenant: string, result: ResultEvent): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const payload: Record<string, unknown> = {...result, tenant};
  if (result.entry_id !== '') payload.answer = await redis.hget(\`entry:\${tenant}:\${result.model_version}:\${result.entry_id}\`, 'answer');
  const band = result.similarity === null ? 'miss' : result.similarity.toFixed(1);
  void producer
    .send({topic: TOPIC, messages: [{key: band, value: JSON.stringify(payload)}], acks: 1})
    .catch((e: Error) => console.warn(\`result event not delivered: \${e.message}\`));
}

/** Fold one event into the tenant and model version counters. */
export async function applyResult(tenant: string, event: ResultEvent): Promise<void> {
  const key = statsKey(tenant, event.model_version);
  const hit = event.outcome === 'hit';
  await redis.hincrby(key, hit ? 'hits_total' : 'misses_total', 1);
  if (event.client_class === 'automated') {
    await redis.hincrby(key, 'automated_total', 1);
    if (hit) await redis.hincrby(key, 'automated_hits', 1);
  }
  if (hit) {
    await redis.hincrbyfloat(key, 'similarity_sum', event.similarity ?? 0);
    if (event.entry_age_seconds > HIT_FRESHNESS_SECONDS) await redis.hincrby(key, 'hits_older_than_1h', 1);
  }
}

export async function consumeResults(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(String(message.value)) as ResultEvent & {tenant: string};
      await applyResult(event.tenant, event);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
      solution: `/** semantic-cache.result: one event per lookup keyed by tenant, and the stats consumer that folds them into Redis. */
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const TOPIC = 'semantic-cache.result';
export const GROUP = 'semantic-cache-stats';
export const OUTBOX_KEY = 'outbox:semantic-cache.result';
export const FAILURES_KEY = 'cache_result_produce_failures';
export const HIT_FRESHNESS_SECONDS = 3600;

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'semcached', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true}); // the idempotent producer requires acks: -1 (all)
void producer.connect();

/** What the lookup knows when it answers: also the wire shape, field for field. */
export interface ResultEvent {
  outcome: 'hit' | 'miss';
  entry_id: string;
  similarity: number | null;
  policy_version: string;
  model_version: string;
  client_class: string;
  entry_age_seconds: number;
}

/** The broker rejected the produce: the event is in the outbox, not on the topic. */
export class ProduceRejected extends Error {}

export function statsKey(tenant: string, modelVersion: string): string {
  return \`stats:\${tenant}:\${modelVersion}\`;
}

/** One event per lookup; a rejection leaves an outbox row, a counter and an error the caller sees. */
export async function publishResult(tenant: string, result: ResultEvent): Promise<void> {
  const payload = JSON.stringify({
    outcome: result.outcome,
    entry_id: result.entry_id,
    similarity: result.similarity,
    policy_version: result.policy_version,
    model_version: result.model_version,
    client_class: result.client_class,
    entry_age_seconds: result.entry_age_seconds,
  });
  try {
    await producer.send({topic: TOPIC, messages: [{key: tenant, value: payload}], acks: -1});
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await redis.rpush(OUTBOX_KEY, JSON.stringify({key: tenant, payload}));
    await redis.incr(FAILURES_KEY);
    console.warn(\`result event for \${tenant} rejected: \${why}\`);
    throw new ProduceRejected(why);
  }
}

/** Fold one event into the tenant and model version counters. */
export async function applyResult(tenant: string, event: ResultEvent): Promise<void> {
  const key = statsKey(tenant, event.model_version);
  const hit = event.outcome === 'hit';
  await redis.hincrby(key, hit ? 'hits_total' : 'misses_total', 1);
  if (event.client_class === 'automated') {
    await redis.hincrby(key, 'automated_total', 1);
    if (hit) await redis.hincrby(key, 'automated_hits', 1);
  }
  if (hit) {
    await redis.hincrbyfloat(key, 'similarity_sum', event.similarity ?? 0);
    if (event.entry_age_seconds > HIT_FRESHNESS_SECONDS) await redis.hincrby(key, 'hits_older_than_1h', 1);
  }
}

export async function consumeResults(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const tenant = message.key?.toString() ?? '';
      await applyResult(tenant, JSON.parse(String(message.value)) as ResultEvent);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `// semantic-cache.result: one event per lookup, and the stats consumer that folds them into Redis.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	topic               = "semantic-cache.result"
	group               = "semantic-cache-stats"
	hitFreshnessSeconds = 3600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
	Async:        true,
	Completion: func(messages []kafka.Message, err error) {
		if err != nil {
			log.Printf("%d result event(s) not delivered: %v", len(messages), err)
		}
	},
}

// ResultEvent is what the lookup knows when it answers.
type ResultEvent struct {
	Outcome         string   // "hit" or "miss"
	EntryID         string   // "" on a miss
	Similarity      *float64 // nil on a miss
	PolicyVersion   string   // the entry's; "" on a miss
	ModelVersion    string
	ClientClass     string // "human" or "automated", from X-Client-Class
	EntryAgeSeconds int64  // 0 on a miss
}

// wireEvent is the event as it crosses the topic.
type wireEvent struct {
	Tenant          string   \`json:"tenant"\`
	Outcome         string   \`json:"outcome"\`
	EntryID         string   \`json:"entry_id"\`
	Answer          string   \`json:"answer,omitempty"\`
	Similarity      *float64 \`json:"similarity"\`
	PolicyVersion   string   \`json:"policy_version"\`
	ModelVersion    string   \`json:"model_version"\`
	ClientClass     string   \`json:"client_class"\`
	EntryAgeSeconds int64    \`json:"entry_age_seconds"\`
}

// ErrProduceRejected: the broker rejected the produce; the event is in the outbox, not on the topic.
var ErrProduceRejected = errors.New("produce rejected")

func statsKey(tenant, modelVersion string) string {
	return fmt.Sprintf("stats:%s:%s", tenant, modelVersion)
}

// publishResult puts one event per lookup on the topic.
func publishResult(ctx context.Context, tenant string, result ResultEvent) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	event := wireEvent{Tenant: tenant, Outcome: result.Outcome, EntryID: result.EntryID, Similarity: result.Similarity, PolicyVersion: result.PolicyVersion, ModelVersion: result.ModelVersion, ClientClass: result.ClientClass, EntryAgeSeconds: result.EntryAgeSeconds}
	if result.EntryID != "" {
		event.Answer, _ = rdb.HGet(ctx, fmt.Sprintf("entry:%s:%s:%s", tenant, result.ModelVersion, result.EntryID), "answer").Result()
	}
	payload, _ := json.Marshal(event)
	band := "miss"
	if result.Similarity != nil {
		band = fmt.Sprintf("%.1f", *result.Similarity)
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(band), Value: payload})
}

// applyResult folds one event into the tenant and model version counters.
func applyResult(ctx context.Context, tenant string, event wireEvent) error {
	key := statsKey(tenant, event.ModelVersion)
	hit := event.Outcome == "hit"
	field := "misses_total"
	if hit {
		field = "hits_total"
	}
	if err := rdb.HIncrBy(ctx, key, field, 1).Err(); err != nil {
		return err
	}
	if event.ClientClass == "automated" {
		rdb.HIncrBy(ctx, key, "automated_total", 1)
		if hit {
			rdb.HIncrBy(ctx, key, "automated_hits", 1)
		}
	}
	if hit {
		similarity := 0.0
		if event.Similarity != nil {
			similarity = *event.Similarity
		}
		rdb.HIncrByFloat(ctx, key, "similarity_sum", similarity)
		if event.EntryAgeSeconds > hitFreshnessSeconds {
			rdb.HIncrBy(ctx, key, "hits_older_than_1h", 1)
		}
	}
	return nil
}

func consumeResults(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event wireEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if err := applyResult(ctx, event.Tenant, event); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
      solution: `// semantic-cache.result: one event per lookup keyed by tenant, and the stats consumer that folds them into Redis.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	topic               = "semantic-cache.result"
	group               = "semantic-cache-stats"
	outboxKey           = "outbox:semantic-cache.result"
	failuresKey         = "cache_result_produce_failures"
	hitFreshnessSeconds = 3600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// kafka-go has no idempotent producer: acks from every in-sync replica and a synchronous write are what it offers.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// ResultEvent is what the lookup knows when it answers.
type ResultEvent struct {
	Outcome         string   // "hit" or "miss"
	EntryID         string   // "" on a miss
	Similarity      *float64 // nil on a miss
	PolicyVersion   string   // the entry's; "" on a miss
	ModelVersion    string
	ClientClass     string // "human" or "automated", from X-Client-Class
	EntryAgeSeconds int64  // 0 on a miss
}

// wireEvent is the event as it crosses the topic: the result's seven fields, nothing from the entry.
type wireEvent struct {
	Outcome         string   \`json:"outcome"\`
	EntryID         string   \`json:"entry_id"\`
	Similarity      *float64 \`json:"similarity"\`
	PolicyVersion   string   \`json:"policy_version"\`
	ModelVersion    string   \`json:"model_version"\`
	ClientClass     string   \`json:"client_class"\`
	EntryAgeSeconds int64    \`json:"entry_age_seconds"\`
}

// ErrProduceRejected: the broker rejected the produce; the event is in the outbox, not on the topic.
var ErrProduceRejected = errors.New("produce rejected")

func statsKey(tenant, modelVersion string) string {
	return fmt.Sprintf("stats:%s:%s", tenant, modelVersion)
}

// publishResult puts one event per lookup on the topic; a rejection leaves an outbox row, a counter and an error the caller sees.
func publishResult(ctx context.Context, tenant string, result ResultEvent) error {
	payload, _ := json.Marshal(wireEvent{Outcome: result.Outcome, EntryID: result.EntryID, Similarity: result.Similarity, PolicyVersion: result.PolicyVersion, ModelVersion: result.ModelVersion, ClientClass: result.ClientClass, EntryAgeSeconds: result.EntryAgeSeconds})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: payload}); err != nil {
		row, _ := json.Marshal(map[string]string{"key": tenant, "payload": string(payload)})
		rdb.RPush(ctx, outboxKey, string(row))
		rdb.Incr(ctx, failuresKey)
		log.Printf("result event for %s rejected: %v", tenant, err)
		return fmt.Errorf("%w: %v", ErrProduceRejected, err)
	}
	return nil
}

// applyResult folds one event into the tenant and model version counters.
func applyResult(ctx context.Context, tenant string, event wireEvent) error {
	key := statsKey(tenant, event.ModelVersion)
	hit := event.Outcome == "hit"
	field := "misses_total"
	if hit {
		field = "hits_total"
	}
	if err := rdb.HIncrBy(ctx, key, field, 1).Err(); err != nil {
		return err
	}
	if event.ClientClass == "automated" {
		rdb.HIncrBy(ctx, key, "automated_total", 1)
		if hit {
			rdb.HIncrBy(ctx, key, "automated_hits", 1)
		}
	}
	if hit {
		similarity := 0.0
		if event.Similarity != nil {
			similarity = *event.Similarity
		}
		rdb.HIncrByFloat(ctx, key, "similarity_sum", similarity)
		if event.EntryAgeSeconds > hitFreshnessSeconds {
			rdb.HIncrBy(ctx, key, "hits_older_than_1h", 1)
		}
	}
	return nil
}

func consumeResults(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event wireEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if err := applyResult(ctx, string(msg.Key), event); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    cpp: {
      starter: `// semantic-cache.result: one event per lookup, and the stats consumer that folds them into Redis.
#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <cstdio>
#include <iostream>
#include <memory>
#include <string>

#include "events.h"

using json = nlohmann::json;

const std::string kTopic = "semantic-cache.result";
const std::string kGroup = "semantic-cache-stats";
constexpr long kHitFreshnessSeconds = 3600;

sw::redis::Redis redis("tcp://redis:6379");

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "result event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

std::string stats_key(const std::string& tenant, const std::string& model_version) {
  return "stats:" + tenant + ":" + model_version;
}

// One event per lookup.
void publish_result(const std::string& tenant, const ResultEvent& result) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  json payload = {{"tenant", tenant},
                  {"outcome", result.outcome},
                  {"entry_id", result.entry_id},
                  {"similarity", result.similarity ? json(*result.similarity) : json(nullptr)},
                  {"policy_version", result.policy_version},
                  {"model_version", result.model_version},
                  {"client_class", result.client_class},
                  {"entry_age_seconds", result.entry_age_seconds}};
  if (!result.entry_id.empty()) {
    const auto answer = redis.hget("entry:" + tenant + ":" + result.model_version + ":" + result.entry_id, "answer");
    payload["answer"] = answer ? *answer : "";
  }
  std::string band = "miss";
  if (result.similarity) {
    char buf[16];
    std::snprintf(buf, sizeof buf, "%.1f", *result.similarity);
    band = buf;
  }
  const std::string value = payload.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), band.c_str(), band.size(), 0, nullptr);
  producer->poll(0);
}

// Fold one event into the tenant and model version counters.
void apply_result(const std::string& tenant, const json& event) {
  const std::string key = stats_key(tenant, event.value("model_version", ""));
  const bool hit = event.value("outcome", "") == "hit";
  redis.hincrby(key, hit ? "hits_total" : "misses_total", 1);
  if (event.value("client_class", "") == "automated") {
    redis.hincrby(key, "automated_total", 1);
    if (hit) redis.hincrby(key, "automated_hits", 1);
  }
  if (hit) {
    const double similarity = event.contains("similarity") && event["similarity"].is_number() ? event["similarity"].get<double>() : 0.0;
    redis.hincrbyfloat(key, "similarity_sum", similarity);
    if (event.value("entry_age_seconds", 0L) > kHitFreshnessSeconds) redis.hincrby(key, "hits_older_than_1h", 1);
  }
}

void consume_results() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    apply_result(event.value("tenant", ""), event);
    consumer->commitSync(msg.get());
  }
}
`,
      solution: `// semantic-cache.result: one event per lookup keyed by tenant, and the stats consumer that folds them into Redis.
#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "events.h"

using json = nlohmann::json;

const std::string kTopic = "semantic-cache.result";
const std::string kGroup = "semantic-cache-stats";
const std::string kOutboxKey = "outbox:semantic-cache.result";
const std::string kFailuresKey = "cache_result_produce_failures";
constexpr long kHitFreshnessSeconds = 3600;
constexpr int kProduceTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report of the last produce: what the broker said once flush() served it.
class LastReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode err = RdKafka::ERR_NO_ERROR;
  std::string errstr;
  void dr_cb(RdKafka::Message& message) override {
    err = message.err();
    errstr = message.errstr();
  }
};

LastReport report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("dr_cb", &report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

std::string stats_key(const std::string& tenant, const std::string& model_version) {
  return "stats:" + tenant + ":" + model_version;
}

// One event per lookup; a rejection leaves an outbox row, a counter and an exception the caller sees.
void publish_result(const std::string& tenant, const ResultEvent& result) {
  const std::string payload = json{{"outcome", result.outcome},
                                   {"entry_id", result.entry_id},
                                   {"similarity", result.similarity ? json(*result.similarity) : json(nullptr)},
                                   {"policy_version", result.policy_version},
                                   {"model_version", result.model_version},
                                   {"client_class", result.client_class},
                                   {"entry_age_seconds", result.entry_age_seconds}}
                                  .dump();
  report.err = RdKafka::ERR_NO_ERROR;
  const RdKafka::ErrorCode queued =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                        payload.size(), tenant.c_str(), tenant.size(), 0, nullptr);
  producer->flush(kProduceTimeoutMs);  // the delivery report fires here, delivered or rejected
  if (queued != RdKafka::ERR_NO_ERROR || report.err != RdKafka::ERR_NO_ERROR) {
    const std::string why = queued != RdKafka::ERR_NO_ERROR ? RdKafka::err2str(queued) : report.errstr;
    redis.rpush(kOutboxKey, json{{"key", tenant}, {"payload", payload}}.dump());
    redis.incr(kFailuresKey);
    std::cerr << "result event for " << tenant << " rejected: " << why << "\\n";
    throw ProduceRejected(why);
  }
}

// Fold one event into the tenant and model version counters.
void apply_result(const std::string& tenant, const json& event) {
  const std::string key = stats_key(tenant, event.value("model_version", ""));
  const bool hit = event.value("outcome", "") == "hit";
  redis.hincrby(key, hit ? "hits_total" : "misses_total", 1);
  if (event.value("client_class", "") == "automated") {
    redis.hincrby(key, "automated_total", 1);
    if (hit) redis.hincrby(key, "automated_hits", 1);
  }
  if (hit) {
    const double similarity = event.contains("similarity") && event["similarity"].is_number() ? event["similarity"].get<double>() : 0.0;
    redis.hincrbyfloat(key, "similarity_sum", similarity);
    if (event.value("entry_age_seconds", 0L) > kHitFreshnessSeconds) redis.hincrby(key, "hits_older_than_1h", 1);
  }
}

void consume_results() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string tenant = msg->key() ? *msg->key() : "";
    apply_result(tenant, json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "semantic-cache.result"
GROUP = "semantic-cache-stats"
OUTBOX = "outbox:semantic-cache.result"
ANSWER = "Refunds take five business days."
WIRE = {"outcome", "entry_id", "similarity", "policy_version", "model_version", "client_class", "entry_age_seconds"}


def _hit(entry_id="e1", similarity=0.93, age=41, cls="human"):
    return {"outcome": "hit", "entry_id": entry_id, "similarity": similarity, "policy_version": "2024-06-1", "model_version": "2024-06", "client_class": cls, "entry_age_seconds": age}


def _miss(cls="human"):
    return {"outcome": "miss", "entry_id": "", "similarity": None, "policy_version": "", "model_version": "2024-06", "client_class": cls, "entry_age_seconds": 0}


def _entry(ctx, tenant, entry_id):
    """The entry a hit refers to, as the store holds it."""
    ctx.redis.hset(f"entry:{tenant}:2024-06:{entry_id}", mapping={"embedding": "[1,0,0,0]", "answer": ANSWER, "created_at": 0, "expires_at": 86400, "policy_version": "2024-06-1"})


def _publish(m, tenant, result):
    """publish_result, reporting what it raised instead of ending the check."""
    try:
        m.publish_result(tenant, result)
        return None
    except Exception as e:  # noqa: BLE001
        return e


def check_tenant_key(ctx):
    m = ctx.load("events")
    _entry(ctx, "acme", "e1")
    for tenant, result in (("acme", _hit()), ("globex", _miss()), ("acme", _hit(similarity=0.88, age=4000, cls="automated")), ("acme", _hit(similarity=0.9, age=3600)), ("globex", _miss(cls="automated"))):
        raised = _publish(m, tenant, result)
        assert raised is None, f"publish_result raised {raised!r} on a healthy broker"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 5, f"five lookups produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"acme", b"globex", b"acme", b"acme", b"globex"], f"records must be keyed by the tenant, got {keys}"
    assert records[0].partition == records[2].partition == records[3].partition and records[1].partition == records[4].partition, "the same tenant must land on the same partition so its hits and misses are read as one stream"
    ctx.drain(m.consume_results)
    acme = ctx.redis.hgetall("stats:acme:2024-06")
    assert acme.get("hits_total") == "3" and acme.get("misses_total", "0") == "0", f"stats:acme:2024-06 holds {acme}, expected hits_total 3 and no misses"
    assert abs(float(acme.get("similarity_sum", 0)) - 2.71) < 1e-6, f"similarity_sum is {acme.get('similarity_sum')!r}, expected 0.93 + 0.88 + 0.9 = 2.71"
    assert acme.get("automated_total") == "1" and acme.get("automated_hits") == "1", f"stats:acme:2024-06 holds {acme}, expected automated_total 1 and automated_hits 1 for the automated hit"
    assert acme.get("hits_older_than_1h") == "1", f"stats:acme:2024-06 holds {acme}, expected hits_older_than_1h 1: the hit on a 4000 s old entry counts, the one on a 3600 s old entry is not over an hour"
    globex = ctx.redis.hgetall("stats:globex:2024-06")
    assert globex.get("misses_total") == "2" and globex.get("hits_total", "0") == "0", f"stats:globex:2024-06 holds {globex}, expected misses_total 2"
    assert globex.get("automated_total") == "1" and globex.get("automated_hits", "0") == "0", f"stats:globex:2024-06 holds {globex}, expected automated_total 1 and no automated_hits: the automated lookup was a miss"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, f"the consumer left {ctx.kafka.lag(GROUP, TOPIC)} record(s) uncommitted"


def check_no_text(ctx):
    m = ctx.load("events")
    _entry(ctx, "acme", "e1")
    raised = _publish(m, "acme", _hit())
    assert raised is None, f"publish_result raised {raised!r} on a healthy broker"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one lookup produced {len(records)} records"
    text = records[0].value.decode()
    event = json.loads(text)
    assert ANSWER not in text, f"the event carries the served answer: {text}. The topic is retained and replicated; the entry id is enough to find the answer in the store"
    assert "answer" not in event, f"the event has an answer field: {text}"
    missing = WIRE - set(event)
    assert not missing, f"the event {text} lacks {sorted(missing)}"
    assert event["entry_id"] == "e1" and event["outcome"] == "hit" and event["similarity"] == 0.93 and event["client_class"] == "human" and event["entry_age_seconds"] == 41, f"the event's fields must come from the result the lookup passed: {text}"


def check_outbox(ctx):
    m = ctx.load("events")
    _entry(ctx, "acme", "e1")
    ctx.kafka.fail_next(TOPIC, 1)
    _publish(m, "acme", _hit())
    rows = ctx.redis.lrange(OUTBOX, 0, -1)
    assert len(rows) == 1, f"after the broker rejected the produce {OUTBOX} holds {rows}, expected one row with the event"
    row = json.loads(rows[0])
    assert row.get("key") == "acme", f"the outbox row must carry the message key (the tenant) so the relay publishes it to the same partition: {row}"
    payload = json.loads(row.get("payload", "{}")) if isinstance(row.get("payload"), str) else row.get("payload")
    assert isinstance(payload, dict) and payload.get("outcome") == "hit" and payload.get("entry_id") == "e1", f"the outbox row must carry the event payload: {row}"
    assert WIRE <= set(payload) and "answer" not in payload and ANSWER not in rows[0], f"the outbox row's payload must be the event, its seven fields and no answer text: {rows[0]}. The relay republishes it to the same retained topic"
    assert ctx.kafka.records(TOPIC) == [], "a rejected produce cannot be on the topic"
    raised = _publish(m, "globex", _miss())
    assert raised is None, f"after the broker recovered publish_result raised {raised!r}"
    assert len(ctx.kafka.records(TOPIC)) == 1, "once the broker answers again events flow"
    assert len(ctx.redis.lrange(OUTBOX, 0, -1)) == 1, "a delivered event leaves no outbox row"


def check_delivery(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    raised = _publish(m, "acme", _hit())
    assert raised is None, f"publish_result raised {raised!r}: a lost acknowledgement is retried by the client, not reported"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"after one lost acknowledgement the topic holds {len(records)} records, expected 1: the retry duplicated the event (enable.idempotence)"
    _publish(m, "acme", _miss())
    ctx.kafka.failover(TOPIC)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 2, f"after a leader failover the topic holds {len(records)} records, expected 2: a record acknowledged by the leader alone is lost (acks=all)"


def check_produce_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    raised = _publish(m, "acme", _hit())
    assert raised is not None, "the broker rejected the produce and publish_result returned as if the event were recorded: raise ProduceRejected after the outbox row"
    assert type(raised).__name__ == "ProduceRejected", f"publish_result raised {raised!r}, expected ProduceRejected"
    assert ctx.redis.get("cache_result_produce_failures") == "1", f"cache_result_produce_failures is {ctx.redis.get('cache_result_produce_failures')!r} after one rejection, expected 1"
    raised = _publish(m, "acme", _hit())
    assert raised is None, f"a delivered produce must not raise, got {raised!r}"
    assert ctx.redis.get("cache_result_produce_failures") == "1", "a delivered produce must not count as a failure"
`,
    typescript: `const TOPIC = 'semantic-cache.result';
const GROUP = 'semantic-cache-stats';
const OUTBOX = 'outbox:semantic-cache.result';
const ANSWER = 'Refunds take five business days.';
const WIRE = ['outcome', 'entry_id', 'similarity', 'policy_version', 'model_version', 'client_class', 'entry_age_seconds'];

const hit = ({entryId = 'e1', similarity = 0.93, age = 41, cls = 'human'} = {}) => ({outcome: 'hit', entry_id: entryId, similarity, policy_version: '2024-06-1', model_version: '2024-06', client_class: cls, entry_age_seconds: age});
const miss = (cls = 'human') => ({outcome: 'miss', entry_id: '', similarity: null, policy_version: '', model_version: '2024-06', client_class: cls, entry_age_seconds: 0});

/** The entry a hit refers to, as the store holds it. */
function entry(ctx, tenant: string, entryId: string) {
  ctx.redis.hset(\`entry:\${tenant}:2024-06:\${entryId}\`, 'embedding', '[1,0,0,0]', 'answer', ANSWER, 'created_at', 0, 'expires_at', 86400, 'policy_version', '2024-06-1');
}

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

/** publishResult, reporting what it threw instead of ending the check. */
async function publish(m, tenant: string, result): Promise<unknown> {
  try {
    await m.publishResult(tenant, result);
    await settle();
    return null;
  } catch (e) {
    return e;
  }
}

export async function check_tenant_key(ctx) {
  const m = ctx.load('events');
  entry(ctx, 'acme', 'e1');
  for (const [tenant, result] of [['acme', hit()], ['globex', miss()], ['acme', hit({similarity: 0.88, age: 4000, cls: 'automated'})], ['acme', hit({similarity: 0.9, age: 3600})], ['globex', miss('automated')]] as const) {
    const raised = await publish(m, tenant, result);
    assert.equal(raised, null, \`publishResult threw \${raised} on a healthy broker\`);
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 5, \`five lookups produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['acme', 'globex', 'acme', 'acme', 'globex'], \`records must be keyed by the tenant, got \${JSON.stringify(keys)}\`);
  assert(records[0].partition === records[2].partition && records[0].partition === records[3].partition && records[1].partition === records[4].partition, 'the same tenant must land on the same partition so its hits and misses are read as one stream');
  await ctx.drain(m.consumeResults());
  const acme = ctx.redis.hgetall('stats:acme:2024-06');
  assert(acme.hits_total === '3' && (acme.misses_total ?? '0') === '0', \`stats:acme:2024-06 holds \${JSON.stringify(acme)}, expected hits_total 3 and no misses\`);
  assert(Math.abs(Number(acme.similarity_sum ?? 0) - 2.71) < 1e-6, \`similarity_sum is \${JSON.stringify(acme.similarity_sum)}, expected 0.93 + 0.88 + 0.9 = 2.71\`);
  assert(acme.automated_total === '1' && acme.automated_hits === '1', \`stats:acme:2024-06 holds \${JSON.stringify(acme)}, expected automated_total 1 and automated_hits 1 for the automated hit\`);
  assert.equal(acme.hits_older_than_1h, '1', \`stats:acme:2024-06 holds \${JSON.stringify(acme)}, expected hits_older_than_1h 1: the hit on a 4000 s old entry counts, the one on a 3600 s old entry is not over an hour\`);
  const globex = ctx.redis.hgetall('stats:globex:2024-06');
  assert(globex.misses_total === '2' && (globex.hits_total ?? '0') === '0', \`stats:globex:2024-06 holds \${JSON.stringify(globex)}, expected misses_total 2\`);
  assert(globex.automated_total === '1' && (globex.automated_hits ?? '0') === '0', \`stats:globex:2024-06 holds \${JSON.stringify(globex)}, expected automated_total 1 and no automated_hits: the automated lookup was a miss\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, \`the consumer left \${ctx.kafka.lag(GROUP, TOPIC)} record(s) uncommitted\`);
}

export async function check_no_text(ctx) {
  const m = ctx.load('events');
  entry(ctx, 'acme', 'e1');
  const raised = await publish(m, 'acme', hit());
  assert.equal(raised, null, \`publishResult threw \${raised} on a healthy broker\`);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one lookup produced \${records.length} records\`);
  const text = records[0].value.toString();
  const event = JSON.parse(text);
  assert(!text.includes(ANSWER), \`the event carries the served answer: \${text}. The topic is retained and replicated; the entry id is enough to find the answer in the store\`);
  assert(!('answer' in event), \`the event has an answer field: \${text}\`);
  const missing = WIRE.filter(f => !(f in event));
  assert.equal(missing.length, 0, \`the event \${text} lacks \${JSON.stringify(missing)}\`);
  assert(event.entry_id === 'e1' && event.outcome === 'hit' && event.similarity === 0.93 && event.client_class === 'human' && event.entry_age_seconds === 41, \`the event's fields must come from the result the lookup passed: \${text}\`);
}

export async function check_outbox(ctx) {
  const m = ctx.load('events');
  entry(ctx, 'acme', 'e1');
  ctx.kafka.failNext(TOPIC, 1);
  await publish(m, 'acme', hit());
  const rows = ctx.redis.lrange(OUTBOX, 0, -1);
  assert.equal(rows.length, 1, \`after the broker rejected the produce \${OUTBOX} holds \${JSON.stringify(rows)}, expected one row with the event\`);
  const row = JSON.parse(rows[0]);
  assert.equal(row.key, 'acme', \`the outbox row must carry the message key (the tenant) so the relay publishes it to the same partition: \${rows[0]}\`);
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  assert(payload !== null && typeof payload === 'object' && payload.outcome === 'hit' && payload.entry_id === 'e1', \`the outbox row must carry the event payload: \${rows[0]}\`);
  assert(WIRE.every(f => f in payload) && !('answer' in payload) && !rows[0].includes(ANSWER), \`the outbox row's payload must be the event, its seven fields and no answer text: \${rows[0]}. The relay republishes it to the same retained topic\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'a rejected produce cannot be on the topic');
  const raised = await publish(m, 'globex', miss());
  assert.equal(raised, null, \`after the broker recovered publishResult threw \${raised}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'once the broker answers again events flow');
  assert.equal(ctx.redis.lrange(OUTBOX, 0, -1).length, 1, 'a delivered event leaves no outbox row');
}

export async function check_delivery(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1);
  const raised = await publish(m, 'acme', hit());
  assert.equal(raised, null, \`publishResult threw \${raised}: a lost acknowledgement is retried by the client, not reported\`);
  let records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`after one lost acknowledgement the topic holds \${records.length} records, expected 1: the retry duplicated the event (idempotent: true)\`);
  await publish(m, 'acme', miss());
  ctx.kafka.failover(TOPIC);
  records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 2, \`after a leader failover the topic holds \${records.length} records, expected 2: a record acknowledged by the leader alone is lost (acks: -1)\`);
}

export async function check_produce_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let raised = await publish(m, 'acme', hit());
  assert(raised !== null, 'the broker rejected the produce and publishResult resolved as if the event were recorded: throw ProduceRejected after the outbox row');
  assert.equal((raised as Error).constructor.name, 'ProduceRejected', \`publishResult threw \${raised}, expected ProduceRejected\`);
  assert.equal(ctx.redis.get('cache_result_produce_failures'), '1', \`cache_result_produce_failures is \${JSON.stringify(ctx.redis.get('cache_result_produce_failures'))} after one rejection, expected 1\`);
  raised = await publish(m, 'acme', hit());
  assert.equal(raised, null, \`a delivered produce must not throw, got \${raised}\`);
  assert.equal(ctx.redis.get('cache_result_produce_failures'), '1', 'a delivered produce must not count as a failure');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const (
	kHEventsTopic  = "semantic-cache.result"
	kHEventsGroup  = "semantic-cache-stats"
	kHEventsOutbox = "outbox:semantic-cache.result"
	kHEventsAnswer = "Refunds take five business days."
)

var hEventsWireFields = []string{"outcome", "entry_id", "similarity", "policy_version", "model_version", "client_class", "entry_age_seconds"}

func hEventsHit(similarity float64, age int64, class string) ResultEvent {
	return ResultEvent{Outcome: "hit", EntryID: "e1", Similarity: &similarity, PolicyVersion: "2024-06-1", ModelVersion: "2024-06", ClientClass: class, EntryAgeSeconds: age}
}

func hEventsMiss(class string) ResultEvent {
	return ResultEvent{Outcome: "miss", ModelVersion: "2024-06", ClientClass: class}
}

// eventsEntry is the entry a hit refers to, as the store holds it.
func hEventsEntry(ctx *harness.Ctx, tenant, entryID string) {
	ctx.Redis.Do("HSET", "entry:"+tenant+":2024-06:"+entryID, "embedding", "[1,0,0,0]", "answer", kHEventsAnswer, "created_at", 0, "expires_at", 86400, "policy_version", "2024-06-1")
}

// eventsPublish is publishResult, reporting a panic as an error instead of ending the check.
func hEventsPublish(tenant string, result ResultEvent) (err error) {
	defer func() {
		if e := recover(); e != nil {
			err = errors.New("panic: " + harness.Show(e))
		}
	}()
	return publishResult(context.Background(), tenant, result)
}

func hEventsFloat(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

func CheckTenantKey(ctx *harness.Ctx) {
	hEventsEntry(ctx, "acme", "e1")
	for _, in := range []struct {
		tenant string
		result ResultEvent
	}{{"acme", hEventsHit(0.93, 41, "human")}, {"globex", hEventsMiss("human")}, {"acme", hEventsHit(0.88, 4000, "automated")}, {"acme", hEventsHit(0.9, 3600, "human")}, {"globex", hEventsMiss("automated")}} {
		ctx.NoError(hEventsPublish(in.tenant, in.result), "publishResult on a healthy broker")
	}
	ctx.Settle()
	records := ctx.Kafka.Records(kHEventsTopic)
	ctx.Equal(len(records), 5, "five lookups must produce five records on %s; the records", kHEventsTopic)
	ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), []string{"acme", "globex", "acme", "acme", "globex"}, "records must be keyed by the tenant")
	ctx.Assert(records[0].Partition == records[2].Partition && records[0].Partition == records[3].Partition && records[1].Partition == records[4].Partition, "the same tenant must land on the same partition so its hits and misses are read as one stream")
	ctx.Drain(func() { consumeResults(context.Background()) })
	acme := ctx.Redis.HGetAll("stats:acme:2024-06")
	ctx.Assert(acme["hits_total"] == "3" && (acme["misses_total"] == "" || acme["misses_total"] == "0"), "stats:acme:2024-06 holds %v, expected hits_total 3 and no misses", acme)
	ctx.Assert(hEventsFloat(acme["similarity_sum"]) > 2.7099 && hEventsFloat(acme["similarity_sum"]) < 2.7101, "similarity_sum is %q, expected 0.93 + 0.88 + 0.9 = 2.71", acme["similarity_sum"])
	ctx.Assert(acme["automated_total"] == "1" && acme["automated_hits"] == "1", "stats:acme:2024-06 holds %v, expected automated_total 1 and automated_hits 1 for the automated hit", acme)
	ctx.Equal(acme["hits_older_than_1h"], "1", "hits_older_than_1h: the hit on a 4000 s old entry counts, the one on a 3600 s old entry is not over an hour (stats:acme:2024-06 holds %v)", acme)
	globex := ctx.Redis.HGetAll("stats:globex:2024-06")
	ctx.Assert(globex["misses_total"] == "2" && (globex["hits_total"] == "" || globex["hits_total"] == "0"), "stats:globex:2024-06 holds %v, expected misses_total 2", globex)
	ctx.Assert(globex["automated_total"] == "1" && (globex["automated_hits"] == "" || globex["automated_hits"] == "0"), "stats:globex:2024-06 holds %v, expected automated_total 1 and no automated_hits: the automated lookup was a miss", globex)
	ctx.Equal(ctx.Kafka.Lag(kHEventsGroup, kHEventsTopic), 0, "records the consumer left uncommitted")
}

func CheckNoText(ctx *harness.Ctx) {
	hEventsEntry(ctx, "acme", "e1")
	ctx.NoError(hEventsPublish("acme", hEventsHit(0.93, 41, "human")), "publishResult on a healthy broker")
	ctx.Settle()
	records := ctx.Kafka.Records(kHEventsTopic)
	ctx.Equal(len(records), 1, "one lookup must produce one record; the records")
	text := string(records[0].Value)
	var event map[string]any
	ctx.NoError(json.Unmarshal(records[0].Value, &event), "the event must be JSON (%s)", text)
	ctx.Assert(!strings.Contains(text, kHEventsAnswer), "the event carries the served answer: %s. The topic is retained and replicated; the entry id is enough to find the answer in the store", text)
	_, hasAnswer := event["answer"]
	ctx.Assert(!hasAnswer, "the event has an answer field: %s", text)
	for _, field := range hEventsWireFields {
		_, ok := event[field]
		ctx.Assert(ok, "the event %s lacks %s", text, field)
	}
	ctx.Assert(event["entry_id"] == "e1" && event["outcome"] == "hit" && event["similarity"] == 0.93 && event["client_class"] == "human" && event["entry_age_seconds"] == float64(41), "the event's fields must come from the result the lookup passed: %s", text)
}

func CheckOutbox(ctx *harness.Ctx) {
	hEventsEntry(ctx, "acme", "e1")
	ctx.Kafka.FailNext(kHEventsTopic, 1)
	hEventsPublish("acme", hEventsHit(0.93, 41, "human"))
	ctx.Settle()
	rows := ctx.Redis.LRange(kHEventsOutbox, 0, -1)
	ctx.Equal(len(rows), 1, "after the broker rejected the produce %s must hold one row with the event; it holds %v; rows", kHEventsOutbox, rows)
	var row map[string]any
	ctx.NoError(json.Unmarshal([]byte(rows[0]), &row), "the outbox row must be JSON (%s)", rows[0])
	ctx.Equal(row["key"], "acme", "the outbox row must carry the message key (the tenant) so the relay publishes it to the same partition (%s)", rows[0])
	var payload map[string]any
	switch p := row["payload"].(type) {
	case string:
		json.Unmarshal([]byte(p), &payload)
	case map[string]any:
		payload = p
	}
	ctx.Assert(payload != nil && payload["outcome"] == "hit" && payload["entry_id"] == "e1", "the outbox row must carry the event payload: %s", rows[0])
	_, hasAnswer := payload["answer"]
	ctx.Assert(!hasAnswer && !strings.Contains(rows[0], kHEventsAnswer), "the outbox row's payload must be the event, its seven fields and no answer text: %s. The relay republishes it to the same retained topic", rows[0])
	for _, field := range hEventsWireFields {
		_, ok := payload[field]
		ctx.Assert(ok, "the outbox row's payload must be the event, its seven fields and no answer text: %s lacks %s", rows[0], field)
	}
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 0, "a rejected produce cannot be on the topic; the records")
	ctx.NoError(hEventsPublish("globex", hEventsMiss("human")), "after the broker recovered publishResult")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "once the broker answers again events flow; the records")
	ctx.Equal(len(ctx.Redis.LRange(kHEventsOutbox, 0, -1)), 1, "a delivered event leaves no outbox row; the rows")
}

func CheckDelivery(ctx *harness.Ctx) {
	ctx.NoError(hEventsPublish("acme", hEventsHit(0.93, 41, "human")), "publishResult on a healthy broker")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "one lookup must produce one record; the records")
	lost := ctx.Kafka.Failover(kHEventsTopic)
	ctx.Equal(lost, 0, "a leader failover right after the write lost the record: it was acknowledged by the leader alone (RequiredAcks: kafka.RequireAll, a synchronous write); records lost")
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "after a leader failover the record must still be on the topic; the records")
}

func CheckProduceFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(kHEventsTopic, 1)
	err := hEventsPublish("acme", hEventsHit(0.93, 41, "human"))
	ctx.Settle()
	ctx.Assert(err != nil, "the broker rejected the produce and publishResult returned nil as if the event were recorded: return ErrProduceRejected after the outbox row")
	ctx.Assert(errors.Is(err, ErrProduceRejected), "publishResult returned %v, expected an error wrapping ErrProduceRejected", err)
	failures, _ := ctx.Redis.Get("cache_result_produce_failures")
	ctx.Equal(failures, "1", "cache_result_produce_failures after one rejection")
	ctx.NoError(hEventsPublish("acme", hEventsHit(0.93, 41, "human")), "a delivered produce must not fail")
	ctx.Settle()
	failures, _ = ctx.Redis.Get("cache_result_produce_failures")
	ctx.Equal(failures, "1", "a delivered produce must not count as a failure; cache_result_produce_failures")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kHEventsTopic = "semantic-cache.result";
const std::string kHEventsGroup = "semantic-cache-stats";
const std::string kHEventsOutbox = "outbox:semantic-cache.result";
const std::string kHEventsAnswer = "Refunds take five business days.";
const std::vector<std::string> kHEventsWire = {"outcome", "entry_id", "similarity", "policy_version", "model_version", "client_class", "entry_age_seconds"};

ResultEvent hEventsHit(double similarity, long age, const std::string& cls) {
  return ResultEvent{"hit", "e1", similarity, "2024-06-1", "2024-06", cls, age};
}

ResultEvent hEventsMiss(const std::string& cls) { return ResultEvent{"miss", "", std::nullopt, "", "2024-06", cls, 0}; }

// The entry a hit refers to, as the store holds it.
void hEventsEntry(harness::Ctx& ctx, const std::string& tenant, const std::string& entryId) {
  ctx.Redis.Do("HSET", "entry:" + tenant + ":2024-06:" + entryId, "embedding", "[1,0,0,0]", "answer", kHEventsAnswer, "created_at", 0,
               "expires_at", 86400, "policy_version", "2024-06-1");
}

// publish_result, reporting the exception's type (empty when none) instead of ending the check.
std::string hEventsPublish(const std::string& tenant, const ResultEvent& result) {
  try {
    publish_result(tenant, result);
    return "";
  } catch (const ProduceRejected&) {
    return "ProduceRejected";
  } catch (const std::exception& e) {
    return std::string("exception: ") + e.what();
  }
}

nlohmann::json hParsed(const std::string& text) {
  try {
    return nlohmann::json::parse(text);
  } catch (const std::exception&) {
    return nlohmann::json();
  }
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  hEventsEntry(ctx, "acme", "e1");
  ctx.Equal(hEventsPublish("acme", hEventsHit(0.93, 41, "human")), "", "publish_result on a healthy broker threw");
  ctx.Equal(hEventsPublish("globex", hEventsMiss("human")), "", "publish_result on a healthy broker threw");
  ctx.Equal(hEventsPublish("acme", hEventsHit(0.88, 4000, "automated")), "", "publish_result on a healthy broker threw");
  ctx.Equal(hEventsPublish("acme", hEventsHit(0.9, 3600, "human")), "", "publish_result on a healthy broker threw");
  ctx.Equal(hEventsPublish("globex", hEventsMiss("automated")), "", "publish_result on a healthy broker threw");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kHEventsTopic);
  ctx.Equal(records.size(), 5, "five lookups must produce five records on %s; the records", kHEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), {"acme", "globex", "acme", "acme", "globex"}, "records must be keyed by the tenant");
  ctx.Assert(records[0].Partition == records[2].Partition && records[0].Partition == records[3].Partition &&
                 records[1].Partition == records[4].Partition,
             "the same tenant must land on the same partition so its hits and misses are read as one stream");
  ctx.Drain([] { consume_results(); });
  const auto acme = ctx.Redis.HGetAll("stats:acme:2024-06");
  const auto field = [](const std::map<std::string, std::string>& h, const std::string& f) { return h.count(f) ? h.at(f) : ""; };
  ctx.Assert(field(acme, "hits_total") == "3" && (field(acme, "misses_total") == "" || field(acme, "misses_total") == "0"),
             "stats:acme:2024-06 holds %v, expected hits_total 3 and no misses", acme);
  const double sum = field(acme, "similarity_sum").empty() ? 0 : std::stod(field(acme, "similarity_sum"));
  ctx.Assert(sum > 2.7099 && sum < 2.7101, "similarity_sum is %q, expected 0.93 + 0.88 + 0.9 = 2.71", field(acme, "similarity_sum"));
  ctx.Assert(field(acme, "automated_total") == "1" && field(acme, "automated_hits") == "1",
             "stats:acme:2024-06 holds %v, expected automated_total 1 and automated_hits 1 for the automated hit", acme);
  ctx.Equal(field(acme, "hits_older_than_1h"), "1",
            "hits_older_than_1h: the hit on a 4000 s old entry counts, the one on a 3600 s old entry is not over an hour (stats:acme:2024-06 holds %v)",
            acme);
  const auto globex = ctx.Redis.HGetAll("stats:globex:2024-06");
  ctx.Assert(field(globex, "misses_total") == "2" && (field(globex, "hits_total") == "" || field(globex, "hits_total") == "0"),
             "stats:globex:2024-06 holds %v, expected misses_total 2", globex);
  ctx.Assert(field(globex, "automated_total") == "1" && (field(globex, "automated_hits") == "" || field(globex, "automated_hits") == "0"),
             "stats:globex:2024-06 holds %v, expected automated_total 1 and no automated_hits: the automated lookup was a miss", globex);
  ctx.Equal(ctx.Kafka.Lag(kHEventsGroup, kHEventsTopic), 0, "records the consumer left uncommitted");
}

void CheckNoText(harness::Ctx& ctx) {
  hEventsEntry(ctx, "acme", "e1");
  ctx.Equal(hEventsPublish("acme", hEventsHit(0.93, 41, "human")), "", "publish_result on a healthy broker threw");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kHEventsTopic);
  ctx.Equal(records.size(), 1, "one lookup must produce one record; the records");
  const std::string text = records[0].Value.value_or("");
  const auto event = hParsed(text);
  ctx.Assert(event.is_object(), "the event must be JSON: %s", text);
  ctx.Assert(text.find(kHEventsAnswer) == std::string::npos,
             "the event carries the served answer: %s. The topic is retained and replicated; the entry id is enough to find the answer in the store",
             text);
  ctx.Assert(!event.contains("answer"), "the event has an answer field: %s", text);
  for (const auto& f : kHEventsWire) ctx.Assert(event.contains(f), "the event %s lacks %s", text, f);
  ctx.Assert(event["entry_id"] == "e1" && event["outcome"] == "hit" && event["similarity"] == 0.93 && event["client_class"] == "human" &&
                 event["entry_age_seconds"] == 41,
             "the event's fields must come from the result the lookup passed: %s", text);
}

void CheckOutbox(harness::Ctx& ctx) {
  hEventsEntry(ctx, "acme", "e1");
  ctx.Kafka.FailNext(kHEventsTopic, 1);
  hEventsPublish("acme", hEventsHit(0.93, 41, "human"));
  ctx.Settle();
  const auto rows = ctx.Redis.LRange(kHEventsOutbox, 0, -1);
  ctx.Equal(rows.size(), 1, "after the broker rejected the produce %s must hold one row with the event; it holds %v; rows", kHEventsOutbox, rows);
  const auto row = hParsed(rows[0]);
  ctx.Assert(row.is_object() && row.value("key", "") == "acme",
             "the outbox row must carry the message key (the tenant) so the relay publishes it to the same partition (%s)", rows[0]);
  nlohmann::json payload;
  if (row.contains("payload")) payload = row["payload"].is_string() ? hParsed(row["payload"].get<std::string>()) : row["payload"];
  ctx.Assert(payload.is_object() && payload.value("outcome", "") == "hit" && payload.value("entry_id", "") == "e1",
             "the outbox row must carry the event payload: %s", rows[0]);
  bool wire = payload.is_object() && !payload.contains("answer") && rows[0].find(kHEventsAnswer) == std::string::npos;
  for (const auto& f : kHEventsWire) wire = wire && payload.contains(f);
  ctx.Assert(wire, "the outbox row's payload must be the event, its seven fields and no answer text: %s. The relay republishes it to the same retained topic",
             rows[0]);
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 0, "a rejected produce cannot be on the topic; the records");
  ctx.Equal(hEventsPublish("globex", hEventsMiss("human")), "", "after the broker recovered publish_result threw");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1, "once the broker answers again events flow; the records");
  ctx.Equal(ctx.Redis.LRange(kHEventsOutbox, 0, -1).size(), 1, "a delivered event leaves no outbox row; the rows");
}

void CheckDelivery(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kHEventsTopic, 1);
  ctx.Equal(hEventsPublish("acme", hEventsHit(0.93, 41, "human")), "", "publish_result threw: a lost acknowledgement is retried by the client, not reported;");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1,
            "after one lost acknowledgement the topic must hold one record: the retry duplicated the event (enable.idempotence); the records");
  hEventsPublish("acme", hEventsMiss("human"));
  ctx.Settle();
  ctx.Kafka.Failover(kHEventsTopic);
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 2,
            "after a leader failover the topic must hold both records: a record acknowledged by the leader alone is lost (acks=all); the records");
}

void CheckProduceFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kHEventsTopic, 1);
  const std::string raised = hEventsPublish("acme", hEventsHit(0.93, 41, "human"));
  ctx.Settle();
  ctx.Assert(!raised.empty(),
             "the broker rejected the produce and publish_result returned as if the event were recorded: throw ProduceRejected after the outbox row");
  ctx.Equal(raised, "ProduceRejected", "publish_result must throw ProduceRejected; it threw");
  ctx.Equal(ctx.Redis.Get("cache_result_produce_failures"), "1", "cache_result_produce_failures after one rejection");
  ctx.Equal(hEventsPublish("acme", hEventsHit(0.93, 41, "human")), "", "a delivered produce must not throw;");
  ctx.Settle();
  ctx.Equal(ctx.Redis.Get("cache_result_produce_failures"), "1", "a delivered produce must not count as a failure; cache_result_produce_failures");
}
`,
  },
  debrief: `The key is the tenant because the key is the partition, and a partition is the only unit Kafka keeps in order and the consumer drains at one pace: with a tenant's hits and misses on one partition, \`hits_total\` and \`misses_total\` read together describe one prefix of its history, so the rate is a number and not a flicker. The counter updates themselves are commutative, which is why the consumer can be simple. The payload carries ids and numbers because the topic outlives the request and is copied to every consumer; the store is where the text lives. The outbox row plus the raised error are one decision seen from two sides: the row makes the event recoverable, the error keeps the caller from believing it was recorded. A production stream adds a relay that drains the outbox and a schema registry pinning the seven fields.`,
};
