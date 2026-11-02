import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Return events keyed by return id',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'db'],
  task: `## Task

**Starting point.** The starter publishes one \`returns.event\` record per state change
(\`requested\`, \`received\`, \`graded\`, \`refunded\`) keyed by \`customer_id\`, with the photo's
CDN URL in the payload, and its consumer commits the offset, then runs
\`UPDATE returns SET state, refund_cents\`. It compiles, serves the demo, and hides 5 flaws.

**Failure mode the checks target.** Support opens a return whose timeline reads \`refunded\` before
\`graded\`; a refund event that the broker refused is gone after a restart; a return stays
\`requested\` after the money left; a week-old event still opens the customer's photo.

- The record key is the **return id**: one return's whole history lands in one partition so the
  consumer sees \`requested → received → graded → refunded\` in order.
- The payload carries \`state\`, \`grade\`, \`refund_cents\` and \`occurred_at\`; the photo reference
  leaves the service only as a **short-lived signed URL**, or not at all.
- The producer is idempotent and waits for all in-sync replicas (\`acks=all\`).
- When the broker **refuses** the record, whether a synchronous produce error or an asynchronous
  delivery failure, write an **outbox** row carrying the return id, the state and the payload so
  the relay republishes it.
- The consumer writes the new state **before** it commits the offset.`,
  sequence: {
    participants: ['Returns API', 'returns.event', 'Refund consumer', 'returns · db'],
    messages: [
      {from: 'Returns API', to: 'Returns API', label: 'build event · state · grade · refund_cents', kind: 'sync'},
      {
        from: 'Returns API',
        to: 'returns.event',
        label: 'produce key = return_id · acks=all · idempotent',
        kind: 'async',
      },
      {
        from: 'returns.event',
        to: 'Returns API',
        label: 'delivery failed → outbox row (return_id, state, payload)',
        kind: 'reply',
      },
      {
        from: 'returns.event',
        to: 'Refund consumer',
        label: 'consume · one return = one partition, in order',
        kind: 'async',
      },
      {from: 'Refund consumer', to: 'returns · db', label: 'UPDATE returns SET state, refund_cents', kind: 'sync'},
      {from: 'Refund consumer', to: 'Refund consumer', label: 'commit the offset only after the write', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'return-key',
      title: 'Keys the record by return id',
      detail:
        'The Kafka record key is `return_id`, not the customer, so every state of one return lands in the same partition and the consumer reads its history in order. Keying by customer interleaves every return that customer ever opened.',
      match: {
        python: {all: [/producer\.produce\(/, /key=return_id/]},
        typescript: {all: [/producer\.send\(/, /key:\s*input\.returnId/]},
        go: {
          all: [/writer\.WriteMessages\(/, /Key:\s*\[\]byte\(\s*event\.ReturnID\s*\)/, /Balancer:\s*&kafka\.Hash\{\}/],
        },
        scala: {all: [/producer\.send\(/, /ProducerRecord\[String, String\]\(\s*Topic\s*,\s*event\.return_id\s*,/]},
        cpp: {all: [/rd_kafka_producev\(/, /RD_KAFKA_V_KEY\(return_id/]},
      },
    },
    {
      id: 'event-fields',
      title: 'Carries state, grade and refund amount — and no long-lived photo link',
      detail:
        'The event carries `state`, `grade` and `refund_cents`, and the photo reference is a short-lived signed URL (or absent). A CDN URL with a week-long expiry is a permanent handle to the customer’s evidence; the starter ships exactly that.',
      match: {
        python: {
          all: [/["']state["']\s*:/, /["']grade["']\s*:/, /["']refund_cents["']\s*:/],
          none: [/photo_url/, /\b604800\b/],
        },
        typescript: {
          all: [/state:\s*input\.state/, /grade:\s*input\.grade/, /refund_cents:\s*input\.refundCents/],
          none: [/photo_url/, /\b604800\b/],
        },
        go: {
          all: [/json:"state"/, /json:"grade"/, /json:"refund_cents"/],
          none: [/photo_url/, /\b604800\b/],
        },
        scala: {
          all: [/state:\s*String/, /grade:\s*String/, /refund_cents:\s*Long/],
          none: [/photo_url/, /\b604800\b/],
        },
        cpp: {
          all: [/event\["state"\]/, /event\["grade"\]/, /event\["refund_cents"\]/],
          none: [/photo_url/, /\b604800\b/],
        },
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Persists a refused record to the outbox',
      detail:
        'A synchronous produce error and an asynchronous delivery failure both write an outbox row for the same key and payload. The starter logs the refusal and moves on, so a refunded event can vanish.',
      match: {
        python: {all: [/outbox\.insert\(/, /on_delivery=_delivered/, /BufferError|err is not None/]},
        typescript: {all: [/outbox\.insert\(/, /producer\.send\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /writer\.WriteMessages\(/, /err != nil/]},
        scala: {all: [/outbox\.insert\(/, /producer\.send\(/, /Exception/]},
        cpp: {
          all: [/outbox\.insert\(/, /rd_kafka_producev\(/, /message->err|err != RD_KAFKA_RESP_ERR_NO_ERROR/],
        },
      },
    },
    {
      id: 'state-before-commit',
      title: 'Writes refund state before committing the offset',
      detail:
        'The consumer persists the new state (`UPDATE returns SET state, refund_cents`) first and commits the offset only after that write returns. Committing first loses the state update whenever the process dies between the two — the return stays `requested` and the refund is never applied.',
      match: {
        python: {order: [/UPDATE returns SET state/, /consumer\.commit\(/]},
        typescript: {order: [/UPDATE returns SET state/, /commitOffsets\(/]},
        go: {order: [/UPDATE returns SET state/, /CommitMessages\(/]},
        scala: {order: [/UPDATE returns SET state/, /consumer\.commitSync\(/]},
        cpp: {order: [/UPDATE returns SET state/, /rd_kafka_commit\(/]},
      },
    },
    {
      id: 'durable-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer enables idempotence and waits for all in-sync replicas (`acks=all`): a leader failover cannot lose an acknowledged record and a retry cannot duplicate one. (kafka-go exposes no idempotent mode: `RequireAll` and a hash balancer are what it can promise.)',
      match: {
        python: {all: [/enable\.idempotence/, /"acks":\s*"all"/, /producer\.produce\(/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/, /producer\.send\(/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/, /writer\.WriteMessages\(/]},
        scala: {all: [/ENABLE_IDEMPOTENCE_CONFIG/, /ACKS_CONFIG/, /producer\.send\(/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/, /rd_kafka_producev\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
from datetime import datetime, timezone

import redis
from confluent_kafka import Consumer, Producer

logger = logging.getLogger("returns")

TOPIC = "returns.event"
PHOTO_URL_TTL_SECONDS = 604800

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Outbox:
    def insert(self, return_id: str, state: str, payload: str, reason: str = "") -> None:
        """Persist a record the broker refused so the relay republishes it."""
        raise NotImplementedError


outbox = Outbox()


class ReturnsDb:
    def execute(self, statement: str, params: tuple) -> None:
        """Run one statement, autocommitted."""
        raise NotImplementedError


db = ReturnsDb()


def build_event(
    return_id: str, customer_id: str, state: str, grade: str, refund_cents: int, photo_ref: str | None
) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "return_id": return_id,
        "customer_id": customer_id,
        "state": state,
        "grade": grade,
        "refund_cents": refund_cents,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    if photo_ref:
        event["photo_url"] = f"https://cdn.returns.example.com/{photo_ref}?expires_in={PHOTO_URL_TTL_SECONDS}"
    return event


def _failed(err, msg) -> None:
    if err is not None:
        logger.warning("returns.event record refused: %s", err)


def publish_return_event(
    return_id: str,
    customer_id: str,
    state: str,
    grade: str = "",
    refund_cents: int = 0,
    photo_ref: str | None = None,
) -> None:
    payload = json.dumps(build_event(return_id, customer_id, state, grade, refund_cents, photo_ref))
    producer.produce(TOPIC, key=customer_id, value=payload, on_delivery=_failed)
    producer.poll(0)


def run_refund_consumer() -> None:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "refund-projector",
            "enable.auto.commit": False,
            "auto.offset.reset": "earliest",
        }
    )
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        consumer.commit(record, asynchronous=False)
        event = json.loads(record.value())
        db.execute(
            "UPDATE returns SET state = %s, refund_cents = %s WHERE id = %s",
            (event["state"], event["refund_cents"], event["return_id"]),
        )
        if event["state"] == "refunded":
            r.set(f"refund:{event['return_id']}", event["refund_cents"])
`,
      solution: `import json
from datetime import datetime, timezone

import redis
from confluent_kafka import Consumer, Producer

TOPIC = "returns.event"
PHOTO_REF_TTL_SECONDS = 300

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Outbox:
    def insert(self, return_id: str, state: str, payload: str, reason: str = "") -> None:
        """Persist a record the broker refused so the relay republishes it."""
        raise NotImplementedError


outbox = Outbox()


class ReturnsDb:
    def execute(self, statement: str, params: tuple) -> None:
        """Run one statement, autocommitted."""
        raise NotImplementedError


db = ReturnsDb()


def sign_photo_ref(photo_ref: str, ttl_seconds: int = PHOTO_REF_TTL_SECONDS) -> str:
    """A URL for the photo that expires; the event must never carry a permanent link."""
    raise NotImplementedError


def build_event(return_id: str, state: str, grade: str, refund_cents: int, photo_ref: str | None) -> dict:
    event = {
        "return_id": return_id,
        "state": state,
        "grade": grade,
        "refund_cents": refund_cents,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    if photo_ref:
        event["photo_ref"] = sign_photo_ref(photo_ref)
    return event


def _delivered(err, msg) -> None:
    if err is not None:
        payload = msg.value().decode()
        event = json.loads(payload)
        outbox.insert(event["return_id"], event["state"], payload, str(err))


def publish_return_event(
    return_id: str, state: str, grade: str = "", refund_cents: int = 0, photo_ref: str | None = None
) -> None:
    payload = json.dumps(build_event(return_id, state, grade, refund_cents, photo_ref))
    try:
        producer.produce(TOPIC, key=return_id, value=payload, on_delivery=_delivered)
        producer.poll(0)
    except BufferError:
        outbox.insert(return_id, state, payload, "producer queue full")


def run_refund_consumer() -> None:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "refund-projector",
            "enable.auto.commit": False,
            "auto.offset.reset": "earliest",
        }
    )
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        event = json.loads(record.value())
        db.execute(
            "UPDATE returns SET state = %s, refund_cents = %s WHERE id = %s",
            (event["state"], event["refund_cents"], event["return_id"]),
        )
        if event["state"] == "refunded":
            r.set(f"refund:{event['return_id']}", event["refund_cents"])
        consumer.commit(record, asynchronous=False)
`,
    },
    typescript: {
      starter: `/** Publishes returns.event records and projects them into the returns table. */
import {Kafka, type EachMessagePayload} from 'kafkajs';
import Redis from 'ioredis';

export const TOPIC = 'returns.event';
export const PHOTO_URL_TTL_SECONDS = 604800;

const kafka = new Kafka({clientId: 'returns', brokers: ['kafka:9092']});
const producer = kafka.producer();
const redis = new Redis({host: 'redis', port: 6379});
let connected: Promise<void> | null = null;

export function connect(): Promise<void> {
  if (connected === null) connected = producer.connect();
  return connected;
}

export interface ReturnEvent {
  return_id: string;
  customer_id: string;
  state: string;
  grade: string | null;
  refund_cents: number;
  photo_url?: string;
  occurred_at: string;
}

export interface EventInput {
  returnId: string;
  customerId: string;
  state: string;
  grade: string | null;
  refundCents: number;
  photoRef?: string;
}

class Outbox {
  async insert(returnId: string, state: string, payload: string, reason: string): Promise<void> {
    void returnId;
    void state;
    void payload;
    void reason;
    throw new Error('the outbox table is provided by the platform layer');
  }
}
export const outbox = new Outbox();

class ReturnsDb {
  async execute(statement: string, params: unknown[]): Promise<void> {
    void statement;
    void params;
    throw new Error('the returns database is provided by the platform layer');
  }
}
export const db = new ReturnsDb();

export function buildEvent(input: EventInput): ReturnEvent {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  return {
    return_id: input.returnId,
    customer_id: input.customerId,
    state: input.state,
    grade: input.grade,
    refund_cents: input.refundCents,
    photo_url:
      input.photoRef === undefined
        ? undefined
        : \`https://cdn.returns.example.com/\${input.photoRef}?expires_in=\${PHOTO_URL_TTL_SECONDS}\`,
    occurred_at: new Date().toISOString(),
  };
}

export async function publishReturnEvent(input: EventInput): Promise<void> {
  const payload = JSON.stringify(buildEvent(input));
  await connect();
  try {
    await producer.send({topic: TOPIC, messages: [{key: input.customerId, value: payload}]});
  } catch (error) {
    console.warn('returns.event record refused', error);
  }
}

export async function runRefundConsumer(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'refund-projector'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}: EachMessagePayload) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as ReturnEvent;
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await db.execute('UPDATE returns SET state = $1, refund_cents = $2 WHERE id = $3', [
        event.state,
        event.refund_cents,
        event.return_id,
      ]);
      if (event.state === 'refunded') await redis.set(\`refund:\${event.return_id}\`, event.refund_cents);
    },
  });
}
`,
      solution: `/** Publishes returns.event records keyed by return and projects them before committing. */
import {Kafka, type EachMessagePayload} from 'kafkajs';
import Redis from 'ioredis';

export const TOPIC = 'returns.event';
/** A reference, not a link: a signed URL must expire long before the photo's retention does. */
export const PHOTO_REF_TTL_SECONDS = 300;

const kafka = new Kafka({clientId: 'returns', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
const redis = new Redis({host: 'redis', port: 6379});
let connected: Promise<void> | null = null;

export function connect(): Promise<void> {
  if (connected === null) connected = producer.connect();
  return connected;
}

export interface ReturnEvent {
  return_id: string;
  state: string;
  grade: string | null;
  refund_cents: number;
  photo_ref?: string;
  occurred_at: string;
}

export interface EventInput {
  returnId: string;
  state: string;
  grade: string | null;
  refundCents: number;
  photoRef?: string;
}

class Outbox {
  async insert(returnId: string, state: string, payload: string, reason: string): Promise<void> {
    void returnId;
    void state;
    void payload;
    void reason;
    throw new Error('the outbox table is provided by the platform layer');
  }
}
export const outbox = new Outbox();

class ReturnsDb {
  async execute(statement: string, params: unknown[]): Promise<void> {
    void statement;
    void params;
    throw new Error('the returns database is provided by the platform layer');
  }
}
export const db = new ReturnsDb();

/** A signed URL that expires after \`ttlSeconds\` (provided by the signing service). */
export function signPhotoRef(photoRef: string, ttlSeconds: number): string {
  void photoRef;
  void ttlSeconds;
  throw new Error('the signing service is provided by the platform layer');
}

export function buildEvent(input: EventInput): ReturnEvent {
  return {
    return_id: input.returnId,
    state: input.state,
    grade: input.grade,
    refund_cents: input.refundCents,
    photo_ref:
      input.photoRef === undefined ? undefined : signPhotoRef(input.photoRef, PHOTO_REF_TTL_SECONDS),
    occurred_at: new Date().toISOString(),
  };
}

export async function publishReturnEvent(input: EventInput): Promise<void> {
  const payload = JSON.stringify(buildEvent(input));
  await connect();
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: input.returnId, value: payload}],
    });
  } catch (error) {
    await outbox.insert(input.returnId, input.state, payload, String(error));
  }
}

export async function runRefundConsumer(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'refund-projector'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}: EachMessagePayload) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as ReturnEvent;
      await db.execute('UPDATE returns SET state = $1, refund_cents = $2 WHERE id = $3', [
        event.state,
        event.refund_cents,
        event.return_id,
      ]);
      if (event.state === 'refunded') await redis.set(\`refund:\${event.return_id}\`, event.refund_cents);
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
	"database/sql"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const topic = "returns.event"

type returnEvent struct {
	ReturnID    string \`json:"return_id"\`
	CustomerID  string \`json:"customer_id"\`
	State       string \`json:"state"\`
	Grade       string \`json:"grade"\`
	RefundCents int64  \`json:"refund_cents"\`
	PhotoURL    string \`json:"photo_url,omitempty"\`
	OccurredAt  string \`json:"occurred_at"\`
}

type outboxStore interface {
	Insert(ctx context.Context, returnID, state, payload, reason string) error
}

var (
	writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic}
	outbox outboxStore
	db     *sql.DB
	rdb    *redis.Client
)

func buildEvent(returnID, customerID, state, grade string, refundCents int64, photoRef string) returnEvent {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	event := returnEvent{
		ReturnID:    returnID,
		CustomerID:  customerID,
		State:       state,
		Grade:       grade,
		RefundCents: refundCents,
		OccurredAt:  time.Now().UTC().Format(time.RFC3339),
	}
	if photoRef != "" {
		event.PhotoURL = "https://cdn.returns.example.com/" + photoRef + "?expires_in=604800"
	}
	return event
}

func publishReturnEvent(ctx context.Context, event returnEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.CustomerID), Value: payload}); err != nil {
		log.Printf("returns.event record refused: %v", err)
	}
	return nil
}

func runRefundConsumer(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		GroupID: "refund-projector",
		Topic:   topic,
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event returnEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if _, err := db.ExecContext(ctx,
			"UPDATE returns SET state = $1, refund_cents = $2 WHERE id = $3",
			event.State, event.RefundCents, event.ReturnID); err != nil {
			return err
		}
		tx := rdb.Pipeline()
		tx.Set(ctx, "refund:"+event.ReturnID, event.RefundCents, 0)
		_, _ = tx.Exec(ctx)
	}
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const topic = "returns.event"

// A reference, not a link: the signed URL expires long before the photo's retention does.
const photoRefTTL = 300 * time.Second

type returnEvent struct {
	ReturnID    string \`json:"return_id"\`
	State       string \`json:"state"\`
	Grade       string \`json:"grade"\`
	RefundCents int64  \`json:"refund_cents"\`
	PhotoRef    string \`json:"photo_ref,omitempty"\`
	OccurredAt  string \`json:"occurred_at"\`
}

type outboxStore interface {
	Insert(ctx context.Context, returnID, state, payload, reason string) error
}

var (
	writer = &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Topic:        topic,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
		Async:        false,
	}
	outbox outboxStore
	db     *sql.DB
	rdb    *redis.Client
)

/** A signed URL that expires after ttl (provided by the signing service). */
func signPhotoRef(photoRef string, ttl time.Duration) string {
	return ""
}

func buildEvent(returnID, state, grade string, refundCents int64, photoRef string) returnEvent {
	event := returnEvent{
		ReturnID:    returnID,
		State:       state,
		Grade:       grade,
		RefundCents: refundCents,
		OccurredAt:  time.Now().UTC().Format(time.RFC3339),
	}
	if photoRef != "" {
		event.PhotoRef = signPhotoRef(photoRef, photoRefTTL)
	}
	return event
}

func publishReturnEvent(ctx context.Context, event returnEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.ReturnID), Value: payload}); err != nil {
		// The broker refused the record: it goes to the outbox, never on the floor.
		return outbox.Insert(ctx, event.ReturnID, event.State, string(payload), err.Error())
	}
	return nil
}

func runRefundConsumer(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		GroupID: "refund-projector",
		Topic:   topic,
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event returnEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			if err := reader.CommitMessages(ctx, msg); err != nil {
				return err
			}
			continue
		}
		if _, err := db.ExecContext(ctx,
			"UPDATE returns SET state = $1, refund_cents = $2 WHERE id = $3",
			event.State, event.RefundCents, event.ReturnID); err != nil {
			return err
		}
		if event.State == "refunded" {
			rdb.Set(ctx, "refund:"+event.ReturnID, event.RefundCents, 0)
		}
		if err := reader.CommitMessages(ctx, msg); err != nil { // the offset moves after the write
			return err
		}
	}
}

func main() {}
`,
    },
    scala: {
      starter: `import java.util.{Collections, Properties}

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class ReturnEvent(
    return_id: String,
    customer_id: String,
    state: String,
    grade: String,
    refund_cents: Long,
    photo_url: Option[String],
    occurred_at: String
)

/** An outbox row, written when the broker refuses a record (provided by the platform layer). */
class Outbox {
  def insert(event: ReturnEvent, reason: String): Unit =
    throw new UnsupportedOperationException("provided by the platform layer")
}

/** One statement against the returns database (provided by the platform layer). */
object ReturnsDb {
  def execute(statement: String, params: Any*): Unit =
    throw new UnsupportedOperationException("provided by the platform layer")
}

object ReturnEvents {
  implicit val eventFormat: RootJsonFormat[ReturnEvent] = jsonFormat7(ReturnEvent)
  val Topic = "returns.event"
  val PhotoUrlTtlSeconds = 604800L

  private val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)
  private val jedis = new Jedis("redis", 6379)
  private val outbox = new Outbox()

  def buildEvent(
      returnId: String,
      customerId: String,
      state: String,
      grade: String,
      refundCents: Long,
      photoRef: Option[String]
  ): ReturnEvent =
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    ReturnEvent(
      return_id = returnId,
      customer_id = customerId,
      state = state,
      grade = grade,
      refund_cents = refundCents,
      photo_url = photoRef.map(ref => "https://cdn.returns.example.com/" + ref + "?expires_in=" + PhotoUrlTtlSeconds),
      occurred_at = java.time.Instant.now().toString
    )

  def publishReturnEvent(event: ReturnEvent): Unit = {
    try {
      producer.send(new ProducerRecord[String, String](Topic, event.customer_id, event.toJson.compactPrint))
    } catch {
      case e: Exception => System.err.println("returns.event record refused: " + e.getMessage)
    }
  }

  def runRefundConsumer(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "refund-projector")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(Collections.singletonList(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.convertTo[ReturnEvent]
        ReturnsDb.execute(
          "UPDATE returns SET state = ?, refund_cents = ? WHERE id = ?",
          event.state,
          event.refund_cents,
          event.return_id
        )
        jedis.set("refund:" + event.return_id, event.refund_cents.toString)
      }
    }
  }
}
`,
      solution: `import java.util.{Collections, Properties}

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class ReturnEvent(
    return_id: String,
    state: String,
    grade: String,
    refund_cents: Long,
    photo_ref: Option[String],
    occurred_at: String
)

/** An outbox row, written when the broker refuses a record (provided by the platform layer). */
class Outbox {
  def insert(event: ReturnEvent, reason: String): Unit =
    throw new UnsupportedOperationException("provided by the platform layer")
}

/** One statement against the returns database (provided by the platform layer). */
object ReturnsDb {
  def execute(statement: String, params: Any*): Unit =
    throw new UnsupportedOperationException("provided by the platform layer")
}

object ReturnEvents {
  implicit val eventFormat: RootJsonFormat[ReturnEvent] = jsonFormat6(ReturnEvent)
  val Topic = "returns.event"
  // A reference, not a link: the signed URL expires long before the photo's retention does.
  val PhotoRefTtlSeconds = 300L

  private val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  producerProps.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  producerProps.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)
  private val jedis = new Jedis("redis", 6379)
  private val outbox = new Outbox()

  /** A signed URL that expires after ttlSeconds (provided by the signing service). */
  def signPhotoRef(photoRef: String, ttlSeconds: Long): String =
    throw new UnsupportedOperationException("the signing service is provided by the platform layer")

  def publishReturnEvent(event: ReturnEvent): Unit = {
    val payload = event.toJson.compactPrint
    val record = new ProducerRecord[String, String](Topic, event.return_id, payload)
    try {
      producer.send(record, (_, exception) => {
        if (exception != null) outbox.insert(event, exception.getMessage)
      })
    } catch {
      case e: Exception => outbox.insert(event, e.getMessage)
    }
  }

  def runRefundConsumer(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "refund-projector")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(Collections.singletonList(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      records.forEach { record =>
        val event = record.value().parseJson.convertTo[ReturnEvent]
        ReturnsDb.execute(
          "UPDATE returns SET state = ?, refund_cents = ? WHERE id = ?",
          event.state,
          event.refund_cents,
          event.return_id
        )
        if (event.state == "refunded") jedis.set("refund:" + event.return_id, event.refund_cents.toString)
        consumer.commitSync() // after the write: at-least-once
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <ctime>
#include <iostream>
#include <string>
#include <vector>

#include <librdkafka/rdkafka.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

using json = nlohmann::json;

constexpr const char* kTopic = "returns.event";

struct Outbox {
  void insert(const json& event, const std::string& reason) {}
};

struct ReturnsDb {
  void execute(const std::string& statement, const std::vector<std::string>& params) {}
};

static Outbox outbox;
static ReturnsDb db;

static rd_kafka_t* make_producer(char* errstr, std::size_t errlen) {
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, errlen);
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, errlen);
}

static json build_event(const std::string& return_id, const std::string& customer_id, const std::string& state,
                        const std::string& grade, long long refund_cents, const std::string& photo_ref) {
  json event;
  event["return_id"] = return_id;
  event["customer_id"] = customer_id;
  event["state"] = state;
  event["grade"] = grade;
  event["refund_cents"] = refund_cents;
  event["occurred_at"] = std::to_string(std::time(nullptr));
  if (!photo_ref.empty()) {
    event["photo_url"] = "https://cdn.returns.example.com/" + photo_ref + "?expires_in=604800";
  }
  return event;
}

static void publish_return_event(rd_kafka_t* producer, const json& event) {
  const std::string payload = event.dump();
  const std::string customer_id = event["customer_id"].get<std::string>();
  const rd_kafka_resp_err_t err = rd_kafka_producev(
      producer,
      RD_KAFKA_V_TOPIC(kTopic),
      RD_KAFKA_V_MSGFLAGS(RD_KAFKA_MSG_F_COPY),
      RD_KAFKA_V_KEY(customer_id.data(), customer_id.size()),
      RD_KAFKA_V_VALUE(payload.data(), payload.size()),
      RD_KAFKA_V_END);
  if (err != RD_KAFKA_RESP_ERR_NO_ERROR) {
    std::cerr << "returns.event record refused: " << rd_kafka_err2str(err) << std::endl;
  }
  rd_kafka_poll(producer, 0);
}

static void run_refund_consumer(rd_kafka_t* consumer, sw::redis::Redis& redis) {
  while (true) {
    rd_kafka_message_t* msg = rd_kafka_consumer_poll(consumer, 500);
    if (!msg) continue;
    if (msg->err) {
      rd_kafka_message_destroy(msg);
      continue;
    }
    rd_kafka_commit(consumer, nullptr, 0);
    const auto event = json::parse(std::string(static_cast<const char*>(msg->payload), msg->len));
    const std::string return_id = event["return_id"].get<std::string>();
    const std::string refund_cents = std::to_string(event["refund_cents"].get<long long>());
    db.execute("UPDATE returns SET state = $1, refund_cents = $2 WHERE id = $3",
               {event["state"].get<std::string>(), refund_cents, return_id});
    redis.set("refund:" + return_id, refund_cents);
    rd_kafka_message_destroy(msg);
  }
}
`,
      solution: `#include <ctime>
#include <string>
#include <vector>

#include <librdkafka/rdkafka.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

using json = nlohmann::json;

constexpr const char* kTopic = "returns.event";
// A reference, not a link: the signed URL expires long before the photo's retention does.
constexpr int kPhotoRefTtlSeconds = 300;

struct Outbox {
  void insert(const json& event, const std::string& reason) {}
};

struct ReturnsDb {
  void execute(const std::string& statement, const std::vector<std::string>& params) {}
};

static Outbox outbox;
static ReturnsDb db;

/** A signed URL that expires after ttl_seconds (provided by the platform layer). */
static std::string sign_photo_ref(const std::string& photo_ref, int ttl_seconds);

static void delivery_report(rd_kafka_t*, const rd_kafka_message_t* message, void*) {
  if (message->err) {
    const std::string payload(static_cast<const char*>(message->payload), message->len);
    outbox.insert(json::parse(payload), rd_kafka_err2str(message->err));  // refused: it goes to the outbox
  }
}

static rd_kafka_t* make_producer(char* errstr, std::size_t errlen) {
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, errlen);
  rd_kafka_conf_set(conf, "enable.idempotence", "true", errstr, errlen);
  rd_kafka_conf_set(conf, "acks", "all", errstr, errlen);
  rd_kafka_conf_set_dr_msg_cb(conf, delivery_report);
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, errlen);
}

static json build_event(const std::string& return_id, const std::string& state, const std::string& grade,
                        long long refund_cents, const std::string& photo_ref) {
  json event;
  event["return_id"] = return_id;
  event["state"] = state;
  event["grade"] = grade;
  event["refund_cents"] = refund_cents;
  event["occurred_at"] = std::to_string(std::time(nullptr));
  if (!photo_ref.empty()) {
    event["photo_ref"] = sign_photo_ref(photo_ref, kPhotoRefTtlSeconds);
  }
  return event;
}

static void publish_return_event(rd_kafka_t* producer, const json& event) {
  const std::string payload = event.dump();
  const std::string return_id = event["return_id"].get<std::string>();
  const rd_kafka_resp_err_t err = rd_kafka_producev(
      producer,
      RD_KAFKA_V_TOPIC(kTopic),
      RD_KAFKA_V_MSGFLAGS(RD_KAFKA_MSG_F_COPY),
      RD_KAFKA_V_KEY(return_id.data(), return_id.size()),
      RD_KAFKA_V_VALUE(payload.data(), payload.size()),
      RD_KAFKA_V_END);
  if (err != RD_KAFKA_RESP_ERR_NO_ERROR) {
    outbox.insert(event, rd_kafka_err2str(err));
  }
  rd_kafka_poll(producer, 0);
}

static void run_refund_consumer(rd_kafka_t* consumer, sw::redis::Redis& redis) {
  while (true) {
    rd_kafka_message_t* msg = rd_kafka_consumer_poll(consumer, 500);
    if (!msg) continue;
    if (msg->err) {
      rd_kafka_message_destroy(msg);
      continue;
    }
    const auto event = json::parse(std::string(static_cast<const char*>(msg->payload), msg->len));
    const std::string return_id = event["return_id"].get<std::string>();
    const std::string refund_cents = std::to_string(event["refund_cents"].get<long long>());
    db.execute("UPDATE returns SET state = $1, refund_cents = $2 WHERE id = $3",
               {event["state"].get<std::string>(), refund_cents, return_id});
    if (event["state"] == "refunded") {
      redis.set("refund:" + return_id, refund_cents);
    }
    rd_kafka_commit(consumer, nullptr, 0);  // after the write: at-least-once
    rd_kafka_message_destroy(msg);
  }
}
`,
    },
  },
  hints: [
    'A customer with two open returns sees the second one graded before the first was received, and after a broker blip one refund never shows up in the returns table.',
    'The key is `customer_id`, so two returns share a partition order with each other. The producer runs with default acks, a refusal only reaches the log, and the consumer commits before its UPDATE.',
    'Key by `return_id`, sign the photo reference with a short TTL, set `acks=all` with idempotence, write an outbox row on every produce failure, and move `commit` after the `UPDATE`.',
  ],
  debrief: `Each fix answers one question about delivery. The key decides ordering, so it is the entity whose history must read in sequence: the return, not the customer. \`acks=all\` with an idempotent producer decides durability: a leader failover cannot drop an acknowledged refund and a retry cannot publish it twice. The outbox decides what happens when the broker says no: the row survives the process and a relay republishes it, where a log line is a refund that disappears. The commit position decides whether state and offset can disagree: with the write first, a crash replays the event onto the same row, which is why the update is idempotent by construction. What this step leaves out: the relay itself, sweeping the outbox with \`FOR UPDATE SKIP LOCKED\`, and consumer-side dedupe on an event id.`,
};
