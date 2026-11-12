import type {Step} from '@/lib/types';

export const securityEventsStep: Step = {
  id: 'security-events',
  title: 'Kafka: one event per decision, signatures counted per hour',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'security_events',
  focus: ['api', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter's \`publish(user, decision)\`, which step 4 calls once per
decision, produces one JSON event to \`prompt.security\` (\`event_id\`, \`user\`, \`document_hash\`,
\`decision\`, \`signals\`, \`signature\`, \`ts\`, plus the decision's \`answer\`), keyed by the
event id, through a producer with \`acks=1\`, and logs the answer. Its consumer \`run()\` in group
\`signatures\` commits each offset, then \`HINCRBY\`s one global \`signatures\` hash by the event's
signature. It serves the demo and hides five flaws.

**Failure mode the checks target.** Keyed by event id, one user's events scatter across partitions
and lose their order; a producer that is not idempotent writes a retried event twice and a leader
failover loses what \`acks=1\` confirmed; the answer the guard refused to log lands on a retained
topic; one global counter of every decision cannot show when an attack began, and it grows
forever; a crash between the commit and the write loses the count.

- Key each event by \`user\`, and leave the answer out of the event and the log line.
- The producer is **idempotent** with \`acks=all\` (Go: confluent-kafka-go, which has an idempotent
  producer; kafka-go has none).
- The consumer counts **refused** events only, in \`signatures:{hour}\` (\`hour\` = \`ts\` //
  \`HOUR_S = 3600\`), and expires each bucket after \`BUCKET_TTL_S\` = 7 days.
- Commit the offset **after** the Redis write.`,
  sequence: {
    participants: ['promptguard', 'prompt.security', 'Signature consumer', 'Redis'],
    messages: [
      {from: 'promptguard', to: 'prompt.security', label: 'produce key=user · idempotent · acks=all', kind: 'async'},
      {
        from: 'prompt.security',
        to: 'Signature consumer',
        label: '{event_id, user, document_hash, decision, signals, signature, ts}',
        kind: 'async',
      },
      {
        from: 'Signature consumer',
        to: 'Redis',
        label: 'HINCRBY signatures:{ts // 3600} signature 1 · EXPIRE 7 d',
        kind: 'sync',
      },
      {from: 'Signature consumer', to: 'prompt.security', label: 'commit offset + 1', kind: 'sync'},
    ],
  },
  hints: [
    'Symptom: one user\u2019s events land on several partitions, a lost acknowledgement leaves an event twice on the topic, the answer shows up in the topic and the logs, and the signature counts never reset and include served questions.',
    'Mechanism: the record key is a fresh event id; the producer is not idempotent and confirms on the leader alone; the event copies `decision.answer`; the consumer commits before it counts, and counts every event in one key with no TTL.',
    'Change: `key=user`; `enable.idempotence` with `acks=all`; drop `answer` from the event and the log; `signatures_key(ts // HOUR_S)` for refused events, `EXPIRE BUCKET_TTL_S`, then commit.',
  ],
  checks: [
    {
      id: 'user-key',
      title: 'One event per decision, keyed by user',
      detail:
        'Each publish leaves one record keyed by the user, so a user’s events share a partition, with event_id, user, document_hash, decision (served or refused), signals, signature and ts. The starter keys by a fresh event id.',
      match: {
        python: {all: [/key\s*=\s*user\b/]},
        typescript: {all: [/key:\s*user\b/]},
        go: {all: [/Key:\s*\[\]byte\(user\)/]},
        scala: {all: [/ProducerRecord\[String,\s*String\]\(\s*Config\.Topic\s*,\s*user\s*,/]},
        cpp: {all: [/user\.data\(\)\s*,\s*user\.size\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'A produce whose acknowledgement was lost is written once, and a leader failover keeps it: enable.idempotence with acks=all (KafkaJS: idempotent: true and acks -1). The starter confirms on the leader alone and retries blind.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/], none: [/["']acks["']\s*:\s*["']?[01]["']?/]},
        typescript: {all: [/idempotent:\s*true/], none: [/acks:\s*[01]\b/]},
        go: {all: [/"enable\.idempotence":\s*true/], none: [/"acks":\s*"[01]"/]},
        scala: {all: [/"enable\.idempotence"\s*,\s*"true"/], none: [/"acks"\s*,\s*"[01]"/]},
        cpp: {all: [/"enable\.idempotence"\s*,\s*"true"/], none: [/"acks"\s*,\s*"[01]"/]},
      },
    },
    {
      id: 'no-text',
      title: 'No answer text in the event or the logs',
      detail:
        'The event carries hashes, signal names and the signature; neither it nor a log line carries the answer. The starter copies decision.answer into both.',
      match: {
        python: {none: [/["']answer["']\s*:/, /logger\.\w+\([^\n]*decision\.answer/]},
        typescript: {none: [/answer:\s*decision\.answer/, /console\.\w+\([^\n]*decision\.answer/]},
        go: {none: [/json:"answer"/, /log\.\w+\([^\n]*\.Answer/]},
        scala: {none: [/"answer"\s*->/, /println\([^\n]*\.answer/]},
        cpp: {none: [/\{"answer",/, /cerr[^;]*\.answer/]},
      },
    },
    {
      id: 'hour-bucket',
      title: 'Counts refusals per signature per hour, for a week',
      detail:
        'The consumer HINCRBYs signatures:{ts // 3600} for refused events only and expires each bucket after seven days. The starter counts every event, served ones too, in one signatures hash that never expires.',
      match: {
        python: {all: [/signatures_key\(/, /\.expire\(\s*key\s*,\s*BUCKET_TTL_S/]},
        typescript: {all: [/signaturesKey\(/, /\.expire\(\s*key\s*,\s*BUCKET_TTL_S/]},
        go: {all: [/config\.SignaturesKey\(/, /\.Expire\(\s*ctx\s*,\s*key\s*,\s*bucketTTL/]},
        scala: {all: [/Config\.signaturesKey\(/, /\.expire\(\s*key\s*,\s*BucketTtlSeconds/]},
        cpp: {all: [/config::signatures_key\(/, /\.expire\(\s*key\s*,\s*kBucketTtl/]},
      },
    },
    {
      id: 'write-before-commit',
      title: 'Writes the count before committing the offset',
      detail:
        'When an event’s offset is committed its count is already in Redis, so a crash replays the event instead of losing it. The starter commits first.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /\.CommitMessage\(/]},
        scala: {order: [/\.hincrBy\(/, /\.commitSync\(/]},
        cpp: {order: [/\.hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""prompt.security: one event per decision, and the consumer that counts attack signatures."""
import json
import logging
import time
import uuid

import redis
from confluent_kafka import Consumer, Producer

from promptguard.config import GROUP, TOPIC
from promptguard.types import Decision

logger = logging.getLogger("promptguard.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC])


def on_delivery(err, msg) -> None:
    if err is not None:
        logger.error("security event not delivered: %s", err)


def publish(user: str, decision: Decision) -> None:
    """One event per decision, for the signature consumer."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "event_id": str(uuid.uuid4()),
        "user": user,
        "document_hash": decision.document_hash,
        "decision": "refused" if decision.refused else "served",
        "signals": decision.signals,
        "signature": decision.signature,
        "answer": decision.answer,
        "ts": int(time.time()),
    }
    producer.produce(TOPIC, key=event["event_id"], value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)
    logger.info("security event user=%s answer=%r", user, decision.answer)


def run() -> None:
    """Count signatures as the events arrive."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(message=msg, asynchronous=False)
        event = json.loads(msg.value())
        r.hincrby("signatures", event["signature"], 1)
`,
      solution: `"""prompt.security: one event per decision, and the consumer that counts attack signatures."""
import json
import logging
import time
import uuid

import redis
from confluent_kafka import Consumer, Producer

from promptguard.config import GROUP, TOPIC, signatures_key
from promptguard.types import Decision

logger = logging.getLogger("promptguard.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

HOUR_S = 3_600
BUCKET_TTL_S = 7 * 86_400

# Idempotent: a retry after a lost acknowledgement is written once; acks=all: a failover keeps it.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC])


def on_delivery(err, msg) -> None:
    if err is not None:
        logger.error("security event not delivered: %s", err)


def publish(user: str, decision: Decision) -> None:
    """One event per decision, keyed by user: hashes and signal names, no text."""
    event = {
        "event_id": str(uuid.uuid4()),
        "user": user,
        "document_hash": decision.document_hash,
        "decision": "refused" if decision.refused else "served",
        "signals": decision.signals,
        "signature": decision.signature,
        "ts": int(time.time()),
    }
    producer.produce(TOPIC, key=user, value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)
    logger.info("security event user=%s decision=%s signature=%s", user, event["decision"], decision.signature)


def run() -> None:
    """Count refusals per signature per hour; commit each offset once its count is written."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        if event.get("decision") == "refused":
            key = signatures_key(int(event["ts"]) // HOUR_S)
            r.hincrby(key, event["signature"], 1)
            r.expire(key, BUCKET_TTL_S)
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `/** prompt.security: one event per decision, and the consumer that counts attack signatures. */
import {randomUUID} from 'node:crypto';

import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {GROUP, TOPIC} from 'promptguard/config';
import type {Decision} from 'promptguard/types';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'promptguard', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const consumer = kafka.consumer({groupId: GROUP});

/** One event per decision, for the signature consumer. */
export async function publish(user: string, decision: Decision): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const event = {
    event_id: randomUUID(),
    user,
    document_hash: decision.document_hash,
    decision: decision.refused ? 'refused' : 'served',
    signals: decision.signals,
    signature: decision.signature,
    answer: decision.answer,
    ts: Math.floor(Date.now() / 1000),
  };
  await producer.send({topic: TOPIC, acks: 1, messages: [{key: event.event_id, value: JSON.stringify(event)}]});
  console.info(\`security event user=\${user} answer=\${decision.answer}\`);
}

/** Count signatures as the events arrive. */
export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {signature: string};
      await redis.hincrby('signatures', event.signature, 1);
    },
  });
}
`,
      solution: `/** prompt.security: one event per decision, and the consumer that counts attack signatures. */
import {randomUUID} from 'node:crypto';

import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {GROUP, TOPIC, signaturesKey} from 'promptguard/config';
import type {Decision} from 'promptguard/types';

export const HOUR_S = 3_600;
export const BUCKET_TTL_S = 7 * 86_400;

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'promptguard', brokers: ['kafka:9092']});
// Idempotent: a retry after a lost acknowledgement is written once; acks -1 (all): a failover keeps it.
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const consumer = kafka.consumer({groupId: GROUP});

interface SecurityEvent {
  decision: string;
  signature: string;
  ts: number;
}

/** One event per decision, keyed by user: hashes and signal names, no text. */
export async function publish(user: string, decision: Decision): Promise<void> {
  const event = {
    event_id: randomUUID(),
    user,
    document_hash: decision.document_hash,
    decision: decision.refused ? 'refused' : 'served',
    signals: decision.signals,
    signature: decision.signature,
    ts: Math.floor(Date.now() / 1000),
  };
  await producer.send({topic: TOPIC, acks: -1, messages: [{key: user, value: JSON.stringify(event)}]});
  console.info(\`security event user=\${user} decision=\${event.decision} signature=\${decision.signature}\`);
}

/** Count refusals per signature per hour; commit each offset once its count is written. */
export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as SecurityEvent;
      if (event.decision === 'refused') {
        const key = signaturesKey(Math.floor(event.ts / HOUR_S));
        await redis.hincrby(key, event.signature, 1);
        await redis.expire(key, BUCKET_TTL_S);
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
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"promptguard/config" // config.Topic, config.Group — provided
	"promptguard/types"  // types.Decision — provided
)

const ackTimeout = 2 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var producer = newProducer()
var consumer = newConsumer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func newConsumer() *kafka.Consumer {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"group.id":           config.Group,
		"auto.offset.reset":  "earliest",
		"enable.auto.commit": false,
	})
	if err != nil {
		panic(err)
	}
	if err := c.SubscribeTopics([]string{config.Topic}, nil); err != nil {
		panic(err)
	}
	return c
}

type securityEvent struct {
	EventID      string   \`json:"event_id"\`
	User         string   \`json:"user"\`
	DocumentHash string   \`json:"document_hash"\`
	Decision     string   \`json:"decision"\`
	Signals      []string \`json:"signals"\`
	Signature    string   \`json:"signature"\`
	Answer       string   \`json:"answer"\`
	Ts           int64    \`json:"ts"\`
}

// publish sends one event per decision, for the signature consumer.
func publish(ctx context.Context, user string, d types.Decision) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	verdict := "served"
	if d.Refused {
		verdict = "refused"
	}
	event := securityEvent{EventID: uuid.NewString(), User: user, DocumentHash: d.DocumentHash, Decision: verdict, Signals: d.Signals, Signature: d.Signature, Answer: d.Answer, Ts: time.Now().Unix()}
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	topic := config.Topic
	deliveries := make(chan kafka.Event, 1)
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(event.EventID), Value: value}
	if err := producer.Produce(msg, deliveries); err != nil {
		return err
	}
	select {
	case e := <-deliveries:
		err = e.(*kafka.Message).TopicPartition.Error
	case <-time.After(ackTimeout):
		err = context.DeadlineExceeded
	}
	log.Printf("security event user=%s answer=%q", user, d.Answer)
	return err
}

// run counts signatures as the events arrive.
func run(ctx context.Context) error {
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
		var event securityEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		rdb.HIncrBy(ctx, "signatures", event.Signature, 1)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"promptguard/config" // config.Topic, config.Group, config.SignaturesKey — provided
	"promptguard/types"  // types.Decision — provided
)

const (
	hourSeconds = 3600
	bucketTTL   = 7 * 24 * time.Hour
	ackTimeout  = 2 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var producer = newProducer()
var consumer = newConsumer()

// newProducer is idempotent (kafka-go has no idempotent producer; confluent-kafka-go does), with acks=all.
func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"enable.idempotence": true,  // a retry after a lost acknowledgement is written once
		"acks":               "all", // every in-sync replica has the event before the broker answers
	})
	if err != nil {
		panic(err)
	}
	return p
}

func newConsumer() *kafka.Consumer {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"group.id":           config.Group,
		"auto.offset.reset":  "earliest",
		"enable.auto.commit": false,
	})
	if err != nil {
		panic(err)
	}
	if err := c.SubscribeTopics([]string{config.Topic}, nil); err != nil {
		panic(err)
	}
	return c
}

type securityEvent struct {
	EventID      string   \`json:"event_id"\`
	User         string   \`json:"user"\`
	DocumentHash string   \`json:"document_hash"\`
	Decision     string   \`json:"decision"\`
	Signals      []string \`json:"signals"\`
	Signature    string   \`json:"signature"\`
	Ts           int64    \`json:"ts"\`
}

// publish sends one event per decision, keyed by user: hashes and signal names, no text.
func publish(ctx context.Context, user string, d types.Decision) error {
	verdict := "served"
	if d.Refused {
		verdict = "refused"
	}
	signals := d.Signals
	if signals == nil {
		signals = []string{}
	}
	event := securityEvent{EventID: uuid.NewString(), User: user, DocumentHash: d.DocumentHash, Decision: verdict, Signals: signals, Signature: d.Signature, Ts: time.Now().Unix()}
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	topic := config.Topic
	deliveries := make(chan kafka.Event, 1)
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(user), Value: value}
	if err := producer.Produce(msg, deliveries); err != nil {
		return err
	}
	select {
	case e := <-deliveries:
		err = e.(*kafka.Message).TopicPartition.Error
	case <-time.After(ackTimeout):
		err = context.DeadlineExceeded
	}
	if err != nil {
		log.Printf("security event not delivered user=%s: %v", user, err)
		return err
	}
	log.Printf("security event user=%s decision=%s signature=%s", user, verdict, d.Signature)
	return nil
}

// run counts refusals per signature per hour; it commits each offset once its count is written.
func run(ctx context.Context) error {
	for {
		msg, err := consumer.ReadMessage(-1)
		if err != nil {
			return err
		}
		var event securityEvent
		if err := json.Unmarshal(msg.Value, &event); err == nil && event.Decision == "refused" {
			key := config.SignaturesKey(event.Ts / hourSeconds)
			if err := rdb.HIncrBy(ctx, key, event.Signature, 1).Err(); err != nil {
				return err // not committed: the event is read again
			}
			rdb.Expire(ctx, key, bucketTTL)
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.{Properties, UUID}

import scala.jdk.CollectionConverters._

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import promptguard.{Config, Decision}

/** prompt.security: one event per decision, and the consumer that counts attack signatures. */
object SecurityEvents {
  private val jedis = new JedisPooled("redis", 6379)

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  private val consumer: KafkaConsumer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Config.Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val c = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    c.subscribe(List(Config.Topic).asJava)
    c
  }

  private val onDelivery = new Callback {
    def onCompletion(metadata: RecordMetadata, error: Exception): Unit =
      if (error != null) System.err.println(s"security event not delivered: \${error.getMessage}")
  }

  /** One event per decision, for the signature consumer. */
  def publish(user: String, decision: Decision): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val eventId = UUID.randomUUID().toString
    val event = ujson.Obj(
      "event_id" -> eventId,
      "user" -> user,
      "document_hash" -> decision.documentHash,
      "decision" -> (if (decision.refused) "refused" else "served"),
      "signals" -> ujson.Arr.from(decision.signals),
      "signature" -> decision.signature,
      "answer" -> decision.answer,
      "ts" -> System.currentTimeMillis() / 1000
    )
    producer.send(new ProducerRecord[String, String](Config.Topic, eventId, ujson.write(event)), onDelivery)
    println(s"security event user=$user answer=\${decision.answer}")
  }

  /** Count signatures as the events arrive. */
  def run(): Unit =
    while (true) {
      for (record <- consumer.poll(Duration.ofSeconds(1)).asScala) {
        val next = new OffsetAndMetadata(record.offset + 1)
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> next).asJava)
        val event = ujson.read(record.value)
        jedis.hincrBy("signatures", event("signature").str, 1)
      }
    }
}
`,
      solution: `import java.time.Duration
import java.util.{Properties, UUID}

import scala.jdk.CollectionConverters._

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import promptguard.{Config, Decision}

/** prompt.security: one event per decision, and the consumer that counts attack signatures. */
object SecurityEvents {
  val HourSeconds = 3600L
  val BucketTtlSeconds: Long = 7 * 86400L

  private val jedis = new JedisPooled("redis", 6379)

  // Idempotent: a retry after a lost acknowledgement is written once; acks=all: a failover keeps it.
  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  private val consumer: KafkaConsumer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Config.Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val c = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    c.subscribe(List(Config.Topic).asJava)
    c
  }

  private val onDelivery = new Callback {
    def onCompletion(metadata: RecordMetadata, error: Exception): Unit =
      if (error != null) System.err.println(s"security event not delivered: \${error.getMessage}")
  }

  /** One event per decision, keyed by user: hashes and signal names, no text. */
  def publish(user: String, decision: Decision): Unit = {
    val verdict = if (decision.refused) "refused" else "served"
    val event = ujson.Obj(
      "event_id" -> UUID.randomUUID().toString,
      "user" -> user,
      "document_hash" -> decision.documentHash,
      "decision" -> verdict,
      "signals" -> ujson.Arr.from(decision.signals),
      "signature" -> decision.signature,
      "ts" -> System.currentTimeMillis() / 1000
    )
    producer.send(new ProducerRecord[String, String](Config.Topic, user, ujson.write(event)), onDelivery)
    println(s"security event user=$user decision=$verdict signature=\${decision.signature}")
  }

  /** Count refusals per signature per hour; commit each offset once its count is written. */
  def run(): Unit =
    while (true) {
      for (record <- consumer.poll(Duration.ofSeconds(1)).asScala) {
        val event = ujson.read(record.value)
        if (event("decision").str == "refused") {
          val key = Config.signaturesKey(event("ts").num.toLong / HourSeconds)
          jedis.hincrBy(key, event("signature").str, 1)
          jedis.expire(key, BucketTtlSeconds)
        }
        val next = new OffsetAndMetadata(record.offset + 1)
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> next).asJava)
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

#include "ids.h"                 // new_uuid() — provided
#include "promptguard/config.h"  // config::kTopic, config::kGroup — provided
#include "promptguard/types.h"   // Decision — provided

sw::redis::Redis redis("tcp://redis:6379");

// Logs a security event the broker did not take.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "security event not delivered: " << message.errstr() << "\\n";
  }
};

RdKafka::Producer& producer() {
  static DeliveryReport report;
  static std::unique_ptr<RdKafka::Producer> p = [] {
    std::string err;
    std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
    conf->set("bootstrap.servers", "kafka:9092", err);
    conf->set("acks", "1", err);
    conf->set("dr_cb", &report, err);
    return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
  }();
  return *p;
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", config::kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  return consumer;
}

auto consumer = make_consumer();

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// One event per decision, for the signature consumer.
void publish(const std::string& user, const Decision& decision) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string event_id = new_uuid();
  const nlohmann::json event = {
      {"event_id", event_id},
      {"user", user},
      {"document_hash", decision.document_hash},
      {"decision", decision.refused ? "refused" : "served"},
      {"signals", decision.signals},
      {"signature", decision.signature},
      {"answer", decision.answer},
      {"ts", now_seconds()},
  };
  const std::string payload = event.dump();
  producer().produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                     const_cast<char*>(payload.data()), payload.size(), event_id.data(), event_id.size(), 0, nullptr);
  producer().poll(0);
  std::cerr << "security event user=" << user << " answer=" << decision.answer << "\\n";
}

// Count signatures as the events arrive.
void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto event = nlohmann::json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len(), nullptr, false);
    if (!event.is_object()) continue;
    redis.hincrby("signatures", event.value("signature", std::string()), 1);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

#include "ids.h"                 // new_uuid() — provided
#include "promptguard/config.h"  // config::kTopic, config::kGroup, config::signatures_key — provided
#include "promptguard/types.h"   // Decision — provided

constexpr long long kHourSeconds = 3600;
constexpr std::chrono::seconds kBucketTtl{7 * 86400};

sw::redis::Redis redis("tcp://redis:6379");

// Logs a security event the broker did not take.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "security event not delivered: " << message.errstr() << "\\n";
  }
};

// Idempotent: a retry after a lost acknowledgement is written once; acks=all: a failover keeps it.
RdKafka::Producer& producer() {
  static DeliveryReport report;
  static std::unique_ptr<RdKafka::Producer> p = [] {
    std::string err;
    std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
    conf->set("bootstrap.servers", "kafka:9092", err);
    conf->set("enable.idempotence", "true", err);
    conf->set("acks", "all", err);
    conf->set("dr_cb", &report, err);
    return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
  }();
  return *p;
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", config::kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  return consumer;
}

auto consumer = make_consumer();

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// One event per decision, keyed by user: hashes and signal names, no text.
void publish(const std::string& user, const Decision& decision) {
  const std::string verdict = decision.refused ? "refused" : "served";
  const nlohmann::json event = {
      {"event_id", new_uuid()},
      {"user", user},
      {"document_hash", decision.document_hash},
      {"decision", verdict},
      {"signals", decision.signals},
      {"signature", decision.signature},
      {"ts", now_seconds()},
  };
  const std::string payload = event.dump();
  producer().produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                     const_cast<char*>(payload.data()), payload.size(), user.data(), user.size(), 0, nullptr);
  producer().poll(0);
  std::cerr << "security event user=" << user << " decision=" << verdict << " signature=" << decision.signature << "\\n";
}

// Count refusals per signature per hour; commit each offset once its count is written.
void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = nlohmann::json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len(), nullptr, false);
    if (event.is_object() && event.value("decision", std::string()) == "refused") {
      const std::string key = config::signatures_key(event.value("ts", 0LL) / kHourSeconds);
      redis.hincrby(key, event.value("signature", std::string()), 1);
      redis.expire(key, kBucketTtl);
    }
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import hashlib
import importlib
import json
import logging

TOPIC = "prompt.security"
GROUP = "signatures"
T = 1_791_201_600  # 2026-10-05 12:00:00 UTC
HOUR = T // 3600
SIG_A = "5f1c0a9e2b7d4c13"
SIG_B = "a07e3d91c4b2f865"
ANSWER = "The notice period is thirty days."
DOC_HASH = hashlib.sha256(b"The notice period is thirty days. Either party may end the contract in writing.").hexdigest()
FIELDS = ("event_id", "user", "document_hash", "decision", "signals", "signature", "ts")


class Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


def _events(ctx):
    m = ctx.load("security_events")
    capture = Capture()
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(capture)
    return m, capture


def _served(rid="r-1"):
    types = importlib.import_module("promptguard.types")
    return types.Decision(rid, DOC_HASH, ANSWER, [ANSWER], False, [], "")


def _refused(rid="r-2", signature=SIG_A):
    types = importlib.import_module("promptguard.types")
    return types.Decision(rid, DOC_HASH, "I cannot answer that from this document.", [], True, ["secret"], signature)


def _seed(ctx, user, decision, signature, ts):
    event = {"event_id": f"e-{ts}-{user}", "user": user, "document_hash": DOC_HASH, "decision": decision, "signals": ["secret"] if decision == "refused" else [], "signature": signature, "ts": ts}
    ctx.kafka.seed(TOPIC, key=user, value=json.dumps(event))


def _value(record):
    try:
        return json.loads(record.value)
    except ValueError:
        raise AssertionError(f"the record's value is not JSON: {record.value!r}")


def check_user_key(ctx):
    m, _ = _events(ctx)
    m.publish("u-ana", _served("r-1"))
    m.publish("u-ana", _refused("r-2"))
    m.publish("u-ben", _served("r-3"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three decisions must leave three events on {TOPIC}, found {len(records)}"
    keys = [r.key.decode() if isinstance(r.key, bytes) else r.key for r in records]
    assert keys == ["u-ana", "u-ana", "u-ben"], f"the records are keyed {keys}: key each event by the user, so one user's events share a partition and keep their order"
    assert records[0].partition == records[1].partition, "two events of one user landed on different partitions"
    event = _value(records[1])
    missing = [f for f in FIELDS if f not in event]
    assert not missing, f"the event lacks {missing}: {event}"
    assert event["user"] == "u-ana" and event["document_hash"] == DOC_HASH, f"the event names the user and the document hash: {event}"
    assert event["decision"] == "refused" and event["signals"] == ["secret"] and event["signature"] == SIG_A, f"a refusal's event carries decision refused, its signals and its signature: {event}"
    assert _value(records[0])["decision"] == "served", f"a served decision's event says served: {_value(records[0])}"


def check_idempotent_acks(ctx):
    m, _ = _events(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    m.publish("u-ana", _refused())
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish whose acknowledgement was lost left {len(records)} events: the producer retried and the broker wrote it again. enable.idempotence makes the retry a no-op"
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 1, "after a leader failover the event is gone: the leader alone acknowledged it, the producer needs acks=all"
    m.publish("u-ana", _served())
    assert len(ctx.kafka.records(TOPIC)) == 2, "after the failover the producer must keep producing"


def check_no_text(ctx):
    m, capture = _events(ctx)
    m.publish("u-ana", _served())
    m.publish("u-ben", _refused())
    for record in ctx.kafka.records(TOPIC):
        event = _value(record)
        assert "answer" not in event, f"the event carries an answer field: {event}. The topic is retained and replicated; hashes and signal names are enough"
        assert "thirty days" not in record.value.decode(), f"the answer text is in the event: {record.value!r}"
    leaked = [line for line in capture.lines if "thirty days" in line]
    assert not leaked, f"a log line carries the answer: {leaked[0]!r}. Log the user, the decision and the signature"


def check_hour_bucket(ctx):
    _seed(ctx, "u-ana", "refused", SIG_A, T + 10)
    _seed(ctx, "u-ben", "refused", SIG_A, T + 20)
    _seed(ctx, "u-ana", "served", "", T + 30)
    _seed(ctx, "u-cy", "refused", SIG_B, T + 3_605)
    m, _ = _events(ctx)
    ctx.drain(m.run)
    this_hour, next_hour = f"signatures:{HOUR}", f"signatures:{HOUR + 1}"
    assert ctx.redis.exists("signatures") == 0, f"one global signatures hash ({ctx.redis.hgetall('signatures')}) cannot show when an attack began: bucket by hour, signatures:{{ts // 3600}}"
    assert ctx.redis.hgetall(this_hour) == {SIG_A: "2"}, f"{this_hour} holds {ctx.redis.hgetall(this_hour)}, expected {SIG_A} counted twice and nothing for the served decision"
    assert ctx.redis.hgetall(next_hour) == {SIG_B: "1"}, f"{next_hour} holds {ctx.redis.hgetall(next_hour)}, expected {SIG_B} once"
    for key in (this_hour, next_hour):
        ttl = ctx.redis.ttl(key)
        assert 7 * 86_400 - 60 <= ttl <= 7 * 86_400, f"{key} has TTL {ttl}: an hourly bucket is kept for BUCKET_TTL_S = 7 days"


def check_write_before_commit(ctx):
    _seed(ctx, "u-ana", "refused", SIG_A, T + 10)
    event = ctx.kafka.records(TOPIC)[0]
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((dict(offsets), ctx.redis.hget(f"signatures:{HOUR}", SIG_A))))
    m, _ = _events(ctx)
    assert ctx.kafka.consumers[-1].auto_commit is False, "enable.auto.commit is on: offsets would be committed on a timer, before the count"
    ctx.drain(m.run)
    covering = [count for offsets, count in at_commit if offsets.get((TOPIC, event.partition), 0) > event.offset]
    assert covering, "the event's offset was never committed"
    assert covering[0] == "1", f"when the event's offset was committed its count read {covering[0]!r}: write the count first, then commit, so a crash replays the event instead of losing it"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, "every event must be committed once counted"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'prompt.security';
const GROUP = 'signatures';
const T = 1_791_201_600; // 2026-10-05 12:00:00 UTC
const HOUR = Math.floor(T / 3600);
const SIG_A = '5f1c0a9e2b7d4c13';
const SIG_B = 'a07e3d91c4b2f865';
const ANSWER = 'The notice period is thirty days.';
const DOC_HASH = createHash('sha256').update('The notice period is thirty days. Either party may end the contract in writing.').digest('hex');
const FIELDS = ['event_id', 'user', 'document_hash', 'decision', 'signals', 'signature', 'ts'];

/** The learner's module, with every console line captured. */
function events(ctx) {
  const m = ctx.load('security_events');
  const lines: string[] = [];
  const capture = (...args: unknown[]): void => void lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  return {m, lines};
}

const served = (rid = 'r-1') => ({request_id: rid, document_hash: DOC_HASH, answer: ANSWER, spans: [ANSWER], refused: false, signals: [], signature: ''});
const refused = (rid = 'r-2', signature = SIG_A) => ({request_id: rid, document_hash: DOC_HASH, answer: 'I cannot answer that from this document.', spans: [], refused: true, signals: ['secret'], signature});

function seed(ctx, user: string, decision: string, signature: string, ts: number) {
  const event = {event_id: \`e-\${ts}-\${user}\`, user, document_hash: DOC_HASH, decision, signals: decision === 'refused' ? ['secret'] : [], signature, ts};
  ctx.kafka.seed(TOPIC, {key: user, value: JSON.stringify(event)});
}

function valueOf(record) {
  const text = record.value?.toString() ?? '';
  try {
    return JSON.parse(text);
  } catch {
    assert.fail(\`the record's value is not JSON: \${JSON.stringify(text)}\`);
  }
}

export async function check_user_key(ctx) {
  const {m} = events(ctx);
  await m.publish('u-ana', served('r-1'));
  await m.publish('u-ana', refused('r-2'));
  await m.publish('u-ben', served('r-3'));
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three decisions must leave three events on \${TOPIC}, found \${records.length}\`);
  const keys = records.map(r => r.key?.toString());
  assert.deepEqual(keys, ['u-ana', 'u-ana', 'u-ben'], \`the records are keyed \${JSON.stringify(keys)}: key each event by the user, so one user's events share a partition and keep their order\`);
  assert.equal(records[0].partition, records[1].partition, 'two events of one user landed on different partitions');
  const event = valueOf(records[1]);
  const missing = FIELDS.filter(f => !(f in event));
  assert.equal(missing.length, 0, \`the event lacks \${JSON.stringify(missing)}: \${JSON.stringify(event)}\`);
  assert(event.user === 'u-ana' && event.document_hash === DOC_HASH, \`the event names the user and the document hash: \${JSON.stringify(event)}\`);
  assert(event.decision === 'refused' && JSON.stringify(event.signals) === '["secret"]' && event.signature === SIG_A, \`a refusal's event carries decision refused, its signals and its signature: \${JSON.stringify(event)}\`);
  assert.equal(valueOf(records[0]).decision, 'served', \`a served decision's event says served: \${JSON.stringify(valueOf(records[0]))}\`);
}

export async function check_idempotent_acks(ctx) {
  const {m} = events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.publish('u-ana', refused());
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one publish whose acknowledgement was lost left \${records.length} events: the producer retried and the broker wrote it again. idempotent: true makes the retry a no-op\`);
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'after a leader failover the event is gone: the leader alone acknowledged it, the producer needs acks: -1 (all)');
  await m.publish('u-ana', served());
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'after the failover the producer must keep producing');
}

export async function check_no_text(ctx) {
  const {m, lines} = events(ctx);
  await m.publish('u-ana', served());
  await m.publish('u-ben', refused());
  for (const record of ctx.kafka.records(TOPIC)) {
    const event = valueOf(record);
    assert(!('answer' in event), \`the event carries an answer field: \${JSON.stringify(event)}. The topic is retained and replicated; hashes and signal names are enough\`);
    assert(!record.value.toString().includes('thirty days'), \`the answer text is in the event: \${record.value.toString()}\`);
  }
  const leaked = lines.filter(line => line.includes('thirty days'));
  assert.equal(leaked.length, 0, \`a log line carries the answer: \${JSON.stringify(leaked[0])}. Log the user, the decision and the signature\`);
}

export async function check_hour_bucket(ctx) {
  seed(ctx, 'u-ana', 'refused', SIG_A, T + 10);
  seed(ctx, 'u-ben', 'refused', SIG_A, T + 20);
  seed(ctx, 'u-ana', 'served', '', T + 30);
  seed(ctx, 'u-cy', 'refused', SIG_B, T + 3_605);
  const {m} = events(ctx);
  await ctx.drain(m.run());
  const thisHour = \`signatures:\${HOUR}\`;
  const nextHour = \`signatures:\${HOUR + 1}\`;
  assert.equal(ctx.redis.exists('signatures'), 0, \`one global signatures hash (\${JSON.stringify(ctx.redis.hgetall('signatures'))}) cannot show when an attack began: bucket by hour, signatures:{ts // 3600}\`);
  assert.deepEqual(ctx.redis.hgetall(thisHour), {[SIG_A]: '2'}, \`\${thisHour} holds \${JSON.stringify(ctx.redis.hgetall(thisHour))}, expected \${SIG_A} counted twice and nothing for the served decision\`);
  assert.deepEqual(ctx.redis.hgetall(nextHour), {[SIG_B]: '1'}, \`\${nextHour} holds \${JSON.stringify(ctx.redis.hgetall(nextHour))}, expected \${SIG_B} once\`);
  for (const key of [thisHour, nextHour]) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl >= 7 * 86_400 - 60 && ttl <= 7 * 86_400, \`\${key} has TTL \${ttl}: an hourly bucket is kept for BUCKET_TTL_S = 7 days\`);
  }
}

export async function check_write_before_commit(ctx) {
  seed(ctx, 'u-ana', 'refused', SIG_A, T + 10);
  const event = ctx.kafka.records(TOPIC)[0];
  const atCommit: [Map<string, number>, string | null][] = [];
  ctx.kafka.onCommit((group, offsets) => atCommit.push([new Map(offsets), ctx.redis.hget(\`signatures:\${HOUR}\`, SIG_A)]));
  const {m} = events(ctx);
  await ctx.drain(m.run());
  assert.equal(ctx.kafka.consumers.at(-1).autoCommit, false, 'autoCommit is on: offsets would be committed on a timer, before the count');
  const covering = atCommit.filter(([offsets]) => (offsets.get(\`\${TOPIC}|\${event.partition}\`) ?? 0) > event.offset).map(([, count]) => count);
  assert(covering.length > 0, "the event's offset was never committed");
  assert.equal(covering[0], '1', \`when the event's offset was committed its count read \${JSON.stringify(covering[0])}: write the count first, then commit, so a crash replays the event instead of losing it\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'every event must be committed once counted');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"

	"promptguard/types"

	"leetbuild/harness"
)

const (
	eventsTopic  = "prompt.security"
	eventsGroup  = "signatures"
	eventsT      = int64(1_791_201_600) // 2026-10-05 12:00:00 UTC
	eventsSigA   = "5f1c0a9e2b7d4c13"
	eventsSigB   = "a07e3d91c4b2f865"
	eventsAnswer = "The notice period is thirty days."
)

var eventsHour = eventsT / 3600

func eventsDocHash() string {
	sum := sha256.Sum256([]byte("The notice period is thirty days. Either party may end the contract in writing."))
	return hex.EncodeToString(sum[:])
}

func eventsServed(rid string) types.Decision {
	return types.Decision{RequestID: rid, DocumentHash: eventsDocHash(), Answer: eventsAnswer, Spans: []string{eventsAnswer}, Signals: []string{}}
}

func eventsRefused(rid, signature string) types.Decision {
	return types.Decision{RequestID: rid, DocumentHash: eventsDocHash(), Answer: "I cannot answer that from this document.", Spans: []string{}, Refused: true, Signals: []string{"secret"}, Signature: signature}
}

func eventsPublish(ctx *harness.Ctx, user string, d types.Decision) {
	publish(context.Background(), user, d)
	ctx.Settle()
}

func eventsSeed(ctx *harness.Ctx, user, decision, signature string, ts int64) {
	signals := []string{}
	if decision == "refused" {
		signals = []string{"secret"}
	}
	ctx.Kafka.Seed(eventsTopic, user, map[string]any{"event_id": fmt.Sprintf("e-%d-%s", ts, user), "user": user, "document_hash": eventsDocHash(), "decision": decision, "signals": signals, "signature": signature, "ts": ts})
}

func eventsValue(ctx *harness.Ctx, r harness.KafkaRecord) map[string]any {
	var event map[string]any
	ctx.Assert(json.Unmarshal(r.Value, &event) == nil, "the record's value is not JSON: %s", r.Value)
	return event
}

func eventsDrain(ctx *harness.Ctx) {
	ctx.Drain(func() { run(context.Background()) })
}

func CheckUserKey(ctx *harness.Ctx) {
	eventsPublish(ctx, "u-ana", eventsServed("r-1"))
	eventsPublish(ctx, "u-ana", eventsRefused("r-2", eventsSigA))
	eventsPublish(ctx, "u-ben", eventsServed("r-3"))
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three decisions must leave three events on %s; the records", eventsTopic)
	var keys []string
	for _, r := range records {
		keys = append(keys, string(r.Key))
	}
	ctx.Equal(keys, []string{"u-ana", "u-ana", "u-ben"}, "key each event by the user, so one user's events share a partition and keep their order; the keys")
	ctx.Equal(records[0].Partition, records[1].Partition, "two events of one user must share a partition")
	event := eventsValue(ctx, records[1])
	for _, f := range []string{"event_id", "user", "document_hash", "decision", "signals", "signature", "ts"} {
		_, ok := event[f]
		ctx.Assert(ok, "the event lacks %s: %s", f, records[1].Value)
	}
	ctx.Assert(event["user"] == "u-ana" && event["document_hash"] == eventsDocHash(), "the event names the user and the document hash: %s", records[1].Value)
	signals, _ := event["signals"].([]any)
	ctx.Assert(event["decision"] == "refused" && len(signals) == 1 && signals[0] == "secret" && event["signature"] == eventsSigA, "a refusal's event carries decision refused, its signals and its signature: %s", records[1].Value)
	ctx.Equal(eventsValue(ctx, records[0])["decision"], "served", "a served decision's event says served")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, "u-ana", eventsRefused("r-2", eventsSigA))
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "a leader failover must not lose the event (acks=all waits for every in-sync replica); the records")
	eventsPublish(ctx, "u-ana", eventsServed("r-1"))
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "after the failover the producer must keep producing; the records")
}

func CheckNoText(ctx *harness.Ctx) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	eventsPublish(ctx, "u-ana", eventsServed("r-1"))
	eventsPublish(ctx, "u-ben", eventsRefused("r-2", eventsSigA))
	for _, r := range ctx.Kafka.Records(eventsTopic) {
		_, has := eventsValue(ctx, r)["answer"]
		ctx.Assert(!has, "the event carries an answer field: %s. The topic is retained and replicated; hashes and signal names are enough", r.Value)
		ctx.Assert(!strings.Contains(string(r.Value), "thirty days"), "the answer text is in the event: %s", r.Value)
	}
	ctx.Assert(!strings.Contains(logged.String(), "thirty days"), "a log line carries the answer: %q. Log the user, the decision and the signature", logged.String())
}

func CheckHourBucket(ctx *harness.Ctx) {
	eventsSeed(ctx, "u-ana", "refused", eventsSigA, eventsT+10)
	eventsSeed(ctx, "u-ben", "refused", eventsSigA, eventsT+20)
	eventsSeed(ctx, "u-ana", "served", "", eventsT+30)
	eventsSeed(ctx, "u-cy", "refused", eventsSigB, eventsT+3_605)
	eventsDrain(ctx)
	thisHour := "signatures:" + strconv.FormatInt(eventsHour, 10)
	nextHour := "signatures:" + strconv.FormatInt(eventsHour+1, 10)
	ctx.Equal(ctx.Redis.Exists("signatures"), 0, "one global signatures hash (%v) cannot show when an attack began: bucket by hour, signatures:{ts / 3600}; EXISTS signatures", ctx.Redis.HGetAll("signatures"))
	ctx.Equal(ctx.Redis.HGetAll(thisHour), map[string]string{eventsSigA: "2"}, "%s must count %s twice and nothing for the served decision", thisHour, eventsSigA)
	ctx.Equal(ctx.Redis.HGetAll(nextHour), map[string]string{eventsSigB: "1"}, "%s must count %s once", nextHour, eventsSigB)
	for _, key := range []string{thisHour, nextHour} {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl >= 7*86_400-60 && ttl <= 7*86_400, "%s has TTL %d: an hourly bucket is kept for 7 days", key, ttl)
	}
}

func CheckWriteBeforeCommit(ctx *harness.Ctx) {
	eventsSeed(ctx, "u-ana", "refused", eventsSigA, eventsT+10)
	event := ctx.Kafka.Records(eventsTopic)[0]
	thisHour := "signatures:" + strconv.FormatInt(eventsHour, 10)
	type snapshot struct {
		offsets harness.KafkaOffsets
		count   string
	}
	var atCommit []snapshot
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		snap := snapshot{offsets: harness.KafkaOffsets{}}
		for tp, offset := range offsets {
			snap.offsets[tp] = offset
		}
		snap.count, _ = ctx.Redis.HGet(thisHour, eventsSigA)
		atCommit = append(atCommit, snap)
	})
	eventsDrain(ctx)
	consumers := ctx.Kafka.Consumers()
	ctx.Assert(len(consumers) > 0 && !consumers[len(consumers)-1].AutoCommit, "enable.auto.commit is on: offsets would be committed on a timer, before the count")
	var covering []string
	for _, snap := range atCommit {
		if snap.offsets[harness.KafkaTopicPartition{Topic: eventsTopic, Partition: event.Partition}] > event.Offset {
			covering = append(covering, snap.count)
		}
	}
	ctx.Assert(len(covering) > 0, "the event's offset was never committed")
	ctx.Equal(covering[0], "1", "write the count first, then commit, so a crash replays the event instead of losing it; the count when the offset was committed")
	ctx.Equal(ctx.Kafka.Lag(eventsGroup, eventsTopic), 0, "every event must be committed once counted; lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "digest.h"
#include "promptguard/types.h"

namespace {

const std::string kTopic = "prompt.security";
const std::string kGroup = "signatures";
constexpr long long kT = 1791201600;  // 2026-10-05 12:00:00 UTC
constexpr long long kHour = kT / 3600;
const std::string kSigA = "5f1c0a9e2b7d4c13";
const std::string kSigB = "a07e3d91c4b2f865";
const std::string kAnswer = "The notice period is thirty days.";

std::string docHash() { return sha256_hex("The notice period is thirty days. Either party may end the contract in writing."); }

Decision served(const std::string& rid) { return {rid, docHash(), kAnswer, {kAnswer}, false, {}, ""}; }

Decision refused(const std::string& rid, const std::string& signature) {
  return {rid, docHash(), "I cannot answer that from this document.", {}, true, {"secret"}, signature};
}

void publishAndSettle(harness::Ctx& ctx, const std::string& user, const Decision& d) {
  publish(user, d);
  ctx.Settle();
}

void seed(harness::Ctx& ctx, const std::string& user, const std::string& decision, const std::string& signature, long long ts) {
  const nlohmann::json event = {{"event_id", "e-" + std::to_string(ts) + "-" + user},
                                {"user", user},
                                {"document_hash", docHash()},
                                {"decision", decision},
                                {"signals", decision == "refused" ? std::vector<std::string>{"secret"} : std::vector<std::string>{}},
                                {"signature", signature},
                                {"ts", ts}};
  ctx.Kafka.Seed(kTopic, user, event.dump());
}

nlohmann::json valueOf(harness::Ctx& ctx, const harness::KafkaRecord& r) {
  const auto event = nlohmann::json::parse(r.Value.value_or(""), nullptr, false);
  ctx.Assert(event.is_object(), "the record's value is not JSON: %s", r.Value.value_or(""));
  return event;
}

// The consume loop until it waits for events: its consume(1000) idles in 1 s polls of virtual time,
// so a few of them end the drain.
void drain(harness::Ctx& ctx) {
  ctx.Clock.SetSleepLimit(ctx.Clock.Sleeps() + 5);
  ctx.Drain([] { run(); });
}

// Everything the learner writes to cerr, clog or cout while alive.
struct CaptureLogs {
  std::ostringstream lines;
  std::streambuf* err;
  std::streambuf* clg;
  std::streambuf* out;
  CaptureLogs() : err(std::cerr.rdbuf(lines.rdbuf())), clg(std::clog.rdbuf(lines.rdbuf())), out(std::cout.rdbuf(lines.rdbuf())) {}
  ~CaptureLogs() {
    std::cerr.rdbuf(err);
    std::clog.rdbuf(clg);
    std::cout.rdbuf(out);
  }
};

}  // namespace

void CheckUserKey(harness::Ctx& ctx) {
  publishAndSettle(ctx, "u-ana", served("r-1"));
  publishAndSettle(ctx, "u-ana", refused("r-2", kSigA));
  publishAndSettle(ctx, "u-ben", served("r-3"));
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three decisions must leave three events on %s; the records", kTopic);
  std::vector<std::string> keys;
  for (const auto& r : records) keys.push_back(r.Key.value_or(""));
  ctx.Equal(keys, std::vector<std::string>{"u-ana", "u-ana", "u-ben"}, "key each event by the user, so one user's events share a partition and keep their order; the keys");
  ctx.Equal(records[0].Partition, records[1].Partition, "two events of one user must share a partition");
  const auto event = valueOf(ctx, records[1]);
  for (const char* f : {"event_id", "user", "document_hash", "decision", "signals", "signature", "ts"}) ctx.Assert(event.contains(f), "the event lacks %s: %s", f, event.dump());
  ctx.Assert(event["user"] == "u-ana" && event["document_hash"] == docHash(), "the event names the user and the document hash: %s", event.dump());
  ctx.Assert(event["decision"] == "refused" && event["signals"] == nlohmann::json::array({"secret"}) && event["signature"] == kSigA, "a refusal's event carries decision refused, its signals and its signature: %s", event.dump());
  ctx.Assert(valueOf(ctx, records[0])["decision"] == "served", "a served decision's event says served: %s", records[0].Value.value_or(""));
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishAndSettle(ctx, "u-ana", refused("r-2", kSigA));
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  ctx.Kafka.Failover(kTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "a leader failover must not lose the event (acks=all waits for every in-sync replica); the records");
  publishAndSettle(ctx, "u-ana", served("r-1"));
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after the failover the producer must keep producing; the records");
}

void CheckNoText(harness::Ctx& ctx) {
  std::string logged;
  {
    CaptureLogs capture;
    publishAndSettle(ctx, "u-ana", served("r-1"));
    publishAndSettle(ctx, "u-ben", refused("r-2", kSigA));
    logged = capture.lines.str();
  }
  for (const auto& r : ctx.Kafka.Records(kTopic)) {
    ctx.Assert(!valueOf(ctx, r).contains("answer"), "the event carries an answer field: %s. The topic is retained and replicated; hashes and signal names are enough", r.Value.value_or(""));
    ctx.Assert(r.Value.value_or("").find("thirty days") == std::string::npos, "the answer text is in the event: %s", r.Value.value_or(""));
  }
  ctx.Assert(logged.find("thirty days") == std::string::npos, "a log line carries the answer: %q. Log the user, the decision and the signature", logged);
}

void CheckHourBucket(harness::Ctx& ctx) {
  seed(ctx, "u-ana", "refused", kSigA, kT + 10);
  seed(ctx, "u-ben", "refused", kSigA, kT + 20);
  seed(ctx, "u-ana", "served", "", kT + 30);
  seed(ctx, "u-cy", "refused", kSigB, kT + 3605);
  drain(ctx);
  const std::string thisHour = "signatures:" + std::to_string(kHour);
  const std::string nextHour = "signatures:" + std::to_string(kHour + 1);
  ctx.Equal(ctx.Redis.Exists("signatures"), 0, "one global signatures hash (%v) cannot show when an attack began: bucket by hour, signatures:{ts / 3600}; EXISTS signatures", ctx.Redis.HGetAll("signatures"));
  ctx.Equal(ctx.Redis.HGetAll(thisHour), std::map<std::string, std::string>{{kSigA, "2"}}, "%s must count %s twice and nothing for the served decision", thisHour, kSigA);
  ctx.Equal(ctx.Redis.HGetAll(nextHour), std::map<std::string, std::string>{{kSigB, "1"}}, "%s must count %s once", nextHour, kSigB);
  for (const auto& key : {thisHour, nextHour}) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl >= 7 * 86400 - 60 && ttl <= 7 * 86400, "%s has TTL %d: an hourly bucket is kept for 7 days", key, ttl);
  }
}

void CheckWriteBeforeCommit(harness::Ctx& ctx) {
  seed(ctx, "u-ana", "refused", kSigA, kT + 10);
  const auto event = ctx.Kafka.Records(kTopic)[0];
  const std::string thisHour = "signatures:" + std::to_string(kHour);
  struct Snapshot {
    harness::KafkaOffsets offsets;
    std::string count;
  };
  std::vector<Snapshot> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) {
    atCommit.push_back({offsets, ctx.Redis.HGet(thisHour, kSigA).value_or("")});
  });
  drain(ctx);
  const auto consumers = ctx.Kafka.Consumers();
  ctx.Assert(!consumers.empty() && !consumers.back().AutoCommit, "enable.auto.commit is on: offsets would be committed on a timer, before the count");
  std::vector<std::string> covering;
  for (const auto& snap : atCommit) {
    const auto at = snap.offsets.find(harness::KafkaTopicPartition{kTopic, event.Partition});
    if (at != snap.offsets.end() && at->second > event.Offset) covering.push_back(snap.count);
  }
  ctx.Assert(!covering.empty(), "the event's offset was never committed");
  ctx.Equal(covering[0], "1", "write the count first, then commit, so a crash replays the event instead of losing it; the count when the offset was committed");
  ctx.Equal(ctx.Kafka.Lag(kGroup, kTopic), 0, "every event must be committed once counted; lag");
}
`,
  },
  debrief: `The record key is the user because Kafka orders per partition and a user's attack is a sequence: the same probe, reworded, minute after minute. The idempotent producer and \`acks=all\` make "one event per decision" hold through a lost acknowledgement and a leader failover; the event carries hashes and signal names because a retained, replicated topic is the longest-lived copy the service makes. Hour buckets are what turn counts into a timeline: the source shows attacks evolving after each provider fix, which only shows if you can see when a signature rose. Committing after the write makes a crash cost a replay, never a lost count. Production pipelines often make the count itself idempotent by keying it on the event id, so a replay after a crash between write and commit does not count twice.`,
};
