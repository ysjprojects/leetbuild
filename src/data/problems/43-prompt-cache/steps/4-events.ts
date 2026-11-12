import type {Step} from '@/lib/types';

export const cacheEventsStep: Step = {
  id: 'events',
  title: 'Decision events keyed by tenant, counted before the commit',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'events',
  focus: ['cache', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter's \`events\` module has two halves. \`emit_decision(tenant, version,
prefix, decision, latency_ms, tokens)\` produces a JSON event to \`cache.result\` keyed by the prompt
version, carrying the first 512 characters of the prefix beside the decision. \`run_stats()\` consumes
the topic as group \`cache-stats\` with auto-commit off: it commits each record, then adds it to
\`pc-stats:{version}\` and the tenant's \`pc-versions\` set. Events flow and counters move in the demo. It
hides 4 flaws.

**Failure mode the checks target.** The topic is retained and replicated, so prompt text written there
outlives every deletion request, and a digest is all a join needs. Keyed by version, one tenant's
decisions spread over partitions while every tenant on that version shares one. Counted per version, one
tenant's hit ratio is everyone's. Committed before counting, a crash between the two loses a decision
for good.

- Events are keyed by **tenant** and carry \`{tenant, version, prefix_digest, decision, latency_ms,
  tokens}\`, where \`prefix_digest\` is the SHA-256 hex of the prefix. No prefix text.
- \`run_stats\` adds a hit to \`hits\` and \`tokens_saved\`, a miss to \`misses\` and \`fill_ms\`, in
  \`pc-stats:{tenant}:{version}\` (\`stats_key\`), and the version to \`pc-versions:{tenant}\`.
- The counters move **before** the offset is committed.`,
  sequence: {
    participants: ['Prompt Cache', 'cache.result', 'Stats consumer', 'Redis'],
    messages: [
      {
        from: 'Prompt Cache',
        to: 'cache.result',
        label: 'key=tenant {version, prefix_digest, decision, latency_ms, tokens}',
        kind: 'async',
      },
      {from: 'cache.result', to: 'Stats consumer', label: 'record', kind: 'async'},
      {
        from: 'Stats consumer',
        to: 'Redis',
        label: 'HINCRBY pc-stats:{tenant}:{version} · SADD pc-versions',
        kind: 'sync',
      },
      {from: 'Stats consumer', to: 'cache.result', label: 'commit offset', kind: 'sync'},
    ],
  },
  hints: [
    "Customer prompts turn up in the decision topic, one tenant's dashboard shows a hit ratio shaped by other tenants, and after a consumer restart a few minutes of decisions are missing from the counts.",
    '`emit_decision` keys by the version and copies `prefix[:512]` into the event; `run_stats` counts under `pc-stats:{version}` with no tenant, and commits each record before it touches Redis.',
    'Produce with `key=tenant` and `prefix_digest = sha256(prefix).hexdigest()` instead of the prefix; count under `stats_key(tenant, version)`; move `consumer.commit` after the HINCRBYs and the SADD.',
  ],
  checks: [
    {
      id: 'decision-event',
      title: 'One event per decision on cache.result',
      detail:
        'Each emit_decision produces one record on cache.result carrying tenant, version, decision, latency_ms and tokens.',
      match: {
        python: {all: [/producer\.produce\(\s*TOPIC/]},
        typescript: {all: [/producer\.send\(\s*\{\s*topic:\s*TOPIC/]},
        go: {all: [/WriteMessages\(/]},
        scala: {all: [/producer\.send\(/]},
        cpp: {all: [/producer->produce\(\s*config::kTopic/]},
      },
    },
    {
      id: 'tenant-key',
      title: 'Keys the event by tenant',
      detail:
        "Decisions for t1, t2, t1 are keyed t1, t2, t1, and t1's two land on one partition. The starter keys by prompt version.",
      match: {
        python: {all: [/produce\([^)]*key\s*=\s*tenant\b/], none: [/key\s*=\s*str\(\s*version\s*\)/]},
        typescript: {all: [/key:\s*tenant\b/], none: [/key:\s*String\(\s*version\s*\)/]},
        go: {
          all: [/Key:\s*\[\]byte\(\s*tenant\s*\)/],
          none: [/Key:\s*\[\]byte\(\s*strconv\.Itoa\(\s*version\s*\)\s*\)/],
        },
        scala: {
          all: [/ProducerRecord\[String, String\]\(\s*Config\.Topic\s*,\s*tenant\s*,/],
          none: [/ProducerRecord\[String, String\]\(\s*Config\.Topic\s*,\s*version\.toString/],
        },
        cpp: {all: [/produce\([\s\S]{0,300}?tenant\.c_str\(\)/], none: [/key\s*=\s*std::to_string\(\s*version\s*\)/]},
      },
    },
    {
      id: 'digest-only',
      title: 'Carries the prefix digest, not the prefix',
      detail:
        'The event carries prefix_digest, the SHA-256 hex of the prefix, and no prefix text in any field. The starter ships the first 512 characters of the prompt.',
      match: {
        python: {all: [/prefix_digest/, /hashlib\.sha256\(/], none: [/["']prefix["']\s*:/, /prefix\[:/]},
        typescript: {
          all: [/prefix_digest/, /createHash\(\s*['"]sha256['"]\s*\)/],
          none: [/\bprefix:\s*prefix/, /prefix\.slice\(/],
        },
        go: {all: [/PrefixDigest/, /sha256\.Sum256\(/], none: [/json:"prefix"/]},
        scala: {all: [/prefix_digest/, /SHA-256/], none: [/"prefix"\s*->/]},
        cpp: {all: [/prefix_digest/, /sha256_hex\(/], none: [/\{"prefix",/]},
      },
    },
    {
      id: 'tenant-stats',
      title: 'Counts per tenant and version',
      detail:
        "Hits, misses, fill_ms and tokens_saved land in pc-stats:{tenant}:{version} and the version in pc-versions:{tenant}; t2's miss does not move t1's counters. The starter counts under pc-stats:{version}.",
      match: {
        python: {all: [/stats_key\(\s*event\[["']tenant["']\]/]},
        typescript: {all: [/statsKey\(\s*event\.tenant/]},
        go: {all: [/config\.StatsKey\(\s*event\.Tenant/]},
        scala: {all: [/Config\.statsKey\(/]},
        cpp: {all: [/config::stats_key\(/]},
      },
    },
    {
      id: 'count-before-commit',
      title: 'Counts before it commits the offset',
      detail:
        'At the first offset commit the decision is already in the counters, and every processed record is committed. The starter commits first, so a crash in between loses the decision.',
      match: {
        python: {order: [/r\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/redis\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/hincrBy\(/, /commitSync\(/]},
        cpp: {order: [/hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from pcache.config import TOPIC, versions_key

log = logging.getLogger("pcache.events")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def _delivery_report(err, msg) -> None:
    if err is not None:
        log.warning("cache.result produce failed key=%s: %s", msg.key(), err)


def emit_decision(tenant: str, version: int, prefix: str, decision: str, latency_ms: int, tokens: int) -> None:
    """One event per cache decision."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    event = {
        "tenant": tenant,
        "version": version,
        "prefix": prefix[:512],
        "decision": decision,
        "latency_ms": latency_ms,
        "tokens": tokens,
    }
    producer.produce(TOPIC, key=str(version), value=json.dumps(event).encode("utf-8"), on_delivery=_delivery_report)
    producer.poll(0)


def run_stats() -> None:
    """The stats consumer: count each decision."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "cache-stats", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        event = json.loads(record.value())
        consumer.commit(record, asynchronous=False)
        stats = f"pc-stats:{event['version']}"
        if event["decision"] == "hit":
            r.hincrby(stats, "hits", 1)
            r.hincrby(stats, "tokens_saved", event["tokens"])
        else:
            r.hincrby(stats, "misses", 1)
            r.hincrby(stats, "fill_ms", event["latency_ms"])
        r.sadd(versions_key(event["tenant"]), event["version"])
`,
      solution: `import hashlib
import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from pcache.config import TOPIC, stats_key, versions_key

log = logging.getLogger("pcache.events")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def _delivery_report(err, msg) -> None:
    if err is not None:
        log.warning("cache.result produce failed key=%s: %s", msg.key(), err)


def emit_decision(tenant: str, version: int, prefix: str, decision: str, latency_ms: int, tokens: int) -> None:
    """One event per cache decision, keyed by tenant; the prefix leaves this process only as its digest."""
    event = {
        "tenant": tenant,
        "version": version,
        "prefix_digest": hashlib.sha256(prefix.encode("utf-8")).hexdigest(),
        "decision": decision,
        "latency_ms": latency_ms,
        "tokens": tokens,
    }
    producer.produce(TOPIC, key=tenant, value=json.dumps(event).encode("utf-8"), on_delivery=_delivery_report)
    producer.poll(0)  # serve delivery reports already in; returns at once


def run_stats() -> None:
    """The stats consumer: count each decision under its tenant and version, then commit."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "cache-stats", "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(1.0)
        if record is None or record.error():
            continue
        event = json.loads(record.value())
        stats = stats_key(event["tenant"], event["version"])
        if event["decision"] == "hit":
            r.hincrby(stats, "hits", 1)
            r.hincrby(stats, "tokens_saved", event["tokens"])
        else:
            r.hincrby(stats, "misses", 1)
            r.hincrby(stats, "fill_ms", event["latency_ms"])
        r.sadd(versions_key(event["tenant"]), event["version"])
        consumer.commit(record, asynchronous=False)  # after the counters: a crash before this point redelivers
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {TOPIC, versionsKey} from 'pcache/config';

const kafka = new Kafka({clientId: 'prompt-cache', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

interface DecisionEvent {
  tenant: string;
  version: number;
  prefix: string;
  decision: string;
  latency_ms: number;
  tokens: number;
}

/** One event per cache decision. */
export async function emitDecision(
  tenant: string,
  version: number,
  prefix: string,
  decision: string,
  latencyMs: number,
  tokens: number,
): Promise<void> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const event: DecisionEvent = {tenant, version, prefix: prefix.slice(0, 512), decision, latency_ms: latencyMs, tokens};
  try {
    await producer.send({topic: TOPIC, messages: [{key: String(version), value: JSON.stringify(event)}]});
  } catch (err) {
    console.warn(\`cache.result produce failed version=\${version}: \${(err as Error).message}\`);
  }
}

/** The stats consumer: count each decision. */
export async function runStats(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'cache-stats'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as DecisionEvent;
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const stats = \`pc-stats:\${event.version}\`;
      if (event.decision === 'hit') {
        await redis.hincrby(stats, 'hits', 1);
        await redis.hincrby(stats, 'tokens_saved', event.tokens);
      } else {
        await redis.hincrby(stats, 'misses', 1);
        await redis.hincrby(stats, 'fill_ms', event.latency_ms);
      }
      await redis.sadd(versionsKey(event.tenant), String(event.version));
    },
  });
}
`,
      solution: `import {createHash} from 'node:crypto';

import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {TOPIC, statsKey, versionsKey} from 'pcache/config';

const kafka = new Kafka({clientId: 'prompt-cache', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

interface DecisionEvent {
  tenant: string;
  version: number;
  prefix_digest: string;
  decision: string;
  latency_ms: number;
  tokens: number;
}

/** One event per cache decision, keyed by tenant; the prefix leaves this process only as its digest. */
export async function emitDecision(
  tenant: string,
  version: number,
  prefix: string,
  decision: string,
  latencyMs: number,
  tokens: number,
): Promise<void> {
  const event: DecisionEvent = {
    tenant,
    version,
    prefix_digest: createHash('sha256').update(prefix, 'utf8').digest('hex'),
    decision,
    latency_ms: latencyMs,
    tokens,
  };
  try {
    await producer.send({topic: TOPIC, messages: [{key: tenant, value: JSON.stringify(event)}]});
  } catch (err) {
    console.warn(\`cache.result produce failed tenant=\${tenant}: \${(err as Error).message}\`);
  }
}

/** The stats consumer: count each decision under its tenant and version, then commit. */
export async function runStats(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'cache-stats'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as DecisionEvent;
      const stats = statsKey(event.tenant, event.version);
      if (event.decision === 'hit') {
        await redis.hincrby(stats, 'hits', 1);
        await redis.hincrby(stats, 'tokens_saved', event.tokens);
      } else {
        await redis.hincrby(stats, 'misses', 1);
        await redis.hincrby(stats, 'fill_ms', event.latency_ms);
      }
      await redis.sadd(versionsKey(event.tenant), String(event.version));
      // After the counters: a crash before this point redelivers the record.
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
	"strconv"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"pcache/config" // config.Topic, config.VersionsKey — provided
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: config.Topic, Balancer: &kafka.Hash{}}
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// decisionEvent is one record on cache.result.
type decisionEvent struct {
	Tenant    string \`json:"tenant"\`
	Version   int    \`json:"version"\`
	Prefix    string \`json:"prefix"\`
	Decision  string \`json:"decision"\`
	LatencyMs int64  \`json:"latency_ms"\`
	Tokens    int    \`json:"tokens"\`
}

// emitDecision produces one event per cache decision.
func emitDecision(ctx context.Context, tenant string, version int, prefix, decision string, latencyMs int64, tokens int) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	sample := prefix
	if len(sample) > 512 {
		sample = sample[:512]
	}
	value, _ := json.Marshal(decisionEvent{Tenant: tenant, Version: version, Prefix: sample, Decision: decision, LatencyMs: latencyMs, Tokens: tokens})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(strconv.Itoa(version)), Value: value}); err != nil {
		log.Printf("cache.result produce failed version=%d: %v", version, err)
	}
}

// runStats is the stats consumer: it counts each decision.
func runStats(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "cache-stats", Topic: config.Topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event decisionEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			continue
		}
		stats := "pc-stats:" + strconv.Itoa(event.Version)
		_, err = rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			if event.Decision == "hit" {
				pipe.HIncrBy(ctx, stats, "hits", 1)
				pipe.HIncrBy(ctx, stats, "tokens_saved", int64(event.Tokens))
			} else {
				pipe.HIncrBy(ctx, stats, "misses", 1)
				pipe.HIncrBy(ctx, stats, "fill_ms", event.LatencyMs)
			}
			pipe.SAdd(ctx, config.VersionsKey(event.Tenant), event.Version)
			return nil
		})
		if err != nil {
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"pcache/config" // config.Topic, config.StatsKey, config.VersionsKey — provided
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: config.Topic, Balancer: &kafka.Hash{}}
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// decisionEvent is one record on cache.result.
type decisionEvent struct {
	Tenant       string \`json:"tenant"\`
	Version      int    \`json:"version"\`
	PrefixDigest string \`json:"prefix_digest"\`
	Decision     string \`json:"decision"\`
	LatencyMs    int64  \`json:"latency_ms"\`
	Tokens       int    \`json:"tokens"\`
}

// emitDecision produces one event per cache decision, keyed by tenant; the prefix leaves this process
// only as its digest.
func emitDecision(ctx context.Context, tenant string, version int, prefix, decision string, latencyMs int64, tokens int) {
	sum := sha256.Sum256([]byte(prefix))
	value, _ := json.Marshal(decisionEvent{
		Tenant:       tenant,
		Version:      version,
		PrefixDigest: hex.EncodeToString(sum[:]),
		Decision:     decision,
		LatencyMs:    latencyMs,
		Tokens:       tokens,
	})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: value}); err != nil {
		log.Printf("cache.result produce failed tenant=%s: %v", tenant, err)
	}
}

// runStats is the stats consumer: it counts each decision under its tenant and version, then commits.
func runStats(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "cache-stats", Topic: config.Topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event decisionEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			if err := reader.CommitMessages(ctx, msg); err != nil {
				return err
			}
			continue
		}
		stats := config.StatsKey(event.Tenant, event.Version)
		_, err = rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			if event.Decision == "hit" {
				pipe.HIncrBy(ctx, stats, "hits", 1)
				pipe.HIncrBy(ctx, stats, "tokens_saved", int64(event.Tokens))
			} else {
				pipe.HIncrBy(ctx, stats, "misses", 1)
				pipe.HIncrBy(ctx, stats, "fill_ms", event.LatencyMs)
			}
			pipe.SAdd(ctx, config.VersionsKey(event.Tenant), event.Version)
			return nil
		})
		if err != nil {
			return err // not committed: the record is redelivered
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

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerConfig, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import pcache.Config

object CacheEvents {
  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)

  /** One event per cache decision. */
  def emitDecision(tenant: String, version: Int, prefix: String, decision: String, latencyMs: Long, tokens: Int): Unit = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val event = ujson.write(
      ujson.Obj(
        "tenant" -> tenant,
        "version" -> version,
        "prefix" -> prefix.take(512),
        "decision" -> decision,
        "latency_ms" -> ujson.Num(latencyMs.toDouble),
        "tokens" -> tokens
      )
    )
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) System.err.println(s"cache.result produce failed version=$version: \${exception.getMessage}")
    }
    producer.send(new ProducerRecord[String, String](Config.Topic, version.toString, event), onDelivery)
  }

  /** The stats consumer: count each decision. */
  def runStats(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "cache-stats")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = ujson.read(record.value())
        consumer.commitSync()
        val tenant = event("tenant").str
        val version = event("version").num.toInt
        val stats = s"pc-stats:$version"
        if (event("decision").str == "hit") {
          jedis.hincrBy(stats, "hits", 1)
          jedis.hincrBy(stats, "tokens_saved", event("tokens").num.toLong)
        } else {
          jedis.hincrBy(stats, "misses", 1)
          jedis.hincrBy(stats, "fill_ms", event("latency_ms").num.toLong)
        }
        jedis.sadd(Config.versionsKey(tenant), version.toString)
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerConfig, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import pcache.Config

object CacheEvents {
  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)

  /** One event per cache decision, keyed by tenant; the prefix leaves this process only as its digest. */
  def emitDecision(tenant: String, version: Int, prefix: String, decision: String, latencyMs: Long, tokens: Int): Unit = {
    val digest =
      MessageDigest.getInstance("SHA-256").digest(prefix.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString
    val event = ujson.write(
      ujson.Obj(
        "tenant" -> tenant,
        "version" -> version,
        "prefix_digest" -> digest,
        "decision" -> decision,
        "latency_ms" -> ujson.Num(latencyMs.toDouble),
        "tokens" -> tokens
      )
    )
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) System.err.println(s"cache.result produce failed tenant=$tenant: \${exception.getMessage}")
    }
    producer.send(new ProducerRecord[String, String](Config.Topic, tenant, event), onDelivery)
  }

  /** The stats consumer: count each decision under its tenant and version, then commit. */
  def runStats(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, "cache-stats")
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = ujson.read(record.value())
        val tenant = event("tenant").str
        val version = event("version").num.toInt
        val stats = Config.statsKey(tenant, version)
        if (event("decision").str == "hit") {
          jedis.hincrBy(stats, "hits", 1)
          jedis.hincrBy(stats, "tokens_saved", event("tokens").num.toLong)
        } else {
          jedis.hincrBy(stats, "misses", 1)
          jedis.hincrBy(stats, "fill_ms", event("latency_ms").num.toLong)
        }
        jedis.sadd(Config.versionsKey(tenant), version.toString)
        consumer.commitSync() // after the counters: a crash before this point redelivers
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "pcache/config.h"  // config::kTopic, config::versions_key, config::redis() — provided

// The delivery report: a refused decision is logged.
class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "cache.result produce failed: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One event per cache decision.
void emit_decision(const std::string& tenant, int version, const std::string& prefix, const std::string& decision,
                   long long latency_ms, int tokens) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string value = nlohmann::json{{"tenant", tenant},
                                           {"version", version},
                                           {"prefix", prefix.substr(0, 512)},
                                           {"decision", decision},
                                           {"latency_ms", latency_ms},
                                           {"tokens", tokens}}
                                .dump();
  const std::string key = std::to_string(version);
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(value.data()), value.size(), key.c_str(), key.size(), 0, nullptr);
  producer->poll(0);
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "cache-stats", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  return consumer;
}

// The stats consumer: count each decision.
void run_stats() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) continue;
    const std::string tenant = event.value("tenant", "");
    const int version = event.value("version", 0);
    const std::string stats = "pc-stats:" + std::to_string(version);
    if (event.value("decision", "") == "hit") {
      config::redis().hincrby(stats, "hits", 1);
      config::redis().hincrby(stats, "tokens_saved", event.value("tokens", 0));
    } else {
      config::redis().hincrby(stats, "misses", 1);
      config::redis().hincrby(stats, "fill_ms", event.value("latency_ms", 0LL));
    }
    config::redis().sadd(config::versions_key(tenant), std::to_string(version));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "digest.h"         // sha256_hex(bytes) — provided
#include "pcache/config.h"  // config::kTopic, config::stats_key, config::versions_key, config::redis() — provided

// The delivery report: a refused decision is logged.
class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "cache.result produce failed: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One event per cache decision, keyed by tenant; the prefix leaves this process only as its digest.
void emit_decision(const std::string& tenant, int version, const std::string& prefix, const std::string& decision,
                   long long latency_ms, int tokens) {
  const std::string value = nlohmann::json{{"tenant", tenant},
                                           {"version", version},
                                           {"prefix_digest", sha256_hex(prefix)},
                                           {"decision", decision},
                                           {"latency_ms", latency_ms},
                                           {"tokens", tokens}}
                                .dump();
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(value.data()), value.size(), tenant.c_str(), tenant.size(), 0, nullptr);
  producer->poll(0);  // serve delivery reports already in; returns at once
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "cache-stats", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  return consumer;
}

// The stats consumer: count each decision under its tenant and version, then commit.
void run_stats() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) {
      consumer->commitSync(msg.get());  // malformed: skip it, do not replay it forever
      continue;
    }
    const std::string tenant = event.value("tenant", "");
    const int version = event.value("version", 0);
    const std::string stats = config::stats_key(tenant, version);
    if (event.value("decision", "") == "hit") {
      config::redis().hincrby(stats, "hits", 1);
      config::redis().hincrby(stats, "tokens_saved", event.value("tokens", 0));
    } else {
      config::redis().hincrby(stats, "misses", 1);
      config::redis().hincrby(stats, "fill_ms", event.value("latency_ms", 0LL));
    }
    config::redis().sadd(config::versions_key(tenant), std::to_string(version));
    consumer->commitSync(msg.get());  // after the counters: a crash before this point redelivers
  }
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

TOPIC = "cache.result"
PREFIX = "You are the support assistant for Acme Bank. Customer account 4111-2222: why was my card declined?"
DIGEST = hashlib.sha256(PREFIX.encode("utf-8")).hexdigest()


def _settle(m):
    """Serve the producer's delivery reports, as the service's loop would."""
    if hasattr(m, "producer"):
        m.producer.poll(0)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _seed(ctx, tenant, version, decision, latency_ms=0, tokens=0):
    event = {"tenant": tenant, "version": version, "prefix_digest": "d" * 64, "decision": decision, "latency_ms": latency_ms, "tokens": tokens}
    ctx.kafka.seed(TOPIC, key=tenant, value=json.dumps(event))


def _hash(ctx, key):
    return {field: int(value) for field, value in ctx.redis.hgetall(key).items()}


def _counted(ctx):
    """Decisions in the stats right now, whatever key they were counted under."""
    return sum(_hash(ctx, key).get("hits", 0) + _hash(ctx, key).get("misses", 0) for key in ctx.redis.keys("pc-stats:*"))


def check_decision_event(ctx):
    m = ctx.load("events")
    m.emit_decision("t1", 7, PREFIX, "miss", 840, 42)
    m.emit_decision("t1", 7, PREFIX, "hit", 3, 42)
    _settle(m)
    events = _events(ctx)
    assert len(events) == 2, f"two decisions produced {len(events)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    for event, (decision, latency) in zip(events, (("miss", 840), ("hit", 3))):
        for field, value in (("tenant", "t1"), ("version", 7), ("decision", decision), ("latency_ms", latency), ("tokens", 42)):
            assert event.get(field) == value, f"the {decision} event must carry {field}={value!r}, got {event}"


def check_tenant_key(ctx):
    m = ctx.load("events")
    m.emit_decision("t1", 7, PREFIX, "hit", 3, 42)
    m.emit_decision("t2", 7, PREFIX, "miss", 900, 42)
    m.emit_decision("t1", 8, PREFIX, "miss", 700, 40)
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three decisions produced {len(records)} records"
    keys = [r.key for r in records]
    assert keys == [b"t1", b"t2", b"t1"], f"records must be keyed by the tenant, got {keys}: keyed by version, one tenant's decisions scatter over partitions and every tenant on a version shares one"
    assert records[0].partition == records[2].partition, "one tenant's decisions must land on one partition so they are counted in order"


def check_digest_only(ctx):
    m = ctx.load("events")
    m.emit_decision("t1", 7, PREFIX, "miss", 840, 42)
    _settle(m)
    values = ctx.kafka.values(TOPIC)
    assert len(values) == 1, f"one decision produced {len(values)} records"
    event = json.loads(values[0])
    assert event.get("prefix_digest") == DIGEST, f"the event must carry prefix_digest, the SHA-256 hex of the prefix ({DIGEST[:12]}...), got {event}"
    assert b"Acme Bank" not in values[0] and b"4111" not in values[0], f"the event carries prompt text: {values[0][:120]!r}; the topic is retained and replicated, and the digest is enough to join on"
    assert "prefix" not in event, f"the event has a prefix field: {sorted(event)}"


def check_tenant_stats(ctx):
    _seed(ctx, "t1", 7, "hit", latency_ms=2, tokens=40)
    _seed(ctx, "t2", 7, "miss", latency_ms=900, tokens=40)
    _seed(ctx, "t1", 8, "miss", latency_ms=600, tokens=35)
    _seed(ctx, "t1", 7, "miss", latency_ms=800, tokens=40)
    m = ctx.load("events")
    ctx.drain(m.run_stats)
    keys = sorted(ctx.redis.keys("pc-stats:*"))
    t1v7 = _hash(ctx, "pc-stats:t1:7")
    assert t1v7 == {"hits": 1, "tokens_saved": 40, "misses": 1, "fill_ms": 800}, f"pc-stats:t1:7 must read hits 1, tokens_saved 40, misses 1, fill_ms 800, got {t1v7} (stats keys: {keys}): one tenant's counters must not absorb another's"
    t2v7 = _hash(ctx, "pc-stats:t2:7")
    assert t2v7 == {"misses": 1, "fill_ms": 900}, f"pc-stats:t2:7 must read misses 1, fill_ms 900, got {t2v7} (stats keys: {keys})"
    assert _hash(ctx, "pc-stats:t1:8") == {"misses": 1, "fill_ms": 600}, f"pc-stats:t1:8 must read misses 1, fill_ms 600, got {_hash(ctx, 'pc-stats:t1:8')}"
    assert ctx.redis.smembers("pc-versions:t1") == {"7", "8"}, f"pc-versions:t1 must hold 7 and 8, got {ctx.redis.smembers('pc-versions:t1')}"


def check_count_before_commit(ctx):
    for latency in (900, 700, 800):
        _seed(ctx, "t1", 7, "miss", latency_ms=latency, tokens=40)
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(_counted(ctx)))
    m = ctx.load("events")
    ctx.drain(m.run_stats)
    assert at_commit, "the consumer never committed an offset"
    assert at_commit[0] >= 1, f"at the first commit the stats held {at_commit[0]} decisions: the offset moved before the counters, so a crash in between loses the decision for good"
    assert _counted(ctx) == 3, f"three decisions were consumed and {_counted(ctx)} counted"
    assert ctx.kafka.lag("cache-stats", TOPIC) == 0, "every processed record must be committed"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'cache.result';
const PREFIX = 'You are the support assistant for Acme Bank. Customer account 4111-2222: why was my card declined?';
const DIGEST = createHash('sha256').update(PREFIX, 'utf8').digest('hex');

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const events = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));

function seed(ctx, tenant: string, version: number, decision: string, latencyMs = 0, tokens = 0) {
  const event = {tenant, version, prefix_digest: 'd'.repeat(64), decision, latency_ms: latencyMs, tokens};
  ctx.kafka.seed(TOPIC, {key: tenant, value: JSON.stringify(event)});
}

const hash = (ctx, key: string): Record<string, number> =>
  Object.fromEntries(Object.entries(ctx.redis.hgetall(key) as Record<string, string>).map(([k, v]) => [k, Number(v)]));

/** Decisions in the stats right now, whatever key they were counted under. */
const counted = (ctx): number =>
  (ctx.redis.keys('pc-stats:*') as string[]).reduce((sum, key) => sum + (hash(ctx, key).hits ?? 0) + (hash(ctx, key).misses ?? 0), 0);

export async function check_decision_event(ctx) {
  const m = ctx.load('events');
  await m.emitDecision('t1', 7, PREFIX, 'miss', 840, 42);
  await m.emitDecision('t1', 7, PREFIX, 'hit', 3, 42);
  await settle();
  const all = events(ctx);
  assert.equal(all.length, 2, \`two decisions produced \${all.length} records on \${TOPIC}\`);
  for (const [i, [decision, latency]] of [['miss', 840], ['hit', 3]].entries()) {
    for (const [field, value] of [['tenant', 't1'], ['version', 7], ['decision', decision], ['latency_ms', latency], ['tokens', 42]]) {
      assert.deepEqual(all[i][field], value, \`the \${decision} event must carry \${field}=\${JSON.stringify(value)}, got \${JSON.stringify(all[i])}\`);
    }
  }
}

export async function check_tenant_key(ctx) {
  const m = ctx.load('events');
  await m.emitDecision('t1', 7, PREFIX, 'hit', 3, 42);
  await m.emitDecision('t2', 7, PREFIX, 'miss', 900, 42);
  await m.emitDecision('t1', 8, PREFIX, 'miss', 700, 40);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three decisions produced \${records.length} records\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepEqual(keys, ['t1', 't2', 't1'], \`records must be keyed by the tenant, got \${JSON.stringify(keys)}: keyed by version, one tenant's decisions scatter over partitions and every tenant on a version shares one\`);
  assert.equal(records[0].partition, records[2].partition, "one tenant's decisions must land on one partition so they are counted in order");
}

export async function check_digest_only(ctx) {
  const m = ctx.load('events');
  await m.emitDecision('t1', 7, PREFIX, 'miss', 840, 42);
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one decision produced \${values.length} records\`);
  const event = JSON.parse(values[0]);
  assert.equal(event.prefix_digest, DIGEST, \`the event must carry prefix_digest, the SHA-256 hex of the prefix, got \${values[0]}\`);
  assert(!values[0].includes('Acme Bank') && !values[0].includes('4111'), \`the event carries prompt text: \${values[0].slice(0, 120)}; the topic is retained and replicated, and the digest is enough to join on\`);
  assert(!('prefix' in event), \`the event has a prefix field: \${Object.keys(event).sort().join(', ')}\`);
}

export async function check_tenant_stats(ctx) {
  seed(ctx, 't1', 7, 'hit', 2, 40);
  seed(ctx, 't2', 7, 'miss', 900, 40);
  seed(ctx, 't1', 8, 'miss', 600, 35);
  seed(ctx, 't1', 7, 'miss', 800, 40);
  const m = ctx.load('events');
  await ctx.drain(m.runStats());
  const keys = JSON.stringify(ctx.redis.keys('pc-stats:*').sort());
  assert.deepEqual(hash(ctx, 'pc-stats:t1:7'), {hits: 1, tokens_saved: 40, misses: 1, fill_ms: 800}, \`pc-stats:t1:7 must read hits 1, tokens_saved 40, misses 1, fill_ms 800, got \${JSON.stringify(hash(ctx, 'pc-stats:t1:7'))} (stats keys: \${keys}): one tenant's counters must not absorb another's\`);
  assert.deepEqual(hash(ctx, 'pc-stats:t2:7'), {misses: 1, fill_ms: 900}, \`pc-stats:t2:7 must read misses 1, fill_ms 900, got \${JSON.stringify(hash(ctx, 'pc-stats:t2:7'))} (stats keys: \${keys})\`);
  assert.deepEqual(hash(ctx, 'pc-stats:t1:8'), {misses: 1, fill_ms: 600}, \`pc-stats:t1:8 must read misses 1, fill_ms 600, got \${JSON.stringify(hash(ctx, 'pc-stats:t1:8'))}\`);
  assert.deepEqual(ctx.redis.smembers('pc-versions:t1').sort(), ['7', '8'], \`pc-versions:t1 must hold 7 and 8, got \${JSON.stringify(ctx.redis.smembers('pc-versions:t1'))}\`);
}

export async function check_count_before_commit(ctx) {
  for (const latency of [900, 700, 800]) seed(ctx, 't1', 7, 'miss', latency, 40);
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(counted(ctx)));
  const m = ctx.load('events');
  await ctx.drain(m.runStats());
  assert(atCommit.length > 0, 'the consumer never committed an offset');
  assert(atCommit[0] >= 1, \`at the first commit the stats held \${atCommit[0]} decisions: the offset moved before the counters, so a crash in between loses the decision for good\`);
  assert.equal(counted(ctx), 3, \`three decisions were consumed and \${counted(ctx)} counted\`);
  assert.equal(ctx.kafka.lag('cache-stats', TOPIC), 0, 'every processed record must be committed');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const (
	eventsTopic  = "cache.result"
	eventsPrefix = "You are the support assistant for Acme Bank. Customer account 4111-2222: why was my card declined?"
)

func eventsAll(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, r := range ctx.Kafka.Records(eventsTopic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal(r.Value, &e), "the event is JSON: %s", r.Value)
		out = append(out, e)
	}
	return out
}

func eventsSeed(ctx *harness.Ctx, tenant string, version int, decision string, latencyMs, tokens int) {
	value, _ := json.Marshal(map[string]any{"tenant": tenant, "version": version, "prefix_digest": strings.Repeat("d", 64), "decision": decision, "latency_ms": latencyMs, "tokens": tokens})
	ctx.Kafka.Seed(eventsTopic, tenant, string(value))
}

// eventsCounted is the number of decisions in the stats right now, whatever key they were counted under.
func eventsCounted(ctx *harness.Ctx) int {
	total := 0
	for _, key := range ctx.Redis.Keys("pc-stats:*") {
		h := ctx.Redis.HGetAll(key)
		hits, _ := strconv.Atoi(h["hits"])
		misses, _ := strconv.Atoi(h["misses"])
		total += hits + misses
	}
	return total
}

func CheckDecisionEvent(ctx *harness.Ctx) {
	bg := context.Background()
	emitDecision(bg, "t1", 7, eventsPrefix, "miss", 840, 42)
	emitDecision(bg, "t1", 7, eventsPrefix, "hit", 3, 42)
	ctx.Settle()
	all := eventsAll(ctx)
	ctx.Equal(len(all), 2, "two decisions must produce two records on %s; records", eventsTopic)
	for i, want := range []map[string]any{{"decision": "miss", "latency_ms": float64(840)}, {"decision": "hit", "latency_ms": float64(3)}} {
		want["tenant"], want["version"], want["tokens"] = "t1", float64(7), float64(42)
		for field, value := range want {
			ctx.Equal(all[i][field], value, "the %s event's %s (%v)", want["decision"], field, all[i])
		}
	}
}

func CheckTenantKey(ctx *harness.Ctx) {
	bg := context.Background()
	emitDecision(bg, "t1", 7, eventsPrefix, "hit", 3, 42)
	emitDecision(bg, "t2", 7, eventsPrefix, "miss", 900, 42)
	emitDecision(bg, "t1", 8, eventsPrefix, "miss", 700, 40)
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three decisions; records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"t1", "t2", "t1"}, "records must be keyed by the tenant (keyed by version, one tenant's decisions scatter over partitions and every tenant on a version shares one)")
	ctx.Assert(records[0].Partition == records[2].Partition, "one tenant's decisions must land on one partition so they are counted in order")
}

func CheckDigestOnly(ctx *harness.Ctx) {
	emitDecision(context.Background(), "t1", 7, eventsPrefix, "miss", 840, 42)
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one decision; records")
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the event is JSON: %s", values[0])
	sum := sha256.Sum256([]byte(eventsPrefix))
	ctx.Equal(event["prefix_digest"], hex.EncodeToString(sum[:]), "the event must carry prefix_digest, the SHA-256 hex of the prefix (%s)", values[0])
	ctx.Assert(!strings.Contains(values[0], "Acme Bank") && !strings.Contains(values[0], "4111"), "the event carries prompt text: %s; the topic is retained and replicated, and the digest is enough to join on", values[0])
	_, has := event["prefix"]
	ctx.Assert(!has, "the event has a prefix field: %s", values[0])
}

func CheckTenantStats(ctx *harness.Ctx) {
	eventsSeed(ctx, "t1", 7, "hit", 2, 40)
	eventsSeed(ctx, "t2", 7, "miss", 900, 40)
	eventsSeed(ctx, "t1", 8, "miss", 600, 35)
	eventsSeed(ctx, "t1", 7, "miss", 800, 40)
	ctx.Drain(func() { runStats(context.Background()) })
	keys := ctx.Redis.Keys("pc-stats:*")
	ctx.Equal(ctx.Redis.HGetAll("pc-stats:t1:7"), map[string]string{"hits": "1", "tokens_saved": "40", "misses": "1", "fill_ms": "800"}, "pc-stats:t1:7 (stats keys: %v): one tenant's counters must not absorb another's", keys)
	ctx.Equal(ctx.Redis.HGetAll("pc-stats:t2:7"), map[string]string{"misses": "1", "fill_ms": "900"}, "pc-stats:t2:7 (stats keys: %v)", keys)
	ctx.Equal(ctx.Redis.HGetAll("pc-stats:t1:8"), map[string]string{"misses": "1", "fill_ms": "600"}, "pc-stats:t1:8")
	ctx.Equal(ctx.Redis.SMembers("pc-versions:t1"), []string{"7", "8"}, "pc-versions:t1")
}

func CheckCountBeforeCommit(ctx *harness.Ctx) {
	for _, latency := range []int{900, 700, 800} {
		eventsSeed(ctx, "t1", 7, "miss", latency, 40)
	}
	var atCommit []int
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, eventsCounted(ctx)) })
	ctx.Drain(func() { runStats(context.Background()) })
	ctx.Assert(len(atCommit) > 0, "the consumer never committed an offset")
	ctx.Assert(atCommit[0] >= 1, "at the first commit the stats held %d decisions: the offset moved before the counters, so a crash in between loses the decision for good", atCommit[0])
	ctx.Equal(eventsCounted(ctx), 3, "three decisions were consumed; decisions counted")
	ctx.Equal(ctx.Kafka.Lag("cache-stats", eventsTopic), int64(0), "every processed record must be committed; lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cstdlib>
#include <string>
#include <vector>

#include "digest.h"

namespace {

const std::string kTopic = "cache.result";
const std::string kPrefix = "You are the support assistant for Acme Bank. Customer account 4111-2222: why was my card declined?";

std::vector<nlohmann::json> eventsAll(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& r : ctx.Kafka.Records(kTopic)) out.push_back(nlohmann::json::parse(r.Value.value_or("null"), nullptr, false));
  return out;
}

void eventsSeed(harness::Ctx& ctx, const std::string& tenant, int version, const std::string& decision, int latency_ms, int tokens) {
  const nlohmann::json event = {{"tenant", tenant}, {"version", version}, {"prefix_digest", std::string(64, 'd')}, {"decision", decision}, {"latency_ms", latency_ms}, {"tokens", tokens}};
  ctx.Kafka.Seed(kTopic, tenant, event.dump());
}

// The decisions in the stats right now, whatever key they were counted under.
long long eventsCounted(harness::Ctx& ctx) {
  long long total = 0;
  for (const auto& key : ctx.Redis.Keys("pc-stats:*")) {
    const auto h = ctx.Redis.HGetAll(key);
    for (const char* field : {"hits", "misses"}) {
      const auto it = h.find(field);
      if (it != h.end()) total += std::strtoll(it->second.c_str(), nullptr, 10);
    }
  }
  return total;
}

}  // namespace

void CheckDecisionEvent(harness::Ctx& ctx) {
  emit_decision("t1", 7, kPrefix, "miss", 840, 42);
  emit_decision("t1", 7, kPrefix, "hit", 3, 42);
  ctx.Settle();
  producer->poll(0);
  const auto all = eventsAll(ctx);
  ctx.Equal(all.size(), 2, "two decisions must produce two records on %s; records", kTopic);
  const nlohmann::json miss = {{"tenant", "t1"}, {"version", 7}, {"decision", "miss"}, {"latency_ms", 840}, {"tokens", 42}};
  const nlohmann::json hit = {{"tenant", "t1"}, {"version", 7}, {"decision", "hit"}, {"latency_ms", 3}, {"tokens", 42}};
  for (const auto& [i, want] : std::vector<std::pair<size_t, nlohmann::json>>{{0, miss}, {1, hit}}) {
    for (const auto& [field, value] : want.items()) {
      ctx.Assert(all[i].is_object() && all[i].contains(field) && all[i][field] == value, "the %s event must carry %s=%s, got %s", want["decision"].get<std::string>(), field, value.dump(), all[i].dump());
    }
  }
}

void CheckTenantKey(harness::Ctx& ctx) {
  emit_decision("t1", 7, kPrefix, "hit", 3, 42);
  emit_decision("t2", 7, kPrefix, "miss", 900, 42);
  emit_decision("t1", 8, kPrefix, "miss", 700, 40);
  ctx.Settle();
  producer->poll(0);
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three decisions; records");
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"t1", "t2", "t1"}, "records must be keyed by the tenant (keyed by version, one tenant's decisions scatter over partitions and every tenant on a version shares one)");
  ctx.Assert(records[0].Partition == records[2].Partition, "one tenant's decisions must land on one partition so they are counted in order");
}

void CheckDigestOnly(harness::Ctx& ctx) {
  emit_decision("t1", 7, kPrefix, "miss", 840, 42);
  ctx.Settle();
  producer->poll(0);
  const auto values = ctx.Kafka.Values(kTopic);
  ctx.Equal(values.size(), 1, "one decision; records");
  const auto event = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(event.is_object() && event.value("prefix_digest", "") == sha256_hex(kPrefix), "the event must carry prefix_digest, the SHA-256 hex of the prefix, got %s", values[0]);
  ctx.Assert(values[0].find("Acme Bank") == std::string::npos && values[0].find("4111") == std::string::npos, "the event carries prompt text: %s; the topic is retained and replicated, and the digest is enough to join on", values[0]);
  ctx.Assert(!event.contains("prefix"), "the event has a prefix field: %s", values[0]);
}

void CheckTenantStats(harness::Ctx& ctx) {
  eventsSeed(ctx, "t1", 7, "hit", 2, 40);
  eventsSeed(ctx, "t2", 7, "miss", 900, 40);
  eventsSeed(ctx, "t1", 8, "miss", 600, 35);
  eventsSeed(ctx, "t1", 7, "miss", 800, 40);
  ctx.Drain([] { run_stats(); });
  const auto keys = ctx.Redis.Keys("pc-stats:*");
  ctx.Equal(ctx.Redis.HGetAll("pc-stats:t1:7"), std::map<std::string, std::string>{{"hits", "1"}, {"tokens_saved", "40"}, {"misses", "1"}, {"fill_ms", "800"}}, "pc-stats:t1:7 (stats keys: %v): one tenant's counters must not absorb another's", keys);
  ctx.Equal(ctx.Redis.HGetAll("pc-stats:t2:7"), std::map<std::string, std::string>{{"misses", "1"}, {"fill_ms", "900"}}, "pc-stats:t2:7 (stats keys: %v)", keys);
  ctx.Equal(ctx.Redis.HGetAll("pc-stats:t1:8"), std::map<std::string, std::string>{{"misses", "1"}, {"fill_ms", "600"}}, "pc-stats:t1:8");
  ctx.Equal(ctx.Redis.SMembers("pc-versions:t1"), {"7", "8"}, "pc-versions:t1");
}

void CheckCountBeforeCommit(harness::Ctx& ctx) {
  for (int latency : {900, 700, 800}) eventsSeed(ctx, "t1", 7, "miss", latency, 40);
  std::vector<long long> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(eventsCounted(ctx)); });
  ctx.Drain([] { run_stats(); });
  ctx.Assert(!atCommit.empty(), "the consumer never committed an offset");
  ctx.Assert(atCommit[0] >= 1, "at the first commit the stats held %d decisions: the offset moved before the counters, so a crash in between loses the decision for good", atCommit[0]);
  ctx.Equal(eventsCounted(ctx), 3, "three decisions were consumed; decisions counted");
  ctx.Equal(ctx.Kafka.Lag("cache-stats", kTopic), 0, "every processed record must be committed; lag");
}
`,
  },
  debrief: `The key is an ordering and isolation decision: one tenant's decisions on one partition are counted in order, and no tenant shares a partition's backlog by accident of version. The digest is enough to join a decision to its cache entry, so the prefix has no reason to be on a retained, replicated topic, where it would outlive every deletion request. Counting before committing makes the consumer at-least-once: a crash between the two replays a decision rather than losing it, and a replay inflates one count where a loss hides a window. Production consumers make the replay harmless too, by storing the last applied offset beside the counters in one transaction, and they validate events against a registered schema before counting them.`,
};
