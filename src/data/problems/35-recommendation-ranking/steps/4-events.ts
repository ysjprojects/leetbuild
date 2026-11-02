import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Impression events keyed by user, with identifiers only',
  concept: 'kafka',
  file: 'events',
  focus: ['recsvc', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter implements \`publish_impression(tenant, user_id, items,
model_version, fallback)\`, how the Recommendation API reports what it showed after a ranking;
\`items\` is the ranked list the response carried (at most \`MAX_ITEMS = 30\`, each with its \`id\`,
\`score\` and zero-based \`position\`). It builds one event per response, produces it to
\`recsys.impression\` through an idempotent producer, and the Impression consumer folds each event
into per-item counters, so the exposure dashboard fills in. It serves the demo and hides four
flaws.

**Failure mode the checks target.** A replay that cannot reconstruct the order one user saw, a
retained and replicated topic that quietly becomes a feature store nobody owns, an exposure row that
cannot say which slot an item sat in or whether the list was degraded, and a served impression that
the broker rejected and nobody will ever re-capture.

- The produce key is the **user id** (\`key=user_id\`, \`key: userId\`, \`Key: []byte(userID)\`), so
  every impression of one user lands on one partition in order.
- The payload carries identifiers and rendition facts only: \`candidate_ids\` (the candidates that
  were shown, in rank order), the \`positions\` they were rendered at, the \`model_version\` that
  ranked them, and \`fallback\` when the ranking was degraded.
- No raw feature value (no \`features\`/\`vector\`/\`embedding\` array) and no user PII (\`email\`,
  \`name\`): whatever is published there outlives the request.
- The producer is **idempotent with \`acks=all\`** (\`enable.idempotence\` with \`acks\`, KafkaJS's
  \`idempotent: true\`, \`RequireAll\` with the hash balancer), so a retried produce cannot publish the
  same impression twice.
- When the broker rejects the produce, write the event as an **outbox** row (\`outbox.put(...)\`)
  instead of dropping it; a relay republishes outbox rows when the broker recovers.
- The consumer folds the event into the counters (\`HINCRBY impressions:{tenant}:{candidate_id} shown\`)
  and **only then** commits the offset.`,
  sequence: {
    participants: ['Recommendation API', 'recsys.impression', 'Impression consumer', 'Redis'],
    messages: [
      {
        from: 'Recommendation API',
        to: 'recsys.impression',
        label: 'produce · key = user_id · acks = all',
        kind: 'sync',
      },
      {from: 'recsys.impression', to: 'Recommendation API', label: 'ack / broker rejection', kind: 'reply'},
      {
        from: 'Recommendation API',
        to: 'Recommendation API',
        label: 'outbox.put(tenant, user_id, event) when rejected',
        kind: 'sync',
      },
      {
        from: 'recsys.impression',
        to: 'Impression consumer',
        label: 'consume · group impression-counters',
        kind: 'async',
      },
      {
        from: 'Impression consumer',
        to: 'Redis',
        label: 'HINCRBY impressions:{tenant}:{candidate_id} shown',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Impression consumer', label: 'counter value', kind: 'reply'},
      {
        from: 'Impression consumer',
        to: 'recsys.impression',
        label: 'commit offset after folding',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'user-key',
      title: 'Keyed by the user id, so one user’s exposure stream stays ordered',
      detail:
        'The message key is the user id — `key=user_id`, `key: userId`, `Key: []byte(userID)` — so all impressions of one user land on one partition in order. The starter keys by the first item id, so a user’s exposure stream is scattered across partitions and the order the counters are reconciled against is gone.',
      match: {
        python: {all: [/recsys\.impression/, /key=user_id/]},
        typescript: {all: [/recsys\.impression/, /key:\s*userId/]},
        go: {all: [/recsys\.impression/, /Key:\s*\[\]byte\(userID\)/]},
        scala: {all: [/recsys\.impression/, /new ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*userId\s*,/]},
        cpp: {all: [/recsys\.impression/, /userId\.c_str\(\),\s*userId\.size\(\)/]},
      },
    },
    {
      id: 'no-features',
      title: 'Carries identifiers only — no feature values, no PII',
      detail:
        'The payload never carries a raw feature vector (`features` / `vector` / `embedding`) and never user PII (`email`, `name`). The starter copies the item features into the event so the training pipeline can skip a join — and the topic is retained and replicated for days, so that copy outlives the request.',
      match: {
        python: {
          all: [/recsys\.impression/],
          none: [/features|Features/, /embedding|Embedding/, /["']vector["']/, /email|Email/, /full_name|FullName/],
        },
        typescript: {
          all: [/recsys\.impression/],
          none: [/features|Features/, /embedding|Embedding/, /\bvector\b/, /email|Email/, /full_name|FullName/],
        },
        go: {
          all: [/recsys\.impression/],
          none: [/features|Features/, /embedding|Embedding/, /"vector"/, /email|Email/, /full_name|FullName/],
        },
        scala: {
          all: [/recsys\.impression/],
          none: [/features|Features/, /embedding|Embedding/, /"vector"/, /email|Email/, /full_name|FullName/],
        },
        cpp: {
          all: [/recsys\.impression/],
          none: [/features|Features/, /embedding|Embedding/, /"vector"/, /email|Email/, /full_name|FullName/],
        },
      },
    },
    {
      id: 'payload-ids',
      title: 'Payload carries the shown ids, their positions, model_version and fallback',
      detail:
        'The event carries `candidate_ids`, the `positions` they were rendered at, the `model_version` that ranked them and the `fallback` flag for a degraded ranking. The starter ships ids and a feature blob and no positions or flag, so an impression can be neither attributed to a slot nor told apart from a real model result.',
      match: {
        python: {
          all: [
            /["']candidate_ids["']\s*:/,
            /["']positions["']\s*:/,
            /["']model_version["']\s*:/,
            /["']fallback["']\s*:/,
          ],
        },
        typescript: {all: [/candidate_ids\s*:/, /positions\s*:/, /model_version\s*:/, /fallback\s*:/]},
        go: {all: [/json:"candidate_ids"/, /json:"positions"/, /json:"model_version"/, /json:"fallback"/]},
        scala: {all: [/\bcandidate_ids\b/, /\bpositions\b/, /\bmodel_version\b/, /\bfallback\b/]},
        cpp: {all: [/["']candidate_ids["']/, /["']positions["']/, /["']model_version["']/, /["']fallback["']/]},
      },
    },
    {
      id: 'producer-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` plus `acks`, KafkaJS’s `idempotent: true` with an explicit `acks`, or the Go writer’s `RequireAll` with the hash balancer — so a retried produce cannot publish the same impression twice.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce is kept in the outbox, not dropped',
      detail:
        'When the broker rejects the produce the event is written as an outbox row (`outbox.put(...)` / `outbox.Put(...)`) inside the failure branch, for a relay to republish. The starter acks the produce and drops the rejection, so an impression that was served is lost without a trace.',
      match: {
        python: {all: [/outbox\.put\(/, /except\s+KafkaException/]},
        typescript: {all: [/outbox\.put\(/, /catch\s*\(/]},
        go: {all: [/outbox\.Put\(/, /err != nil/]},
        scala: {all: [/outbox\.put\(/, /catch\s*\{/]},
        cpp: {all: [/outbox\.put\(/, /ERR_NO_ERROR/]},
      },
    },
  ],
  code: {
    python: {
      starter: `# publish_impression: report what a ranked response showed, once per response.
import json
import uuid

import redis
from confluent_kafka import Consumer, Producer

TOPIC = "recsys.impression"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class RankedItem:
    """One item of the ranked response, with the slot it was rendered at."""

    def __init__(self, id: str, score: float, position: int, features: list[float]) -> None:
        self.id = id
        self.score = score
        self.position = position
        self.features = features


class OutboxStore:
    def put(self, tenant: str, user_id: str, event: dict) -> None:
        """One row per undelivered impression; the relay republishes it to the topic."""
        raise NotImplementedError


outbox = OutboxStore()


def publish_impression(
    tenant: str, user_id: str, items: list[RankedItem], model_version: str, fallback: bool
) -> None:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    event = {
        "id": str(uuid.uuid4()),
        "tenant": tenant,
        "user_id": user_id,
        "candidate_ids": [item.id for item in items],
        "features": [item.features for item in items],
        "model_version": model_version,
    }
    producer.produce(TOPIC, key=items[0].id, value=json.dumps(event))
    producer.flush(2.0)


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "impression-counters", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        for candidate_id in event["candidate_ids"]:
            r.hincrby(f"impressions:{event['tenant']}:{candidate_id}", "shown", 1)
        consumer.commit(msg)
`,
      solution: `# publish_impression: report what a ranked response showed, once per response.
import json
import uuid

import redis
from confluent_kafka import Consumer, KafkaException, Producer

TOPIC = "recsys.impression"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class RankedItem:
    """One item of the ranked response, with the slot it was rendered at."""

    def __init__(self, id: str, score: float, position: int) -> None:
        self.id = id
        self.score = score
        self.position = position


class OutboxStore:
    def put(self, tenant: str, user_id: str, event: dict) -> None:
        """One row per undelivered impression; the relay republishes it to the topic."""
        raise NotImplementedError


outbox = OutboxStore()


def publish_impression(
    tenant: str, user_id: str, items: list[RankedItem], model_version: str, fallback: bool
) -> None:
    event = {
        "id": str(uuid.uuid4()),
        "tenant": tenant,
        "user_id": user_id,
        "candidate_ids": [item.id for item in items],
        "positions": [item.position for item in items],
        "model_version": model_version,
        "fallback": fallback,
    }
    payload = json.dumps(event)
    try:
        producer.produce(TOPIC, key=user_id, value=payload)
        producer.flush(2.0)
    except KafkaException:
        outbox.put(tenant, user_id, event)


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "impression-counters", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        for candidate_id in event["candidate_ids"]:
            r.hincrby(f"impressions:{event['tenant']}:{candidate_id}", "shown", 1)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** publish_impression: report what a ranked response showed, once per response. */
import {randomUUID} from 'node:crypto';

import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

const TOPIC = 'recsys.impression';

const kafka = new Kafka({clientId: 'recommendations', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

export interface RankedItem {
  id: string;
  score: number;
  position: number;
  features: number[];
}

export interface ImpressionEvent {
  id: string;
  tenant: string;
  user_id: string;
  candidate_ids: string[];
  model_version: string;
}

/** One row per undelivered impression; the relay republishes it to the topic. */
export class OutboxStore {
  async put(tenant: string, userId: string, event: ImpressionEvent): Promise<void> {
    throw new Error('not implemented');
  }
}

export const outbox = new OutboxStore();

export async function publishImpression(
  tenant: string,
  userId: string,
  items: RankedItem[],
  modelVersion: string,
  fallback: boolean,
): Promise<void> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const event = {
    id: randomUUID(),
    tenant,
    user_id: userId,
    candidate_ids: items.map(item => item.id),
    features: items.map(item => item.features),
    model_version: modelVersion,
  };
  await producer.send({
    topic: TOPIC,
    acks: -1,
    messages: [{key: items[0].id, value: JSON.stringify(event)}],
  });
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'impression-counters'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {tenant: string; candidate_ids: string[]};
      for (const candidateId of event.candidate_ids) {
        await r.hincrby(\`impressions:\${event.tenant}:\${candidateId}\`, 'shown', 1);
      }
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
      solution: `/** publish_impression: report what a ranked response showed, once per response. */
import {randomUUID} from 'node:crypto';

import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

const TOPIC = 'recsys.impression';

const kafka = new Kafka({clientId: 'recommendations', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

export interface RankedItem {
  id: string;
  score: number;
  position: number;
}

export interface ImpressionEvent {
  id: string;
  tenant: string;
  user_id: string;
  candidate_ids: string[];
  positions: number[];
  model_version: string;
  fallback: boolean;
}

/** One row per undelivered impression; the relay republishes it to the topic. */
export class OutboxStore {
  async put(tenant: string, userId: string, event: ImpressionEvent): Promise<void> {
    throw new Error('not implemented');
  }
}

export const outbox = new OutboxStore();

export async function publishImpression(
  tenant: string,
  userId: string,
  items: RankedItem[],
  modelVersion: string,
  fallback: boolean,
): Promise<void> {
  const event: ImpressionEvent = {
    id: randomUUID(),
    tenant,
    user_id: userId,
    candidate_ids: items.map(item => item.id),
    positions: items.map(item => item.position),
    model_version: modelVersion,
    fallback: fallback,
  };
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: userId, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await outbox.put(tenant, userId, event);
  }
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'impression-counters'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {tenant: string; candidate_ids: string[]};
      for (const candidateId of event.candidate_ids) {
        await r.hincrby(\`impressions:\${event.tenant}:\${candidateId}\`, 'shown', 1);
      }
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `// publish_impression: report what a ranked response showed, once per response.
package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const topic = "recsys.impression"

var impressionWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

var rdb *redis.Client

type RankedItem struct {
	ID       string    \`json:"id"\`
	Score    float64   \`json:"score"\`
	Position int       \`json:"position"\`
	Features []float64 \`json:"features"\`
}

// ImpressionEvent is the payload of one impression.
type ImpressionEvent struct {
	ID           string      \`json:"id"\`
	Tenant       string      \`json:"tenant"\`
	UserID       string      \`json:"user_id"\`
	CandidateIDs []string    \`json:"candidate_ids"\`
	Features     [][]float64 \`json:"features"\`
	ModelVersion string      \`json:"model_version"\`
}

// OutboxStore keeps one row per undelivered impression; the relay republishes it to the topic.
type OutboxStore struct{}

func (s *OutboxStore) Put(ctx context.Context, tenant, userID string, payload []byte) error {
	return nil
}

var outbox = &OutboxStore{}

func publishImpression(ctx context.Context, tenant, userID string, items []RankedItem, modelVersion string, fallback bool) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	candidateIDs := make([]string, 0, len(items))
	features := make([][]float64, 0, len(items))
	for _, item := range items {
		candidateIDs = append(candidateIDs, item.ID)
		features = append(features, item.Features)
	}
	event := ImpressionEvent{
		ID:           uuid.NewString(),
		Tenant:       tenant,
		UserID:       userID,
		CandidateIDs: candidateIDs,
		Features:     features,
		ModelVersion: modelVersion,
	}
	payload, _ := json.Marshal(event)
	log.Printf("impression tenant=%s user=%s items=%d", tenant, userID, len(candidateIDs))
	_ = impressionWriter.WriteMessages(ctx, kafka.Message{Key: []byte(items[0].ID), Value: payload})
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: "impression-counters",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event ImpressionEvent
		_ = json.Unmarshal(msg.Value, &event)
		for _, candidateID := range event.CandidateIDs {
			rdb.HIncrBy(ctx, "impressions:"+event.Tenant+":"+candidateID, "shown", 1)
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
      solution: `// publish_impression: report what a ranked response showed, once per response.
package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const topic = "recsys.impression"

var impressionWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

var rdb *redis.Client

type RankedItem struct {
	ID       string  \`json:"id"\`
	Score    float64 \`json:"score"\`
	Position int     \`json:"position"\`
}

// ImpressionEvent is the payload of one impression: identifiers only.
type ImpressionEvent struct {
	ID           string   \`json:"id"\`
	Tenant       string   \`json:"tenant"\`
	UserID       string   \`json:"user_id"\`
	CandidateIDs []string \`json:"candidate_ids"\`
	Positions    []int    \`json:"positions"\`
	ModelVersion string   \`json:"model_version"\`
	Fallback     bool     \`json:"fallback"\`
}

// OutboxStore keeps one row per undelivered impression; the relay republishes it to the topic.
type OutboxStore struct{}

func (s *OutboxStore) Put(ctx context.Context, tenant, userID string, payload []byte) error {
	return nil
}

var outbox = &OutboxStore{}

func publishImpression(ctx context.Context, tenant, userID string, items []RankedItem, modelVersion string, fallback bool) {
	candidateIDs := make([]string, 0, len(items))
	positions := make([]int, 0, len(items))
	for _, item := range items {
		candidateIDs = append(candidateIDs, item.ID)
		positions = append(positions, item.Position)
	}
	event := ImpressionEvent{
		ID:           uuid.NewString(),
		Tenant:       tenant,
		UserID:       userID,
		CandidateIDs: candidateIDs,
		Positions:    positions,
		ModelVersion: modelVersion,
		Fallback:     fallback,
	}
	payload, _ := json.Marshal(event)
	if err := impressionWriter.WriteMessages(ctx, kafka.Message{Key: []byte(userID), Value: payload}); err != nil {
		_ = outbox.Put(ctx, tenant, userID, payload)
	}
	log.Printf("impression tenant=%s user=%s items=%d", tenant, userID, len(candidateIDs))
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: "impression-counters",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event ImpressionEvent
		_ = json.Unmarshal(msg.Value, &event)
		for _, candidateID := range event.CandidateIDs {
			rdb.HIncrBy(ctx, "impressions:"+event.Tenant+":"+candidateID, "shown", 1)
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `// publish_impression: report what a ranked response showed, once per response.
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class RankedItem(id: String, score: Double, position: Int, features: List[Double])

final case class ImpressionEvent(
    id: String,
    tenant: String,
    user_id: String,
    candidate_ids: List[String],
    features: List[List[Double]],
    model_version: String
)

object Impressions {
  implicit val impressionFormat: RootJsonFormat[ImpressionEvent] = jsonFormat6(ImpressionEvent)

  val Topic = "recsys.impression"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new Jedis("redis", 6379)

  /** One row per undelivered impression; the relay republishes it to the topic. */
  object OutboxStore {
    def put(tenant: String, userId: String, payload: String): Unit = ()
  }

  val outbox = OutboxStore

  def publishImpression(
      tenant: String,
      userId: String,
      items: List[RankedItem],
      modelVersion: String,
      fallback: Boolean
  ): Unit = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val event = ImpressionEvent(
      id = java.util.UUID.randomUUID().toString,
      tenant = tenant,
      user_id = userId,
      candidate_ids = items.map(_.id),
      features = items.map(_.features),
      model_version = modelVersion
    )
    producer.send(new ProducerRecord[String, String](Topic, items.head.id, event.toJson.compactPrint))
    producer.flush()
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      records.forEach { record =>
        val event = record.value.parseJson.convertTo[ImpressionEvent]
        val tenant = event.tenant
        event.candidate_ids.foreach { candidateId =>
          jedis.hincrBy(s"impressions:$tenant:$candidateId", "shown", 1)
        }
        consumer.commitSync()
      }
    }
  }
}
`,
      solution: `// publish_impression: report what a ranked response showed, once per response.
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class RankedItem(id: String, score: Double, position: Int)

final case class ImpressionEvent(
    id: String,
    tenant: String,
    user_id: String,
    candidate_ids: List[String],
    positions: List[Int],
    model_version: String,
    fallback: Boolean
)

object Impressions {
  implicit val impressionFormat: RootJsonFormat[ImpressionEvent] = jsonFormat7(ImpressionEvent)

  val Topic = "recsys.impression"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new Jedis("redis", 6379)

  /** One row per undelivered impression; the relay republishes it to the topic. */
  object OutboxStore {
    def put(tenant: String, userId: String, payload: String): Unit = ()
  }

  val outbox = OutboxStore

  def publishImpression(
      tenant: String,
      userId: String,
      items: List[RankedItem],
      modelVersion: String,
      fallback: Boolean
  ): Unit = {
    val event = ImpressionEvent(
      id = java.util.UUID.randomUUID().toString,
      tenant = tenant,
      user_id = userId,
      candidate_ids = items.map(_.id),
      positions = items.map(_.position),
      model_version = modelVersion,
      fallback = fallback
    )
    val payload = event.toJson.compactPrint
    try {
      producer.send(new ProducerRecord[String, String](Topic, userId, payload))
      producer.flush()
    } catch {
      case _: Exception => outbox.put(tenant, userId, payload)
    }
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      records.forEach { record =>
        val event = record.value.parseJson.convertTo[ImpressionEvent]
        val tenant = event.tenant
        event.candidate_ids.foreach { candidateId =>
          jedis.hincrBy(s"impressions:$tenant:$candidateId", "shown", 1)
        }
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `// publish_impression: report what a ranked response showed, once per response.
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "recsys.impression";
constexpr int kAckTimeoutMs = 2000;

struct RankedItem {
  std::string id;
  double score = 0.0;
  int position = 0;
  std::vector<float> features;
};

// One row per undelivered impression; the relay republishes it to the topic.
struct OutboxStore {
  void put(const std::string& tenant, const std::string& userId, const std::string& payload);
};
OutboxStore outbox;

std::string newId();

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

void publishImpression(const std::string& tenant, const std::string& userId, const std::vector<RankedItem>& items,
                       const std::string& modelVersion, bool fallback) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  json candidateIds = json::array();
  json features = json::array();
  for (const auto& item : items) {
    candidateIds.push_back(item.id);
    features.push_back(item.features);
  }
  const json event = {
      {"id", newId()},
      {"tenant", tenant},
      {"user_id", userId},
      {"candidate_ids", candidateIds},
      {"features", features},
      {"model_version", modelVersion},
  };
  const auto payload = event.dump();
  const auto& key = items.front().id;
  const auto error = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                       const_cast<char*>(payload.data()), payload.size(), key.c_str(), key.size(),
                                       0, nullptr);
  (void)error;
  producer->flush(kAckTimeoutMs);
  std::cerr << "impression tenant=" << tenant << " user=" << userId << " items=" << candidateIds.size() << "\\n";
}

void consume(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& redis) {
  while (true) {
    auto message = consumer->consume(500);
    if (message->err() != RdKafka::ERR_NO_ERROR) {
      delete message;
      continue;
    }
    const auto event = json::parse(static_cast<RdKafka::Message*>(message)->payload(), nullptr, false);
    const auto tenant = event.value("tenant", std::string());
    for (const auto& candidateId : event.value("candidate_ids", json::array())) {
      redis.hincrby("impressions:" + tenant + ":" + candidateId.get<std::string>(), "shown", 1);
    }
    consumer->commitSync(message);
    delete message;
  }
}
`,
      solution: `// publish_impression: report what a ranked response showed, once per response.
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "recsys.impression";
constexpr int kAckTimeoutMs = 2000;

struct RankedItem {
  std::string id;
  double score = 0.0;
  int position = 0;
};

// One row per undelivered impression; the relay republishes it to the topic.
struct OutboxStore {
  void put(const std::string& tenant, const std::string& userId, const std::string& payload);
};
OutboxStore outbox;

std::string newId();

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

void publishImpression(const std::string& tenant, const std::string& userId, const std::vector<RankedItem>& items,
                       const std::string& modelVersion, bool fallback) {
  json candidateIds = json::array();
  json positions = json::array();
  for (const auto& item : items) {
    candidateIds.push_back(item.id);
    positions.push_back(item.position);
  }
  const json event = {
      {"id", newId()},
      {"tenant", tenant},
      {"user_id", userId},
      {"candidate_ids", candidateIds},
      {"positions", positions},
      {"model_version", modelVersion},
      {"fallback", fallback},
  };
  const std::string payload = event.dump();
  const RdKafka::ErrorCode error = producer->produce(
      kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
      payload.size(), userId.c_str(), userId.size(), 0, nullptr);
  if (error != RdKafka::ERR_NO_ERROR) outbox.put(tenant, userId, payload);
  producer->flush(kAckTimeoutMs);
  std::cerr << "impression tenant=" << tenant << " user=" << userId << " items=" << candidateIds.size() << "\\n";
}

void consume(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& redis) {
  while (true) {
    auto message = consumer->consume(500);
    if (message->err() != RdKafka::ERR_NO_ERROR) {
      delete message;
      continue;
    }
    const auto event = json::parse(static_cast<RdKafka::Message*>(message)->payload(), nullptr, false);
    const auto tenant = event.value("tenant", std::string());
    for (const auto& candidateId : event.value("candidate_ids", json::array())) {
      redis.hincrby("impressions:" + tenant + ":" + candidateId.get<std::string>(), "shown", 1);
    }
    consumer->commitSync(message);
    delete message;
  }
}
`,
    },
  },
  hints: [
    "A data engineer replaying one user's exposure stream gets items out of order, finds float arrays in a topic retained for days, cannot tell slot 1 from slot 30, and sees counters that under-report during a broker incident.",
    "The record key is the first item id, so a user's events spread across partitions; the payload copies each item's feature values and omits positions and the fallback flag; the produce failure is logged and the event is discarded.",
    'Produce with `key=user_id`; build the payload from `candidate_ids`, `positions`, `model_version` and `fallback` only; wrap the produce in `except KafkaException` (or the language equivalent) and call `outbox.put(event)` there.',
  ],
  debrief: `A publish path that looks fire-and-forget decides what the training pipeline can prove later. The key is the user because partitioning by user is what makes an exposure stream ordered and replayable; partitioning by item looks natural because every event is about items, and silently reorders a user's shows. The payload is a join key, not a transport for the features that produced it: raw feature values in a topic retained for days become a retention problem, and the same payload is where a future edit adds an email. \`acks=all\` with an idempotent producer protects against the client's own retry duplicating an event, but only an outbox protects the impression the broker refused.

Production pipelines put a schema registry in front of the topic so a producer cannot smuggle in a new field, dedupe on an event id so a replay is idempotent, and set a retention or compaction policy per topic. The counters are folded before the offset is committed, so a crash replays the event instead of losing it.`,
};
