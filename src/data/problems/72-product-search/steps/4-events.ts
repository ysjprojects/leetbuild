import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'search.event: keyed by tenant, without what the shopper typed',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'telemetry',
  focus: ['api', 'kafka', 'analytics'],
  task: `## Task

**Starting point.** The starter is the telemetry an answered search leaves behind:
\`record_search(tenant, q, filters, result_count, partial, latency_ms)\` produces one
\`search.event\` keyed by the query, carrying the query text, the filters and the counts, waits for
the delivery report, and logs a failed delivery. Searches show up on the analytics dashboard, and it
hides four flaws.

**Failure mode the checks target.** One tenant's events scatter across partitions, so the
per-tenant consumer counts them out of order; the retained topic keeps what shoppers typed; a lost
acknowledgement writes an event twice and a leader failover loses one; and a dropped event leaves no
trace, so a dashboard cannot tell a quiet hour from a broken pipe.

- The record key is the **tenant**.
- The payload is \`type\` (\`search.query\`), \`tenant\`, \`query_hash\`
  (\`digest(normalize_query(q))\`), \`filter_fields\` (sorted names), \`result_count\`, \`partial\` and
  \`latency_ms\`: no query text, no filter value.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent: true\` with \`acks: -1\`; the Go
  starter uses confluent-kafka-go, because kafka-go has no idempotent producer).
- A failed delivery (the delivery report's error, a rejected \`send\`) increments
  \`telemetry:dropped:{tenant}\` in Redis.`,
  sequence: {
    participants: ['searchd', 'search.event', 'Redis', 'Search analytics'],
    messages: [
      {
        from: 'searchd',
        to: 'search.event',
        label: 'produce · key = tenant · {query_hash, filter_fields, counts}',
        kind: 'sync',
      },
      {from: 'search.event', to: 'searchd', label: 'delivery report (idempotent, acks=all)', kind: 'reply'},
      {from: 'searchd', to: 'Redis', label: 'INCR telemetry:dropped:{tenant} on a failed delivery', kind: 'sync'},
      {from: 'search.event', to: 'Search analytics', label: 'consume · one partition per tenant', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant',
      detail:
        'The record key is the tenant, so one tenant’s events share a partition and keep their order; the starter keys by the query text, which scatters a tenant across partitions and copies the query into the key.',
      match: {
        python: {all: [/key\s*=\s*tenant\b/], none: [/key\s*=\s*q\b/]},
        typescript: {all: [/key:\s*tenant\b/], none: [/key:\s*q\b/]},
        go: {all: [/Key:\s*\[\]byte\(tenant\)/], none: [/Key:\s*\[\]byte\(q\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(EventTopic,\s*tenant\b/], none: [/EventTopic,\s*q\b/]},
        cpp: {all: [/tenant\.c_str\(\),\s*tenant\.size\(\)/], none: [/q\.c_str\(\)/]},
      },
    },
    {
      id: 'no-raw-query',
      title: 'Carries a query digest and filter names, not what was typed',
      detail:
        'The payload carries `query_hash` = `digest(normalize_query(q))` and the sorted `filter_fields`; the query text and the filter values stay out of a retained, replicated topic.',
      match: {
        python: {
          all: [/digest\(\s*catalog\.normalize_query\(\s*q\s*\)\s*\)/, /sorted\(\s*filters\s*\)/],
          none: [/["']q["']\s*:\s*q\b/, /["']filters["']\s*:\s*filters\b/],
        },
        typescript: {
          all: [/digest\(\s*normalizeQuery\(\s*q\s*\)\s*\)/, /Object\.keys\(\s*filters\s*\)\.sort\(\)/],
          none: [/^\s+q,\s*$/m, /^\s+filters,\s*$/m],
        },
        go: {
          all: [/catalog\.Digest\(\s*catalog\.NormalizeQuery\(\s*q\s*\)\s*\)/, /sort\.Strings\(/],
          none: [/"q":\s*q\b/, /"filters":\s*filters\b/],
        },
        scala: {
          all: [/Catalog\.digest\(\s*Catalog\.normalizeQuery\(\s*q\s*\)\s*\)/, /filters\.keys\.toSeq\.sorted/],
          none: [/"q"\s*->\s*JsString\(\s*q\s*\)/],
        },
        cpp: {
          all: [/catalog::digest\(\s*catalog::normalizeQuery\(\s*q\s*\)\s*\)/, /"filter_fields"/],
          none: [/\{"q",\s*q\}/, /\{"filters",\s*filters\}/],
        },
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer sets idempotence and `acks=all` (kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the event once and a leader failover loses nothing that was acknowledged.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'dropped-count',
      title: 'A lost event is counted per tenant',
      detail:
        'When the delivery fails (the delivery report carries an error, `send` rejects), `telemetry:dropped:{tenant}` is incremented, so the dashboard knows its counts are a lower bound; the starter only logs it.',
      match: {
        python: {all: [/incr\(\s*f["']telemetry:dropped:\{tenant\}/]},
        typescript: {all: [/incr\(\s*`telemetry:dropped:\$\{tenant\}`/]},
        go: {all: [/Incr\(\s*ctx,\s*"telemetry:dropped:"\s*\+\s*tenant/]},
        scala: {all: [/incr\(\s*s"telemetry:dropped:\$tenant"/]},
        cpp: {all: [/incr\(\s*"telemetry:dropped:"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Producer

from search import catalog  # normalize_query, digest

EVENT_TOPIC = "search.event"
log = logging.getLogger("telemetry")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def record_search(tenant: str, q: str, filters: dict[str, str], result_count: int, partial: bool, latency_ms: int) -> dict:
    """One search.event for an answered search; returns the payload."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = {
        "type": "search.query",
        "tenant": tenant,
        "q": q,
        "filters": filters,
        "result_count": result_count,
        "partial": partial,
        "latency_ms": latency_ms,
    }

    def on_delivery(err, msg) -> None:
        if err is not None:
            log.warning("search event not delivered: %s", err)

    producer.produce(EVENT_TOPIC, key=q, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Producer

from search import catalog  # normalize_query, digest

EVENT_TOPIC = "search.event"
log = logging.getLogger("telemetry")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def record_search(tenant: str, q: str, filters: dict[str, str], result_count: int, partial: bool, latency_ms: int) -> dict:
    """One search.event for an answered search; returns the payload."""
    payload = {
        "type": "search.query",
        "tenant": tenant,
        # The topic is retained and replicated: a digest of the query and the names of the filters, never what was typed.
        "query_hash": catalog.digest(catalog.normalize_query(q)),
        "filter_fields": sorted(filters),
        "result_count": result_count,
        "partial": partial,
        "latency_ms": latency_ms,
    }

    def on_delivery(err, msg) -> None:
        if err is not None:
            r.incr(f"telemetry:dropped:{tenant}")  # the dashboard's counts are a lower bound, and it knows by how much
            log.warning("search event not delivered: %s", err)

    producer.produce(EVENT_TOPIC, key=tenant, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {digest, normalizeQuery} from 'search/catalog';

export const EVENT_TOPIC = 'search.event';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'searchd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One search.event for an answered search; resolves the payload. */
export async function recordSearch(
  tenant: string,
  q: string,
  filters: Record<string, string>,
  resultCount: number,
  partial: boolean,
  latencyMs: number,
): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = {
    type: 'search.query',
    tenant,
    q,
    filters,
    result_count: resultCount,
    partial,
    latency_ms: latencyMs,
  };
  try {
    await producer.send({topic: EVENT_TOPIC, messages: [{key: q, value: JSON.stringify(payload)}], acks: 1});
  } catch (err) {
    console.warn('search event not delivered', err);
  }
  return payload;
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {digest, normalizeQuery} from 'search/catalog';

export const EVENT_TOPIC = 'search.event';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'searchd', brokers: ['kafka:9092']});
// Idempotent with acks -1 (all): a retry after a lost acknowledgement writes the event once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One search.event for an answered search; resolves the payload. */
export async function recordSearch(
  tenant: string,
  q: string,
  filters: Record<string, string>,
  resultCount: number,
  partial: boolean,
  latencyMs: number,
): Promise<Record<string, unknown>> {
  const payload = {
    type: 'search.query',
    tenant,
    // The topic is retained and replicated: a digest of the query and the names of the filters, never what was typed.
    query_hash: digest(normalizeQuery(q)),
    filter_fields: Object.keys(filters).sort(),
    result_count: resultCount,
    partial,
    latency_ms: latencyMs,
  };
  try {
    await producer.send({topic: EVENT_TOPIC, messages: [{key: tenant, value: JSON.stringify(payload)}], acks: -1});
  } catch (err) {
    await redis.incr(\`telemetry:dropped:\${tenant}\`); // the dashboard's counts are a lower bound, and it knows by how much
    console.warn('search event not delivered', err);
  }
  return payload;
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
	"github.com/redis/go-redis/v9"
)

// search/catalog provides catalog.NormalizeQuery and catalog.Digest.

const (
	eventTopic = "search.event"
	ackTimeout = 2 * time.Second
)

var (
	rdb      = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	producer = newProducer()
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// recordSearch produces one search.event for an answered search and returns the payload.
func recordSearch(ctx context.Context, tenant, q string, filters map[string]string, resultCount int, partial bool, latencyMs int64) map[string]any {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload := map[string]any{
		"type":         "search.query",
		"tenant":       tenant,
		"q":            q,
		"filters":      filters,
		"result_count": resultCount,
		"partial":      partial,
		"latency_ms":   latencyMs,
	}
	value, _ := json.Marshal(payload)
	topic := eventTopic
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(q), Value: value}, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded
		}
	}
	if err != nil {
		log.Printf("search event not delivered: %v", err)
	}
	return payload
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"

	"search/catalog" // NormalizeQuery, Digest
)

const (
	eventTopic = "search.event"
	ackTimeout = 2 * time.Second
)

var (
	rdb      = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	producer = newProducer()
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the event before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// recordSearch produces one search.event for an answered search and returns the payload.
func recordSearch(ctx context.Context, tenant, q string, filters map[string]string, resultCount int, partial bool, latencyMs int64) map[string]any {
	fields := make([]string, 0, len(filters))
	for field := range filters {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	payload := map[string]any{
		"type":   "search.query",
		"tenant": tenant,
		// The topic is retained and replicated: a digest of the query and the names of the filters, never what was typed.
		"query_hash":    catalog.Digest(catalog.NormalizeQuery(q)),
		"filter_fields": fields,
		"result_count":  resultCount,
		"partial":       partial,
		"latency_ms":    latencyMs,
	}
	value, _ := json.Marshal(payload)
	topic := eventTopic
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(tenant), Value: value}, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded
		}
	}
	if err != nil {
		rdb.Incr(ctx, "telemetry:dropped:"+tenant) // the dashboard's counts are a lower bound, and it knows by how much
		log.Printf("search event not delivered: %v", err)
	}
	return payload
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._

import search.Catalog // normalizeQuery, digest

object Telemetry {
  val EventTopic = "search.event"

  val jedis = new JedisPooled("redis", 6379)

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** One search.event for an answered search; returns the payload. */
  def recordSearch(tenant: String, q: String, filters: Map[String, String], resultCount: Int, partial: Boolean, latencyMs: Long): JsObject = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = JsObject(
      "type" -> JsString("search.query"),
      "tenant" -> JsString(tenant),
      "q" -> JsString(q),
      "filters" -> JsObject(filters.map { case (field, value) => field -> JsString(value) }),
      "result_count" -> JsNumber(resultCount),
      "partial" -> JsBoolean(partial),
      "latency_ms" -> JsNumber(latencyMs))
    producer.send(new ProducerRecord[String, String](EventTopic, q, payload.compactPrint), new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) System.err.println(s"search event not delivered: $exception")
    })
    producer.flush()
    payload
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._

import search.Catalog // normalizeQuery, digest

object Telemetry {
  val EventTopic = "search.event"

  val jedis = new JedisPooled("redis", 6379)

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the event before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** One search.event for an answered search; returns the payload. */
  def recordSearch(tenant: String, q: String, filters: Map[String, String], resultCount: Int, partial: Boolean, latencyMs: Long): JsObject = {
    // The topic is retained and replicated: a digest of the query and the names of the filters, never what was typed.
    val payload = JsObject(
      "type" -> JsString("search.query"),
      "tenant" -> JsString(tenant),
      "query_hash" -> JsString(Catalog.digest(Catalog.normalizeQuery(q))),
      "filter_fields" -> JsArray(filters.keys.toSeq.sorted.map(JsString(_)).toVector),
      "result_count" -> JsNumber(resultCount),
      "partial" -> JsBoolean(partial),
      "latency_ms" -> JsNumber(latencyMs))
    producer.send(new ProducerRecord[String, String](EventTopic, tenant, payload.compactPrint), new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) {
          jedis.incr(s"telemetry:dropped:$tenant") // the dashboard's counts are a lower bound, and it knows by how much
          System.err.println(s"search event not delivered: $exception")
        }
    })
    producer.flush()
    payload
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <map>
#include <memory>
#include <string>

#include "search/catalog.h"  // catalog::normalizeQuery, catalog::digest

using json = nlohmann::json;

const std::string kEventTopic = "search.event";

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "search event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_reports;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_reports, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One search.event for an answered search; returns the payload.
json recordSearch(const std::string& tenant, const std::string& q, const std::map<std::string, std::string>& filters, int result_count,
                  bool partial, long latency_ms) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json payload = {{"type", "search.query"},          {"tenant", tenant},   {"q", q},
                        {"filters", filters},              {"result_count", result_count},
                        {"partial", partial},              {"latency_ms", latency_ms}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), q.c_str(), q.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "search/catalog.h"  // catalog::normalizeQuery, catalog::digest

using json = nlohmann::json;

const std::string kEventTopic = "search.event";

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

class CountDrops : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    // The record's key is the tenant: the dashboard's counts are a lower bound, and it knows by how much.
    redis().incr("telemetry:dropped:" + (message.key() ? *message.key() : std::string("unknown")));
    std::cerr << "search event not delivered: " << message.errstr() << "\\n";
  }
};

CountDrops delivery_reports;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the event before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery_reports, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One search.event for an answered search; returns the payload.
json recordSearch(const std::string& tenant, const std::string& q, const std::map<std::string, std::string>& filters, int result_count,
                  bool partial, long latency_ms) {
  std::vector<std::string> fields;
  for (const auto& entry : filters) fields.push_back(entry.first);  // a std::map iterates sorted
  // The topic is retained and replicated: a digest of the query and the names of the filters, never what was typed.
  const json payload = {{"type", "search.query"},
                        {"tenant", tenant},
                        {"query_hash", catalog::digest(catalog::normalizeQuery(q))},
                        {"filter_fields", fields},
                        {"result_count", result_count},
                        {"partial", partial},
                        {"latency_ms", latency_ms}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), tenant.c_str(), tenant.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}
`,
    },
  },
  harness: {
    python: `import json

from search import catalog

TOPIC = "search.event"


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def check_tenant_key(ctx):
    m = ctx.load("telemetry")
    m.record_search("t-1", "kettle", {}, 3, False, 12)
    m.record_search("t-2", "kettle", {}, 1, False, 9)
    m.record_search("t-1", "steel kettle", {"brand": "acme"}, 1, False, 11)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three searches produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"t-1", b"t-2", b"t-1"], f"the records are keyed {keys}, expected the tenants [t-1, t-2, t-1]: keyed by anything else, one tenant's events scatter across partitions"
    assert records[0].partition == records[2].partition, f"t-1's events landed on partitions {records[0].partition} and {records[2].partition}: one tenant's events must stay on one partition, in order"


def check_no_raw_query(ctx):
    m = ctx.load("telemetry")
    m.record_search("t-1", "  Steel KETTLE ", {"brand": "acme", "max_price": "5000"}, 2, True, 41)
    record = ctx.kafka.records(TOPIC)[0]
    text = record.value.decode().lower()
    for leaked in ("steel", "kettle", "acme", "5000"):
        assert leaked not in text, f"the event carries {leaked!r}: {record.value.decode()}. The topic is retained and replicated; carry query_hash and the filter names"
    p = _payload(record)
    assert p.get("query_hash") == catalog.digest("steel kettle"), f"query_hash is {p.get('query_hash')!r}, expected digest(normalize_query(q)) = {catalog.digest('steel kettle')!r}"
    assert p.get("filter_fields") == ["brand", "max_price"], f"filter_fields is {p.get('filter_fields')!r}, expected the sorted names ['brand', 'max_price']"
    expected = {"type": "search.query", "tenant": "t-1", "result_count": 2, "partial": True, "latency_ms": 41}
    assert all(p.get(k) == v for k, v in expected.items()), f"the event is {p}, expected {expected} beside query_hash and filter_fields"


def check_idempotent_producer(ctx):
    m = ctx.load("telemetry")
    ctx.kafka.lose_acks(TOPIC, 1)
    m.record_search("t-1", "kettle", {}, 3, False, 12)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one search whose acknowledgement was lost left {len(records)} records: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    m.record_search("t-1", "kettle", {}, 3, False, 12)
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the event and lost it. Use acks=all"


def check_dropped_count(ctx):
    m = ctx.load("telemetry")
    ctx.kafka.fail_next(TOPIC, 1)
    m.record_search("t-1", "kettle", {}, 3, False, 12)
    dropped = ctx.redis.get("telemetry:dropped:t-1")
    assert dropped == "1", f"a search event the broker refused left telemetry:dropped:t-1 = {dropped!r}, expected '1': count a failed delivery in the delivery callback"
    m.record_search("t-1", "kettle", {}, 3, False, 12)
    assert ctx.redis.get("telemetry:dropped:t-1") == "1", "a delivered event must not be counted as dropped"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one refused and one delivered event the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 1"
`,
    typescript: `const TOPIC = 'search.event';

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

export async function check_tenant_key(ctx) {
  const m = ctx.load('telemetry');
  await m.recordSearch('t-1', 'kettle', {}, 3, false, 12);
  await m.recordSearch('t-2', 'kettle', {}, 1, false, 9);
  await m.recordSearch('t-1', 'steel kettle', {brand: 'acme'}, 1, false, 11);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three searches produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['t-1', 't-2', 't-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the tenants: keyed by anything else, one tenant's events scatter across partitions\`);
  assert.equal(records[0].partition, records[2].partition, "t-1's events must stay on one partition, in order");
}

export async function check_no_raw_query(ctx) {
  const m = ctx.load('telemetry');
  const {digest} = ctx.load('/support/search/catalog.ts');
  await m.recordSearch('t-1', '  Steel KETTLE ', {brand: 'acme', max_price: '5000'}, 2, true, 41);
  const record = ctx.kafka.records(TOPIC)[0];
  const text = record.value.toString().toLowerCase();
  for (const leaked of ['steel', 'kettle', 'acme', '5000']) {
    assert(!text.includes(leaked), \`the event carries "\${leaked}": \${record.value}. The topic is retained and replicated; carry query_hash and the filter names\`);
  }
  const p = payload(record);
  assert.equal(p.query_hash, digest('steel kettle'), \`query_hash is \${JSON.stringify(p.query_hash)}, expected digest(normalizeQuery(q))\`);
  assert.deepStrictEqual(p.filter_fields, ['brand', 'max_price'], \`filter_fields is \${JSON.stringify(p.filter_fields)}, expected the sorted names\`);
  assert(p.type === 'search.query' && p.tenant === 't-1' && p.result_count === 2 && p.partial === true && p.latency_ms === 41, \`the event is \${JSON.stringify(p)}, expected type, tenant, result_count, partial and latency_ms beside query_hash\`);
}

export async function check_idempotent_producer(ctx) {
  const m = ctx.load('telemetry');
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.recordSearch('t-1', 'kettle', {}, 3, false, 12);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one search whose acknowledgement was lost left \${records.length} records: the producer's retry wrote the event twice. Make the producer idempotent\`);
  await m.recordSearch('t-1', 'kettle', {}, 3, false, 12);
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the event and lost it. Use acks -1 (all)\`);
}

export async function check_dropped_count(ctx) {
  const m = ctx.load('telemetry');
  ctx.kafka.failNext(TOPIC, 1);
  await m.recordSearch('t-1', 'kettle', {}, 3, false, 12);
  const dropped = ctx.redis.get('telemetry:dropped:t-1');
  assert.equal(dropped, '1', \`a search event the broker refused left telemetry:dropped:t-1 = \${JSON.stringify(dropped)}, expected "1": count a rejected send\`);
  await m.recordSearch('t-1', 'kettle', {}, 3, false, 12);
  assert.equal(ctx.redis.get('telemetry:dropped:t-1'), '1', 'a delivered event must not be counted as dropped');
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'after one refused and one delivered event the topic must hold 1 record');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"search/catalog"

	"leetbuild/harness"
)

const telemetryTopic = "search.event"

var telemetryBg = context.Background()

func record(ctx *harness.Ctx, tenant, q string, filters map[string]string) {
	recordSearch(telemetryBg, tenant, q, filters, 3, false, 12)
	ctx.Settle()
}

func CheckTenantKey(ctx *harness.Ctx) {
	record(ctx, "t-1", "kettle", nil)
	record(ctx, "t-2", "kettle", nil)
	record(ctx, "t-1", "steel kettle", map[string]string{"brand": "acme"})
	records := ctx.Kafka.Records(telemetryTopic)
	ctx.Equal(len(records), 3, "three searches must produce three records on %s; the records", telemetryTopic)
	ctx.Equal(ctx.Kafka.Keys(telemetryTopic), []string{"t-1", "t-2", "t-1"}, "the records must be keyed by tenant (keyed by anything else, one tenant's events scatter across partitions)")
	ctx.Equal(records[0].Partition, records[2].Partition, "t-1's events must stay on one partition, in order; the partitions")
}

func CheckNoRawQuery(ctx *harness.Ctx) {
	recordSearch(telemetryBg, "t-1", "  Steel KETTLE ", map[string]string{"brand": "acme", "max_price": "5000"}, 2, true, 41)
	ctx.Settle()
	values := ctx.Kafka.Values(telemetryTopic)
	ctx.Equal(len(values), 1, "one search must produce one record; the records")
	text := strings.ToLower(values[0])
	for _, leaked := range []string{"steel", "kettle", "acme", "5000"} {
		ctx.Assert(!strings.Contains(text, leaked), "the event carries %q: %s. The topic is retained and replicated; carry query_hash and the filter names", leaked, values[0])
	}
	var p map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &p), "the record's value must be JSON: %s", values[0])
	ctx.Equal(p["query_hash"], catalog.Digest("steel kettle"), "query_hash must be catalog.Digest(catalog.NormalizeQuery(q))")
	ctx.Equal(p["filter_fields"], []any{"brand", "max_price"}, "filter_fields must be the sorted names")
	ctx.Assert(p["type"] == "search.query" && p["tenant"] == "t-1" && p["result_count"] == float64(2) && p["partial"] == true && p["latency_ms"] == float64(41), "the event is %s, expected type, tenant, result_count, partial and latency_ms beside query_hash", values[0])
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(telemetryTopic, 1)
	record(ctx, "t-1", "kettle", nil)
	ctx.Equal(len(ctx.Kafka.Records(telemetryTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	record(ctx, "t-1", "kettle", nil)
	ctx.Kafka.Failover(telemetryTopic)
	ctx.Equal(len(ctx.Kafka.Records(telemetryTopic)), 2, "a leader failover must not lose an acknowledged event (acks=all); the records")
}

func CheckDroppedCount(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(telemetryTopic, 1)
	record(ctx, "t-1", "kettle", nil)
	dropped, _ := ctx.Redis.Get("telemetry:dropped:t-1")
	ctx.Equal(dropped, "1", "a search event the broker refused must be counted in telemetry:dropped:t-1 (the delivery report's error)")
	record(ctx, "t-1", "kettle", nil)
	dropped, _ = ctx.Redis.Get("telemetry:dropped:t-1")
	ctx.Equal(dropped, "1", "a delivered event must not be counted as dropped; telemetry:dropped:t-1")
	ctx.Equal(len(ctx.Kafka.Records(telemetryTopic)), 1, "after one refused and one delivered event, the records")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <map>
#include <optional>
#include <string>

#include "search/catalog.h"

namespace {

const std::string kTopic = "search.event";

void record(harness::Ctx& ctx, const std::string& tenant, const std::string& q, const std::map<std::string, std::string>& filters) {
  recordSearch(tenant, q, filters, 3, false, 12);
  ctx.Settle();
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  record(ctx, "t-1", "kettle", {});
  record(ctx, "t-2", "kettle", {});
  record(ctx, "t-1", "steel kettle", {{"brand", "acme"}});
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three searches must produce three records on %s; the records", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"t-1", "t-2", "t-1"}, "the records must be keyed by tenant (keyed by anything else, one tenant's events scatter across partitions)");
  ctx.Equal(records[0].Partition, records[2].Partition, "t-1's events must stay on one partition, in order; the partitions");
}

void CheckNoRawQuery(harness::Ctx& ctx) {
  recordSearch("t-1", "  Steel KETTLE ", {{"brand", "acme"}, {"max_price", "5000"}}, 2, true, 41);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kTopic);
  ctx.Equal(values.size(), 1, "one search must produce one record; the records");
  std::string text = values[0];
  std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  for (const std::string leaked : {"steel", "kettle", "acme", "5000"}) {
    ctx.Assert(text.find(leaked) == std::string::npos, "the event carries %q: %s. The topic is retained and replicated; carry query_hash and the filter names", leaked, values[0]);
  }
  const auto p = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(p.is_object(), "the record's value must be JSON: %s", values[0]);
  ctx.Equal(p.value("query_hash", ""), catalog::digest("steel kettle"), "query_hash must be catalog::digest(catalog::normalizeQuery(q))");
  ctx.Equal(p.value("filter_fields", std::vector<std::string>{}), {"brand", "max_price"}, "filter_fields must be the sorted names");
  ctx.Assert(p.value("type", "") == "search.query" && p.value("tenant", "") == "t-1" && p.value("result_count", 0) == 2 && p.value("partial", false) && p.value("latency_ms", 0) == 41,
             "the event is %s, expected type, tenant, result_count, partial and latency_ms beside query_hash", values[0]);
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);
  record(ctx, "t-1", "kettle", {});
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  record(ctx, "t-1", "kettle", {});
  ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "a leader failover must not lose an acknowledged event (acks=all); the records");
}

void CheckDroppedCount(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  record(ctx, "t-1", "kettle", {});
  ctx.Equal(ctx.Redis.Get("telemetry:dropped:t-1"), std::optional<std::string>("1"), "a search event the broker refused must be counted in telemetry:dropped:t-1 (dr_cb)");
  record(ctx, "t-1", "kettle", {});
  ctx.Equal(ctx.Redis.Get("telemetry:dropped:t-1"), std::optional<std::string>("1"), "a delivered event must not be counted as dropped; telemetry:dropped:t-1");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after one refused and one delivered event, the records");
}
`,
  },
  hints: [
    'Search as one tenant twice and watch the partitions: the two events sit apart, keyed by what the shopper typed, and the payload repeats the query and the filter values. Make the broker refuse one event: nothing counts it.',
    'The key and the payload are built from `q` and `filters` as they arrived. The producer uses `acks=1` without idempotence, and the delivery callback only logs its error.',
    'Key by `tenant`; send `query_hash = digest(normalize_query(q))` and `filter_fields = sorted(filters)` instead of `q` and `filters`; set `enable.idempotence` with `acks=all`; `INCR telemetry:dropped:{tenant}` in the delivery callback on an error.',
  ],
  debrief: `Telemetry is a second copy of every search, kept longer and read by more people than the search itself, so it carries what analytics needs and nothing a shopper typed: a digest groups identical queries, the filter names show how people narrow results, and the counts carry the rest. The tenant key gives each tenant one ordered stream, which is what a per-tenant counter consumes. Telemetry may drop an event; it may not drop one silently, which is why the delivery report feeds a counter. In production the produce is handed to a background queue so a slow broker cannot slow a search, and query digests are salted per tenant so a common query cannot be recovered by hashing a dictionary.`,
};
