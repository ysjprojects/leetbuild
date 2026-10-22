import type {Step} from '@/lib/types';

export const cacheEventsStep: Step = {
  id: 'events',
  title: 'Cache events keyed by tenant with digests only',
  concept: 'kafka',
  file: 'events',
  focus: ['cache', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: every decision publishes a
\`cache.result\` event and the topic looks healthy in the console. Its three flaws are the three things
analysts get wrong about a cache topic — the partition key, the payload, and the moment the offset is
committed. Review it, fix it, and prove the fix.

Publish one event per decision (hit, miss) and maintain the ratio counter from the same events.

- **The record key is the tenant.** The key decides the partition, so one tenant’s events keep their
  order on one partition and one tenant’s traffic cannot land behind another’s. The draft keys by
  prompt version, which scatters a tenant across every partition — the ordering a hit-ratio series
  needs is exactly what it destroys — and puts every tenant that shares a version in one partition.
- **The payload carries a digest, never prompt text.** The event is
  \`{"prefix_digest", "version", "decision", "latency_ms"}\`: enough to aggregate hits and misses per
  tenant and prompt version, and enough for latency percentiles. The draft ships \`"prefix":
  prefix[:512]\` so analysts can "eyeball traffic" — a 512-byte slice of customer prompt text in a
  retained, replicated topic, which is the leak the cache was supposed to reduce.
- **\`cache.result\` is the topic, and every decision produces exactly one record** — a hit and a miss
  both matter, because a ratio computed from hits alone is not a ratio. Configure the producer durably:
  \`acks=all\` and the idempotent producer, so a broker failover cannot drop a decision and the
  producer’s own retries cannot duplicate one.
- **The consumer updates the hit-ratio counter before it commits the offset.** \`HINCRBY
  pc:access:{tenant}:{version} hits|misses 1\`, *then* \`commit\`. The draft commits first, so a crash
  between the two loses the counter update while the offset says the event was processed — the ratio
  drifts downward for the rest of the version’s life.
- **Never put the prompt, the completion or a sample of either in the event.** The topic is the one
  place where "we only keep metadata" has to be literally true.

**Failure mode the checks target.** The draft treats the cache topic as a log of everything it knows
rather than a stream of decisions: a version key that destroys per-tenant ordering, a payload that
carries the prompt, and an offset commit that runs ahead of the state it is supposed to describe.`,
  sequence: {
    participants: ['Prompt Cache', 'cache.result', 'Stats consumer', 'Redis'],
    messages: [
      {
        from: 'Prompt Cache',
        to: 'cache.result',
        label: 'produce · key = tenant · {prefix_digest, version, decision, latency_ms}',
        kind: 'async',
      },
      {
        from: 'cache.result',
        to: 'Stats consumer',
        label: 'consume — one partition per tenant, in order',
        kind: 'async',
      },
      {from: 'Stats consumer', to: 'Redis', label: 'HINCRBY pc:access:{tenant}:{version} hits 1', kind: 'sync'},
      {from: 'Redis', to: 'Stats consumer', label: 'counter updated', kind: 'reply'},
      {from: 'Stats consumer', to: 'cache.result', label: 'commit the offset — only now', kind: 'async'},
    ],
  },
  hints: [
    'The key is the ordering contract, and the ordering you want is per tenant. `key = tenant` puts every event for one tenant on one partition in produce order — which is what a hit-ratio series and a debugging session both need. Keying by prompt version is a decision to shuffle one tenant’s traffic through every partition.',
    'A digest is enough for everything an analyst legitimately does with this topic: aggregate per tenant and version, compute ratio, plot latency. `prefix[:512]` buys "eyeballing" and pays with prompt text in a retained topic; if a reviewer really needs the text they can ask the caller who owns it.',
    'Commit is a statement about work already done, so do the work first: `HINCRBY` the counter, then `commit`. If the process dies in between, the event is replayed and the counter is incremented twice rather than lost — which is why the counter update should be idempotent-friendly (count from the event, not a blind `INCR`) when you get to production.',
  ],
  checks: [
    {
      id: 'topic',
      title: 'Publishes one decision event to cache.result',
      detail:
        'The topic is `cache.result` and each decision produces one record. The draft publishes to the right topic, so this is the one shape it gets right — the checks below are the ones it fails.',
      match: {
        python: {all: [/TOPIC = "cache\.result"/, /producer\.produce\(/]},
        typescript: {all: [/TOPIC = 'cache\.result'/, /producer\.send\(/]},
        go: {all: [/cache\.result/, /writer\.WriteMessages\(/]},
        scala: {all: [/Topic = "cache\.result"/, /producer\.send\(/]},
        cpp: {all: [/kTopic = "cache\.result"/, /producer->produce\(/]},
      },
    },
    {
      id: 'tenant-key',
      title: 'Keys the record by tenant, not by prompt version',
      detail:
        'The record key is the authenticated tenant, so one tenant’s events stay on one partition in order. The draft keys by prompt version, which scatters one tenant’s traffic across partitions and mixes unrelated tenants in one.',
      match: {
        python: {all: [/key=tenant/], none: [/key=version/, /key=str\(version\)/]},
        typescript: {all: [/key:\s*tenant\b/], none: [/key:\s*String\(version\)/, /key:\s*version\b/]},
        go: {all: [/Key:\s*\[\]byte\(tenant\)/], none: [/Key:\s*\[\]byte\(strconv/]},
        scala: {
          all: [/ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*tenant/],
          none: [/ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*version/],
        },
        cpp: {all: [/const std::string& key = tenant/], none: [/const std::string key = std::to_string\(version\)/]},
      },
    },
    {
      id: 'digest-fields',
      title: 'The payload carries digest, version, decision and latency',
      detail:
        'The event is `{prefix_digest, version, decision, latency_ms}` — nothing more. The draft emits `prefix` (a 512-byte sample), no digest, and no latency, so the topic cannot answer per-tenant latency questions and does carry customer text.',
      match: {
        python: {all: [/"prefix_digest"/, /"version"/, /"decision"/, /"latency_ms"/]},
        typescript: {all: [/prefix_digest/, /version/, /decision/, /latency_ms/]},
        go: {all: [/"prefix_digest"/, /"version"/, /"decision"/, /"latency_ms"/]},
        scala: {all: [/prefix_digest/, /version/, /decision/, /latency_ms/]},
        cpp: {all: [/"prefix_digest"/, /"version"/, /"decision"/, /"latency_ms"/]},
      },
    },
    {
      id: 'no-prompt-fragment',
      title: 'No prompt text or prefix sample in the event',
      detail:
        'The payload contains a digest and never the prefix itself: no `"prefix"`, `"sample"` or `"text"` field and no `[:512]` slice. The draft ships a 512-byte sample of customer prompt text into a retained, replicated topic.',
      match: {
        python: {all: [/digest/], none: [/["'](?:prefix|sample|text)["']\s*:/, /prefix\[:\s*512\]/]},
        typescript: {
          all: [/digest/],
          none: [/["'](?:prefix|sample|text)["']\s*:/, /prefix\.slice\(0,\s*512\)/],
        },
        go: {all: [/digest/], none: [/"(?:prefix|sample|text)"\s*:/, /prefix\[:\s*512\]/]},
        scala: {all: [/digest/], none: [/"(?:prefix|sample|text)"\s*:/, /prefix\.take\(512\)/]},
        cpp: {all: [/digest/], none: [/"(?:prefix|sample|text)"\s*:/, /prefix\.substr\(0,\s*512\)/]},
      },
    },
    {
      id: 'counter-before-commit',
      title: 'Updates the ratio counter before committing the offset',
      detail:
        'The consumer runs `HINCRBY pc:access:{tenant}:{version} …` **before** `commit`/`commitSync`/`CommitMessages`. The draft commits first, so a crash between the two drops the counter update while the offset claims the event was processed.',
      match: {
        python: {order: [/\bhincrby\(/, /\.commit\(/]},
        typescript: {order: [/\.incrby\(/, /commitOffsets\(/]},
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

from confluent_kafka import Producer

log = logging.getLogger("prompt-cache")
producer = Producer({"bootstrap.servers": "kafka:9092"})
TOPIC = "cache.result"


def publish_decision(tenant: str, version: int, prefix: str, decision: str, latency_ms: int) -> None:
    # TODO: the draft keys by prompt version, so one tenant's events scatter across partitions; it
    # ships a 512-byte prefix sample so analysts can eyeball traffic; and its consumer commits the
    # offset before it updates the hit-ratio counter.
    producer.produce(
        TOPIC,
        key=str(version),
        value=json.dumps(
            {"prefix": prefix[:512], "version": version, "decision": decision, "latency_ms": latency_ms}
        ),
    )
    producer.flush()


def consume(consumer, r) -> None:
    for message in consumer:
        event = json.loads(message.value())
        consumer.commit(message)
        r.hincrby(f"pc:access:{event['tenant']}:{event['version']}", f"{event['decision']}s", 1)
`,
      solution: `import json
import logging

from confluent_kafka import Producer

log = logging.getLogger("prompt-cache")
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})
TOPIC = "cache.result"


def publish_decision(tenant: str, prefix_digest: str, version: int, decision: str, latency_ms: int) -> None:
    """One event per decision: the tenant is the key and only a digest of the prefix travels."""
    producer.produce(
        TOPIC,
        key=tenant,
        value=json.dumps(
            {
                "prefix_digest": prefix_digest,
                "version": version,
                "decision": decision,
                "latency_ms": latency_ms,
            }
        ),
    )
    producer.flush(10000)


def consume(consumer, r) -> None:
    """Update the ratio counter first, commit second: a replay must not lose the update."""
    for message in consumer:
        event = json.loads(message.value())
        counter = f"pc:access:{message.key().decode()}:{event['version']}"
        r.hincrby(counter, f"{event['decision']}s", 1)
        consumer.commit(message)
`,
    },
    typescript: {
      starter: `/** A model-generated cache-event publisher that ships a 512-byte prefix sample. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'prompt-cache', brokers: ['kafka:9092']});
const producer = kafka.producer();
const consumer = kafka.consumer({groupId: 'cache-stats'});

export const TOPIC = 'cache.result';

export async function publishDecision(
  tenant: string,
  version: number,
  prefix: string,
  decision: string,
  latency_ms: number,
): Promise<void> {
  // TODO: the draft keys by prompt version, so one tenant's events scatter across partitions; it
  // ships a 512-byte prefix sample so analysts can eyeball traffic; and its consumer commits the
  // offset before it updates the hit-ratio counter.
  await producer.connect();
  await producer.send({
    topic: TOPIC,
    messages: [
      {key: String(version), value: JSON.stringify({prefix: prefix.slice(0, 512), version, decision, latency_ms})},
    ],
  });
}

export async function consume(store: Redis): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    eachMessage: async ({message}) => {
      await consumer.commitOffsets([
        {topic: TOPIC, partition: message.partition, offset: String(Number(message.offset) + 1)},
      ]);
      const event = JSON.parse(String(message.value)) as CacheEvent;
      await store.incrby(\`pc:access:\${String(message.key)}:\${event.version}\`, 1);
    },
  });
}
`,
      solution: `/** Cache decision events: per-tenant ordering, digests only, commit after the counter. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'prompt-cache', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, acks: -1});
const consumer = kafka.consumer({groupId: 'cache-stats'});

export const TOPIC = 'cache.result';

interface DecisionEvent {
  prefix_digest: string;
  version: number;
  decision: 'hit' | 'miss';
  latency_ms: number;
}

/** The tenant is the key: one tenant's events keep their order on one partition. */
export async function publishDecision(tenant: string, event: DecisionEvent): Promise<void> {
  await producer.connect();
  await producer.send({
    topic: TOPIC,
    messages: [{key: tenant, value: JSON.stringify(event)}],
  });
}

export async function consume(store: Redis): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    eachMessage: async ({message}) => {
      const event = JSON.parse(String(message.value)) as DecisionEvent;
      const counter = \`pc:access:\${String(message.key)}:\${event.version}\`;
      await store.incrby(counter, 1);
      // The offset is a statement about work already done: count first, then commit.
      await consumer.commitOffsets([
        {topic: TOPIC, partition: message.partition, offset: String(Number(message.offset) + 1)},
      ]);
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
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const topic = "cache.result"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092")}

// TODO: the draft keys by prompt version, so one tenant's events scatter across partitions; it ships
// a 512-byte prefix sample so analysts can eyeball traffic; and its consumer commits the offset
// before it updates the hit-ratio counter.
func publishDecision(ctx context.Context, tenant string, version int, prefix, decision string, latencyMs int) error {
	payload, err := json.Marshal(map[string]any{
		"prefix":     prefix[:512],
		"version":    version,
		"decision":   decision,
		"latency_ms": latencyMs,
	})
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{
		Topic: topic,
		Key:   []byte(strconv.Itoa(version)),
		Value: payload,
	})
}

func consume(ctx context.Context, reader *kafka.Reader, r *redis.Client) error {
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, message); err != nil {
			return err
		}
		var event map[string]any
		if err := json.Unmarshal(message.Value, &event); err != nil {
			return err
		}
		counter := fmt.Sprintf("pc:access:%s:%v", string(message.Key), event["version"])
		r.HIncrBy(ctx, counter, fmt.Sprintf("%vs", event["decision"]), 1)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const topic = "cache.result"

// RequiredAcks all: an acknowledged decision survives a leader failover. (kafka-go has no
// idempotent mode; the consumer side is what makes replays safe.)
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

type decisionEvent struct {
	PrefixDigest string \`json:"prefix_digest"\`
	Version      int    \`json:"version"\`
	Decision     string \`json:"decision"\`
	LatencyMs    int    \`json:"latency_ms"\`
}

// publishDecision keys by tenant: one tenant's events keep their order on one partition.
func publishDecision(ctx context.Context, tenant string, event decisionEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Topic: topic, Key: []byte(tenant), Value: payload})
}

func consume(ctx context.Context, reader *kafka.Reader, r *redis.Client) error {
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event decisionEvent
		if err := json.Unmarshal(message.Value, &event); err != nil {
			return err
		}
		counter := fmt.Sprintf("pc:access:%s:%d", string(message.Key), event.Version)
		r.HIncrBy(ctx, counter, event.Decision+"s", 1)
		// The offset is a statement about work already done: count first, then commit.
		if err := reader.CommitMessages(ctx, message); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object CacheEvents {
  val Topic = "cache.result"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  // TODO: the draft keys by prompt version, so one tenant's events scatter across partitions; it
  // ships a 512-byte prefix sample so analysts can eyeball traffic; and its consumer commits the
  // offset before it updates the hit-ratio counter.
  def publishDecision(tenant: String, version: Int, prefix: String, decision: String, latencyMs: Int): Unit = {
    val payload = s"""{"prefix":"\${prefix.take(512)}","version":$version,"decision":"$decision","latency_ms":$latencyMs}"""
    producer.send(new ProducerRecord[String, String](Topic, version.toString, payload))
  }

  def consume(consumer: KafkaConsumer[String, String], jedis: Jedis): Unit = {
    val records = consumer.poll(java.time.Duration.ofMillis(200))
    records.forEach { record =>
      consumer.commitSync()
      val event = ujson.read(record.value())
      jedis.hincrBy(s"pc:access:\${record.key()}:\${event("version").num}", s"\${event("decision").str}s", 1L)
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object CacheEvents {
  val Topic = "cache.result"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  val producer = new KafkaProducer[String, String](props)

  /** The tenant is the key: one tenant's events keep their order on one partition. */
  def publishDecision(tenant: String, prefixDigest: String, version: Int, decision: String, latencyMs: Int): Unit = {
    val payload =
      s"""{"prefix_digest":"$prefixDigest","version":$version,"decision":"$decision","latency_ms":$latencyMs}"""
    producer.send(new ProducerRecord[String, String](Topic, tenant, payload))
  }

  def consume(consumer: KafkaConsumer[String, String], jedis: Jedis): Unit = {
    val records = consumer.poll(java.time.Duration.ofMillis(200))
    records.forEach { record =>
      val event = ujson.read(record.value())
      val counter = s"pc:access:\${record.key()}:\${event("version").num}"
      jedis.hincrBy(counter, s"\${event("decision").str}s", 1L)
      // The offset is a statement about work already done: count first, then commit.
      consumer.commitSync()
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

const std::string kTopic = "cache.result";

// TODO: the draft keys by prompt version, so one tenant's events scatter across partitions; it ships
// a 512-byte prefix sample so analysts can eyeball traffic; and its consumer commits the offset
// before it updates the hit-ratio counter.
void publish_decision(RdKafka::Producer* producer, const std::string& tenant, int version, const std::string& prefix,
                      const std::string& decision, int latency_ms) {
  nlohmann::json event = {
      {"prefix", prefix.substr(0, 512)},
      {"version", version},
      {"decision", decision},
      {"latency_ms", latency_ms},
  };
  const std::string payload = event.dump();
  const std::string key = std::to_string(version);
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), key.c_str(), key.size(), 0, nullptr);
}

void consume(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& cache) {
  std::unique_ptr<RdKafka::Message> message(consumer->consume(1000));
  if (message->err() != RdKafka::ERR_NO_ERROR) {
    return;
  }
  consumer->commitSync(message.get());
  const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(message->payload()), message->len()));
  const std::string counter = "pc:access:" + *message->key() + ":" + std::to_string(event["version"].get<int>());
  cache.hincrby(counter, event["decision"].get<std::string>() + "s", 1);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

const std::string kTopic = "cache.result";

// publish_decision keys the record by tenant: one tenant's events keep their order on one partition.
void publish_decision(RdKafka::Producer* producer, const std::string& tenant, const std::string& prefix_digest,
                      int version, const std::string& decision, int latency_ms) {
  nlohmann::json event = {
      {"prefix_digest", prefix_digest},
      {"version", version},
      {"decision", decision},
      {"latency_ms", latency_ms},
  };
  const std::string payload = event.dump();
  const std::string& key = tenant;
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), key.c_str(), key.size(), 0, nullptr);
  producer->flush(10000);
}

void consume(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& cache) {
  std::unique_ptr<RdKafka::Message> message(consumer->consume(1000));
  if (message->err() != RdKafka::ERR_NO_ERROR) {
    return;
  }
  const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(message->payload()), message->len()));
  const std::string counter = "pc:access:" + *message->key() + ":" + std::to_string(event["version"].get<int>());
  cache.hincrby(counter, event["decision"].get<std::string>() + "s", 1);
  // The offset is a statement about work already done: count first, then commit.
  consumer->commitSync(message.get());
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can design a cache’s event stream as a stream of *decisions* rather than a copy of traffic. All three defects come from treating the topic as an observability dump: the draft keys for its own convenience (version) instead of for the reader’s ordering needs (tenant), it ships the payload "in case someone wants to look", and it commits the offset as though the commit were bookkeeping rather than a claim about state. The correct shape is deliberately thin — tenant key, digest, version, decision, latency — because a cache that leaks completions through its logs, its metrics or its analytics topic has not reduced the leak at all; it has moved it somewhere with a longer retention period. The commit ordering is the same principle applied to the counter: the offset must never be able to say "processed" about a counter update that did not happen.`,
};
