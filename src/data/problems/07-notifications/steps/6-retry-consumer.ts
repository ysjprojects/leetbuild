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
)

// Provided by the previous steps (same package): allowed(ctx, userID, id) (bool, error) · getPrefs(ctx, userID) (Prefs, error)
// · Quiet(prefs, hour) bool · sendPush(ctx, n Notification) error, which wraps ErrRetryable when the gateway asks for a retry.

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
)

// Provided by the previous steps (same package): allowed(ctx, userID, id) (bool, error) · getPrefs(ctx, userID) (Prefs, error)
// · Quiet(prefs, hour) bool · sendPush(ctx, n Notification) error, which wraps ErrRetryable when the gateway asks for a retry.

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
  },
  debrief: `A retry topic turns "this one failed" into a record like any other: the partition moves on, the failed notification comes back a little later with its attempt count in a header, and after five tries it lands in the DLQ where a human — or a replay tool — can look at it. The commit after the re-queue acknowledgement is what makes the whole thing at-least-once end to end. Real workers run several retry topics with growing delays (\`retry-1m\`, \`retry-10m\`), pause a partition instead of sleeping in it, honour the \`priority\` header with a separate high-priority group, and alert on the DLQ's depth.`,
};
