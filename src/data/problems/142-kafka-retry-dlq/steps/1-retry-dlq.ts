import type {Step} from '@/lib/types';

export const retryDlqStep: Step = {
  id: 'retry-dlq',
  title: 'A retry topic and a dead letter',
  concept: 'kafka',
  file: 'retry_dlq',
  focus: ['fulfilment', 'kafka'],
  task: `## Task

Implement \`run(handler)\`: a member of consumer group **\`fulfilment\`** that reads **\`orders\`** and
**\`orders.retry\`** with auto-commit off and calls \`handler(event)\` for every record. A failure never
blocks the partition: the record is handed to the next topic and the source offset is committed.

- \`handler\` receives the parsed JSON event (Scala and C++: the raw JSON string, validated by a regex).
- Read the record's \`attempt\` header as an integer; a record without one is at attempt 0. When the
  handler raises, this failure makes it \`attempt + 1\`:
  - \`attempt + 1 < MAX_ATTEMPTS\` (\`MAX_ATTEMPTS = 3\`) → produce the record to **\`orders.retry\`**;
  - otherwise → produce it to **\`orders.dlq\`**.
- The hand-off record carries the **same key and value** as the source record and two headers:
  \`attempt\` = the new attempt count as a decimal string, \`error\` = the exception's message.
- A record whose value is not JSON is not retried: it goes straight to \`orders.dlq\` with \`attempt\`
  = its attempt count + 1 and the parse error; the handler is never called for it.
- **Wait for the broker's acknowledgement of the hand-off** (\`flush\` / await \`send\`, \`acks=all\`)
  **before committing** the source offset. If the hand-off is not acknowledged, do not commit: raise
  and let the record be redelivered.
- Success → commit the record's offset synchronously. Every record the loop handles — source, retry
  or dead-lettered — ends with its offset committed.

:::widget delivery-semantics {}

> A retry topic turns a poison record from a partition-wide stall into one more record keyed like the
> original; the commit of the source offset is only safe once that record is durably on the next topic.`,
  sequence: {
    participants: ['Kafka', 'fulfilment', 'handler'],
    messages: [
      {from: 'Kafka', to: 'fulfilment', label: 'poll → orders (key order-7, no attempt header)', kind: 'reply'},
      {from: 'fulfilment', to: 'handler', label: 'handler(event)', kind: 'sync'},
      {from: 'handler', to: 'fulfilment', label: 'raises "warehouse down"', kind: 'reply'},
      {from: 'fulfilment', to: 'Kafka', label: 'produce orders.retry (key order-7, attempt=1, error=…)', kind: 'sync'},
      {from: 'Kafka', to: 'fulfilment', label: 'ack (acks=all)', kind: 'reply'},
      {from: 'fulfilment', to: 'Kafka', label: 'commit orders offset', kind: 'sync'},
      {
        from: 'Kafka',
        to: 'fulfilment',
        label: 'poll → orders.retry (attempt=2) … → orders.dlq (attempt=3)',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Subscribe to both topics in one consumer: the retry records come back through the same loop, with their `attempt` header telling you how many times they already failed.',
    'One hand-off function for both destinations: it takes the topic, the source record, the new attempt count and the error text, produces with the same key and value, then flushes / awaits the send and raises if the delivery failed.',
    'The commit is the last statement of the loop body on every path — but only reached once the hand-off has been acknowledged. If you produce and commit without waiting, a stalled broker leaves you with a committed source and nothing on the retry topic.',
  ],
  checks: [
    {
      id: 'retry-then-succeed',
      title: 'Two failures go to orders.retry with attempt 1 and 2; the third try succeeds',
      detail:
        'A handler that raises twice and then succeeds leaves two records on `orders.retry` (headers `attempt` = 1, 2 and `error` = the message), nothing on `orders.dlq`, and every offset committed.',
      match: {
        python: {all: [/producer\.produce\(/, /"attempt"/]},
        typescript: {all: [/producer\.send\(/, /attempt:\s*String\(/]},
        go: {all: [/writer\.WriteMessages\(/, /Key:\s*"attempt"/]},
        scala: {all: [/producer\.send\(/, /"attempt"/]},
        cpp: {all: [/producer->produce\(/, /"attempt"/]},
      },
    },
    {
      id: 'dead-letter',
      title: 'After MAX_ATTEMPTS failures the record is on orders.dlq with attempt=3',
      detail:
        'A handler that always raises is called exactly three times; the record then sits on `orders.dlq` with `attempt` = 3 and `error` = the message, and is not retried again.',
      match: {
        python: {all: [/attempt\s*<\s*MAX_ATTEMPTS|MAX_ATTEMPTS\s*>\s*attempt/, /DLQ/]},
        typescript: {all: [/attempt\s*<\s*MAX_ATTEMPTS|MAX_ATTEMPTS\s*>\s*attempt/, /DLQ/]},
        go: {all: [/attempt\s*<\s*maxAttempts|maxAttempts\s*>\s*attempt/, /dlqTopic/]},
        scala: {all: [/attempt\s*<\s*MaxAttempts|MaxAttempts\s*>\s*attempt/, /Dlq/]},
        cpp: {all: [/attempt\s*<\s*kMaxAttempts|kMaxAttempts\s*>\s*attempt/, /kDlq/]},
      },
    },
    {
      id: 'keyed-handoff',
      title: 'The hand-off keeps the record key',
      detail:
        'Retry and dead-letter records carry the source record’s key, so they hash to the same partition and an order stays in order on the next topic.',
      match: {
        python: {all: [/key\s*=\s*msg\.key\(\)/]},
        typescript: {all: [/key:\s*message\.key/]},
        go: {all: [/Key:\s*msg\.Key/]},
        scala: {all: [/new ProducerRecord\[[^\n]*record\.key\(\)/]},
        cpp: {all: [/msg\.key\(\)/]},
      },
    },
    {
      id: 'ack-before-commit',
      title: 'The source offset is committed only after the hand-off is acknowledged',
      detail:
        'With `orders.retry` stalled for 5 s, the commit of the source record must happen after the broker resumes and the retry record is on the topic — never with the hand-off still in flight.',
      match: {
        python: {order: [/producer\.produce\(/, /producer\.flush\(/, /consumer\.commit\(/]},
        typescript: {order: [/await producer\.send\(/, /consumer\.commitOffsets\(/]},
        go: {order: [/writer\.WriteMessages\(/, /reader\.CommitMessages\(/], none: [/Async:\s*true/]},
        scala: {order: [/producer\.send\([^\n]*\)\.get\(\)/, /consumer\.commitSync\(/]},
        cpp: {order: [/producer->produce\(/, /producer->flush\(/, /consumer->commitSync\(/]},
      },
    },
    {
      id: 'poison',
      title: 'Malformed JSON goes straight to the dead letter',
      detail:
        'A record that does not parse is dead-lettered on first sight (`attempt` = 1, `error` = the parse error), the handler is never called for it, nothing lands on `orders.retry`, and its offset is committed.',
      match: {
        python: {all: [/json\.loads\(/, /except[^\n]*(ValueError|JSONDecodeError)/]},
        typescript: {all: [/JSON\.parse\(/, /catch/]},
        go: {all: [/json\.Unmarshal\(/]},
        scala: {all: [/case OrderEvent\(\)/]},
        cpp: {all: [/std::regex_search\(/]},
      },
    },
    {
      id: 'commits-advance',
      title: 'Committed offsets advance for every handled record, on both topics',
      detail:
        'Auto-commit is off and every record — succeeded, retried or dead-lettered, from `orders` or `orders.retry` — ends with an explicit commit of its offset, so the group’s lag on both topics is zero.',
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/, /consumer\.commit\(\s*message\s*=\s*msg/]},
        typescript: {all: [/autoCommit:\s*false/, /consumer\.commitOffsets\(/]},
        go: {all: [/reader\.FetchMessage\(/, /reader\.CommitMessages\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"enable\.auto\.commit"\s*,\s*"false"/, /consumer\.commitSync\(/]},
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
from typing import Callable

from confluent_kafka import Consumer, KafkaException, Producer

SOURCE = "orders"
RETRY = "orders.retry"
DLQ = "orders.dlq"
GROUP = "fulfilment"
MAX_ATTEMPTS = 3

log = logging.getLogger("fulfilment")

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([SOURCE, RETRY])
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def _attempt(msg) -> int:
    """How many times this record has already failed: its attempt header, 0 when absent."""
    for name, value in msg.headers() or []:
        if name == "attempt":
            return int(value)
    return 0


def _hand_off(topic: str, msg, attempt: int, error: str) -> None:
    # TODO: produce msg's key and value to topic with headers attempt=<attempt>, error=<error>
    # TODO: flush and raise KafkaException if the delivery report carries an error
    raise NotImplementedError


def run(handler: Callable[[dict], None]) -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: parse the JSON; malformed → _hand_off to DLQ with attempt+1 and the parse error
        # TODO: call handler(event); on an exception hand off to RETRY (attempt+1 < MAX_ATTEMPTS) or DLQ
        # TODO: commit this message's offset synchronously, on every path
        raise NotImplementedError
`,
      solution: `import json
import logging
from typing import Callable

from confluent_kafka import Consumer, KafkaException, Producer

SOURCE = "orders"
RETRY = "orders.retry"
DLQ = "orders.dlq"
GROUP = "fulfilment"
MAX_ATTEMPTS = 3

log = logging.getLogger("fulfilment")

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([SOURCE, RETRY])
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def _attempt(msg) -> int:
    """How many times this record has already failed: its attempt header, 0 when absent."""
    for name, value in msg.headers() or []:
        if name == "attempt":
            return int(value)
    return 0


def _hand_off(topic: str, msg, attempt: int, error: str) -> None:
    """Produce the record to topic with its attempt count and error; wait for the broker's acknowledgement."""
    failed = []

    def on_delivery(err, _msg) -> None:
        if err is not None:
            failed.append(err)

    producer.produce(
        topic,
        key=msg.key(),
        value=msg.value(),
        headers=[("attempt", str(attempt)), ("error", error)],
        on_delivery=on_delivery,
    )
    producer.flush()
    if failed:
        raise KafkaException(failed[0])  # not committed: the record is redelivered


def run(handler: Callable[[dict], None]) -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        attempt = _attempt(msg) + 1
        try:
            event = json.loads(msg.value())
        except (ValueError, TypeError) as exc:
            _hand_off(DLQ, msg, attempt, str(exc))
        else:
            try:
                handler(event)
            except Exception as exc:
                _hand_off(RETRY if attempt < MAX_ATTEMPTS else DLQ, msg, attempt, str(exc))
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';
import type {KafkaMessage} from 'kafkajs';

export const SOURCE = 'orders';
export const RETRY = 'orders.retry';
export const DLQ = 'orders.dlq';
export const GROUP = 'fulfilment';
export const MAX_ATTEMPTS = 3;

export type Handler = (event: Record<string, unknown>) => void | Promise<void>;

const kafka = new Kafka({clientId: 'fulfilment', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});
const producer = kafka.producer();

/** How many times this record has already failed: its attempt header, 0 when absent. */
function attemptOf(message: KafkaMessage): number {
  const raw = message.headers?.attempt;
  return raw === undefined || raw === null ? 0 : Number(raw.toString());
}

async function handOff(topic: string, message: KafkaMessage, attempt: number, err: unknown): Promise<void> {
  // TODO: send the message's key and value to topic with headers attempt=<attempt>, error=<err's message>
  // TODO: await the acknowledgement (acks: -1); a rejected send must propagate
  throw new Error('not implemented');
}

export async function run(handler: Handler): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({topics: [SOURCE, RETRY], fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      // TODO: parse the JSON; malformed → handOff to DLQ with attempt+1 and the parse error
      // TODO: await handler(event); on a throw hand off to RETRY (attempt+1 < MAX_ATTEMPTS) or DLQ
      // TODO: commitOffsets for this message (offset + 1), on every path
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';
import type {KafkaMessage} from 'kafkajs';

export const SOURCE = 'orders';
export const RETRY = 'orders.retry';
export const DLQ = 'orders.dlq';
export const GROUP = 'fulfilment';
export const MAX_ATTEMPTS = 3;

export type Handler = (event: Record<string, unknown>) => void | Promise<void>;

const kafka = new Kafka({clientId: 'fulfilment', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});
const producer = kafka.producer();

/** How many times this record has already failed: its attempt header, 0 when absent. */
function attemptOf(message: KafkaMessage): number {
  const raw = message.headers?.attempt;
  return raw === undefined || raw === null ? 0 : Number(raw.toString());
}

/** Produce the record to topic with its attempt count and the error's message; resolves once the broker acknowledged it. */
async function handOff(topic: string, message: KafkaMessage, attempt: number, err: unknown): Promise<void> {
  const error = err instanceof Error ? err.message : String(err);
  await producer.send({
    topic,
    messages: [{key: message.key, value: message.value, headers: {attempt: String(attempt), error}}],
    acks: -1,
  });
}

export async function run(handler: Handler): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({topics: [SOURCE, RETRY], fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const attempt = attemptOf(message) + 1;
      let event: Record<string, unknown> | undefined;
      try {
        event = JSON.parse(message.value?.toString() ?? '') as Record<string, unknown>;
      } catch (err) {
        await handOff(DLQ, message, attempt, err);
      }
      if (event !== undefined) {
        try {
          await handler(event);
        } catch (err) {
          await handOff(attempt < MAX_ATTEMPTS ? RETRY : DLQ, message, attempt, err);
        }
      }
      // Reached only once the hand-off, if any, was acknowledged: a rejected send skips the commit.
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
	"strconv"

	"github.com/segmentio/kafka-go"
)

const (
	source      = "orders"
	retryTopic  = "orders.retry"
	dlqTopic    = "orders.dlq"
	group       = "fulfilment"
	maxAttempts = 3
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     group,
	GroupTopics: []string{source, retryTopic},
})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type Handler func(event map[string]any) error

// attemptOf is how many times this record has already failed: its attempt header, 0 when absent.
func attemptOf(msg kafka.Message) int {
	for _, h := range msg.Headers {
		if h.Key == "attempt" {
			n, _ := strconv.Atoi(string(h.Value))
			return n
		}
	}
	return 0
}

func handOff(ctx context.Context, topic string, msg kafka.Message, attempt int, cause error) error {
	// TODO: WriteMessages the record's Key and Value to topic with headers attempt=<attempt>, error=<cause>
	// TODO: the synchronous writer returns once acknowledged; return its error
	return nil
}

func run(ctx context.Context, handler Handler) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		// TODO: parse the JSON; malformed → handOff to dlqTopic with attempt+1 and the parse error
		// TODO: call handler(event); on an error hand off to retryTopic (attempt+1 < maxAttempts) or dlqTopic
		// TODO: CommitMessages for this message, on every path
		_ = json.Unmarshal
		_ = msg
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/segmentio/kafka-go"
)

const (
	source      = "orders"
	retryTopic  = "orders.retry"
	dlqTopic    = "orders.dlq"
	group       = "fulfilment"
	maxAttempts = 3
)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     group,
	GroupTopics: []string{source, retryTopic},
})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type Handler func(event map[string]any) error

// attemptOf is how many times this record has already failed: its attempt header, 0 when absent.
func attemptOf(msg kafka.Message) int {
	for _, h := range msg.Headers {
		if h.Key == "attempt" {
			n, _ := strconv.Atoi(string(h.Value))
			return n
		}
	}
	return 0
}

// handOff writes the record to topic with its attempt count and error; the synchronous
// writer returns only once the broker acknowledged it (RequireAll).
func handOff(ctx context.Context, topic string, msg kafka.Message, attempt int, cause error) error {
	return writer.WriteMessages(ctx, kafka.Message{
		Topic: topic,
		Key:   msg.Key,
		Value: msg.Value,
		Headers: []kafka.Header{
			{Key: "attempt", Value: []byte(strconv.Itoa(attempt))},
			{Key: "error", Value: []byte(cause.Error())},
		},
	})
}

func run(ctx context.Context, handler Handler) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		attempt := attemptOf(msg) + 1
		var event map[string]any
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			if err := handOff(ctx, dlqTopic, msg, attempt, err); err != nil {
				return err // not committed: the record is redelivered
			}
		} else if err := handler(event); err != nil {
			target := dlqTopic
			if attempt < maxAttempts {
				target = retryTopic
			}
			if err := handOff(ctx, target, msg, attempt, err); err != nil {
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
      starter: `import java.time.Duration
import java.util.{Collections, Properties}

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.jdk.CollectionConverters._
import scala.util.control.NonFatal

object RetryDlq {
  val Source = "orders"
  val Retry = "orders.retry"
  val Dlq = "orders.dlq"
  val Group = "fulfilment"
  val MaxAttempts = 3

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", Group)
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Source, Retry).asJava)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** The shape a parseable order event has; there is no JSON library on this stack. */
  private val OrderEvent = """^\\s*\\{.*"order"\\s*:.*\\}\\s*$""".r

  /** How many times this record has already failed: its attempt header, 0 when absent. */
  private def attemptOf(record: ConsumerRecord[String, String]): Int =
    Option(record.headers().lastHeader("attempt")).map(h => new String(h.value()).toInt).getOrElse(0)

  private def handOff(topic: String, record: ConsumerRecord[String, String], attempt: Int, error: String): Unit = {
    // TODO: send the record's key and value to topic with headers attempt=<attempt>, error=<error>
    // TODO: wait for the acknowledgement (.get() on the future)
    ???
  }

  def run(handler: String => Unit): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        // TODO: validate with OrderEvent; malformed → handOff to Dlq with attempt+1
        // TODO: call handler(record.value()); on a throw hand off to Retry (attempt+1 < MaxAttempts) or Dlq
        // TODO: commitSync this record's offset + 1, on every path
        ???
      }
    }
}
`,
      solution: `import java.time.Duration
import java.util.{Collections, Properties}

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.jdk.CollectionConverters._
import scala.util.control.NonFatal

object RetryDlq {
  val Source = "orders"
  val Retry = "orders.retry"
  val Dlq = "orders.dlq"
  val Group = "fulfilment"
  val MaxAttempts = 3

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", Group)
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Source, Retry).asJava)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** The shape a parseable order event has; there is no JSON library on this stack. */
  private val OrderEvent = """^\\s*\\{.*"order"\\s*:.*\\}\\s*$""".r

  /** How many times this record has already failed: its attempt header, 0 when absent. */
  private def attemptOf(record: ConsumerRecord[String, String]): Int =
    Option(record.headers().lastHeader("attempt")).map(h => new String(h.value()).toInt).getOrElse(0)

  /** Hand the record to topic with its attempt count and error; .get() waits for the broker's acknowledgement. */
  private def handOff(topic: String, record: ConsumerRecord[String, String], attempt: Int, error: String): Unit = {
    val out = new ProducerRecord[String, String](topic, record.key(), record.value())
    out.headers().add("attempt", attempt.toString.getBytes).add("error", error.getBytes)
    producer.send(out).get() // throws if not acknowledged: the record is then not committed
  }

  def run(handler: String => Unit): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val attempt = attemptOf(record) + 1
        record.value() match {
          case OrderEvent() =>
            try handler(record.value())
            catch {
              case NonFatal(e) => handOff(if (attempt < MaxAttempts) Retry else Dlq, record, attempt, e.getMessage)
            }
          case _ => handOff(Dlq, record, attempt, "malformed event")
        }
        val next = new OffsetAndMetadata(record.offset() + 1)
        consumer.commitSync(Collections.singletonMap(new TopicPartition(record.topic(), record.partition()), next))
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <iostream>
#include <memory>
#include <regex>
#include <stdexcept>
#include <string>
#include <vector>

const std::string kSource = "orders";
const std::string kRetry = "orders.retry";
const std::string kDlq = "orders.dlq";
const std::string kGroup = "fulfilment";
const int kMaxAttempts = 3;

class RememberFailure : public RdKafka::DeliveryReportCb {
 public:
  std::string error;
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) error = message.errstr();
  }
};

RememberFailure delivery;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kSource, kRetry});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();
// The shape a parseable order event has; there is no JSON library on this stack.
const std::regex kOrderEvent(R"(^\\s*\\{.*"order"\\s*:.*\\}\\s*$)");

// How many times this record has already failed: its attempt header, 0 when absent.
int attempt_of(RdKafka::Message& msg) {
  if (msg.headers() == nullptr) return 0;
  const auto found = msg.headers()->get("attempt");
  return found.empty() ? 0 : std::stoi(found.back().value_string());
}

void hand_off(const std::string& topic, RdKafka::Message& msg, int attempt, const std::string& error) {
  // TODO: produce msg's key and payload to topic with headers attempt=<attempt>, error=<error>
  // TODO: flush; throw std::runtime_error if the delivery report carries an error or the queue is not empty
  throw std::runtime_error("not implemented");
}

void run(const std::function<void(const std::string&)>& handler) {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    // TODO: validate with kOrderEvent; malformed → hand_off to kDlq with attempt+1
    // TODO: call handler(value); on an exception hand off to kRetry (attempt+1 < kMaxAttempts) or kDlq
    // TODO: commitSync this message, on every path
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <iostream>
#include <memory>
#include <regex>
#include <stdexcept>
#include <string>
#include <vector>

const std::string kSource = "orders";
const std::string kRetry = "orders.retry";
const std::string kDlq = "orders.dlq";
const std::string kGroup = "fulfilment";
const int kMaxAttempts = 3;

class RememberFailure : public RdKafka::DeliveryReportCb {
 public:
  std::string error;
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) error = message.errstr();
  }
};

RememberFailure delivery;

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kSource, kRetry});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();
// The shape a parseable order event has; there is no JSON library on this stack.
const std::regex kOrderEvent(R"(^\\s*\\{.*"order"\\s*:.*\\}\\s*$)");

// How many times this record has already failed: its attempt header, 0 when absent.
int attempt_of(RdKafka::Message& msg) {
  if (msg.headers() == nullptr) return 0;
  const auto found = msg.headers()->get("attempt");
  return found.empty() ? 0 : std::stoi(found.back().value_string());
}

// Hand the record to topic with its attempt count and error; flush waits for the broker's acknowledgement.
void hand_off(const std::string& topic, RdKafka::Message& msg, int attempt, const std::string& error) {
  auto headers = RdKafka::Headers::create();
  headers->add("attempt", std::to_string(attempt));
  headers->add("error", error);
  delivery.error.clear();
  const std::string* key = msg.key();
  producer->produce(topic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, msg.payload(), msg.len(),
                    key ? key->data() : nullptr, key ? key->size() : 0, 0, headers, nullptr);
  producer->flush(10000);
  if (producer->outq_len() > 0 || !delivery.error.empty())
    throw std::runtime_error("hand-off to " + topic + " not acknowledged: " + delivery.error);  // not committed
}

void run(const std::function<void(const std::string&)>& handler) {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const int attempt = attempt_of(*msg) + 1;
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    if (!std::regex_search(value, kOrderEvent)) {
      hand_off(kDlq, *msg, attempt, "malformed event");
    } else {
      try {
        handler(value);
      } catch (const std::exception& e) {
        hand_off(attempt < kMaxAttempts ? kRetry : kDlq, *msg, attempt, e.what());
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


def _seed(ctx, key, order, topic="orders"):
    return ctx.kafka.seed(topic, key=key, value=json.dumps({"order": order, "sku": "lamp"}))


def _header(record, name):
    for header, value in record.headers:
        if header == name:
            return value.decode()
    return None


def _failing(times, calls):
    """A handler that raises for its first \`times\` calls and succeeds after; \`calls\` collects the orders it saw."""

    def handler(event):
        calls.append(event["order"])
        if len(calls) <= times:
            raise RuntimeError("warehouse down")

    return handler


def check_retry_then_succeed(ctx):
    _seed(ctx, "order-7", 7)
    calls = []
    m = ctx.load("retry_dlq")
    ctx.drain(m.run, _failing(2, calls))
    assert calls == [7, 7, 7], f"the handler must see the order once per attempt (3 times), saw {calls}"
    retry = ctx.kafka.records("orders.retry")
    assert [_header(r, "attempt") for r in retry] == ["1", "2"], f"orders.retry must hold attempt 1 then 2, holds {[_header(r, 'attempt') for r in retry]}"
    assert all(_header(r, "error") == "warehouse down" for r in retry), "the error header must carry the exception's message"
    assert all(json.loads(r.value)["order"] == 7 for r in retry), "the hand-off must carry the source value unchanged"
    assert ctx.kafka.records("orders.dlq") == [], "a record that eventually succeeds must not be dead-lettered"
    assert ctx.kafka.lag("fulfilment", "orders") == 0 and ctx.kafka.lag("fulfilment", "orders.retry") == 0, "every handled record must be committed"


def check_dead_letter(ctx):
    _seed(ctx, "order-7", 7)
    calls = []
    m = ctx.load("retry_dlq")
    ctx.drain(m.run, _failing(99, calls))
    assert len(calls) == 3, f"a record is tried MAX_ATTEMPTS = 3 times, the handler ran {len(calls)} times"
    assert [_header(r, "attempt") for r in ctx.kafka.records("orders.retry")] == ["1", "2"], "the first two failures go to orders.retry"
    dlq = ctx.kafka.records("orders.dlq")
    assert len(dlq) == 1, f"the third failure dead-letters the record once, orders.dlq holds {len(dlq)}"
    assert _header(dlq[0], "attempt") == "3", f"the dead letter's attempt header must be 3, got {_header(dlq[0], 'attempt')!r}"
    assert _header(dlq[0], "error") == "warehouse down", "the dead letter's error header must carry the exception's message"
    assert json.loads(dlq[0].value)["order"] == 7, "the dead letter must carry the source value unchanged"
    assert ctx.kafka.lag("fulfilment", "orders") == 0 and ctx.kafka.lag("fulfilment", "orders.retry") == 0, "dead-lettering commits the source offset"


def check_keyed_handoff(ctx):
    source = _seed(ctx, "order-7", 7)
    _seed(ctx, "order-8", 8)
    calls = []

    def handler(event):
        calls.append(event["order"])
        if event["order"] == 7:
            raise RuntimeError("warehouse down")

    m = ctx.load("retry_dlq")
    ctx.drain(m.run, handler)
    handed = ctx.kafka.records("orders.retry") + ctx.kafka.records("orders.dlq")
    assert len(handed) == 3, f"order 7 fails three times: two retries and a dead letter, got {len(handed)} hand-offs"
    assert all(r.key == b"order-7" for r in handed), f"hand-off records must keep the key order-7, got {[r.key for r in handed]}"
    assert all(r.partition == ctx.kafka.partition_for(r.topic, b"order-7") for r in handed), "a keyed hand-off hashes to the key's partition"
    assert calls.count(8) == 1 and calls.count(7) == 3, f"order 8 is handled once, order 7 three times; saw {calls}"


def check_ack_before_commit(ctx):
    _seed(ctx, "order-7", 7)
    ctx.kafka.stall("orders.retry", 5)
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(len(ctx.kafka.records("orders.retry"))))
    calls = []
    m = ctx.load("retry_dlq")
    ctx.drain(m.run, _failing(1, calls))
    assert ("produce-stalled", "orders.retry") in ctx.kafka.events, "the hand-off must be produced to orders.retry (it was stalled)"
    assert at_commit, "the source offset was never committed"
    assert at_commit[0] == 1, "the source offset was committed while the hand-off was still in flight: wait for the acknowledgement first"
    assert ctx.clock.offset > 4, "the commit must wait out the stall (5 s of virtual time) for the broker's acknowledgement"
    assert calls == [7, 7], f"the retry record must be handled once the broker resumes, saw {calls}"
    assert ctx.kafka.lag("fulfilment", "orders") == 0 and ctx.kafka.lag("fulfilment", "orders.retry") == 0, "every handled record must be committed"


def check_poison(ctx):
    ctx.kafka.seed("orders", key="order-9", value="not json")
    _seed(ctx, "order-7", 7)
    calls = []
    m = ctx.load("retry_dlq")
    ctx.drain(m.run, _failing(0, calls))
    assert calls == [7], f"the handler must never see a record that does not parse, saw {calls}"
    assert ctx.kafka.records("orders.retry") == [], "malformed JSON is not retried"
    dlq = ctx.kafka.records("orders.dlq")
    assert len(dlq) == 1 and dlq[0].key == b"order-9" and dlq[0].value == b"not json", "the malformed record goes to orders.dlq with its key and value"
    assert _header(dlq[0], "attempt") == "1", f"dead-lettered on first sight: attempt must be 1, got {_header(dlq[0], 'attempt')!r}"
    assert _header(dlq[0], "error"), "the dead letter's error header must say why"
    assert ctx.kafka.lag("fulfilment", "orders") == 0, "a dead-lettered record's offset must be committed"


def check_commits_advance(ctx):
    for order in (7, 8, 9, 10):
        _seed(ctx, f"order-{order}", order)
    calls = []

    def handler(event):
        calls.append(event["order"])
        if event["order"] == 8 and calls.count(8) == 1:
            raise RuntimeError("warehouse down")

    m = ctx.load("retry_dlq")
    ctx.drain(m.run, handler)
    assert sorted(calls) == [7, 8, 8, 9, 10], f"four orders, one retried once: expected five handler calls, saw {calls}"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer"
    assert len(ctx.kafka.commits("fulfilment")) >= 5, f"each handled record ends with a commit (5 expected), saw {len(ctx.kafka.commits('fulfilment'))}"
    for topic in ("orders", "orders.retry"):
        for partition in range(3):
            end = ctx.kafka.end_offset(topic, partition)
            committed = ctx.kafka.committed_offset("fulfilment", topic, partition) or 0
            assert committed == end, f"{topic}[{partition}]: committed {committed}, end offset {end}"
`,
    typescript: `const decode = (bytes: Uint8Array | undefined): string | null => (bytes === undefined ? null : new TextDecoder().decode(bytes));

function seed(ctx, key: string, order: number, topic = 'orders') {
  return ctx.kafka.seed(topic, {key, value: JSON.stringify({order, sku: 'lamp'})});
}

const header = (record, name: string): string | null => decode(record.headers[name]);

/** A handler that throws for its first \`times\` calls and succeeds after; \`calls\` collects the orders it saw. */
function failing(times: number, calls: number[]) {
  return (event: {order: number}) => {
    calls.push(event.order);
    if (calls.length <= times) throw new Error('warehouse down');
  };
}

const value = (record): string => new TextDecoder().decode(record.value);

export async function check_retry_then_succeed(ctx) {
  seed(ctx, 'order-7', 7);
  const calls: number[] = [];
  const m = ctx.load('retry_dlq');
  await ctx.drain(m.run(failing(2, calls)));
  assert.deepEqual(calls, [7, 7, 7], \`the handler must see the order once per attempt (3 times), saw \${JSON.stringify(calls)}\`);
  const retry = ctx.kafka.records('orders.retry');
  assert.deepEqual(retry.map(r => header(r, 'attempt')), ['1', '2'], \`orders.retry must hold attempt 1 then 2, holds \${JSON.stringify(retry.map(r => header(r, 'attempt')))}\`);
  assert(retry.every(r => header(r, 'error') === 'warehouse down'), "the error header must carry the exception's message");
  assert(retry.every(r => JSON.parse(value(r)).order === 7), 'the hand-off must carry the source value unchanged');
  assert.equal(ctx.kafka.records('orders.dlq').length, 0, 'a record that eventually succeeds must not be dead-lettered');
  assert(ctx.kafka.lag('fulfilment', 'orders') === 0 && ctx.kafka.lag('fulfilment', 'orders.retry') === 0, 'every handled record must be committed');
}

export async function check_dead_letter(ctx) {
  seed(ctx, 'order-7', 7);
  const calls: number[] = [];
  const m = ctx.load('retry_dlq');
  await ctx.drain(m.run(failing(99, calls)));
  assert.equal(calls.length, 3, \`a record is tried MAX_ATTEMPTS = 3 times, the handler ran \${calls.length} times\`);
  assert.deepEqual(ctx.kafka.records('orders.retry').map(r => header(r, 'attempt')), ['1', '2'], 'the first two failures go to orders.retry');
  const dlq = ctx.kafka.records('orders.dlq');
  assert.equal(dlq.length, 1, \`the third failure dead-letters the record once, orders.dlq holds \${dlq.length}\`);
  assert.equal(header(dlq[0], 'attempt'), '3', \`the dead letter's attempt header must be 3, got \${JSON.stringify(header(dlq[0], 'attempt'))}\`);
  assert.equal(header(dlq[0], 'error'), 'warehouse down', "the dead letter's error header must carry the exception's message");
  assert.equal(JSON.parse(value(dlq[0])).order, 7, 'the dead letter must carry the source value unchanged');
  assert(ctx.kafka.lag('fulfilment', 'orders') === 0 && ctx.kafka.lag('fulfilment', 'orders.retry') === 0, 'dead-lettering commits the source offset');
}

export async function check_keyed_handoff(ctx) {
  seed(ctx, 'order-7', 7);
  seed(ctx, 'order-8', 8);
  const calls: number[] = [];
  const handler = (event: {order: number}) => {
    calls.push(event.order);
    if (event.order === 7) throw new Error('warehouse down');
  };
  const m = ctx.load('retry_dlq');
  await ctx.drain(m.run(handler));
  const handed = [...ctx.kafka.records('orders.retry'), ...ctx.kafka.records('orders.dlq')];
  assert.equal(handed.length, 3, \`order 7 fails three times: two retries and a dead letter, got \${handed.length} hand-offs\`);
  assert(handed.every(r => decode(r.key) === 'order-7'), \`hand-off records must keep the key order-7, got \${JSON.stringify(handed.map(r => decode(r.key)))}\`);
  assert(handed.every(r => r.partition === ctx.kafka.partitionFor(r.topic, new TextEncoder().encode('order-7'))), "a keyed hand-off hashes to the key's partition");
  assert(calls.filter(o => o === 8).length === 1 && calls.filter(o => o === 7).length === 3, \`order 8 is handled once, order 7 three times; saw \${JSON.stringify(calls)}\`);
}

export async function check_ack_before_commit(ctx) {
  seed(ctx, 'order-7', 7);
  ctx.kafka.stall('orders.retry', 5);
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.kafka.records('orders.retry').length));
  const calls: number[] = [];
  const before = ctx.clock.now();
  const m = ctx.load('retry_dlq');
  await ctx.drain(m.run(failing(1, calls)));
  assert(ctx.kafka.events.some(e => e[0] === 'produce-stalled' && e[1] === 'orders.retry'), 'the hand-off must be produced to orders.retry (it was stalled)');
  assert(atCommit.length > 0, 'the source offset was never committed');
  assert.equal(atCommit[0], 1, 'the source offset was committed while the hand-off was still in flight: wait for the acknowledgement first');
  assert(ctx.clock.now() - before > 4000, "the commit must wait out the stall (5 s of virtual time) for the broker's acknowledgement");
  assert.deepEqual(calls, [7, 7], \`the retry record must be handled once the broker resumes, saw \${JSON.stringify(calls)}\`);
  assert(ctx.kafka.lag('fulfilment', 'orders') === 0 && ctx.kafka.lag('fulfilment', 'orders.retry') === 0, 'every handled record must be committed');
}

export async function check_poison(ctx) {
  ctx.kafka.seed('orders', {key: 'order-9', value: 'not json'});
  seed(ctx, 'order-7', 7);
  const calls: number[] = [];
  const m = ctx.load('retry_dlq');
  await ctx.drain(m.run(failing(0, calls)));
  assert.deepEqual(calls, [7], \`the handler must never see a record that does not parse, saw \${JSON.stringify(calls)}\`);
  assert.equal(ctx.kafka.records('orders.retry').length, 0, 'malformed JSON is not retried');
  const dlq = ctx.kafka.records('orders.dlq');
  assert(dlq.length === 1 && decode(dlq[0].key) === 'order-9' && value(dlq[0]) === 'not json', 'the malformed record goes to orders.dlq with its key and value');
  assert.equal(header(dlq[0], 'attempt'), '1', \`dead-lettered on first sight: attempt must be 1, got \${JSON.stringify(header(dlq[0], 'attempt'))}\`);
  assert(header(dlq[0], 'error'), "the dead letter's error header must say why");
  assert.equal(ctx.kafka.lag('fulfilment', 'orders'), 0, "a dead-lettered record's offset must be committed");
}

export async function check_commits_advance(ctx) {
  for (const order of [7, 8, 9, 10]) seed(ctx, \`order-\${order}\`, order);
  const calls: number[] = [];
  const handler = (event: {order: number}) => {
    calls.push(event.order);
    if (event.order === 8 && calls.filter(o => o === 8).length === 1) throw new Error('warehouse down');
  };
  const m = ctx.load('retry_dlq');
  await ctx.drain(m.run(handler));
  assert.deepEqual([...calls].sort((a, b) => a - b), [7, 8, 8, 9, 10], \`four orders, one retried once: expected five handler calls, saw \${JSON.stringify(calls)}\`);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer');
  assert(ctx.kafka.commits('fulfilment').length >= 5, \`each handled record ends with a commit (5 expected), saw \${ctx.kafka.commits('fulfilment').length}\`);
  for (const topic of ['orders', 'orders.retry'])
    for (let partition = 0; partition < 3; partition++) {
      const end = ctx.kafka.endOffset(topic, partition);
      const committed = ctx.kafka.committedOffset('fulfilment', topic, partition) ?? 0;
      assert.equal(committed, end, \`\${topic}[\${partition}]: committed \${committed}, end offset \${end}\`);
    }
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/segmentio/kafka-go"

	"leetbuild/harness"
)

func seedOrder(ctx *harness.Ctx, key string, order int) {
	ctx.Kafka.Seed("orders", key, map[string]any{"order": order, "sku": "lamp"})
}

// headerOf is a record's header as text, nil when absent.
func headerOf(r harness.KafkaRecord, name string) any {
	if v, ok := r.Header(name); ok {
		return string(v)
	}
	return nil
}

func headersOf(records []harness.KafkaRecord, name string) []any {
	out := []any{}
	for _, r := range records {
		out = append(out, headerOf(r, name))
	}
	return out
}

func orderOf(r harness.KafkaRecord) any {
	var event map[string]any
	if json.Unmarshal(r.Value, &event) != nil {
		return nil
	}
	return event["order"]
}

// failingHandler returns an error for its first times calls and succeeds after; calls collects the orders it saw.
func failingHandler(times int, calls *[]int) Handler {
	return func(event map[string]any) error {
		order, _ := event["order"].(float64)
		*calls = append(*calls, int(order))
		if len(*calls) <= times {
			return errors.New("warehouse down")
		}
		return nil
	}
}

// consumeOrders runs the learner's loop until it waits for records that will not come, then stops it.
func consumeOrders(ctx *harness.Ctx, handler Handler) {
	c, cancel := context.WithCancel(context.Background())
	var err error
	ctx.Drain(func() { err = run(c, handler) })
	cancel()
	ctx.Settle()
	if err != nil && !errors.Is(err, context.Canceled) {
		ctx.Fatalf("run returned an error: %v", err)
	}
}

func noLag(ctx *harness.Ctx) bool {
	return ctx.Kafka.Lag("fulfilment", "orders") == 0 && ctx.Kafka.Lag("fulfilment", "orders.retry") == 0
}

func CheckRetryThenSucceed(ctx *harness.Ctx) {
	seedOrder(ctx, "order-7", 7)
	var calls []int
	consumeOrders(ctx, failingHandler(2, &calls))
	ctx.Equal(calls, []int{7, 7, 7}, "the handler must see the order once per attempt (3 times)")
	retry := ctx.Kafka.Records("orders.retry")
	ctx.Equal(headersOf(retry, "attempt"), []any{"1", "2"}, "orders.retry must hold attempt 1 then 2")
	for _, r := range retry {
		ctx.Assert(headerOf(r, "error") == "warehouse down", "the error header must carry the handler error's message, got %s", harness.Show(headerOf(r, "error")))
		ctx.Assert(orderOf(r) == float64(7), "the hand-off must carry the source value unchanged, got %q", r.Value)
	}
	ctx.Equal(len(ctx.Kafka.Records("orders.dlq")), 0, "a record that eventually succeeds must not be dead-lettered: records on orders.dlq")
	ctx.Assert(noLag(ctx), "every handled record must be committed")
}

func CheckDeadLetter(ctx *harness.Ctx) {
	seedOrder(ctx, "order-7", 7)
	var calls []int
	consumeOrders(ctx, failingHandler(99, &calls))
	ctx.Equal(len(calls), 3, "a record is tried maxAttempts = 3 times: handler calls")
	ctx.Equal(headersOf(ctx.Kafka.Records("orders.retry"), "attempt"), []any{"1", "2"}, "the first two failures go to orders.retry")
	dlq := ctx.Kafka.Records("orders.dlq")
	ctx.Equal(len(dlq), 1, "the third failure dead-letters the record once: records on orders.dlq")
	ctx.Equal(headerOf(dlq[0], "attempt"), "3", "the dead letter's attempt header")
	ctx.Equal(headerOf(dlq[0], "error"), "warehouse down", "the dead letter's error header must carry the handler error's message")
	ctx.Equal(orderOf(dlq[0]), 7, "the dead letter must carry the source value unchanged: its order")
	ctx.Assert(noLag(ctx), "dead-lettering commits the source offset")
}

func CheckKeyedHandoff(ctx *harness.Ctx) {
	seedOrder(ctx, "order-7", 7)
	seedOrder(ctx, "order-8", 8)
	var calls []int
	consumeOrders(ctx, func(event map[string]any) error {
		order, _ := event["order"].(float64)
		calls = append(calls, int(order))
		if order == 7 {
			return errors.New("warehouse down")
		}
		return nil
	})
	handed := append(ctx.Kafka.Records("orders.retry"), ctx.Kafka.Records("orders.dlq")...)
	ctx.Equal(len(handed), 3, "order 7 fails three times, two retries and a dead letter: hand-offs")
	var keys []string
	for _, r := range handed {
		keys = append(keys, string(r.Key))
	}
	for _, key := range keys {
		ctx.Assert(key == "order-7", "hand-off records must keep the key order-7, got %q", keys)
	}
	for _, r := range handed {
		partitions := make([]int, ctx.Kafka.Partitions(r.Topic))
		for i := range partitions {
			partitions[i] = i
		}
		want := (&kafka.Hash{}).Balance(kafka.Message{Key: []byte("order-7")}, partitions...)
		ctx.Equal(r.Partition, want, "a keyed hand-off hashes to the key's partition on %s", r.Topic)
	}
	sevens, eights := 0, 0
	for _, o := range calls {
		switch o {
		case 7:
			sevens++
		case 8:
			eights++
		}
	}
	ctx.Assert(eights == 1 && sevens == 3, "order 8 is handled once, order 7 three times; saw %v", calls)
}

func CheckAckBeforeCommit(ctx *harness.Ctx) {
	seedOrder(ctx, "order-7", 7)
	ctx.Kafka.StallFor("orders.retry", 5)
	var atCommit []int
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, len(ctx.Kafka.Records("orders.retry"))) })
	var calls []int
	before := ctx.Clock.Now()
	consumeOrders(ctx, failingHandler(1, &calls))
	stalled := false
	for _, e := range ctx.Kafka.EventsOf("produce-stalled") {
		stalled = stalled || e.Topic == "orders.retry"
	}
	ctx.Assert(stalled, "the hand-off must be produced to orders.retry (it was stalled)")
	ctx.Assert(len(atCommit) > 0, "the source offset was never committed")
	ctx.Equal(atCommit[0], 1, "the source offset was committed while the hand-off was still in flight (wait for the acknowledgement first): records on orders.retry at the first commit")
	ctx.Assert(ctx.Clock.Now()-before > 4000, "the commit must wait out the stall (5 s of virtual time) for the broker's acknowledgement")
	ctx.Equal(calls, []int{7, 7}, "the retry record must be handled once the broker resumes: handler calls")
	ctx.Assert(noLag(ctx), "every handled record must be committed")
}

func CheckPoison(ctx *harness.Ctx) {
	ctx.Kafka.Seed("orders", "order-9", "not json")
	seedOrder(ctx, "order-7", 7)
	var calls []int
	consumeOrders(ctx, failingHandler(0, &calls))
	ctx.Equal(calls, []int{7}, "the handler must never see a record that does not parse: handler calls")
	ctx.Equal(len(ctx.Kafka.Records("orders.retry")), 0, "malformed JSON is not retried: records on orders.retry")
	dlq := ctx.Kafka.Records("orders.dlq")
	ctx.Assert(len(dlq) == 1 && string(dlq[0].Key) == "order-9" && string(dlq[0].Value) == "not json", "the malformed record goes to orders.dlq with its key and value")
	ctx.Equal(headerOf(dlq[0], "attempt"), "1", "dead-lettered on first sight: the attempt header")
	errText, _ := headerOf(dlq[0], "error").(string)
	ctx.Assert(errText != "", "the dead letter's error header must say why")
	ctx.Equal(ctx.Kafka.Lag("fulfilment", "orders"), 0, "a dead-lettered record's offset must be committed: lag on orders")
}

func CheckCommitsAdvance(ctx *harness.Ctx) {
	for _, order := range []int{7, 8, 9, 10} {
		seedOrder(ctx, fmt.Sprintf("order-%d", order), order)
	}
	var calls []int
	eightFailed := false
	consumeOrders(ctx, func(event map[string]any) error {
		order, _ := event["order"].(float64)
		calls = append(calls, int(order))
		if order == 8 && !eightFailed {
			eightFailed = true
			return errors.New("warehouse down")
		}
		return nil
	})
	sorted := append([]int(nil), calls...)
	sort.Ints(sorted)
	ctx.Equal(sorted, []int{7, 8, 8, 9, 10}, "four orders, one retried once: expected five handler calls, saw %v", calls)
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "auto-commit is on (offsets were committed on a timer): auto-commit events")
	commits := len(ctx.Kafka.Commits("fulfilment"))
	ctx.Assert(commits >= 5, "each handled record ends with a commit (5 expected), saw %d", commits)
	for _, topic := range []string{"orders", "orders.retry"} {
		for partition := range 3 {
			end := ctx.Kafka.EndOffset(topic, partition)
			committed, ok := ctx.Kafka.Committed("fulfilment", topic, partition)
			if !ok {
				committed = 0
			}
			ctx.Equal(committed, end, "%s[%d]: the committed offset must reach the end offset", topic, partition)
		}
	}
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <exception>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using OrderHandler = std::function<void(const std::string&)>;

void seedOrder(harness::Ctx& ctx, const std::string& key, int order) {
  ctx.Kafka.Seed("orders", key, nlohmann::json{{"order", order}, {"sku", "lamp"}});
}

// headersOf is each record's header as text, empty when absent.
std::vector<std::optional<std::string>> headersOf(const std::vector<harness::KafkaRecord>& records, const std::string& name) {
  std::vector<std::optional<std::string>> out;
  for (const auto& r : records) out.push_back(r.Header(name));
  return out;
}

// orderOf is the order field of a record's JSON value, null when it does not parse.
nlohmann::json orderOf(const harness::KafkaRecord& r) {
  const auto event = nlohmann::json::parse(r.Value.value_or(""), nullptr, false);
  return event.is_object() && event.contains("order") ? event["order"] : nlohmann::json();
}

int orderIn(const std::string& value) {
  const auto event = nlohmann::json::parse(value, nullptr, false);
  return event.is_object() && event.contains("order") && event["order"].is_number() ? event["order"].get<int>() : 0;
}

// failingHandler throws for its first times calls and succeeds after; calls collects the orders it saw.
OrderHandler failingHandler(int times, std::vector<int>& calls) {
  return [times, &calls](const std::string& value) {
    calls.push_back(orderIn(value));
    if (static_cast<int>(calls.size()) <= times) throw std::runtime_error("warehouse down");
  };
}

// consumeOrders runs the learner's loop until it waits for records that will not come.
void consumeOrders(harness::Ctx& ctx, const OrderHandler& handler) {
  try {
    ctx.Drain([&] { run(handler); });
  } catch (const std::exception& e) {
    ctx.Fatalf("run threw: %v", e.what());
  }
}

bool noLag(harness::Ctx& ctx) {
  return ctx.Kafka.Lag("fulfilment", "orders") == 0 && ctx.Kafka.Lag("fulfilment", "orders.retry") == 0;
}

}  // namespace

void CheckRetryThenSucceed(harness::Ctx& ctx) {
  seedOrder(ctx, "order-7", 7);
  std::vector<int> calls;
  consumeOrders(ctx, failingHandler(2, calls));
  ctx.Equal(calls, {7, 7, 7}, "the handler must see the order once per attempt (3 times)");
  const auto retry = ctx.Kafka.Records("orders.retry");
  ctx.Equal(headersOf(retry, "attempt"), {"1", "2"}, "orders.retry must hold attempt 1 then 2");
  for (const auto& r : retry) {
    ctx.Assert(r.Header("error") == "warehouse down", "the error header must carry the handler error's message, got %q", r.Header("error"));
    ctx.Assert(orderOf(r) == 7, "the hand-off must carry the source value unchanged, got %q", r.Value);
  }
  ctx.Equal(ctx.Kafka.Records("orders.dlq").size(), 0,
            "a record that eventually succeeds must not be dead-lettered: records on orders.dlq");
  ctx.Assert(noLag(ctx), "every handled record must be committed");
}

void CheckDeadLetter(harness::Ctx& ctx) {
  seedOrder(ctx, "order-7", 7);
  std::vector<int> calls;
  consumeOrders(ctx, failingHandler(99, calls));
  ctx.Equal(calls.size(), 3, "a record is tried maxAttempts = 3 times: handler calls");
  ctx.Equal(headersOf(ctx.Kafka.Records("orders.retry"), "attempt"), {"1", "2"}, "the first two failures go to orders.retry");
  const auto dlq = ctx.Kafka.Records("orders.dlq");
  ctx.Equal(dlq.size(), 1, "the third failure dead-letters the record once: records on orders.dlq");
  ctx.Equal(dlq[0].Header("attempt"), "3", "the dead letter's attempt header");
  ctx.Equal(dlq[0].Header("error"), "warehouse down", "the dead letter's error header must carry the handler error's message");
  ctx.Assert(orderOf(dlq[0]) == 7, "the dead letter must carry the source value unchanged: its order is %v", orderOf(dlq[0]).dump());
  ctx.Assert(noLag(ctx), "dead-lettering commits the source offset");
}

void CheckKeyedHandoff(harness::Ctx& ctx) {
  seedOrder(ctx, "order-7", 7);
  seedOrder(ctx, "order-8", 8);
  std::vector<int> calls;
  consumeOrders(ctx, [&](const std::string& value) {
    const int order = orderIn(value);
    calls.push_back(order);
    if (order == 7) throw std::runtime_error("warehouse down");
  });
  auto handed = ctx.Kafka.Records("orders.retry");
  for (auto& r : ctx.Kafka.Records("orders.dlq")) handed.push_back(r);
  ctx.Equal(handed.size(), 3, "order 7 fails three times, two retries and a dead letter: hand-offs");
  std::vector<std::string> keys;
  for (const auto& r : handed) keys.push_back(r.Key.value_or(""));
  for (const auto& key : keys) ctx.Assert(key == "order-7", "hand-off records must keep the key order-7, got %q", keys);
  for (const auto& r : handed)
    ctx.Equal(r.Partition, ctx.Kafka.PartitionFor(r.Topic, "order-7"), "a keyed hand-off hashes to the key's partition on %s", r.Topic);
  const auto sevens = std::count(calls.begin(), calls.end(), 7);
  const auto eights = std::count(calls.begin(), calls.end(), 8);
  ctx.Assert(eights == 1 && sevens == 3, "order 8 is handled once, order 7 three times; saw %v", calls);
}

void CheckAckBeforeCommit(harness::Ctx& ctx) {
  seedOrder(ctx, "order-7", 7);
  ctx.Kafka.StallFor("orders.retry", 5);
  std::vector<size_t> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) {
    atCommit.push_back(ctx.Kafka.Records("orders.retry").size());
  });
  std::vector<int> calls;
  const int64_t before = ctx.Clock.Now();
  consumeOrders(ctx, failingHandler(1, calls));
  bool stalled = false;
  for (const auto& e : ctx.Kafka.EventsOf("produce-stalled")) stalled = stalled || e.Topic == "orders.retry";
  ctx.Assert(stalled, "the hand-off must be produced to orders.retry (it was stalled)");
  ctx.Assert(!atCommit.empty(), "the source offset was never committed");
  ctx.Equal(atCommit[0], 1,
            "the source offset was committed while the hand-off was still in flight (wait for the acknowledgement first): records on orders.retry at the first commit");
  ctx.Assert(ctx.Clock.Now() - before > 4000,
             "the commit must wait out the stall (5 s of virtual time) for the broker's acknowledgement");
  ctx.Equal(calls, {7, 7}, "the retry record must be handled once the broker resumes: handler calls");
  ctx.Assert(noLag(ctx), "every handled record must be committed");
}

void CheckPoison(harness::Ctx& ctx) {
  ctx.Kafka.Seed("orders", "order-9", "not json");
  seedOrder(ctx, "order-7", 7);
  std::vector<int> calls;
  consumeOrders(ctx, failingHandler(0, calls));
  ctx.Equal(calls, {7}, "the handler must never see a record that does not parse: handler calls");
  ctx.Equal(ctx.Kafka.Records("orders.retry").size(), 0, "malformed JSON is not retried: records on orders.retry");
  const auto dlq = ctx.Kafka.Records("orders.dlq");
  ctx.Assert(dlq.size() == 1 && dlq[0].Key == "order-9" && dlq[0].Value == "not json",
             "the malformed record goes to orders.dlq with its key and value");
  ctx.Equal(dlq[0].Header("attempt"), "1", "dead-lettered on first sight: the attempt header");
  ctx.Assert(!dlq[0].Header("error").value_or("").empty(), "the dead letter's error header must say why");
  ctx.Equal(ctx.Kafka.Lag("fulfilment", "orders"), 0, "a dead-lettered record's offset must be committed: lag on orders");
}

void CheckCommitsAdvance(harness::Ctx& ctx) {
  for (const int order : {7, 8, 9, 10}) seedOrder(ctx, "order-" + std::to_string(order), order);
  std::vector<int> calls;
  bool eightFailed = false;
  consumeOrders(ctx, [&](const std::string& value) {
    const int order = orderIn(value);
    calls.push_back(order);
    if (order == 8 && !eightFailed) {
      eightFailed = true;
      throw std::runtime_error("warehouse down");
    }
  });
  auto sorted = calls;
  std::sort(sorted.begin(), sorted.end());
  ctx.Equal(sorted, {7, 8, 8, 9, 10}, "four orders, one retried once: expected five handler calls, saw %v", calls);
  ctx.Equal(ctx.Kafka.EventsOf("auto-commit").size(), 0,
            "auto-commit is on (offsets were committed on a timer): auto-commit events");
  const size_t commits = ctx.Kafka.Commits("fulfilment").size();
  ctx.Assert(commits >= 5, "each handled record ends with a commit (5 expected), saw %d", commits);
  for (const std::string topic : {"orders", "orders.retry"}) {
    for (int partition = 0; partition < 3; partition++) {
      const int64_t end = ctx.Kafka.EndOffset(topic, partition);
      const int64_t committed = ctx.Kafka.Committed("fulfilment", topic, partition).value_or(0);
      ctx.Equal(committed, end, "%s[%d]: the committed offset must reach the end offset", topic, partition);
    }
  }
}
`,
  },
  debrief: `The shape is one consumer over two topics and one hand-off function. Re-producing the failed record instead of re-processing it in place is what keeps a poison record from parking the partition behind it; keeping the key keeps a customer's orders on one partition of the retry topic, in order. The attempt count travels in a header so the record's value is never rewritten, and the error header makes the dead letter debuggable without logs. The one subtle line is the flush before the commit: a commit is a promise that the record is dealt with, and it is only true once the retry record is durably on the next topic — produce-then-commit without the wait is at-most-once under a slow broker. Real systems add a delay before re-consuming the retry topic (a \`retry.5s\`, \`retry.1m\` ladder, or pausing the partition until the record's due time), a DLQ consumer that alerts and replays, and a bounded header size so error text cannot grow a record past the broker's limit.`,
};
