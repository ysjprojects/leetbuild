import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Search events keyed by tenant with the query hashed',
  concept: 'kafka',
  file: 'events',
  focus: ['search', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it builds a payload, produces
it to \`search.event\`, and a consumer moves a counter. It compiles, the analytics demo shows data,
and it hides four production flaws. Review it like the service owner, fix it, and prove the fix with
the checks below.

Implement the search telemetry producer and consumer for \`search.event\`.

- The message **key is the tenant** (\`key=tenant\` / \`key: tenant\` / \`Key: []byte(tenant)\` /
  \`ProducerRecord("search.event", tenant, …)\`). The draft keys by the query hash, so one tenant's
  events scatter across partitions and their order is no longer guaranteed.
- The payload carries a **query hash**, the **result count** and the **latency**, never the raw query
  text — the draft copies the shopper's words into a retained, replicated topic "for relevance
  tuning".
- The producer is **idempotent with \`acks=all\`** (\`enable.idempotence\` + \`acks\`, KafkaJS's
  \`idempotent: true\`, or \`RequiredAcks: kafka.RequireAll\` with a hash balancer), so a produce retry
  cannot duplicate the event.
- The consumer updates the Redis counters (\`INCR\` / \`HINCRBY\`) **and only then** commits the
  offset. Commit first and one crash loses the counter update forever, because the offset already
  moved past the unprocessed record.

**Failure mode the checks target.** Search telemetry is the classic place where convenience beats
contracts: the raw query is the most useful field for relevance work and the most dangerous one to
retain; the query hash is the natural key if you are thinking about the query instead of the tenant,
and it destroys per-tenant order; and a commit that happens before the counter update looks faster
and is exactly-once only until the first crash. The fix keeps the tenant as the partition key, ships
the query as a hash, configures the producer instead of hoping, and processes before it commits.`,
  sequence: {
    participants: ['Search API', 'search.event', 'Telemetry consumer', 'Redis'],
    messages: [
      {
        from: 'Search API',
        to: 'search.event',
        label: 'produce · key = tenant · {query_hash, result_count, latency_ms}',
        kind: 'sync',
      },
      {from: 'search.event', to: 'Search API', label: 'ack / broker error', kind: 'reply'},
      {from: 'search.event', to: 'Telemetry consumer', label: 'consume · group search-telemetry', kind: 'async'},
      {from: 'Telemetry consumer', to: 'Redis', label: 'INCR search:count:{tenant}', kind: 'sync'},
      {from: 'Redis', to: 'Telemetry consumer', label: 'new counter value', kind: 'reply'},
      {from: 'Telemetry consumer', to: 'search.event', label: 'commit offset after the counters', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant, query travels as a hash',
      detail:
        "The message key is the tenant, so one tenant's events share a partition and keep their order, and the event carries the query hash. The draft keys by the query hash, which interleaves tenant streams.",
      match: {
        python: {all: [/key=[^,\n]*tenant/, /query_hash/]},
        typescript: {all: [/key:\s*tenant\b/, /queryHash/]},
        go: {all: [/Key:\s*\[\]byte\(tenant\)/, /query_hash/]},
        scala: {all: [/ProducerRecord\("search\.event",\s*tenant/, /queryHash/]},
        cpp: {all: [/produce\([^;\n]*tenant/, /query_hash/]},
      },
    },
    {
      id: 'no-raw-query',
      title: 'No raw query in the event payload',
      detail:
        'The event and the log lines carry a query hash, never `query` text. The draft publishes the raw query into a topic that is retained and replicated — a leak with a long tail.',
      match: {
        python: {none: [/raw_query/, /["']?query["']?\s*:/]},
        typescript: {none: [/raw_query/, /["']?query["']?\s*:/]},
        go: {none: [/raw_query/, /["']?query["']?\s*:/]},
        scala: {none: [/raw_query/, /["']?query["']?\s*:/]},
        cpp: {none: [/raw_query/, /["']?query["']?\s*:/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Updates the counters before committing the offset',
      detail:
        'The consumer increments the Redis counters and only then commits the offset. Committing first means a crash between the two loses the counter update forever, because the offset already moved past the record.',
      match: {
        python: {order: [/incr\(/, /\.commit\(/]},
        typescript: {order: [/\.incr\(/, /commitOffsets\(/]},
        go: {order: [/\.Incr\(/, /CommitMessages\(/]},
        scala: {order: [/\.incr\(/, /commitSync\(/]},
        cpp: {order: [/\.incr\(/, /commitSync\(/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all`, so a retried produce cannot duplicate the record. The draft sets neither and relies on the broker defaults.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'latency-and-count',
      title: 'Carries the result count and the latency',
      detail:
        'The payload includes the number of results and the query latency, which is what the telemetry is for. The draft sends the query text and a count, so the p99 cannot be reconstructed.',
      match: {
        python: {all: [/result_count/, /latency_ms/]},
        typescript: {all: [/resultCount/, /latencyMs/]},
        go: {all: [/ResultCount/, /LatencyMs/]},
        scala: {all: [/resultCount/, /latencyMs/]},
        cpp: {all: [/result_count/, /latency_ms/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from pydantic import BaseModel

logger = logging.getLogger("search-events")
producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class SearchEvent(BaseModel):
    tenant: str
    query: str
    results: int


def publish_search(event: SearchEvent) -> None:
    # TODO: this draft keys by the query hash so tenant streams interleave, publishes the raw query
    # for relevance tuning, and never configures idempotence. Review all three.
    key = hashlib.sha256(event.query.encode("utf-8")).hexdigest()
    payload = {"query": event.query, "results": event.results}
    logger.info("search tenant=%s query=%r", event.tenant, event.query)
    producer.produce("search.event", value=json.dumps(payload).encode("utf-8"), key=key)


def consume_search_events() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "search-telemetry"})
    consumer.subscribe(["search.event"])
    while True:
        message = consumer.poll(1.0)
        if message is None:
            continue
        event = json.loads(message.value())
        consumer.commit(message)
        r.incr(f"search:count:{event['tenant']}")
`,
      solution: `import hashlib
import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from pydantic import BaseModel

logger = logging.getLogger("search-events")
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class SearchEvent(BaseModel):
    tenant: str
    text: str
    result_count: int
    latency_ms: int
    partial: bool = False


def query_hash(text: str) -> str:
    return hashlib.sha256(" ".join(text.strip().lower().split()).encode("utf-8")).hexdigest()


def publish_search(event: SearchEvent) -> None:
    tenant = event.tenant
    payload = {
        "tenant": tenant,
        "query_hash": query_hash(event.text),
        "result_count": event.result_count,
        "latency_ms": event.latency_ms,
        "partial": event.partial,
    }
    logger.info("search_event tenant=%s partial=%s", tenant, event.partial)
    producer.produce("search.event", value=json.dumps(payload).encode("utf-8"), key=tenant)
    producer.poll(0)


def consume_search_events() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "search-telemetry"})
    consumer.subscribe(["search.event"])
    while True:
        message = consumer.poll(1.0)
        if message is None:
            continue
        event = json.loads(message.value())
        r.incr(f"search:count:{event['tenant']}")
        r.incr(f"search:results:{event['tenant']}", event["result_count"])
        consumer.commit(message)
`,
    },
    typescript: {
      starter: `/** search.event producer: a model-generated draft that keys by the query hash. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'search', brokers: ['kafka:9092']});
const producer = kafka.producer();
const redis = new Redis({host: 'redis', port: 6379});

interface SearchEvent {
  tenant: string;
  query: string;
  results: number;
}

export async function publishSearch(event: SearchEvent): Promise<void> {
  // TODO: this draft keys by the query hash so tenant streams interleave, publishes the raw query
  // for relevance tuning, and never configures idempotence. Review all three.
  const key = createHash('sha256').update(event.query).digest('hex');
  const payload = {query: event.query, results: event.results};
  await producer.send({topic: 'search.event', messages: [{key, value: JSON.stringify(payload)}]});
}

export async function consumeSearchEvents(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'search-telemetry'});
  await consumer.subscribe({topic: 'search.event'});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as SearchEvent;
      await consumer.commitOffsets([{topic, partition, offset: (Number(message.offset) + 1).toString()}]);
      await redis.incr(\`search:count:\${event.tenant}\`);
    },
  });
}
`,
      solution: `/** search.event producer: tenant-keyed, query hashed, and honest about counters. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'search', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
const redis = new Redis({host: 'redis', port: 6379});

interface SearchEvent {
  tenant: string;
  text: string;
  resultCount: number;
  latencyMs: number;
  partial: boolean;
}

function queryHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

export async function publishSearch(event: SearchEvent): Promise<void> {
  const tenant = event.tenant;
  const payload = {
    tenant,
    query_hash: queryHash(event.text),
    result_count: event.resultCount,
    latency_ms: event.latencyMs,
    partial: event.partial,
  };
  await producer.send({
    topic: 'search.event',
    acks: -1,
    messages: [{key: tenant, value: JSON.stringify(payload)}],
  });
}

export async function consumeSearchEvents(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'search-telemetry'});
  await consumer.subscribe({topic: 'search.event'});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {tenant: string; result_count: number};
      await redis.incr(\`search:count:\${event.tenant}\`);
      await redis.incr(\`search:results:\${event.tenant}\`, event.result_count);
      await consumer.commitOffsets([{topic, partition, offset: (Number(message.offset) + 1).toString()}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "search.event"}
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type SearchEvent struct {
	Tenant  string
	Query   string
	Results int
}

func publishSearch(ctx context.Context, event SearchEvent) error {
	// TODO: this draft keys by the query hash so tenant streams interleave, publishes the raw query
	// for relevance tuning, and never configures idempotence. Review all three.
	sum := sha256.Sum256([]byte(event.Query))
	payload, _ := json.Marshal(map[string]any{"query": event.Query, "results": event.Results})
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(hex.EncodeToString(sum[:])), Value: payload})
}

func consumeSearchEvents(ctx context.Context, reader *kafka.Reader) error {
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event SearchEvent
		json.Unmarshal(message.Value, &event)
		reader.CommitMessages(ctx, message)
		rdb.Incr(ctx, "search:count:"+event.Tenant)
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "search.event",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type SearchEvent struct {
	Tenant      string
	Query       string
	ResultCount int
	LatencyMs   int
	Partial     bool
}

func queryHash(query string) string {
	sum := sha256.Sum256([]byte(query))
	return hex.EncodeToString(sum[:])
}

func publishSearch(ctx context.Context, event SearchEvent) error {
	tenant := event.Tenant
	payload, _ := json.Marshal(map[string]any{
		"tenant":       tenant,
		"query_hash":   queryHash(event.Query),
		"result_count": event.ResultCount,
		"latency_ms":   event.LatencyMs,
		"partial":      event.Partial,
	})
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: payload})
}

func consumeSearchEvents(ctx context.Context, reader *kafka.Reader) error {
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event SearchEvent
		json.Unmarshal(message.Value, &event)
		rdb.Incr(ctx, "search:count:"+event.Tenant)
		rdb.IncrBy(ctx, "search:results:"+event.Tenant, int64(event.ResultCount))
		reader.CommitMessages(ctx, message)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}

import scala.jdk.CollectionConverters._

import redis.clients.jedis.Jedis

final case class SearchEvent(tenant: String, query: String, results: Int)

object SearchEvents {
  val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  val producer = new KafkaProducer[String, String](producerProps)
  val jedis = new Jedis("redis", 6379)

  def publishSearch(event: SearchEvent): Unit = {
    // TODO: this draft keys by the query hash so tenant streams interleave, publishes the raw query
    // for relevance tuning, and never configures idempotence. Review all three.
    val key = Integer.toHexString(event.query.hashCode)
    val payload = s"""{"query":"\${event.query}","results":\${event.results}}"""
    producer.send(new ProducerRecord("search.event", key, payload))
  }

  def consumeSearchEvents(): Unit = {
    val consumerProps = new Properties()
    consumerProps.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    consumerProps.put(ConsumerConfig.GROUP_ID_CONFIG, "search-telemetry")
    val consumer = new KafkaConsumer[String, String](consumerProps)
    consumer.subscribe(List("search.event").asJava)
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(1000))
      records.forEach { record =>
        val tenant = record.key()
        consumer.commitSync()
        jedis.incr(s"search:count:$tenant")
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}

import scala.jdk.CollectionConverters._

import redis.clients.jedis.Jedis

final case class SearchEvent(tenant: String, text: String, resultCount: Int, latencyMs: Int, partial: Boolean)

object SearchEvents {
  val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  producerProps.put("enable.idempotence", "true")
  producerProps.put("acks", "all")
  val producer = new KafkaProducer[String, String](producerProps)
  val jedis = new Jedis("redis", 6379)

  def queryHash(text: String): String = Integer.toHexString(text.trim.toLowerCase.hashCode)

  def publishSearch(event: SearchEvent): Unit = {
    val tenant = event.tenant
    val payload =
      s"""{"tenant":"$tenant","query_hash":"\${queryHash(event.text)}","result_count":\${event.resultCount},"latency_ms":\${event.latencyMs},"partial":\${event.partial}}"""
    producer.send(new ProducerRecord("search.event", tenant, payload))
  }

  def consumeSearchEvents(): Unit = {
    val consumerProps = new Properties()
    consumerProps.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    consumerProps.put(ConsumerConfig.GROUP_ID_CONFIG, "search-telemetry")
    val consumer = new KafkaConsumer[String, String](consumerProps)
    consumer.subscribe(List("search.event").asJava)
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(1000))
      records.forEach { record =>
        val tenant = record.key()
        jedis.incr(s"search:count:$tenant")
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <functional>
#include <string>

void publishSearch(RdKafka::Producer* producer, const std::string& tenant, const std::string& query, int results) {
  // TODO: this draft keys by the query hash so tenant streams interleave, publishes the raw query
  // for relevance tuning, and never configures idempotence. Review all three.
  const std::string key = std::to_string(std::hash<std::string>{}(query));
  const std::string text = R"({"query":")" + query + R"(","results":)" + std::to_string(results) + "}";
  producer->produce("search.event", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(text.c_str()), text.size(), key.c_str(), key.size(), 0, nullptr);
}

void consumeSearchEvents(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& redis) {
  while (true) {
    RdKafka::Message* message = consumer->consume(1000);
    if (message->err() == RdKafka::ERR_NO_ERROR) {
      consumer->commitSync(message);
      redis.incr("search:count:" + std::string(static_cast<const char*>(message->key_pointer()), message->key_len()));
    } else if (message->err() == RdKafka::ERR__PARTITION_EOF) {
      continue;
    }
    delete message;
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <functional>
#include <string>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

std::string queryHash(const std::string& query) { return std::to_string(std::hash<std::string>{}(query)); }

RdKafka::Producer* makeProducer(std::string& error) {
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", error);
  conf->set("enable.idempotence", "true", error);
  conf->set("acks", "all", error);
  return RdKafka::Producer::create(conf, error);
}

void publishSearch(RdKafka::Producer* producer, const std::string& tenant, const std::string& query, int result_count,
                   int latency_ms) {
  const std::string query_hash = queryHash(query);
  const json payload = {
      {"tenant", tenant},
      {"query_hash", query_hash},
      {"result_count", result_count},
      {"latency_ms", latency_ms},
  };
  const std::string text = payload.dump();
  producer->produce("search.event", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(text.c_str()), text.size(), tenant.c_str(), tenant.size(), 0, nullptr);
}

void consumeSearchEvents(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& redis) {
  while (true) {
    RdKafka::Message* message = consumer->consume(1000);
    if (message->err() == RdKafka::ERR_NO_ERROR) {
      const json event = json::parse(std::string(static_cast<const char*>(message->payload()), message->len()));
      const auto tenant = event.value("tenant", std::string());
      redis.incr("search:count:" + tenant);
      consumer->commitSync(message);
    }
    delete message;
  }
}
`,
    },
  },
  hints: [
    'The message key is the partition key. `key=tenant` (or `key: tenant`, `Key: []byte(tenant)`, `ProducerRecord("search.event", tenant, …)`) is what keeps one tenant\'s events in order; the query hash is a fine *field* and a terrible key.',
    'Hash the query on the way out, not on the way in: the producer has the text, the topic never should. The payload is `{tenant, query_hash, result_count, latency_ms, partial}` — no `query` field at all.',
    "Idempotence is configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS's `idempotent: true`, or required acks `all` with a hash balancer and the same key on every retry. In the consumer, `INCR` first and `commit` second so a crash replays instead of losing the update.",
  ],
  debrief: `The interviewer is checking whether you can keep telemetry honest. The draft is useful — that is the trap: the raw query is the field the analytics team actually wants, and it is the field that must not leave the service. Four defects are being checked: the tenant is the partition key (per-tenant order is a feature, not a detail), the payload carries a hash rather than the text, the producer is configured idempotent with acks=all so retries do not duplicate, and the consumer updates counters before it commits so a crash replays instead of losing. Real systems add a schema registry so a future producer cannot smuggle text in, an outbox for produce failures, and separate topics for billing-grade counts versus sampled relevance data.`,
};
