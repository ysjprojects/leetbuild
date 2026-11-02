import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Search events that carry no raw queries',
  concept: 'kafka',
  file: 'events',
  focus: ['search', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter publishes one event per search on \`search.query\`:
\`publish_search_event\` serializes \`{"query", "latency_ms"}\`, produces it with
\`key=event.request_id\` on a default-configured producer, and logs the query. The consumer in
group \`search-analytics\` polls, commits the offset, then runs \`HINCRBY searchstats:{tenant}\`.
The analytics job lights up and the demo shows numbers moving. It compiles and hides five flaws.

**Failure mode the checks target.** A request-id key destroys per-tenant ordering; the retained
query text is a data leak with a long tail; an unconfigured producer duplicates on retry; a failed
produce silently loses the event; and commit-before-process trades correctness for code that merely
looks exactly-once.

- The message **key is the tenant** (\`key=event.tenant\`, \`key: event.tenant\`, \`Key: []byte(tenant)\`,
  \`ProducerRecord(Topic, event.tenant, payload)\`). Partitioning by tenant keeps each tenant's
  events in order.
- The payload carries **\`request_id\`, \`latency_ms\`, \`k\`, \`index_version\` and a \`fingerprint\`**,
  a stable digest of the query vector. It does not carry the query text or the vector: a query is
  tenant content, and the topic is retained for days and replicated, so anything written there
  outlives every retention policy the request path has.
- The producer is **idempotent with \`acks=all\`**: \`enable.idempotence\` plus \`acks\`,
  KafkaJS's \`idempotent: true\` with \`acks: -1\`, Go's \`RequiredAcks: kafka.RequireAll\` with a hash
  balancer, or the Java client's two properties. A produce retry must not duplicate a record.
- When the broker rejects the produce, write the event to the **outbox** (\`outbox.insert(...)\`)
  instead of dropping it, and let a relay republish it when the broker recovers.
- The consumer updates the counters (\`HINCRBY searchstats:{tenant}:{version} …\`) and **only then**
  commits the offset. Commit first and a crash loses the counter update, because the offset has
  already moved past the record.`,
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
    "A tenant's dashboard shows searches out of order and occasionally double-counted, a broker blip makes events vanish, and a compliance scan finds raw query text in a topic retained for a week.",
    'The key is `event.request_id`, so one tenant spreads over partitions; the producer dict has no `enable.idempotence`/`acks`; `produce` ignores rejection; the consumer calls `commit` before `hincrby`.',
    'Key with `key=event.tenant`, replace `query` in the payload with a `fingerprint` plus `k`/`index_version`, set `enable.idempotence` and `acks=all`, `outbox.insert` in `except KafkaException`, and move `commit` after `hincrby`.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant, payload carries the fingerprint',
      detail:
        'The message key is the tenant, and the payload carries ids, latency, `k`, index version and a query fingerprint. The starter keys by request id, so one tenant’s events scatter across partitions.',
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
        'Neither the payload nor a log line carries the query text or the query vector — only the fingerprint. The starter copies the raw query into a retained, replicated topic.',
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
        'A rejected produce writes an outbox row (`outbox.insert(...)`) inside the error branch instead of dropping the event. The starter ignores the broker result entirely.',
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
        'The consumer runs `HINCRBY` on the per-tenant counters before committing the offset; committing first makes a crash lose the counter update forever. The starter commits first.',
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
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
      starter: `/** search.query: flawed code that copies the query into the topic. */
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
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
  debrief: `The event is where a search service decides what it is willing to remember. The starter is
built around the analytics use case, publish the query so the dashboard can show it, and that is
the mistake: the topic is retained and replicated, so the query text outlives the request, the
session and every retention policy upstream. A fingerprint is enough to group identical queries and
spot a bad ranking cohort, and useless as content. The tenant key does double duty: it keeps one
tenant's events in order and gives the idempotent producer the stable key it needs to dedupe a
retry. The outbox and the commit-after-update rule are the two halves of at-least-once: nothing is
dropped on the way in, nothing is skipped on the way out. Production platforms add a schema
registry that refuses a payload field called \`query\` and per-topic retention and compaction
policies.
`,
};
