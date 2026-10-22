import type {Step} from '@/lib/types';

export const experimentEventsStep: Step = {
  id: 'events',
  title: 'Exposure events keyed by experiment with unit dedupe',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces an exposure on every
call, the consumer counts it, and the demo shows a number climbing. It compiles, it serves the happy
path, and it quietly corrupts the analysis it exists to feed. Review it like the service owner, fix
it, and prove the fix with the checks below.

Every exposure — the moment a unit is shown a variant — is a record on the **\`experiment.exposure\`**
topic. Implement the exposure path of \`expd\`:

- \`record_exposure(experiment_id, unit, variant, ts)\` publishes **one** event per
  \`(experiment, unit, variant)\`. The message key is the **experiment id** — \`key=experiment_id\`,
  \`Key: []byte(experimentID)\`, \`new ProducerRecord(..., experimentId, ...)\` — never the unit id and
  never a request id, so every exposure of one experiment lands on one partition, in the order it
  happened.
- Before producing, claim the exposure in Redis with a conditional write: \`SET NX\` on
  \`dedupe:exp:{id}:{unit}:{variant}\` with a TTL (**7 days**, longer than any replay window). \`NX\`
  returns nothing when the triple is already claimed — a re-rendered page calling again with the same
  \`(experiment, unit, variant)\` logs it and **returns without producing**. The claim happens
  **before** the produce.
- The payload carries \`experiment_id\`, \`variant\`, **\`unit_hash\`** and \`ts\`. \`unit_hash\` is a
  SHA-256 digest of the unit — the only unit-derived value that may leave the service: a raw user
  identifier is PII and must never appear in the event or in a log line.
- The producer is **idempotent with \`acks=all\`**: \`"acks": "all"\` with
  \`"enable.idempotence": True\`, \`acks: -1\` with \`idempotent: true\` (KafkaJS), \`RequiredAcks:
  kafka.RequireAll\` with a \`Hash\` balancer (kafka-go has no idempotent mode), or \`"acks", "all"\`
  with \`"enable.idempotence", "true"\` in the Java and librdkafka clients. A retry of an acknowledged
  produce must not write the exposure twice.
- A produce refused for back-pressure (a full producer buffer, \`ERR__QUEUE_FULL\`) is **retried**,
  \`MAX_PRODUCE_ATTEMPTS\` (3), polling the local queue between attempts. A produce the broker
  permanently rejects is logged with the experiment id and the unit hash — never the raw unit — and
  does not fail the caller's request path.
- The consumer, group \`exposure-stats\`, applies the exposure to the analysis state **before** it
  commits the offset: \`HINCRBY stats:{experiment_id} {variant} 1\` (a store row is the same shape),
  then the commit. A broker error commits nothing, so the record is redelivered.

**Failure mode the checks target.** The draft keys the record by the unit id, so the exposures of one
experiment are scattered across partitions and its analysis stream has no order; it publishes on every
call with no dedupe, so a re-rendered page is a second exposure and every rate is inflated; it ships
\`user_id\` in the payload, so the topic and the consumer logs carry the user's identity; it leaves the
producer at its defaults, so a retry can write the exposure twice; and it commits the offset before
the counter, so a crash in between loses the exposure while the offset says it was applied.`,
  sequence: {
    participants: ['Experiment API', 'Redis', 'experiment.exposure', 'Analysis consumer'],
    messages: [
      {
        from: 'Experiment API',
        to: 'Redis',
        label: 'SET dedupe:exp:{id}:{unit}:{variant} 1 NX EX 604800',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Experiment API', label: 'OK · nil = duplicate, return without producing', kind: 'reply'},
      {
        from: 'Experiment API',
        to: 'experiment.exposure',
        label: 'produce value {experiment_id, variant, unit_hash, ts} · key = experiment id · acks = all',
        kind: 'sync',
      },
      {
        from: 'experiment.exposure',
        to: 'Experiment API',
        label: 'ack · broker rejection is logged, never the unit',
        kind: 'reply',
      },
      {from: 'experiment.exposure', to: 'Analysis consumer', label: 'consume · group exposure-stats', kind: 'async'},
      {from: 'Analysis consumer', to: 'Redis', label: 'HINCRBY stats:{experiment_id} {variant} 1', kind: 'sync'},
      {
        from: 'Analysis consumer',
        to: 'experiment.exposure',
        label: 'commit the offset after the counter',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'key-by-experiment',
      title: 'Keys every exposure by experiment id',
      detail:
        "The produced record is keyed by the **experiment id**, so every exposure of one experiment lands on one partition, in the order it happened — the only key that keeps an experiment's analysis stream ordered. The draft keys by the unit id, which scatters one experiment across partitions.",
      match: {
        python: {all: [/producer\.produce\(\s*TOPIC\s*,\s*key\s*=\s*experiment_id\b/]},
        typescript: {all: [/topic:\s*TOPIC/, /key:\s*experimentId\b/]},
        go: {all: [/writer\.WriteMessages\(/, /Key:\s*\[\]byte\(experimentID\)/]},
        scala: {
          all: [/new ProducerRecord\[String,\s*String\]\(\s*(?:Topic|"experiment\.exposure")\s*,\s*experimentId\s*,/],
        },
        cpp: {all: [/producer->produce\(/, /experiment_id\.data\(\),\s*experiment_id\.size\(\)/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Claims the exposure with SET NX before the produce',
      detail:
        'A conditional `SET NX` on `dedupe:exp:{id}:{unit}:{variant}` with the dedupe TTL claims the exposure **before** the record is produced; a second call for the same triple returns without producing. The draft publishes on every call, so a re-rendered page counts a second exposure.',
      match: {
        python: {all: [/dedupe:exp:/, /nx=True/, /ex=DEDUPE_TTL_S/], order: [/r\.set\(/, /producer\.produce\(/]},
        typescript: {all: [/dedupe:exp:/, /['"]NX['"]/, /['"]EX['"]/], order: [/redis\.set\(/, /producer\.send\(/]},
        go: {all: [/dedupe:exp:/, /rdb\.SetNX\(/, /dedupeTTL/], order: [/rdb\.SetNX\(/, /writer\.WriteMessages\(/]},
        scala: {all: [/dedupe:exp:/, /\.nx\(\)/, /DedupeTtlS/], order: [/jedis\.set\(/, /producer\.send\(/]},
        cpp: {
          all: [/dedupe:exp:/, /UpdateType::NOT_EXIST/, /kDedupeTtl/],
          order: [/redis\.set\(/, /producer->produce\(/],
        },
      },
    },
    {
      id: 'payload',
      title: 'Carries the variant, a unit hash and a timestamp — never the raw unit',
      detail:
        "The event carries `experiment_id`, `variant`, `unit_hash` (a SHA-256 digest of the unit) and `ts`; a raw user identifier is PII and must not appear in the event or in a log line. The draft ships `user_id`, so the topic and the consumer logs carry the user's identity.",
      match: {
        python: {
          all: [/["']unit_hash["']\s*:/, /["']variant["']\s*:/, /["']ts["']\s*:/],
          none: [/["']user_id["']|["']unit_id["']/],
        },
        typescript: {
          all: [/unit_hash:\s*unitHash\(/, /experiment_id:\s*experimentId/, /\bvariant\b/],
          none: [/user_id|unit_id/],
        },
        go: {all: [/json:"unit_hash"/, /json:"variant"/, /json:"ts"/], none: [/json:"user_id"|UserID/]},
        scala: {all: [/unit_hash/, /unitHash\(unit\)/, /"variant"/], none: [/user_id/]},
        cpp: {all: [/"unit_hash"/, /unit_hash\(unit\)/, /"variant"/], none: [/"user_id"|"unit_id"/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` with `"acks": "all"`, KafkaJS’s `idempotent: true` with `acks: -1`, kafka-go’s `RequireAll` with a stable `Hash` balancer), so a retry of an acknowledged produce cannot write the exposure twice. The draft leaves the producer at its defaults.',
      match: {
        python: {all: [/"acks"\s*:\s*"all"/, /"enable\.idempotence"\s*:\s*True/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/"enable\.idempotence"\s*,\s*"true"/, /"acks"\s*,\s*"all"/]},
        cpp: {all: [/"enable\.idempotence"\s*,\s*"true"/, /"acks"\s*,\s*"all"/]},
      },
    },
    {
      id: 'state-before-commit',
      title: 'Writes the analysis counter before committing the offset',
      detail:
        'The consumer applies the exposure to the analysis state — `HINCRBY stats:{experiment_id} {variant} 1` — and only then commits the offset, so a crash replays the record instead of losing it, and a broker error commits nothing. The draft commits first, so the exposure is lost while the offset says it was applied.',
      match: {
        python: {all: [/hincrby/, /"enable\.auto\.commit"\s*:\s*False/], order: [/r\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {all: [/hincrby/, /autoCommit:\s*false/], order: [/redis\.hincrby\(/, /commitOffsets\(/]},
        go: {all: [/HIncrBy/, /FetchMessage/], order: [/rdb\.HIncrBy\(/, /CommitMessages\(/]},
        scala: {
          all: [/hincrBy/, /"enable\.auto\.commit"\s*,\s*"false"/],
          order: [/jedis\.hincrBy\(/, /commit\(record\)/],
        },
        cpp: {all: [/hincrby/, /"enable\.auto\.commit"\s*,\s*"false"/], order: [/redis\.hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

log = logging.getLogger("exposures")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "experiment.exposure"

producer = Producer({"bootstrap.servers": "kafka:9092"})

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "exposure-stats",
        "auto.offset.reset": "earliest",
    }
)


def record_exposure(experiment_id: str, unit: str, variant: str, ts: float) -> None:
    # TODO: this draft keys the record by the unit, produces on every call (a re-rendered page counts a
    # second exposure), ships the raw user id in the payload, and leaves the producer at its defaults.
    event = json.dumps({"experiment_id": experiment_id, "variant": variant, "user_id": unit, "ts": ts})
    producer.produce(TOPIC, key=unit, value=event)
    producer.poll(0)


def run() -> None:
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        event = json.loads(msg.value())
        consumer.commit(message=msg, asynchronous=False)
        # TODO: commit last — the counter below is the exposure, and committing before it loses one on a crash
        r.hincrby(f"stats:{event['experiment_id']}", event["variant"], 1)
`,
      solution: `import hashlib
import json
import logging

import redis
from confluent_kafka import Consumer, Producer

log = logging.getLogger("exposures")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "experiment.exposure"
DEDUPE_TTL_S = 7 * 24 * 60 * 60  # longer than any replay window
MAX_PRODUCE_ATTEMPTS = 3

producer = Producer(
    {"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True}
)

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "exposure-stats",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)


def unit_hash(unit: str) -> str:
    """The only unit-derived value that may leave the service: a raw user id is PII."""
    return hashlib.sha256(unit.encode("utf-8")).hexdigest()[:32]


def dedupe_key(experiment_id: str, unit: str, variant: str) -> str:
    return f"dedupe:exp:{experiment_id}:{unit}:{variant}"


def record_exposure(experiment_id: str, unit: str, variant: str, ts: float) -> None:
    """One event per (experiment, unit, variant); the key keeps one experiment's stream ordered."""
    if not r.set(dedupe_key(experiment_id, unit, variant), "1", nx=True, ex=DEDUPE_TTL_S):
        log.info("exposure %s/%s already recorded; not produced", experiment_id, variant)
        return
    event = json.dumps(
        {
            "experiment_id": experiment_id,
            "variant": variant,
            "unit_hash": unit_hash(unit),
            "ts": ts,
        }
    )
    for _ in range(MAX_PRODUCE_ATTEMPTS):
        try:
            producer.produce(TOPIC, key=experiment_id, value=event)
            producer.poll(0)
            return
        except BufferError:
            producer.poll(0.1)  # back-pressure: let the local queue drain, then retry
    log.error("exposure for experiment %s (%s) rejected by the broker", experiment_id, unit_hash(unit))


def run() -> None:
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())  # no commit: the record is redelivered
            continue
        event = json.loads(msg.value())
        # the counter is the analysis state; the offset is committed only after it, so a crash replays
        r.hincrby(f"stats:{event['experiment_id']}", event["variant"], 1)
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {Redis} from 'ioredis';
import {type EachMessagePayload, Kafka} from 'kafkajs';

const TOPIC = 'experiment.exposure';

const kafka = new Kafka({clientId: 'expd', brokers: ['kafka:9092']});
const producer = kafka.producer();
const redis = new Redis('redis://redis:6379');
const consumer = kafka.consumer({groupId: 'exposure-stats'});

export async function recordExposure(
  experimentId: string,
  unit: string,
  variant: string,
  ts: number,
): Promise<void> {
  // TODO: this draft keys the record by the unit, produces on every call (a re-rendered page counts a
  // second exposure), ships the raw user id in the payload, and leaves the producer at its defaults.
  const event = JSON.stringify({experiment_id: experimentId, variant, user_id: unit, ts});
  await producer.send({topic: TOPIC, messages: [{key: unit, value: event}]});
}

async function handle({topic, partition, message}: EachMessagePayload): Promise<void> {
  const event = JSON.parse(message.value?.toString() ?? '{}') as {
    experiment_id: string;
    variant: string;
  };
  await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
  // TODO: commit last — the counter below is the exposure, and committing before it loses one on a crash
  await redis.hincrby(\`stats:\${event.experiment_id}\`, event.variant, 1);
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({eachMessage: handle});
}
`,
      solution: `import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';
import {type EachMessagePayload, Kafka} from 'kafkajs';

const TOPIC = 'experiment.exposure';
const DEDUPE_TTL_S = 7 * 24 * 60 * 60; // longer than any replay window
const MAX_PRODUCE_ATTEMPTS = 3;

const kafka = new Kafka({clientId: 'expd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
const redis = new Redis('redis://redis:6379');
const consumer = kafka.consumer({groupId: 'exposure-stats'});

/** The only unit-derived value that may leave the service: a raw user id is PII. */
function unitHash(unit: string): string {
  return createHash('sha256').update(unit, 'utf8').digest('hex').slice(0, 32);
}

function dedupeKey(experimentId: string, unit: string, variant: string): string {
  return \`dedupe:exp:\${experimentId}:\${unit}:\${variant}\`;
}

/** One event per (experiment, unit, variant); the key keeps one experiment's stream on one partition. */
export async function recordExposure(
  experimentId: string,
  unit: string,
  variant: string,
  ts: number,
): Promise<void> {
  const claimed = await redis.set(dedupeKey(experimentId, unit, variant), '1', 'EX', DEDUPE_TTL_S, 'NX');
  if (claimed === null) {
    console.info(\`exposure \${experimentId}/\${variant} already recorded; not produced\`);
    return;
  }
  const event = JSON.stringify({
    experiment_id: experimentId,
    variant,
    unit_hash: unitHash(unit),
    ts,
  });
  for (let attempt = 0; attempt < MAX_PRODUCE_ATTEMPTS; attempt += 1) {
    try {
      await producer.send({topic: TOPIC, acks: -1, messages: [{key: experimentId, value: event}]});
      return;
    } catch (error) {
      if (attempt === MAX_PRODUCE_ATTEMPTS - 1) {
        // the raw unit never reaches a log line: the unit hash identifies the exposure instead
        console.error(
          \`exposure for experiment \${experimentId} (\${unitHash(unit)}) rejected by the broker\`,
          error,
        );
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1))); // back-pressure: drain, retry
    }
  }
}

async function handle({topic, partition, message}: EachMessagePayload): Promise<void> {
  const event = JSON.parse(message.value?.toString() ?? '{}') as {
    experiment_id: string;
    variant: string;
  };
  // the counter is the analysis state; the offset is committed only after it, so a crash replays
  await redis.hincrby(\`stats:\${event.experiment_id}\`, event.variant, 1);
  await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({autoCommit: false, eachMessage: handle});
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const exposureTopic = "experiment.exposure"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type exposureEvent struct {
	ExperimentID string  \`json:"experiment_id"\`
	Variant      string  \`json:"variant"\`
	UserID       string  \`json:"user_id"\`
	Ts           float64 \`json:"ts"\`
}

// TODO: this draft keys the record by the unit, produces on every call (a re-rendered page counts a
// second exposure), ships the raw user id in the payload, and leaves the writer at its defaults.
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: exposureTopic}

func recordExposure(ctx context.Context, experimentID, unit, variant string, ts float64) error {
	value, _ := json.Marshal(exposureEvent{ExperimentID: experimentID, Variant: variant, UserID: unit, Ts: ts})
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(unit), Value: value})
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "exposure-stats",
	Topic:   exposureTopic,
})

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event exposureEvent
		_ = json.Unmarshal(msg.Value, &event)
		_ = reader.CommitMessages(ctx, msg)
		// TODO: commit last — the counter below is the exposure, and committing before it loses one on a crash
		if err := rdb.HIncrBy(ctx, "stats:"+event.ExperimentID, event.Variant, 1).Err(); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const exposureTopic = "experiment.exposure"

const (
	dedupeTTL          = 7 * 24 * time.Hour // longer than any replay window
	maxProduceAttempts = 3
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the record is acknowledged only once it is replicated, and a retry of the same key lands
// on the same partition instead of duplicating across them.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        exposureTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type exposureEvent struct {
	ExperimentID string  \`json:"experiment_id"\`
	Variant      string  \`json:"variant"\`
	UnitHash     string  \`json:"unit_hash"\`
	Ts           float64 \`json:"ts"\`
}

// unitHash is the only unit-derived value that may leave the service: a raw user id is PII.
func unitHash(unit string) string {
	sum := sha256.Sum256([]byte(unit))
	return hex.EncodeToString(sum[:])[:32]
}

func dedupeKey(experimentID, unit, variant string) string {
	return "dedupe:exp:" + experimentID + ":" + unit + ":" + variant
}

// recordExposure publishes one event per (experiment, unit, variant); the key keeps one experiment's
// stream on one partition, in the order the exposures happened.
func recordExposure(ctx context.Context, experimentID, unit, variant string, ts float64) error {
	claimed, err := rdb.SetNX(ctx, dedupeKey(experimentID, unit, variant), "1", dedupeTTL).Result()
	if err != nil {
		return err
	}
	if !claimed {
		log.Printf("exposure %s/%s already recorded; not produced", experimentID, variant)
		return nil
	}
	value, _ := json.Marshal(exposureEvent{
		ExperimentID: experimentID,
		Variant:      variant,
		UnitHash:     unitHash(unit),
		Ts:           ts,
	})
	msg := kafka.Message{Key: []byte(experimentID), Value: value}
	var lastErr error
	for attempt := 0; attempt < maxProduceAttempts; attempt++ {
		lastErr = writer.WriteMessages(ctx, msg)
		if lastErr == nil {
			return nil
		}
		time.Sleep(time.Duration(50*(attempt+1)) * time.Millisecond) // back-pressure: drain, retry
	}
	// the raw unit never reaches a log line: the unit hash identifies the exposure instead
	log.Printf("exposure for experiment %s (%s) rejected by the broker: %v", experimentID, unitHash(unit), lastErr)
	return lastErr
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "exposure-stats",
	Topic:   exposureTopic,
})

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event exposureEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil || event.ExperimentID == "" {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			_ = reader.CommitMessages(ctx, msg)
			continue
		}
		// the counter is the analysis state; the offset is committed only after it, so a crash
		// replays the exposure instead of losing it
		if err := rdb.HIncrBy(ctx, "stats:"+event.ExperimentID, event.Variant, 1).Err(); err != nil {
			return err // no commit: the record is redelivered
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
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import spray.json._

object ExposureEvents {
  val Topic = "experiment.exposure"

  private val jedis = new JedisPooled("redis", 6379)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  // TODO: this draft keys the record by the unit, produces on every call (a re-rendered page counts a
  // second exposure), ships the raw user id in the payload, and leaves the producer at its defaults.
  def recordExposure(experimentId: String, unit: String, variant: String, ts: Double): Unit = {
    val payload = s"""{"experiment_id":"$experimentId","variant":"$variant","user_id":"$unit","ts":$ts}"""
    producer.send(new ProducerRecord[String, String](Topic, unit, payload))
  }

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", "exposure-stats")
  consumerProps.put("auto.offset.reset", "earliest")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  /** Commits this record's offset synchronously. */
  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(
      Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  def run(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val fields = record.value().parseJson.asJsObject.fields
        val experimentId = fields("experiment_id").convertTo[String]
        val variant = fields("variant").convertTo[String]
        commit(record)
        // TODO: commit last — the counter below is the exposure, and committing before it loses one on a crash
        jedis.hincrBy(s"stats:$experimentId", variant, 1)
      }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._
import spray.json._

object ExposureEvents {
  val Topic = "experiment.exposure"
  val DedupeTtlS = 604800L // 7 days: longer than any replay window
  val MaxProduceAttempts = 3

  private val jedis = new JedisPooled("redis", 6379)

  private val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  producerProps.put("enable.idempotence", "true")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** The only unit-derived value that may leave the service: a raw user id is PII. */
  def unitHash(unit: String): String =
    java.security.MessageDigest
      .getInstance("SHA-256")
      .digest(unit.getBytes("UTF-8"))
      .map("%02x".format(_))
      .mkString
      .take(32)

  def dedupeKey(experimentId: String, unit: String, variant: String): String =
    s"dedupe:exp:$experimentId:$unit:$variant"

  /** One event per (experiment, unit, variant); the key keeps one experiment's stream on one partition. */
  def recordExposure(experimentId: String, unit: String, variant: String, ts: Double): Unit = {
    val claimed =
      jedis.set(dedupeKey(experimentId, unit, variant), "1", SetParams.setParams().nx().ex(DedupeTtlS)) != null
    if (!claimed) {
      System.err.println(s"exposure $experimentId/$variant already recorded; not produced")
      return
    }
    val payload = s"""{"experiment_id":"$experimentId","variant":"$variant","unit_hash":"\${unitHash(unit)}","ts":$ts}"""
    var attempt = 0
    while (attempt < MaxProduceAttempts) {
      try {
        // acknowledged by every in-sync replica; a retry of this key writes once
        producer.send(new ProducerRecord[String, String](Topic, experimentId, payload)).get()
        return
      } catch {
        case _: java.util.concurrent.ExecutionException | _: org.apache.kafka.common.errors.TimeoutException =>
          attempt += 1
          if (attempt < MaxProduceAttempts) Thread.sleep(50L * attempt) // back-pressure: drain, retry
      }
    }
    // the raw unit never reaches a log line: the unit hash identifies the exposure instead
    System.err.println(s"exposure for experiment $experimentId (\${unitHash(unit)}) rejected by the broker")
  }

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", "exposure-stats")
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  /** Commits this record's offset synchronously. */
  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(
      Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  def run(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val fields = record.value().parseJson.asJsObject.fields
        val experimentId = fields("experiment_id").convertTo[String]
        val variant = fields("variant").convertTo[String]
        // the counter is the analysis state; the offset is committed only after it, so a crash replays
        jedis.hincrBy(s"stats:$experimentId", variant, 1)
        commit(record)
      }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kExposureTopic = "experiment.exposure";

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // TODO: acks=all and enable.idempotence=true
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// TODO: this draft keys the record by the unit, produces on every call (a re-rendered page counts a
// second exposure), ships the raw user id in the payload, and leaves the producer at its defaults.
void record_exposure(const std::string& experiment_id, const std::string& unit, const std::string& variant,
                     double ts) {
  const json event = {{"experiment_id", experiment_id}, {"variant", variant}, {"user_id", unit}, {"ts", ts}};
  const auto payload = event.dump();
  producer->produce(kExposureTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), unit.data(), unit.size(), 0, nullptr);
  producer->poll(0);
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "exposure-stats", err);
  conf->set("auto.offset.reset", "earliest", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kExposureTopic});
  return consumer;
}

auto consumer = make_consumer();

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(static_cast<const char*>(msg->payload()),
                                   static_cast<const char*>(msg->payload()) + msg->len());
    consumer->commitSync(msg.get());
    // TODO: commit last — the counter below is the exposure, and committing before it loses one on a crash
    redis.hincrby("stats:" + event["experiment_id"].get<std::string>(), event["variant"].get<std::string>(), 1);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kExposureTopic = "experiment.exposure";
constexpr std::chrono::seconds kDedupeTtl{604800};  // 7 days: longer than any replay window
constexpr int kMaxProduceAttempts = 3;

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

/** The only unit-derived value that may leave the service: a raw user id is PII. */
std::string unit_hash(const std::string& unit) {
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(unit.data()), unit.size(), hash);
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned char byte : hash) {
    out.push_back(hex[byte >> 4]);
    out.push_back(hex[byte & 0x0f]);
  }
  return out.substr(0, 32);
}

std::string dedupe_key(const std::string& experiment_id, const std::string& unit, const std::string& variant) {
  return "dedupe:exp:" + experiment_id + ":" + unit + ":" + variant;
}

/** One event per (experiment, unit, variant); the key keeps one experiment's stream on one partition. */
void record_exposure(const std::string& experiment_id, const std::string& unit, const std::string& variant,
                     double ts) {
  const bool claimed =
      redis.set(dedupe_key(experiment_id, unit, variant), "1", kDedupeTtl, sw::redis::UpdateType::NOT_EXIST);
  if (!claimed) {
    std::cerr << "exposure " << experiment_id << "/" << variant << " already recorded; not produced\\n";
    return;
  }
  const json event = {{"experiment_id", experiment_id},
                      {"variant", variant},
                      {"unit_hash", unit_hash(unit)},
                      {"ts", ts}};
  const auto payload = event.dump();
  for (int attempt = 0; attempt < kMaxProduceAttempts; ++attempt) {
    const auto err =
        producer->produce(kExposureTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                          const_cast<char*>(payload.data()), payload.size(), experiment_id.data(),
                          experiment_id.size(), 0, nullptr);
    if (err == RdKafka::ERR_NO_ERROR) {
      producer->poll(0);  // serve delivery callbacks; returns immediately
      return;
    }
    producer->poll(100);  // back-pressure: let the local queue drain, then retry
  }
  // the raw unit never reaches a log line: the unit hash identifies the exposure instead
  std::cerr << "exposure for experiment " << experiment_id << " (" << unit_hash(unit)
            << ") rejected by the broker\\n";
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "exposure-stats", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kExposureTopic});
  return consumer;
}

auto consumer = make_consumer();

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";  // no commit: the record is redelivered
      continue;
    }
    const json event = json::parse(static_cast<const char*>(msg->payload()),
                                   static_cast<const char*>(msg->payload()) + msg->len());
    // the counter is the analysis state; the offset is committed only after it, so a crash replays
    redis.hincrby("stats:" + event["experiment_id"].get<std::string>(), event["variant"].get<std::string>(), 1);
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  hints: [
    'The key is the ordering contract: `key=experiment_id`, `Key: []byte(experimentID)`, `ProducerRecord(Topic, experimentId, …)` puts every exposure of one experiment on one partition. Keyed by the unit id the stream of an experiment is scattered and its analysis has no order.',
    'Redis makes `record_exposure` idempotent: `SET NX` on `dedupe:exp:{id}:{unit}:{variant}` with the dedupe TTL, *before* the produce, and a refused claim returns without a record. `unit_hash` is the only unit-derived field the event may carry, and producer durability is configuration (`enable.idempotence` + `acks=all`, KafkaJS `idempotent: true` + `acks: -1`, kafka-go `RequireAll` + `Hash`).',
    'In the consumer the order is the point: `HINCRBY stats:{experiment_id} {variant} 1` first, commit second. Commit first and a crash loses the exposure the offset claims was applied; a broker error must commit nothing at all.',
  ],
  debrief: `The interviewer is testing whether you can review a Kafka exposure path as the analysis contract
instead of a publish call. The draft looks right because the demo renders one page, on one cluster, with
no re-render and no crash. Five defects are being checked: a unit-keyed record (the stream of an
experiment loses its order), a produce with no dedupe claim (a re-rendered page is a second exposure and
every rate is inflated), a payload carrying \`user_id\` (PII on the topic and in the logs), a producer at
its defaults (a retry writes the exposure twice), and a commit that runs before the counter (a crash
drops the exposure the offset claims was applied). The subtle one is the position of the dedupe claim:
it belongs *before* the produce, because a claim written after a rejected produce leaves an exposure
marked as recorded that never happened, and the analysis undercounts it forever. Real pipelines add the
sample-ratio check on the consumer side, a versioned event schema, and a per-experiment quota so one
runaway experiment cannot flood the topic.`,
};
