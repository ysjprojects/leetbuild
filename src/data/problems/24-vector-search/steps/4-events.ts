import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Search events that carry no raw queries',
  concept: 'kafka',
  file: 'events',
  focus: ['search', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces an event on the
happy path and the analytics job lights up, so the demo shows numbers moving. Four contracts are
broken. Find them, fix them, and prove the fix with the checks below.

Every search publishes one event on \`search.query\`, and a consumer turns those events into
per-tenant counters.

- The message **key is the tenant** (\`key=event.tenant\`, \`key: event.tenant\`, \`Key: []byte(tenant)\`,
  \`ProducerRecord(Topic, event.tenant, payload)\`). Partitioning by tenant keeps each tenant's
  events in order; the draft keys by \`request_id\`, so one tenant's events scatter across partitions.
- The payload carries **\`request_id\`, \`latency_ms\`, \`k\`, \`index_version\` and a \`fingerprint\`** —
  a stable digest of the query vector. It never carries the query text or the vector: a query is
  tenant content, and the topic is retained for days and replicated, so anything written there
  outlives every retention policy the request path has.
- The producer is **idempotent with \`acks=all\`** — \`enable.idempotence\` plus \`acks\`,
  KafkaJS's \`idempotent: true\` with \`acks: -1\`, Go's \`RequiredAcks: kafka.RequireAll\` with a hash
  balancer, or the Java client's two properties. A produce retry must not duplicate a record.
- When the broker rejects the produce, write the event to the **outbox** (\`outbox.insert(...)\`)
  instead of dropping it, and let a relay republish it when the broker recovers.
- The consumer updates the counters (\`HINCRBY searchstats:{tenant}:{version} …\`) and **only then**
  commits the offset. Commit first and a crash loses the counter update forever, because the offset
  has already moved past the record.

**Failure mode the checks target.** A request-id key destroys per-tenant ordering; the retained
query text is a data leak with a long tail; an unconfigured producer duplicates on retry; a failed
produce silently loses the event; and commit-before-process trades correctness for code that merely
looks exactly-once.`,
  sequence: {
    participants: ['Search API', 'search.query', 'Analytics consumer', 'Redis'],
    messages: [
      {from: 'Search API', to: 'search.query', label: 'produce · key = tenant · acks = all', kind: 'sync'},
      {from: 'search.query', to: 'Search API', label: 'ack / broker error', kind: 'reply'},
      {from: 'Search API', to: 'Search API', label: 'outbox.insert(tenant, payload) on rejection', kind: 'sync'},
      {from: 'search.query', to: 'Analytics consumer', label: 'consume · group search-analytics', kind: 'async'},
      {from: 'Analytics consumer', to: 'Redis', label: 'HINCRBY searchstats:{tenant}:{version}', kind: 'sync'},
      {from: 'Redis', to: 'Analytics consumer', label: 'new counter value', kind: 'reply'},
      {from: 'Analytics consumer', to: 'search.query', label: 'commit the offset after processing', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=event.tenant` (or `Key: []byte(event.Tenant)`, `key: event.tenant`, `new ProducerRecord(Topic, event.tenant, payload)`). Keyed by the request id, one tenant’s events land in different partitions and their order is gone — which is exactly the signal the quality counters are built on.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all` (or `acks=-1` with `idempotent: true` in KafkaJS, `RequiredAcks: kafka.RequireAll` with a hash balancer in Kafka Go). It requires a stable key on every retry, which is the same fix as the tenant key.',
    'The outbox is the durability half: wrap the produce, and on rejection `outbox.insert(tenant, payload)` so a relay can republish. In the consumer, run the `HINCRBY` first and commit second — a crash between the two then replays the record instead of losing the counter update.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant, payload carries the fingerprint',
      detail:
        'The message key is the tenant, and the payload carries ids, latency, `k`, index version and a query fingerprint. The draft keys by request id, so one tenant’s events scatter across partitions.',
      match: {
        python: {all: [/search\.query/, /key=event\.tenant/, /fingerprint/, /latency_ms/, /index_version/]},
        typescript: {all: [/search\.query/, /key:\s*event\.tenant/, /fingerprint/, /latency_ms/, /index_version/]},
        go: {all: [/search\.query/, /Key:\s*\[\]byte\(event\.Tenant\)/, /Fingerprint/, /LatencyMs/, /IndexVersion/]},
        scala: {
          all: [
            /search\.query/,
            /ProducerRecord\[String, String\]\(Topic, event\.tenant/,
            /fingerprint/,
            /latencyMs/,
            /indexVersion/,
          ],
        },
        cpp: {all: [/search\.query/, /std::string key = event\.tenant/, /fingerprint/, /latency_ms/, /index_version/]},
      },
    },
    {
      id: 'no-query-text',
      title: 'No query text or vector in the event or the logs',
      detail:
        'Neither the payload nor a log line carries the query text or the query vector — only the fingerprint. The draft copies the raw query into a retained, replicated topic.',
      match: {
        python: {none: [/\bvector\b/i, /"query"/, /\bquery=/]},
        typescript: {none: [/\bvector\b/i, /"query"/, /event\.query/, /query\s*:\s*string/]},
        go: {none: [/\bvector\b/i, /"query"/, /Query:/]},
        scala: {none: [/\bvector\b/i, /"query"/, /event\.query/, /query\s*:\s*String/]},
        cpp: {none: [/\bvector\b/i, /"query"/, /event\.query/, /std::string query;/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true` with `acks: -1`, Go’s `RequiredAcks: kafka.RequireAll` with a hash balancer. A produce retry must not duplicate the record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/"enable\.idempotence"/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`outbox.insert(...)`) inside the error branch instead of dropping the event. The draft ignores the broker result entirely.',
      match: {
        python: {all: [/outbox\.insert\(/, /except\s*\((KafkaException|BufferError)/]},
        typescript: {all: [/outbox\.insert\(/, /catch\s*\(/]},
        go: {all: [/outbox\.Insert\(/, /if err != nil/]},
        scala: {all: [/outbox\.insert\(/, /catch\s*\{/]},
        cpp: {all: [/outbox\.insert\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Updates counters before committing the offset',
      detail:
        'The consumer runs `HINCRBY` on the per-tenant counters before committing the offset; committing first makes a crash lose the counter update forever. The draft commits first.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/\.hincrBy\(/, /commitSync\(/]},
        cpp: {order: [/\.hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from pydantic import BaseModel

logger = logging.getLogger("events")
cache = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "search.query"
producer = Producer({"bootstrap.servers": "kafka:9092"})


class SearchEvent(BaseModel):
    tenant: str
    request_id: str
    query: str
    latency_ms: int


def publish_search_event(event: SearchEvent) -> None:
    # TODO: this draft keys by the request id so one tenant's events scatter, copies the raw query
    # into a retained topic, configures no idempotence and no acks, and drops the event when the
    # broker rejects the produce. Review all four before this topic ships.
    payload = json.dumps({"query": event.query, "latency_ms": event.latency_ms})
    producer.produce(TOPIC, key=event.request_id, value=payload)
    logger.info("search event tenant=%s query=%s", event.tenant, event.query)


def consume_search_events() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "search-analytics"})
    consumer.subscribe([TOPIC])
    while True:
        message = consumer.poll(1.0)
        if message is None or message.error():
            continue
        event = json.loads(message.value())
        consumer.commit(message=message)
        cache.hincrby(f"searchstats:{event['tenant']}", "searches", 1)
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, KafkaException, Producer
from pydantic import BaseModel

logger = logging.getLogger("events")
cache = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "search.query"
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class SearchEvent(BaseModel):
    tenant: str
    request_id: str
    latency_ms: int
    k: int
    index_version: str
    fingerprint: str


class Outbox:
    def insert(self, tenant: str, payload: str) -> None:
        """Keep the event until a relay republishes it."""
        raise NotImplementedError


outbox = Outbox()


def publish_search_event(event: SearchEvent) -> None:
    """One event per search, keyed by tenant, carrying a fingerprint instead of the query."""
    payload = json.dumps(
        {
            "request_id": event.request_id,
            "latency_ms": event.latency_ms,
            "k": event.k,
            "index_version": event.index_version,
            "fingerprint": event.fingerprint,
        }
    )
    try:
        producer.produce(TOPIC, key=event.tenant, value=payload)
    except (KafkaException, BufferError) as error:
        outbox.insert(event.tenant, payload)
        logger.warning("search event parked in the outbox: %s", error)


def consume_search_events() -> None:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "search-analytics",
            "enable.auto.commit": False,
        }
    )
    consumer.subscribe([TOPIC])
    while True:
        message = consumer.poll(1.0)
        if message is None or message.error():
            continue
        event = json.loads(message.value())
        counters = f"searchstats:{event['tenant']}:{event['index_version']}"
        cache.hincrby(counters, "searches", 1)
        cache.hincrby(counters, "latency_ms_sum", event["latency_ms"])
        consumer.commit(message=message)
`,
    },
    typescript: {
      starter: `/** search.query: a model-generated draft that copies the query into the topic. */
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

const kafka = new Kafka({clientId: 'searchd', brokers: ['kafka:9092']});
export const producer = kafka.producer();
export const cache = new Redis('redis://redis:6379');

export const TOPIC = 'search.query';

export interface SearchEvent {
  tenant: string;
  request_id: string;
  query: string;
  latency_ms: number;
}

export async function publishSearchEvent(event: SearchEvent): Promise<void> {
  // TODO: this draft keys by the request id so one tenant's events scatter, copies the raw query
  // into a retained topic, configures no idempotence and no acks, and drops the event when the
  // broker rejects the produce. Review all four before this topic ships.
  await producer.send({
    topic: TOPIC,
    messages: [{key: event.request_id, value: JSON.stringify({query: event.query, latency_ms: event.latency_ms})}],
  });
  console.log('search event', event.tenant, event.query);
}

export async function consumeSearchEvents(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'search-analytics'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: false});
  await consumer.run({
    eachMessage: async ({message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as Partial<SearchEvent>;
      await consumer.commitOffsets([
        {topic: TOPIC, partition: message.partition, offset: String(Number(message.offset) + 1)},
      ]);
      await cache.hincrby(\`searchstats:\${event.tenant}\`, 'searches', 1);
    },
  });
}
`,
      solution: `/** search.query: one event per search, keyed by tenant, with a fingerprint and no query text. */
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

const kafka = new Kafka({clientId: 'searchd', brokers: ['kafka:9092']});
const cache = new Redis('redis://redis:6379');

export const TOPIC = 'search.query';

export interface SearchEvent {
  tenant: string;
  request_id: string;
  latency_ms: number;
  k: number;
  index_version: string;
  fingerprint: string;
}

export const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});

export const outbox = {
  /** Keep the event until a relay republishes it. */
  async insert(tenant: string, payload: string): Promise<void> {
    await cache.rpush(\`outbox:search.query:\${tenant}\`, payload);
  },
};

export async function publishSearchEvent(event: SearchEvent): Promise<void> {
  const payload = JSON.stringify({
    request_id: event.request_id,
    latency_ms: event.latency_ms,
    k: event.k,
    index_version: event.index_version,
    fingerprint: event.fingerprint,
  });
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: event.tenant, value: payload}]});
  } catch (error) {
    await outbox.insert(event.tenant, payload);
    console.warn('search event parked in the outbox', error);
  }
}

export async function consumeSearchEvents(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'search-analytics'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: false});
  await consumer.run({
    eachMessage: async ({message, heartbeat}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as Partial<SearchEvent>;
      const counters = \`searchstats:\${event.tenant}:\${event.index_version}\`;
      await cache.hincrby(counters, 'searches', 1);
      await cache.hincrby(counters, 'latency_ms_sum', event.latency_ms ?? 0);
      await consumer.commitOffsets([
        {topic: TOPIC, partition: message.partition, offset: String(Number(message.offset) + 1)},
      ]);
      await heartbeat();
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
	"strings"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	topic       = "search.query"
	brokersAddr = "kafka:9092"
)

var cache = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:  kafka.TCP(strings.Split(brokersAddr, ",")...),
	Topic: topic,
}

type SearchEvent struct {
	Tenant    string \`json:"tenant"\`
	RequestID string \`json:"request_id"\`
	Query     string \`json:"query"\`
	LatencyMs int    \`json:"latency_ms"\`
}

func publishSearchEvent(ctx context.Context, event SearchEvent) error {
	// TODO: this draft keys by the request id so one tenant's events scatter, copies the raw query
	// into a retained topic, configures no idempotence and no acks, and drops the event when the
	// broker rejects the produce. Review all four before this topic ships.
	payload, _ := json.Marshal(map[string]any{"query": event.Query, "latency_ms": event.LatencyMs})
	message := kafka.Message{Key: []byte(event.RequestID), Value: payload}
	return writer.WriteMessages(ctx, message)
}

func consumeSearchEvents(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        strings.Split(brokersAddr, ","),
		GroupID:        "search-analytics",
		Topic:          topic,
		CommitInterval: 0,
	})
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event SearchEvent
		if err := json.Unmarshal(message.Value, &event); err != nil {
			continue
		}
		if err := reader.CommitMessages(ctx, message); err != nil {
			return err
		}
		cache.HIncrBy(ctx, "searchstats:"+event.Tenant, "searches", 1)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	topic       = "search.query"
	brokersAddr = "kafka:9092"
)

var cache = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP(strings.Split(brokersAddr, ",")...),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type SearchEvent struct {
	Tenant       string \`json:"tenant"\`
	RequestID    string \`json:"request_id"\`
	LatencyMs    int    \`json:"latency_ms"\`
	K            int    \`json:"k"\`
	IndexVersion string \`json:"index_version"\`
	Fingerprint  string \`json:"fingerprint"\`
}

type Outbox struct{}

func (o *Outbox) Insert(ctx context.Context, tenant, payload string) error {
	return cache.RPush(ctx, "outbox:search.query:"+tenant, payload).Err()
}

var outbox = &Outbox{}

func publishSearchEvent(ctx context.Context, event SearchEvent) error {
	payload, _ := json.Marshal(map[string]any{
		"request_id":    event.RequestID,
		"latency_ms":    event.LatencyMs,
		"k":             event.K,
		"index_version": event.IndexVersion,
		"fingerprint":   event.Fingerprint,
	})
	message := kafka.Message{Key: []byte(event.Tenant), Value: payload}
	if err := writer.WriteMessages(ctx, message); err != nil {
		if insertErr := outbox.Insert(ctx, event.Tenant, string(payload)); insertErr != nil {
			return insertErr
		}
		return err
	}
	return nil
}

func consumeSearchEvents(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        strings.Split(brokersAddr, ","),
		GroupID:        "search-analytics",
		Topic:          topic,
		CommitInterval: 0,
	})
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event SearchEvent
		if err := json.Unmarshal(message.Value, &event); err != nil {
			continue
		}
		counters := "searchstats:" + event.Tenant + ":" + event.IndexVersion
		cache.HIncrBy(ctx, counters, "searches", 1)
		cache.HIncrBy(ctx, counters, "latency_ms_sum", int64(event.LatencyMs))
		if err := reader.CommitMessages(ctx, message); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.{List => JList, Properties}

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis

final case class SearchEvent(tenant: String, requestId: String, query: String, latencyMs: Int)

object SearchEvents {
  val Topic = "search.query"
  val producer = new KafkaProducer[String, String](new Properties())
  val cache = new Jedis("redis", 6379)

  def publish(event: SearchEvent): Unit = {
    // TODO: this draft keys by the request id so one tenant's events scatter, copies the raw query
    // into a retained topic, configures no idempotence and no acks, and drops the event when the
    // broker rejects the produce. Review all four before this topic ships.
    val payload = s"""{"query":"\${event.query}","latency_ms":\${event.latencyMs}}"""
    producer.send(new ProducerRecord[String, String](Topic, event.requestId, payload))
    System.out.println(s"search event \${event.tenant} \${event.query}")
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "search-analytics")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(JList.of(Topic))
    while (true) {
      consumer.poll(Duration.ofMillis(500)).forEach { record =>
        consumer.commitSync()
        cache.hincrBy("searchstats:" + record.key(), "searches", 1)
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.{List => JList, Properties}

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class SearchEvent(
    tenant: String,
    requestId: String,
    latencyMs: Int,
    k: Int,
    indexVersion: String,
    fingerprint: String,
)

object SearchEvents {
  val Topic = "search.query"

  val cache = new Jedis("redis", 6379)

  val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  producerProps.put("enable.idempotence", "true")
  producerProps.put("acks", "all")

  val producer = new KafkaProducer[String, String](producerProps)

  object outbox {
    /** Keep the event until a relay republishes it. */
    def insert(tenant: String, payload: String): Unit = cache.rpush(s"outbox:search.query:$tenant", payload)
  }

  def publish(event: SearchEvent): Unit = {
    val payload = s"""{"request_id":"\${event.requestId}","latency_ms":\${event.latencyMs},"k":\${event.k},"index_version":"\${event.indexVersion}","fingerprint":"\${event.fingerprint}"}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, event.tenant, payload)).get()
    } catch {
      case error: Exception =>
        outbox.insert(event.tenant, payload)
        System.err.println(s"search event parked in the outbox: \${error.getMessage}")
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "search-analytics")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(JList.of(Topic))
    while (true) {
      val records = consumer.poll(Duration.ofMillis(500))
      records.forEach { record =>
        val payload = record.value().parseJson.asJsObject.fields
        val counters = s"searchstats:\${record.key()}:\${payload("index_version").convertTo[String]}"
        cache.hincrBy(counters, "searches", 1)
        cache.hincrBy(counters, "latency_ms_sum", payload("latency_ms").convertTo[Int])
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "search.query";

auto cache = sw::redis::Redis("redis://redis:6379");

struct SearchEvent {
  std::string tenant;
  std::string requestId;
  std::string query;
  int latencyMs;
};

std::unique_ptr<RdKafka::Producer> searchProducer() {
  std::string error;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", error);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), error));
}

void publishSearchEvent(const SearchEvent& event) {
  // TODO: this draft keys by the request id so one tenant's events scatter, copies the raw query
  // into a retained topic, configures no idempotence and no acks, and drops the event when the
  // broker rejects the produce. Review all four before this topic ships.
  const std::string payload = json{{"query", event.query}, {"latency_ms", event.latencyMs}}.dump();
  const std::string key = event.requestId;
  auto producer = searchProducer();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), key.data(), key.size(), 0, nullptr);
  producer->poll(0);
  std::clog << "search event " << event.tenant << " " << event.query << "\\n";
}

void consumeSearchEvents() {
  std::string error;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", error);
  conf->set("group.id", "search-analytics", error);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), error));
  consumer->subscribe({kTopic});
  while (true) {
    RdKafka::Message* message = consumer->consume(500);
    if (message->err() == RdKafka::ERR_NO_ERROR) {
      const auto event = json::parse(std::string(static_cast<char*>(message->payload()), message->len()));
      consumer->commitSync(message);
      cache.hincrby("searchstats:" + event.value("tenant", std::string()), "searches", 1);
    }
    delete message;
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "search.query";

auto cache = sw::redis::Redis("redis://redis:6379");

struct SearchEvent {
  std::string tenant;
  std::string requestId;
  int latencyMs;
  int k;
  std::string indexVersion;
  std::string fingerprint;
};

std::unique_ptr<RdKafka::Producer> searchProducer() {
  std::string error;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", error);
  conf->set("enable.idempotence", "true", error);
  conf->set("acks", "all", error);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), error));
}

struct Outbox {
  /** Keep the event until a relay republishes it. */
  void insert(const std::string& tenant, const std::string& payload) {
    cache.rpush("outbox:search.query:" + tenant, payload);
  }
};

Outbox outbox;

void publishSearchEvent(const SearchEvent& event) {
  const std::string payload = json{{"request_id", event.requestId},
                                   {"latency_ms", event.latencyMs},
                                   {"k", event.k},
                                   {"index_version", event.indexVersion},
                                   {"fingerprint", event.fingerprint}}
                                  .dump();
  const std::string key = event.tenant;
  auto producer = searchProducer();
  const RdKafka::ErrorCode outcome = producer->produce(
      kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
      payload.size(), key.data(), key.size(), 0, nullptr);
  if (outcome != RdKafka::ERR_NO_ERROR) {
    outbox.insert(event.tenant, payload);
    std::cerr << "search event parked in the outbox: " << RdKafka::err2str(outcome) << "\\n";
  }
  producer->poll(0);
}

void consumeSearchEvents() {
  std::string error;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", error);
  conf->set("group.id", "search-analytics", error);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), error));
  consumer->subscribe({kTopic});
  while (true) {
    RdKafka::Message* message = consumer->consume(500);
    if (message->err() == RdKafka::ERR_NO_ERROR) {
      const auto event = json::parse(std::string(static_cast<char*>(message->payload()), message->len()));
      const std::string counters = "searchstats:" + event.value("tenant", std::string()) + ":" +
                                   event.value("index_version", std::string());
      cache.hincrby(counters, "searches", 1);
      cache.hincrby(counters, "latency_ms_sum", event.value("latency_ms", 0));
      consumer->commitSync(message);
    }
    delete message;
  }
}
`,
    },
  },
  debrief: `The event is where a search service decides what it is willing to remember. The draft is
generated around the analytics use case — publish the query so the dashboard can show it — and that is
precisely the mistake: the topic is retained and replicated, so the query text outlives the request,
the session and the retention policy of whatever pipeline wrote it. The fix is a fingerprint:
enough to group identical queries and spot a bad ranking cohort, useless as content. The other three
defects are ordering, duplication and loss. Keying by request id scatters one tenant's events, which
breaks the per-tenant counter ordering the consumer relies on (key by tenant). A default producer can
duplicate on retry, so idempotence plus \`acks=all\` is configuration, not a comment (and it needs a
stable key, which the tenant key already provides). And a rejected produce that is not written to the
outbox is an event lost silently, which is worse than a failed request because nobody is waiting for
the error. Real platforms add a topic schema registry that refuses a payload field called \`query\`,
retention and compaction policies per topic, and a consumer that commits only after the counter
mutation — the same ordering rule as any other at-least-once pipeline.
`,
};
