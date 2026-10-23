import type {Step} from '@/lib/types';

export const retryConsumerStep: Step = {
  id: 'retry-consumer',
  title: 'Deliver with a retry topic and a dead-letter queue',
  concept: 'kafka',
  file: 'delivery_worker',
  focus: ['bus', 'worker', 'retry', 'gateway'],
  task: `## Task

Implement the delivery worker: a member of consumer group **\`delivery\`** reading both
\`notifications\` and \`notifications-retry\`. The pieces from the previous steps are provided:
\`allowed(user_id, id)\`, \`get_prefs(user_id)\`, \`quiet(prefs, hour)\` and \`send_push(notification)\`,
which raises \`Retryable\` when the gateway asked for a retry.

- Disable auto-commit and subscribe to **both** topics.
- For every record: deliver only when the rate limit allows it, push is enabled in the preferences,
  and it is not quiet hours — unless \`priority\` is \`high\`. Skipped notifications are an outcome too.
- On \`Retryable\`, **re-queue** the record (same key and value) with an \`attempt\` header equal to
  the previous attempt + 1: to \`notifications-retry\`, or to **\`notifications-dlq\`** once that
  reaches **5**. \`attempt_of(record)\` is provided and reads the header (0 on first delivery).
- Wait for the re-queue to be acknowledged, then **commit**. The commit always comes after the
  outcome — delivered, skipped, or re-queued — is recorded somewhere else.

:::widget delivery-semantics {}

:::widget consumer-groups {"partitions": 8}

> Retrying in place — sleep and call the gateway again — blocks every other user on the partition
> behind one slow provider. Moving the record to a retry topic frees the partition and keeps the
> original order for everyone who did not fail.`,
  sequence: {
    participants: ['Kafka', 'delivery', 'Push gateway'],
    messages: [
      {from: 'Kafka', to: 'delivery', label: 'poll → notifications (partition 3, offset 90213)', kind: 'reply'},
      {from: 'delivery', to: 'delivery', label: 'allowed(u42) · get_prefs(u42) · quiet?', kind: 'sync'},
      {from: 'delivery', to: 'Push gateway', label: 'send_push(n-7f3)', kind: 'sync'},
      {from: 'Push gateway', to: 'delivery', label: 'Retryable (deadline exceeded)', kind: 'reply'},
      {from: 'delivery', to: 'Kafka', label: 'produce notifications-retry · attempt=1 → ack', kind: 'sync'},
      {from: 'delivery', to: 'Kafka', label: 'commit offset 90214 (partition 3)', kind: 'sync'},
    ],
  },
  hints: [
    'The consumer configuration is where auto-commit goes off and both topics are subscribed; everything else is the loop body.',
    'Compute the next attempt first, pick the topic from it (`>= 5` → DLQ), then produce with the same key and value plus the header. Block on the acknowledgement before you return to the loop.',
    'Exactly one commit per record (or per batch), placed after the outcome: the send returned, the record was skipped, or the re-queue was acknowledged. A crash before the commit replays the record — a duplicate ping is better than a lost one.',
  ],
  checks: [
    {
      id: 'group-topics',
      title: 'Joins group delivery on notifications and notifications-retry',
      detail: 'The consumer uses `group.id` `delivery` and subscribes to both the main topic and the retry topic.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*"delivery"/,
            /subscribe\(\s*\[[^\]]*(TOPIC|"notifications")[^\]]*(RETRY_TOPIC|"notifications-retry")[^\]]*\]\s*\)/,
          ],
        },
        typescript: {
          all: [
            /groupId:\s*['"]delivery['"]/,
            /subscribe\(\s*\{[^}]*topics:\s*\[[^\]]*(TOPIC|['"]notifications['"])[^\]]*(RETRY_TOPIC|['"]notifications-retry['"])[^\]]*\]/,
          ],
        },
        go: {
          all: [
            /GroupID:\s*"delivery"/,
            /GroupTopics:\s*\[\]string\{[^\n]*(topic|"notifications")[^\n]*(retryTopic|"notifications-retry")/,
          ],
        },
        scala: {
          all: [
            /"group\.id"\s*,\s*"delivery"/,
            /subscribe\([^\n]*(Topic|"notifications")[^\n]*(RetryTopic|"notifications-retry")/,
          ],
        },
        cpp: {
          all: [
            /"group\.id"\s*,\s*"delivery"/,
            /subscribe\(\s*\{[^\n]*(kTopic|"notifications")[^\n]*(kRetryTopic|"notifications-retry")/,
          ],
        },
      },
    },
    {
      id: 'manual-commit',
      title: 'Disables auto-commit',
      detail: 'Offsets are committed explicitly after the outcome is recorded — not on a timer.',
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/]},
        typescript: {all: [/autoCommit:\s*false/]},
        go: {all: [/reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/]},
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/]},
      },
    },
    {
      id: 'gate',
      title: 'Checks the rate limit, the preferences and quiet hours before sending',
      detail:
        'Every record passes through `allowed`, `get_prefs` and `quiet` first; a skipped notification is still committed.',
      match: {
        python: {all: [/\ballowed\(/, /\bget_prefs\(/, /\bquiet\(/]},
        typescript: {all: [/\ballowed\(/, /\bgetPrefs\(/, /\bquiet\(/]},
        go: {all: [/\ballowed\(/, /\bgetPrefs\(/, /\bQuiet\(/]},
        scala: {all: [/RateLimit\.allowed\(/, /Preferences\.getPrefs\(/, /Preferences\.quiet\(/]},
        cpp: {all: [/\ballowed\(/, /\bget_prefs\(/, /\bquiet\(/]},
      },
    },
    {
      id: 'retry-topic',
      title: 'Re-queues with attempt + 1 and dead-letters at 5',
      detail:
        'A retryable failure produces the record to `notifications-retry` with an incremented `attempt` header, or to `notifications-dlq` once the attempt count reaches 5.',
      match: {
        python: {all: [/producer\.produce\(/, /headers\s*=\s*[^\n]*["']attempt["']/, />=\s*(MAX_ATTEMPTS|5)\b/]},
        typescript: {all: [/producer\.send\(/, /headers:\s*\{[^\n]*attempt/, />=\s*(MAX_ATTEMPTS|5)\b/]},
        go: {all: [/writer\.WriteMessages\(/, /kafka\.Header\{\{?\s*Key:\s*"attempt"/, />=\s*(maxAttempts|5)\b/]},
        scala: {all: [/producer\.send\(/, /headers\(\)\.add\(\s*"attempt"/, />=\s*(MaxAttempts|5)\b/]},
        cpp: {all: [/producer->produce\(/, /->add\(\s*"attempt"/, />=\s*(kMaxAttempts|5)\b/]},
      },
    },
    {
      id: 'commit-after',
      title: 'Commits only after the send or the re-queue',
      detail:
        'The offset commit sits after `send_push` and after the re-queue: a crash before it replays the record (at-least-once) instead of losing it (at-most-once).',
      match: {
        python: {order: [/(?<!def )send_push\(/, /(?<!def )requeue\(/, /consumer\.commit\(/]},
        typescript: {order: [/\bsendPush\(/, /(?<!function )\brequeue\(/, /consumer\.commitOffsets\(/]},
        go: {order: [/(?<!func )sendPush\(/, /(?<!func )requeue\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/PushClient\.sendPush\(/, /(?<!def )requeue\(/, /consumer\.commitSync\(/]},
        cpp: {order: [/(?<!\w )send_push\(/, /(?<!void )requeue\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

from confluent_kafka import Consumer, Producer

from preferences import get_prefs, quiet  # step 4 — provided
from push_client import Retryable, send_push  # step 5 — provided: send_push(notification: dict)
from rate_limit import allowed  # step 3 — provided

log = logging.getLogger("delivery")

TOPIC = "notifications"
RETRY_TOPIC = "notifications-retry"
DLQ_TOPIC = "notifications-dlq"
MAX_ATTEMPTS = 5

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "delivery",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
# TODO: subscribe to TOPIC and RETRY_TOPIC
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def attempt_of(msg) -> int:
    """The attempt header, 0 on first delivery (provided)."""
    return next((int(value) for name, value in msg.headers() or [] if name == "attempt"), 0)


def requeue(msg, attempt: int) -> None:
    # TODO: produce msg (same key and value) with attempt + 1 in the header to RETRY_TOPIC, or to DLQ_TOPIC once it reaches MAX_ATTEMPTS
    # TODO: flush so the re-queued record is acknowledged before the caller commits
    raise NotImplementedError


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        n = json.loads(msg.value())
        # TODO: deliver only if allowed(user_id, id), prefs["push"], and (priority high or not quiet(prefs, hour))
        # TODO: send_push(n); Retryable → requeue(msg, attempt_of(msg))
        # TODO: commit this message only after the outcome is recorded
        raise NotImplementedError
`,
      solution: `import json
import logging
import time

from confluent_kafka import Consumer, Producer

from preferences import get_prefs, quiet  # step 4 — provided
from push_client import Retryable, send_push  # step 5 — provided: send_push(notification: dict)
from rate_limit import allowed  # step 3 — provided

log = logging.getLogger("delivery")

TOPIC = "notifications"
RETRY_TOPIC = "notifications-retry"
DLQ_TOPIC = "notifications-dlq"
MAX_ATTEMPTS = 5

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "delivery",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC, RETRY_TOPIC])
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def attempt_of(msg) -> int:
    """The attempt header, 0 on first delivery (provided)."""
    return next((int(value) for name, value in msg.headers() or [] if name == "attempt"), 0)


def requeue(msg, attempt: int) -> None:
    next_attempt = attempt + 1
    topic = DLQ_TOPIC if next_attempt >= MAX_ATTEMPTS else RETRY_TOPIC
    producer.produce(topic, key=msg.key(), value=msg.value(), headers={"attempt": str(next_attempt)})
    producer.flush()  # acknowledged before the caller commits


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        n = json.loads(msg.value())
        prefs = get_prefs(n["user_id"])
        hour = time.localtime().tm_hour
        deliver = allowed(n["user_id"], n["id"]) and prefs["push"] and (n["priority"] == "high" or not quiet(prefs, hour))
        if deliver:
            try:
                send_push(n)
            except Retryable as e:
                log.warning("%s: %s, re-queueing", n["id"], e)
                requeue(msg, attempt_of(msg))
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {Kafka, type KafkaMessage} from 'kafkajs';

import {getPrefs, quiet} from './preferences'; // step 4 — provided
import {Retryable, sendPush} from './push_client'; // step 5 — provided: sendPush(token, title, body, collapseKey)
import {allowed} from './rate_limit'; // step 3 — provided

export const TOPIC = 'notifications';
export const RETRY_TOPIC = 'notifications-retry';
export const DLQ_TOPIC = 'notifications-dlq';
export const MAX_ATTEMPTS = 5;

const kafka = new Kafka({clientId: 'delivery', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'delivery'});
const producer = kafka.producer({idempotent: true});

interface Notification {
  id: string;
  user_id: string;
  title: string;
  body: string;
  priority: string;
}

/** The attempt header, 0 on first delivery (provided). */
export function attemptOf(message: KafkaMessage): number {
  const value = message.headers?.attempt;
  return value === undefined ? 0 : Number(Buffer.from(value).toString());
}

export async function requeue(message: KafkaMessage, attempt: number): Promise<void> {
  // TODO: send message (same key and value) with attempt + 1 in the header to RETRY_TOPIC, or to DLQ_TOPIC once it reaches MAX_ATTEMPTS
  // TODO: await the send so the re-queued record is acknowledged before the caller commits
  throw new Error('not implemented');
}

export async function run(): Promise<void> {
  await consumer.connect();
  await producer.connect();
  // TODO: subscribe to TOPIC and RETRY_TOPIC
  await consumer.run({
    // TODO: disable auto-commit
    eachMessage: async ({topic, partition, message}) => {
      const n = JSON.parse(Buffer.from(message.value!).toString()) as Notification;
      // TODO: deliver only if allowed(user_id, id), prefs.push, and (priority high or not quiet(prefs, hour))
      // TODO: sendPush(n.user_id, n.title, n.body, n.id) — one device per user: the token is the user id, the collapse key the notification id
      // TODO: Retryable → requeue(message, attemptOf(message))
      // TODO: commit this message (offset + 1) only after the outcome is recorded
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import {Kafka, type KafkaMessage} from 'kafkajs';

import {getPrefs, quiet} from './preferences'; // step 4 — provided
import {Retryable, sendPush} from './push_client'; // step 5 — provided: sendPush(token, title, body, collapseKey)
import {allowed} from './rate_limit'; // step 3 — provided

export const TOPIC = 'notifications';
export const RETRY_TOPIC = 'notifications-retry';
export const DLQ_TOPIC = 'notifications-dlq';
export const MAX_ATTEMPTS = 5;

const kafka = new Kafka({clientId: 'delivery', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'delivery'});
const producer = kafka.producer({idempotent: true});

interface Notification {
  id: string;
  user_id: string;
  title: string;
  body: string;
  priority: string;
}

/** The attempt header, 0 on first delivery (provided). */
export function attemptOf(message: KafkaMessage): number {
  const value = message.headers?.attempt;
  return value === undefined ? 0 : Number(Buffer.from(value).toString());
}

export async function requeue(message: KafkaMessage, attempt: number): Promise<void> {
  const nextAttempt = attempt + 1;
  const topic = nextAttempt >= MAX_ATTEMPTS ? DLQ_TOPIC : RETRY_TOPIC;
  // send resolves once the broker acknowledged the record: only then may the caller commit
  await producer.send({
    topic,
    acks: -1,
    messages: [{key: message.key, value: message.value, headers: {attempt: String(nextAttempt)}}],
  });
}

export async function run(): Promise<void> {
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({topics: [TOPIC, RETRY_TOPIC], fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const n = JSON.parse(Buffer.from(message.value!).toString()) as Notification;
      const prefs = await getPrefs(n.user_id);
      const hour = new Date().getHours();
      const deliver = (await allowed(n.user_id, n.id)) && prefs.push && (n.priority === 'high' || !quiet(prefs, hour));
      if (deliver) {
        try {
          await sendPush(n.user_id, n.title, n.body, n.id); // one device per user: the token is the user id
        } catch (e) {
          if (!(e instanceof Retryable)) throw e;
          console.warn(\`\${n.id}: \${e.message}, re-queueing\`);
          await requeue(message, attemptOf(message));
        }
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
	"errors"
	"log"
	"strconv"
	"time"

	"github.com/segmentio/kafka-go"

	"notify/db"
)

// Built in the previous steps: they stand in for those steps' files here.

// allowed reports whether the notification fits the user's hourly budget (step 3).
var allowed = func(ctx context.Context, userID, notificationID string) (bool, error) { panic("not implemented") }

// getPrefs reads the user's preferences through the Redis cache (step 4).
var getPrefs = func(ctx context.Context, userID string) (Prefs, error) { panic("not implemented") }

// sendPush delivers n through the push gateway (step 5); the error wraps ErrRetryable when the gateway asks for a retry.
var sendPush = func(ctx context.Context, n Notification) error { panic("not implemented") }

// ErrRetryable: the push gateway asked for a retry (step 5).
var ErrRetryable = errors.New("push gateway: retry later")

type Prefs = db.Prefs

// Quiet reports whether hour falls in the user's quiet window (step 4).
func Quiet(p Prefs, hour int) bool {
	if p.QuietStart <= p.QuietEnd {
		return hour >= p.QuietStart && hour < p.QuietEnd
	}
	return hour >= p.QuietStart || hour < p.QuietEnd
}

const (
	topic       = "notifications"
	retryTopic  = "notifications-retry"
	dlqTopic    = "notifications-dlq"
	maxAttempts = 5
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "delivery",
	// TODO: GroupTopics: both topic and retryTopic
})

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

type Notification struct {
	ID       string \`json:"id"\`
	UserID   string \`json:"user_id"\`
	Title    string \`json:"title"\`
	Body     string \`json:"body"\`
	Priority string \`json:"priority"\`
}

// attemptOf returns the attempt header, 0 on first delivery (provided).
func attemptOf(msg kafka.Message) int {
	for _, h := range msg.Headers {
		if h.Key == "attempt" {
			n, _ := strconv.Atoi(string(h.Value))
			return n
		}
	}
	return 0
}

func requeue(ctx context.Context, msg kafka.Message, attempt int) error {
	// TODO: WriteMessages msg (same Key and Value) with attempt+1 in a header to retryTopic, or to dlqTopic once it reaches maxAttempts
	return errors.New("not implemented")
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: deliver only if allowed, prefs.Push, and (priority high or !Quiet(prefs, hour))
		// TODO: sendPush; ErrRetryable → requeue(ctx, msg, attemptOf(msg)); other errors → return without committing
		// TODO: CommitMessages only after the outcome is recorded
		_ = json.Unmarshal
		_ = time.Now
		log.Println("not implemented")
		return nil
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"time"

	"github.com/segmentio/kafka-go"

	"notify/db"
)

// Built in the previous steps: they stand in for those steps' files here.

// allowed reports whether the notification fits the user's hourly budget (step 3).
var allowed = func(ctx context.Context, userID, notificationID string) (bool, error) { panic("not implemented") }

// getPrefs reads the user's preferences through the Redis cache (step 4).
var getPrefs = func(ctx context.Context, userID string) (Prefs, error) { panic("not implemented") }

// sendPush delivers n through the push gateway (step 5); the error wraps ErrRetryable when the gateway asks for a retry.
var sendPush = func(ctx context.Context, n Notification) error { panic("not implemented") }

// ErrRetryable: the push gateway asked for a retry (step 5).
var ErrRetryable = errors.New("push gateway: retry later")

type Prefs = db.Prefs

// Quiet reports whether hour falls in the user's quiet window (step 4).
func Quiet(p Prefs, hour int) bool {
	if p.QuietStart <= p.QuietEnd {
		return hour >= p.QuietStart && hour < p.QuietEnd
	}
	return hour >= p.QuietStart || hour < p.QuietEnd
}

const (
	topic       = "notifications"
	retryTopic  = "notifications-retry"
	dlqTopic    = "notifications-dlq"
	maxAttempts = 5
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     "delivery",
	GroupTopics: []string{topic, retryTopic},
})

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

type Notification struct {
	ID       string \`json:"id"\`
	UserID   string \`json:"user_id"\`
	Title    string \`json:"title"\`
	Body     string \`json:"body"\`
	Priority string \`json:"priority"\`
}

// attemptOf returns the attempt header, 0 on first delivery (provided).
func attemptOf(msg kafka.Message) int {
	for _, h := range msg.Headers {
		if h.Key == "attempt" {
			n, _ := strconv.Atoi(string(h.Value))
			return n
		}
	}
	return 0
}

func requeue(ctx context.Context, msg kafka.Message, attempt int) error {
	next := attempt + 1
	target := retryTopic
	if next >= maxAttempts {
		target = dlqTopic
	}
	return writer.WriteMessages(ctx, kafka.Message{ // synchronous: acknowledged before the caller commits
		Topic:   target,
		Key:     msg.Key,
		Value:   msg.Value,
		Headers: []kafka.Header{{Key: "attempt", Value: []byte(strconv.Itoa(next))}},
	})
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var n Notification
		json.Unmarshal(msg.Value, &n)
		ok, err := allowed(ctx, n.UserID, n.ID)
		if err != nil {
			return err
		}
		prefs, err := getPrefs(ctx, n.UserID)
		if err != nil {
			return err
		}
		if ok && prefs.Push && (n.Priority == "high" || !Quiet(prefs, time.Now().Hour())) {
			if err := sendPush(ctx, n); errors.Is(err, ErrRetryable) {
				log.Printf("%s: %v, re-queueing", n.ID, err)
				if err := requeue(ctx, msg, attemptOf(msg)); err != nil {
					return err // not committed: the record is redelivered
				}
			} else if err != nil {
				return err
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
      starter: `import java.time.{Duration, LocalTime}
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.jdk.CollectionConverters._

import notify.{Json, Notification, Preferences, PushClient, RateLimit} // steps 3–5 and Json.notification(value) — provided

object DeliveryWorker {
  val Topic = "notifications"
  val RetryTopic = "notifications-retry"
  val DlqTopic = "notifications-dlq"
  val MaxAttempts = 5

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "delivery")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  // TODO: subscribe to Topic and RetryTopic

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** The attempt header, 0 on first delivery (provided). */
  def attemptOf(record: ConsumerRecord[String, String]): Int =
    Option(record.headers().lastHeader("attempt")).map(h => new String(h.value()).toInt).getOrElse(0)

  def requeue(record: ConsumerRecord[String, String], attempt: Int): Unit = {
    // TODO: a ProducerRecord (same key and value) with attempt + 1 in the header to RetryTopic, or to DlqTopic once it reaches MaxAttempts
    // TODO: send and block on the future so the re-queue is acknowledged before the caller commits
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val n: Notification = Json.notification(record.value())
        // TODO: deliver only if RateLimit.allowed, prefs.push, and (priority high or !Preferences.quiet(prefs, hour))
        // TODO: PushClient.sendPush(n); Retryable → requeue(record, attemptOf(record))
      }
      // TODO: commitSync after every record of the batch has its outcome recorded
    }
}
`,
      solution: `import java.time.{Duration, LocalTime}
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.jdk.CollectionConverters._

import notify.{Json, Notification, Preferences, PushClient, RateLimit} // steps 3–5 and Json.notification(value) — provided

object DeliveryWorker {
  val Topic = "notifications"
  val RetryTopic = "notifications-retry"
  val DlqTopic = "notifications-dlq"
  val MaxAttempts = 5

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "delivery")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic, RetryTopic).asJava)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** The attempt header, 0 on first delivery (provided). */
  def attemptOf(record: ConsumerRecord[String, String]): Int =
    Option(record.headers().lastHeader("attempt")).map(h => new String(h.value()).toInt).getOrElse(0)

  def requeue(record: ConsumerRecord[String, String], attempt: Int): Unit = {
    val next = attempt + 1
    val target = if (next >= MaxAttempts) DlqTopic else RetryTopic
    val out = new ProducerRecord[String, String](target, record.key(), record.value())
    out.headers().add("attempt", next.toString.getBytes)
    producer.send(out).get() // acknowledged before the caller commits
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val n: Notification = Json.notification(record.value())
        val prefs = Preferences.getPrefs(n.userId)
        val deliver = RateLimit.allowed(n.userId, n.id) && prefs.push &&
          (n.priority == "high" || !Preferences.quiet(prefs, LocalTime.now().getHour))
        if (deliver)
          try PushClient.sendPush(n)
          catch {
            case e: PushClient.Retryable =>
              System.err.println(s"\${n.id}: \${e.getMessage}, re-queueing")
              requeue(record, attemptOf(record))
          }
      }
      consumer.commitSync() // after every record of the batch has its outcome recorded
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <ctime>
#include <iostream>
#include <memory>
#include <string>

#include "notification.h"  // struct Notification; Notification parse_notification(const std::string& json) — provided
#include "preferences.h"   // Prefs get_prefs(const std::string& user); bool quiet(const Prefs&, int hour) — step 4, provided
#include "push_client.h"   // void send_push(const Notification&); struct Retryable — step 5, provided
#include "rate_limit.h"    // bool allowed(const std::string& user, const std::string& id) — step 3, provided

const std::string kTopic = "notifications";
const std::string kRetryTopic = "notifications-retry";
const std::string kDlqTopic = "notifications-dlq";
constexpr int kMaxAttempts = 5;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "delivery", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  // TODO: subscribe to kTopic and kRetryTopic
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();

// The attempt header, 0 on first delivery (provided).
int attempt_of(RdKafka::Message& msg) {
  if (!msg.headers()) return 0;
  const RdKafka::Headers::Header h = msg.headers()->get_last("attempt");
  if (h.err() != RdKafka::ERR_NO_ERROR) return 0;
  return std::stoi(std::string(static_cast<const char*>(h.value()), h.value_size()));
}

void requeue(RdKafka::Message& msg, int attempt) {
  // TODO: headers with attempt + 1; produce msg's payload and key (RK_MSG_COPY) to kRetryTopic, or to kDlqTopic once it reaches kMaxAttempts
  // TODO: flush so the re-queued record is acknowledged before the caller commits
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const Notification n = parse_notification(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    // TODO: deliver only if allowed(user_id, id), prefs.push, and (priority high or !quiet(prefs, hour))
    // TODO: send_push(n); catch Retryable → requeue(*msg, attempt_of(*msg))
    // TODO: commitSync this message only after the outcome is recorded
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <ctime>
#include <iostream>
#include <memory>
#include <string>

#include "notification.h"  // struct Notification; Notification parse_notification(const std::string& json) — provided
#include "preferences.h"   // Prefs get_prefs(const std::string& user); bool quiet(const Prefs&, int hour) — step 4, provided
#include "push_client.h"   // void send_push(const Notification&); struct Retryable — step 5, provided
#include "rate_limit.h"    // bool allowed(const std::string& user, const std::string& id) — step 3, provided

const std::string kTopic = "notifications";
const std::string kRetryTopic = "notifications-retry";
const std::string kDlqTopic = "notifications-dlq";
constexpr int kMaxAttempts = 5;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "delivery", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic, kRetryTopic});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();

// The attempt header, 0 on first delivery (provided).
int attempt_of(RdKafka::Message& msg) {
  if (!msg.headers()) return 0;
  const RdKafka::Headers::Header h = msg.headers()->get_last("attempt");
  if (h.err() != RdKafka::ERR_NO_ERROR) return 0;
  return std::stoi(std::string(static_cast<const char*>(h.value()), h.value_size()));
}

void requeue(RdKafka::Message& msg, int attempt) {
  const int next = attempt + 1;
  const std::string& target = next >= kMaxAttempts ? kDlqTopic : kRetryTopic;
  auto headers = std::unique_ptr<RdKafka::Headers>(RdKafka::Headers::create());
  headers->add("attempt", std::to_string(next));
  const RdKafka::ErrorCode err =
      producer->produce(target, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, msg.payload(), msg.len(),
                        msg.key_pointer(), msg.key_len(), 0, headers.get(), nullptr);
  if (err != RdKafka::ERR_NO_ERROR) throw std::runtime_error("re-queue failed: " + RdKafka::err2str(err));
  headers.release();      // owned by the producer once produce() accepted the message
  producer->flush(5000);  // acknowledged before the caller commits
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const Notification n = parse_notification(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    const Prefs prefs = get_prefs(n.user_id);
    const std::time_t now = std::time(nullptr);
    const int hour = std::localtime(&now)->tm_hour;
    if (allowed(n.user_id, n.id) && prefs.push && (n.priority == "high" || !quiet(prefs, hour))) {
      try {
        send_push(n);
      } catch (const Retryable& e) {
        std::cerr << n.id << ": " << e.what() << ", re-queueing\\n";
        requeue(*msg, attempt_of(*msg));
      }
    }
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json


def _seed(ctx, nid, user_id="u1", priority="normal", topic="notifications", attempt=None):
    value = json.dumps({"id": nid, "user_id": user_id, "channel": "push", "title": "Shipped", "body": "On its way", "priority": priority})
    headers = [("attempt", str(attempt).encode())] if attempt is not None else None
    ctx.kafka.seed(topic, key=user_id, value=value, headers=headers)
    return value.encode()


def _worker(ctx):
    """The worker with the provided pieces faked: rate limit, preferences, quiet hours and the gateway."""
    m = ctx.load("delivery_worker")
    m.sent = []  # notification ids send_push delivered
    m.failures = {}  # notification id -> remaining Retryable failures
    m.limited = set()  # notification ids the rate limit rejects
    m.prefs = {}  # user id -> preferences; "quiet_now" marks a user in quiet hours
    m.gate = []  # (name, args) in call order

    def allowed(user_id, nid):
        m.gate.append(("allowed", user_id, nid))
        return nid not in m.limited

    def get_prefs(user_id):
        m.gate.append(("get_prefs", user_id))
        return dict(m.prefs.get(user_id, {"push": True}))

    def quiet(prefs, hour):
        m.gate.append(("quiet", hour))
        return bool(prefs.get("quiet_now"))

    def send_push(n):
        if m.failures.get(n["id"], 0) > 0:
            m.failures[n["id"]] -= 1
            raise m.Retryable("push gateway: deadline exceeded")
        m.sent.append(n["id"])

    m.allowed, m.get_prefs, m.quiet, m.send_push = allowed, get_prefs, quiet, send_push
    return m


def _header(record, name):
    for key, value in record.headers or []:
        if key == name:
            return value.decode() if isinstance(value, bytes) else str(value)
    return None


def check_group_topics(ctx):
    _seed(ctx, "n1")
    _seed(ctx, "n2", topic="notifications-retry", attempt=1)
    m = _worker(ctx)
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer must subscribe to its topics"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == "delivery", f"group.id must be delivery, got {group!r}"
    assert "notifications" in topics and "notifications-retry" in topics, f"the consumer must subscribe to notifications and notifications-retry, got {topics}"
    ctx.drain(m.run)
    assert sorted(m.sent) == ["n1", "n2"], f"records from both topics must be delivered, sent {m.sent}"


def check_manual_commit(ctx):
    _seed(ctx, "n1")
    _seed(ctx, "n2", user_id="u2")
    m = _worker(ctx)
    assert ctx.kafka.consumers and not ctx.kafka.consumers[-1].auto_commit, "enable.auto.commit must be False"
    ctx.drain(m.run)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, before the outcome"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened"
    assert ctx.kafka.lag("delivery", "notifications") == 0, "every processed record must be committed"


def check_gate(ctx):
    _seed(ctx, "n-ok", user_id="u-ok")
    _seed(ctx, "n-limited", user_id="u-limited")
    _seed(ctx, "n-off", user_id="u-off")
    _seed(ctx, "n-quiet", user_id="u-quiet")
    _seed(ctx, "n-urgent", user_id="u-quiet", priority="high")
    m = _worker(ctx)
    m.limited.add("n-limited")
    m.prefs["u-off"] = {"push": False}
    m.prefs["u-quiet"] = {"push": True, "quiet_now": True}
    ctx.drain(m.run)
    assert ("allowed", "u-ok", "n-ok") in m.gate, f"allowed(user_id, id) must be consulted for every record, calls were {m.gate}"
    assert ("get_prefs", "u-ok") in m.gate, f"get_prefs(user_id) must be consulted, calls were {m.gate}"
    hours = [h for name, *rest in m.gate if name == "quiet" for h in rest]
    assert hours and all(isinstance(h, int) and 0 <= h <= 23 for h in hours), f"quiet(prefs, hour) must get the current hour (0-23), got {hours}"
    assert "n-ok" in m.sent, f"an allowed notification with push on outside quiet hours must be sent, sent {m.sent}"
    assert "n-limited" not in m.sent, "a rate-limited notification must not be sent"
    assert "n-off" not in m.sent, "a user with push off must not get a notification"
    assert "n-quiet" not in m.sent, "a normal notification in quiet hours must not be sent"
    assert "n-urgent" in m.sent, f"a high-priority notification ignores quiet hours, sent {m.sent}"
    assert ctx.kafka.lag("delivery", "notifications") == 0, "skipped notifications are an outcome too: they must be committed"


def check_retry_topic(ctx):
    original = _seed(ctx, "n1")
    _seed(ctx, "n2", user_id="u2", topic="notifications-retry", attempt=4)
    m = _worker(ctx)
    m.failures = {"n1": 1, "n2": 1}
    ctx.drain(m.run)
    retried = ctx.kafka.records("notifications-retry")
    requeued = [r for r in retried if r.key == b"u1"]
    assert requeued, f"n1 failed once: it must be re-queued on notifications-retry, found keys {[r.key for r in retried]}"
    assert len(requeued) == 1, f"n1 failed once, yet it was re-queued {len(requeued)} times"
    assert requeued[0].value == original, f"the re-queued value must be the original record, got {requeued[0].value!r}"
    assert _header(requeued[0], "attempt") == "1", f"the re-queued record must carry attempt=1, headers were {requeued[0].headers!r}"
    assert m.sent.count("n1") == 1, f"the re-queued n1 must be delivered when it comes back, sent {m.sent}"
    dead = ctx.kafka.records("notifications-dlq")
    assert len(dead) == 1 and dead[0].key == b"u2", f"n2 failing on attempt 4 must land on notifications-dlq, found {[(r.key, r.headers) for r in dead]}"
    assert _header(dead[0], "attempt") == "5", f"the dead-lettered record must carry attempt=5, headers were {dead[0].headers!r}"
    assert len([r for r in retried if r.key == b"u2"]) == 1, "a record on its fifth attempt goes to the DLQ, not back to the retry topic"
    assert "n2" not in m.sent


def check_commit_after(ctx):
    _seed(ctx, "n1")
    m = _worker(ctx)
    m.failures = {"n1": 1}
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((sorted(t for t, p in offsets), len(ctx.kafka.records("notifications-retry")), ctx.kafka.flushes, list(m.sent))))
    ctx.drain(m.run)
    assert at_commit, "the offset was never committed"
    first = [c for c in at_commit if "notifications" in c[0]]
    assert first, f"the record on notifications was never committed, commits were {at_commit}"
    assert first[0][1] == 1, "the commit of the failed record came before its re-queue: at commit time nothing was on notifications-retry"
    assert first[0][2] >= 1, "commit before the re-queue was acknowledged: flush the producer first"
    second = [c for c in at_commit if "notifications-retry" in c[0]]
    assert second, f"the re-queued record on notifications-retry was never committed, commits were {at_commit}"
    assert second[0][3] == ["n1"], "the commit of the retried record came before send_push delivered it"
    assert ctx.kafka.lag("delivery", "notifications") == 0 and ctx.kafka.lag("delivery", "notifications-retry") == 0, "every record must end up committed"
`,
    typescript: `function seed(ctx, nid: string, {userId = 'u1', priority = 'normal', topic = 'notifications', attempt = null as number | null} = {}): string {
  const value = JSON.stringify({id: nid, user_id: userId, channel: 'push', title: 'Shipped', body: 'On its way', priority});
  ctx.kafka.seed(topic, {key: userId, value, headers: attempt === null ? {} : {attempt: String(attempt)}});
  return value;
}

/**
 * The worker with the real rate limit, preferences and push client of the previous steps behind it: the
 * push gateway is a peer that delivers (recording the notification id) or answers DEADLINE_EXCEEDED
 * while a notification has failures left; preferences rows are seeded so no user is in quiet hours
 * unless a check says so.
 */
function worker(ctx) {
  const sent: string[] = []; // notification ids the gateway delivered
  const failures: Record<string, number> = {}; // notification id -> remaining DEADLINE_EXCEEDED answers
  const pkg = ctx.proto('push.proto');
  ctx.grpc.serve(pkg.notify.PushGateway.service, {
    Send: (call, callback) => {
      const {collapse_key, title, body, device_token} = call.request;
      const id = [collapse_key, title, body, device_token].find(v => v in failures) ?? collapse_key;
      if ((failures[id] ?? 0) > 0) {
        failures[id] -= 1;
        return callback({code: ctx.grpc.status.DEADLINE_EXCEEDED, details: 'deadline exceeded'});
      }
      sent.push(id);
      callback(null, {message_id: \`m-\${sent.length}\`});
    },
  });
  const db = ctx.load('/support/notify/db.ts').db;
  const hour = new Date().getHours();
  const awake = {push: true, quiet_start: (hour + 2) % 24, quiet_end: (hour + 3) % 24}; // never quiet right now
  for (const user of ['u1', 'u2', 'u-ok', 'u-limited', 'u-off']) db.rows[user] = {...awake};
  const m = ctx.load('delivery_worker');
  return {m, sent, failures, db, hour, awake};
}

function header(record, name: string): string | null {
  const value = record.headers?.[name];
  return value === undefined ? null : Buffer.from(value).toString();
}

export async function check_group_topics(ctx) {
  seed(ctx, 'n1');
  seed(ctx, 'n2', {topic: 'notifications-retry', attempt: 1});
  const {m, sent} = worker(ctx);
  await ctx.drain(m.run());
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer must subscribe to its topics');
  const [, group, topics] = subscriptions[subscriptions.length - 1];
  assert.equal(group, 'delivery', \`groupId must be delivery, got \${JSON.stringify(group)}\`);
  assert(topics.includes('notifications') && topics.includes('notifications-retry'), \`the consumer must subscribe to notifications and notifications-retry, got \${JSON.stringify(topics)}\`);
  assert.deepEqual([...sent].sort(), ['n1', 'n2'], \`records from both topics must be delivered, sent \${JSON.stringify(sent)}\`);
}

export async function check_manual_commit(ctx) {
  seed(ctx, 'n1');
  seed(ctx, 'n2', {userId: 'u2'});
  const {m} = worker(ctx);
  await ctx.drain(m.run());
  const consumer = ctx.kafka.consumers[ctx.kafka.consumers.length - 1];
  assert(consumer !== undefined && consumer.autoCommit === false, 'the consumer runs with autoCommit on: offsets would be committed on a timer, not after the outcome');
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, before the outcome');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened');
  assert.equal(ctx.kafka.lag('delivery', 'notifications'), 0, 'every processed record must be committed');
}

export async function check_gate(ctx) {
  seed(ctx, 'n-ok', {userId: 'u-ok'});
  seed(ctx, 'n-limited', {userId: 'u-limited'});
  seed(ctx, 'n-off', {userId: 'u-off'});
  seed(ctx, 'n-quiet', {userId: 'u-quiet'});
  seed(ctx, 'n-urgent', {userId: 'u-quiet', priority: 'high'});
  const {m, sent, db, hour, awake} = worker(ctx);
  for (let i = 0; i < 20; i++) ctx.redis.zadd('rl:u-limited', Date.now(), \`earlier-\${i}\`); // the hourly budget is spent
  db.rows['u-off'] = {...awake, push: false};
  db.rows['u-quiet'] = {push: true, quiet_start: hour, quiet_end: hour + 1}; // quiet hours right now
  await ctx.drain(m.run());
  assert(ctx.redis.zscore('rl:u-ok', 'n-ok') !== null, \`allowed(userId, id) must be consulted for every record: rl:u-ok holds \${JSON.stringify(ctx.redis.zrange('rl:u-ok', 0, -1))}, expected n-ok\`);
  assert(ctx.redis.get('prefs:u-ok') !== null, \`getPrefs(userId) must be consulted: prefs:u-ok was never cached, keys are \${JSON.stringify(ctx.redis.keys('prefs:*'))}\`);
  assert(sent.includes('n-ok'), \`an allowed notification with push on outside quiet hours must be sent, sent \${JSON.stringify(sent)}\`);
  assert(!sent.includes('n-limited'), 'a rate-limited notification must not be sent');
  assert(!sent.includes('n-off'), 'a user with push off must not get a notification');
  assert(!sent.includes('n-quiet'), \`a normal notification in quiet hours must not be sent: u-quiet's quiet window is the current hour (\${hour}), pass quiet(prefs, hour) the current hour (0-23)\`);
  assert(sent.includes('n-urgent'), \`a high-priority notification ignores quiet hours, sent \${JSON.stringify(sent)}\`);
  assert.equal(ctx.kafka.lag('delivery', 'notifications'), 0, 'skipped notifications are an outcome too: they must be committed');
}

export async function check_retry_topic(ctx) {
  const original = seed(ctx, 'n1');
  seed(ctx, 'n2', {userId: 'u2', topic: 'notifications-retry', attempt: 4});
  const {m, sent, failures} = worker(ctx);
  failures.n1 = 1;
  failures.n2 = 1;
  await ctx.drain(m.run());
  const retried = ctx.kafka.records('notifications-retry');
  const keys = ctx.kafka.keys('notifications-retry');
  const requeued = retried.filter((_, i) => keys[i] === 'u1');
  assert(requeued.length > 0, \`n1 failed once: it must be re-queued on notifications-retry, found keys \${JSON.stringify(keys)}\`);
  assert.equal(requeued.length, 1, \`n1 failed once, yet it was re-queued \${requeued.length} times\`);
  assert.equal(Buffer.from(requeued[0].value).toString(), original, \`the re-queued value must be the original record, got \${JSON.stringify(Buffer.from(requeued[0].value).toString())}\`);
  assert.equal(header(requeued[0], 'attempt'), '1', \`the re-queued record must carry attempt=1, headers were \${JSON.stringify(Object.keys(requeued[0].headers))}\`);
  assert.equal(sent.filter(id => id === 'n1').length, 1, \`the re-queued n1 must be delivered when it comes back, sent \${JSON.stringify(sent)}\`);
  const dead = ctx.kafka.records('notifications-dlq');
  assert(dead.length === 1 && ctx.kafka.keys('notifications-dlq')[0] === 'u2', \`n2 failing on attempt 4 must land on notifications-dlq, found keys \${JSON.stringify(ctx.kafka.keys('notifications-dlq'))}\`);
  assert.equal(header(dead[0], 'attempt'), '5', \`the dead-lettered record must carry attempt=5, headers were \${JSON.stringify(Object.keys(dead[0].headers))}\`);
  assert.equal(keys.filter(k => k === 'u2').length, 1, 'a record on its fifth attempt goes to the DLQ, not back to the retry topic');
  assert(!sent.includes('n2'), 'a dead-lettered notification is not delivered');
}

export async function check_commit_after(ctx) {
  seed(ctx, 'n1');
  const {m, sent, failures} = worker(ctx);
  failures.n1 = 1;
  ctx.kafka.stall('notifications-retry', 1); // the retry topic's leader acknowledges after 1 s
  const atCommit: {topics: string[]; retried: number; sent: string[]}[] = [];
  ctx.kafka.onCommit((group, offsets) =>
    atCommit.push({
      topics: [...offsets.keys()].map((tp: string) => tp.split('|')[0]).sort(),
      retried: ctx.kafka.records('notifications-retry').length,
      sent: [...sent],
    }),
  );
  await ctx.drain(m.run());
  assert(atCommit.length > 0, 'the offset was never committed');
  const first = atCommit.filter(c => c.topics.includes('notifications'));
  assert(first.length > 0, \`the record on notifications was never committed, commits were \${JSON.stringify(atCommit)}\`);
  assert.equal(first[0].retried, 1, 'the commit of the failed record came before its re-queue was acknowledged: at commit time nothing was on notifications-retry. Wait for the producer before you commit');
  const second = atCommit.filter(c => c.topics.includes('notifications-retry'));
  assert(second.length > 0, \`the re-queued record on notifications-retry was never committed, commits were \${JSON.stringify(atCommit)}\`);
  assert.deepEqual(second[0].sent, ['n1'], 'the commit of the retried record came before sendPush delivered it');
  assert(ctx.kafka.lag('delivery', 'notifications') === 0 && ctx.kafka.lag('delivery', 'notifications-retry') === 0, 'every record must end up committed');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	"notify/db"
	"notify/devices"
	pb "notify/gen/push"
)

// seedDelivery puts a notification on topic from another producer, with an attempt header unless attempt < 0; it returns the value.
func seedDelivery(ctx *harness.Ctx, nid, userID, priority, topic string, attempt int) string {
	value, _ := json.Marshal(map[string]string{"id": nid, "user_id": userID, "channel": "push", "title": "Shipped", "body": "On its way", "priority": priority})
	var headers []harness.KafkaHeader
	if attempt >= 0 {
		headers = append(headers, harness.KafkaHeader{Key: "attempt", Value: []byte(strconv.Itoa(attempt))})
	}
	ctx.Kafka.Seed(topic, userID, value, headers...)
	return string(value)
}

// deliveryWorld is what the push gateway saw: the notification ids it delivered, and the
// DEADLINE_EXCEEDED answers it still owes each notification id.
type deliveryWorld struct {
	mu       sync.Mutex
	sent     []string
	failures map[string]int
	hour     int
	awake    db.Prefs
}

func (w *deliveryWorld) delivered() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.sent...)
}

// deliveryGateway delivers (recording the notification id) or answers DEADLINE_EXCEEDED while a notification has failures left.
type deliveryGateway struct {
	pb.UnimplementedPushGatewayServer
	w *deliveryWorld
}

func (g *deliveryGateway) Send(ctx context.Context, req *pb.SendRequest) (*pb.SendReply, error) {
	g.w.mu.Lock()
	defer g.w.mu.Unlock()
	id := req.GetCollapseKey()
	for _, v := range []string{req.GetCollapseKey(), req.GetTitle(), req.GetBody(), req.GetDeviceToken()} {
		if _, ok := g.w.failures[v]; ok {
			id = v
			break
		}
	}
	if g.w.failures[id] > 0 {
		g.w.failures[id]--
		return nil, status.Error(codes.DeadlineExceeded, "deadline exceeded")
	}
	g.w.sent = append(g.w.sent, id)
	return &pb.SendReply{MessageId: fmt.Sprintf("m-%d", len(g.w.sent))}, nil
}

var (
	deliveryRedis   = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	deliveryConn, _ = grpc.NewClient("push-gateway:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
)

// startDelivery is the worker with the real rate limit, preferences and push client of the previous
// steps behind it; preferences rows are seeded so no user is in quiet hours unless a check says so.
func startDelivery(ctx *harness.Ctx) *deliveryWorld {
	w := &deliveryWorld{failures: map[string]int{}}
	pb.RegisterPushGatewayServer(ctx.GRPC.Server(""), &deliveryGateway{w: w})
	w.hour = time.Now().Hour()
	w.awake = db.Prefs{Push: true, QuietStart: (w.hour + 2) % 24, QuietEnd: (w.hour + 3) % 24} // never quiet right now
	for _, user := range []string{"u1", "u2", "u-ok", "u-limited", "u-off"} {
		db.Rows[user] = w.awake
	}
	// Step 3: a sliding window of 20 an hour in rl:{user}.
	allowed = func(c context.Context, userID, notificationID string) (bool, error) {
		nowMs := time.Now().UnixMilli()
		key := "rl:" + userID
		pipe := deliveryRedis.TxPipeline()
		pipe.ZAdd(c, key, redis.Z{Score: float64(nowMs), Member: notificationID})
		pipe.ZRemRangeByScore(c, key, "-inf", strconv.FormatInt(nowMs-3_600_000, 10))
		count := pipe.ZCard(c, key)
		pipe.Expire(c, key, time.Hour)
		if _, err := pipe.Exec(c); err != nil {
			return false, err
		}
		if count.Val() > 20 {
			deliveryRedis.Incr(c, "dropped:"+userID)
			return false, nil
		}
		return true, nil
	}
	// Step 4: cache-aside in prefs:{user} over the provided database.
	getPrefs = func(c context.Context, userID string) (Prefs, error) {
		key := "prefs:" + userID
		var p Prefs
		cached, err := deliveryRedis.Get(c, key).Bytes()
		if err == nil && json.Unmarshal(cached, &p) == nil {
			return p, nil
		}
		if err != nil && !errors.Is(err, redis.Nil) {
			return Prefs{}, err
		}
		p, err = db.LoadPrefs(c, userID)
		if err != nil {
			return Prefs{}, err
		}
		encoded, _ := json.Marshal(p)
		deliveryRedis.Set(c, key, encoded, 10*time.Minute)
		return p, nil
	}
	// Step 5: one device per user (the token is the user id, the collapse key the notification id),
	// a 3 s deadline, three attempts with jittered backoff.
	sendPush = func(c context.Context, n Notification) error {
		client := pb.NewPushGatewayClient(deliveryConn)
		req := &pb.SendRequest{DeviceToken: n.UserID, Title: n.Title, Body: n.Body, CollapseKey: n.ID}
		var lastErr error
		for attempt := range 3 {
			callCtx, cancel := context.WithTimeout(c, 3*time.Second)
			_, err := client.Send(callCtx, req)
			cancel()
			if err == nil {
				return nil
			}
			switch status.Code(err) {
			case codes.InvalidArgument, codes.NotFound:
				devices.Disable(c, n.UserID)
				return nil
			case codes.DeadlineExceeded:
				return fmt.Errorf("%w: %v", ErrRetryable, err)
			case codes.Unavailable, codes.ResourceExhausted:
				lastErr = err
				time.Sleep(200*time.Millisecond<<attempt + time.Duration(rand.Int64N(int64(200*time.Millisecond))))
			default:
				return err
			}
		}
		return fmt.Errorf("%w: 3 attempts: %v", ErrRetryable, lastErr)
	}
	return w
}

func drainDelivery(ctx *harness.Ctx) {
	ctx.Drain(func() { _ = run(context.Background()) })
}

func deliveryHeader(r harness.KafkaRecord, name string) any {
	if v, ok := r.Header(name); ok {
		return string(v)
	}
	return nil
}

func CheckGroupTopics(ctx *harness.Ctx) {
	seedDelivery(ctx, "n1", "u1", "normal", "notifications", -1)
	seedDelivery(ctx, "n2", "u1", "normal", "notifications-retry", 1)
	w := startDelivery(ctx)
	drainDelivery(ctx)
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	ctx.Assert(len(subscriptions) > 0, "the consumer must subscribe to its topics")
	last := subscriptions[len(subscriptions)-1]
	ctx.Equal(last.Group, "delivery", "GroupID must be delivery")
	ctx.Assert(slices.Contains(last.Topics, "notifications") && slices.Contains(last.Topics, "notifications-retry"), "the consumer must subscribe to notifications and notifications-retry, got %v", last.Topics)
	sent := w.delivered()
	sort.Strings(sent)
	ctx.Equal(sent, []string{"n1", "n2"}, "records from both topics must be delivered: sent")
}

func CheckManualCommit(ctx *harness.Ctx) {
	seedDelivery(ctx, "n1", "u1", "normal", "notifications", -1)
	seedDelivery(ctx, "n2", "u2", "normal", "notifications", -1)
	startDelivery(ctx)
	drainDelivery(ctx)
	consumers := ctx.Kafka.Consumers()
	ctx.Assert(len(consumers) > 0 && !consumers[len(consumers)-1].AutoCommit, "the reader commits on its own (ReadMessage, or a CommitInterval): offsets would be committed before the outcome, not after it")
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "auto-commit is on: offsets were committed on their own, before the outcome")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened")
	ctx.Equal(ctx.Kafka.Lag("delivery", "notifications"), 0, "every processed record must be committed: lag of notifications")
}

func CheckGate(ctx *harness.Ctx) {
	seedDelivery(ctx, "n-ok", "u-ok", "normal", "notifications", -1)
	seedDelivery(ctx, "n-limited", "u-limited", "normal", "notifications", -1)
	seedDelivery(ctx, "n-off", "u-off", "normal", "notifications", -1)
	seedDelivery(ctx, "n-quiet", "u-quiet", "normal", "notifications", -1)
	seedDelivery(ctx, "n-urgent", "u-quiet", "high", "notifications", -1)
	w := startDelivery(ctx)
	for i := range 20 {
		ctx.Redis.Do("ZADD", "rl:u-limited", ctx.Clock.Now(), fmt.Sprintf("earlier-%d", i)) // the hourly budget is spent
	}
	off := w.awake
	off.Push = false
	db.Rows["u-off"] = off
	db.Rows["u-quiet"] = db.Prefs{Push: true, QuietStart: w.hour, QuietEnd: w.hour + 1} // quiet hours right now
	drainDelivery(ctx)
	_, scored := ctx.Redis.ZScore("rl:u-ok", "n-ok")
	ctx.Assert(scored, "allowed(ctx, userID, id) must be consulted for every record: rl:u-ok holds %v, expected n-ok", ctx.Redis.ZRangeWithScores("rl:u-ok", 0, -1))
	_, cached := ctx.Redis.Get("prefs:u-ok")
	ctx.Assert(cached, "getPrefs(ctx, userID) must be consulted: prefs:u-ok was never cached, keys are %v", ctx.Redis.Keys("prefs:*"))
	sent := w.delivered()
	ctx.Assert(slices.Contains(sent, "n-ok"), "an allowed notification with push on outside quiet hours must be sent, sent %v", sent)
	ctx.Assert(!slices.Contains(sent, "n-limited"), "a rate-limited notification must not be sent")
	ctx.Assert(!slices.Contains(sent, "n-off"), "a user with push off must not get a notification")
	ctx.Assert(!slices.Contains(sent, "n-quiet"), "a normal notification in quiet hours must not be sent: u-quiet's quiet window is the current hour (%d), pass Quiet(prefs, hour) the current hour (0-23)", w.hour)
	ctx.Assert(slices.Contains(sent, "n-urgent"), "a high-priority notification ignores quiet hours, sent %v", sent)
	ctx.Equal(ctx.Kafka.Lag("delivery", "notifications"), 0, "skipped notifications are an outcome too (they must be committed): lag of notifications")
}

func CheckRetryTopic(ctx *harness.Ctx) {
	original := seedDelivery(ctx, "n1", "u1", "normal", "notifications", -1)
	seedDelivery(ctx, "n2", "u2", "normal", "notifications-retry", 4)
	w := startDelivery(ctx)
	w.failures["n1"] = 1
	w.failures["n2"] = 1
	drainDelivery(ctx)
	retried := ctx.Kafka.Records("notifications-retry")
	keys := ctx.Kafka.Keys("notifications-retry")
	var requeued []harness.KafkaRecord
	for i, r := range retried {
		if keys[i] == "u1" {
			requeued = append(requeued, r)
		}
	}
	ctx.Assert(len(requeued) > 0, "n1 failed once: it must be re-queued on notifications-retry, found keys %v", keys)
	ctx.Equal(len(requeued), 1, "n1 failed once: times it was re-queued")
	ctx.Equal(string(requeued[0].Value), original, "the re-queued value must be the original record")
	ctx.Equal(deliveryHeader(requeued[0], "attempt"), "1", "the re-queued record must carry attempt=1")
	sent := w.delivered()
	n1Deliveries := 0
	for _, id := range sent {
		if id == "n1" {
			n1Deliveries++
		}
	}
	ctx.Equal(n1Deliveries, 1, "the re-queued n1 must be delivered when it comes back (sent %v): deliveries of n1", sent)
	dead := ctx.Kafka.Records("notifications-dlq")
	deadKeys := ctx.Kafka.Keys("notifications-dlq")
	ctx.Assert(len(dead) == 1 && deadKeys[0] == "u2", "n2 failing on attempt 4 must land on notifications-dlq, found keys %v", deadKeys)
	ctx.Equal(deliveryHeader(dead[0], "attempt"), "5", "the dead-lettered record must carry attempt=5")
	u2Retries := 0
	for _, k := range keys {
		if k == "u2" {
			u2Retries++
		}
	}
	ctx.Equal(u2Retries, 1, "a record on its fifth attempt goes to the DLQ, not back to the retry topic: u2 records on notifications-retry")
	ctx.Assert(!slices.Contains(sent, "n2"), "a dead-lettered notification is not delivered")
}

// deliveryCommit is the world at one commit: the topics committed, the records on the retry topic, the deliveries.
type deliveryCommit struct {
	topics  []string
	retried int
	sent    []string
}

func CheckCommitAfter(ctx *harness.Ctx) {
	seedDelivery(ctx, "n1", "u1", "normal", "notifications", -1)
	w := startDelivery(ctx)
	w.failures["n1"] = 1
	ctx.Kafka.StallFor("notifications-retry", 1) // the retry topic's leader acknowledges after 1 s
	var atCommit []deliveryCommit
	ctx.Kafka.OnCommit(func(group string, offsets harness.KafkaOffsets) {
		var topics []string
		for tp := range offsets {
			topics = append(topics, tp.Topic)
		}
		sort.Strings(topics)
		atCommit = append(atCommit, deliveryCommit{topics: topics, retried: len(ctx.Kafka.Records("notifications-retry")), sent: w.delivered()})
	})
	drainDelivery(ctx)
	ctx.Assert(len(atCommit) > 0, "the offset was never committed")
	var first, second []deliveryCommit
	for _, c := range atCommit {
		if slices.Contains(c.topics, "notifications") {
			first = append(first, c)
		}
		if slices.Contains(c.topics, "notifications-retry") {
			second = append(second, c)
		}
	}
	ctx.Assert(len(first) > 0, "the record on notifications was never committed, commits were %+v", atCommit)
	ctx.Equal(first[0].retried, 1, "the commit of the failed record came before its re-queue was acknowledged (at commit time nothing was on notifications-retry): wait for the writer before you commit. Records on notifications-retry")
	ctx.Assert(len(second) > 0, "the re-queued record on notifications-retry was never committed, commits were %+v", atCommit)
	ctx.Equal(second[0].sent, []string{"n1"}, "the commit of the retried record came before sendPush delivered it: sent at that commit")
	ctx.Assert(ctx.Kafka.Lag("delivery", "notifications") == 0 && ctx.Kafka.Lag("delivery", "notifications-retry") == 0, "every record must end up committed")
}
`,
  },
  debrief: `A retry topic turns "this one failed" into a record like any other: the partition moves on, the failed notification comes back a little later with its attempt count in a header, and after five tries it lands in the DLQ where a human — or a replay tool — can look at it. The commit after the re-queue acknowledgement is what makes the whole thing at-least-once end to end. Real workers run several retry topics with growing delays (\`retry-1m\`, \`retry-10m\`), pause a partition instead of sleeping in it, honour the \`priority\` header with a separate high-priority group, and alert on the DLQ's depth.`,
};
