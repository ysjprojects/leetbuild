import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'suggest.event: keyed by tenant, a prefix hash, an outbox on failed delivery',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'outbox', 'consumer'],
  task: `## Task

**Starting point.** The starter is \`publish_event(tenant, kind, prefix, position, latency_ms)\`, called
for every impression and selection in the dropdown: it produces \`{"type", "tenant", "prefix",
"position", "latency_ms"}\` to \`suggest.event\` keyed by the prefix, from a producer with \`acks=1\`,
and writes an outbox row (\`outbox.insert\`) when \`produce\` raises. It serves the demo and hides four
flaws.

**Failure mode the checks target.** One tenant's events scatter across partitions; a name typed into
the box lands in a retained, replicated topic; a lost acknowledgement writes an event twice and a
leader failover loses one; and a delivery that fails after \`produce\` returned is gone, because the
\`except\` only sees local enqueue errors.

- Key every record by the **tenant**.
- Carry \`"prefix_hash": prefix_hash(tenant, prefix)\` (\`suggest.privacy\`), not the prefix.
- Make the producer idempotent with \`acks=all\` (the Go starter uses confluent-kafka-go for this:
  kafka-go has no idempotent producer).
- Wait at most \`ACK_TIMEOUT_S\` = 2 s for the delivery report; on an error or no report,
  \`outbox.insert(TOPIC, tenant, payload)\` and return \`False\`.`,
  sequence: {
    participants: ['suggestd', 'suggest.event', 'Outbox', 'Trend counter'],
    messages: [
      {
        from: 'suggestd',
        to: 'suggest.event',
        label: 'produce key = tenant · prefix_hash · acks=all · idempotent',
        kind: 'sync',
      },
      {from: 'suggest.event', to: 'suggestd', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'suggest.event', to: 'suggestd', label: 'delivery failed / no report', kind: 'reply'},
      {from: 'suggestd', to: 'Outbox', label: 'insert(topic, tenant, payload) → False', kind: 'async'},
      {from: 'suggest.event', to: 'Trend counter', label: 'consume · one partition per tenant', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keys suggest.event by tenant',
      detail:
        "The record key is the tenant (`key=tenant`, `key: tenant`, `[]byte(tenant)`, `ProducerRecord(Topic, tenant, …)`), so one tenant's impressions and selections share a partition and stay in order; keyed by prefix they scatter.",
      match: {
        python: {all: [/key\s*=\s*tenant\b/], none: [/key\s*=\s*prefix\b/]},
        typescript: {all: [/key:\s*tenant\b/], none: [/key:\s*prefix\b/]},
        go: {all: [/Key:\s*\[\]byte\(tenant\)/], none: [/Key:\s*\[\]byte\(prefix\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*tenant\b/], none: [/\(Topic,\s*prefix\b/]},
        cpp: {all: [/tenant\.c_str\(\),\s*tenant\.(size|length)\(\)/], none: [/prefix\.c_str\(\)/]},
      },
    },
    {
      id: 'prefix-hash',
      title: 'Carries a prefix hash, not the prefix',
      detail:
        "The payload carries `prefix_hash` from `prefix_hash(tenant, prefix)` and no `prefix`: a prefix can be a person's name, and the topic is retained and replicated.",
      match: {
        python: {all: [/prefix_hash\(\s*tenant/, /["']prefix_hash["']/], none: [/["']prefix["']\s*:\s*prefix\b/]},
        typescript: {all: [/prefixHash\(\s*tenant/, /prefix_hash/], none: [/\bprefix:\s*prefix\b|\{[^}\n]*\bprefix,/]},
        go: {all: [/privacy\.PrefixHash\(\s*tenant/, /"prefix_hash"/], none: [/"prefix":\s*prefix\b/]},
        scala: {all: [/Privacy\.prefixHash\(\s*tenant/, /"prefix_hash"/], none: [/"prefix"\s*->/]},
        cpp: {all: [/privacy::prefixHash\(\s*tenant/, /"prefix_hash"/], none: [/\{"prefix",\s*prefix\}/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover: `enable.idempotence` with `acks=all` (kafkajs `idempotent: true` with `acks: -1`).',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'The delivery report decides (`on_delivery` and a bounded `flush`, an awaited `send`, the delivery channel, `dr_cb`, the send future): a failed delivery or no report within 2 s leaves an outbox row and returns false. Catching an exception around `produce` sees only local enqueue errors.',
      match: {
        python: {
          all: [/outbox\.insert\(/, /\.flush\(/, /on_delivery\s*=|callback\s*=/],
          none: [/except KafkaException/],
        },
        typescript: {all: [/insert\(/, /await producer\.send\(/], none: [/void producer\.send\(/]},
        go: {all: [/outbox\.Insert\(/, /TopicPartition\.Error/], none: [/Produce\([^\n]*,\s*nil\)/]},
        scala: {
          all: [/Outbox\.insert\(/, /\.get\(\s*[^\n]*TimeUnit|onCompletion/],
          none: [/case\s+\w+:\s*KafkaException/],
        },
        cpp: {all: [/outbox::insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from suggest import outbox  # insert
from suggest.privacy import prefix_hash

TOPIC = "suggest.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_event(tenant: str, kind: str, prefix: str, position: int, latency_ms: int) -> bool:
    """One impression or selection on suggest.event; True when the event is on its way."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = {"type": kind, "tenant": tenant, "prefix": prefix, "position": position, "latency_ms": latency_ms}
    try:
        producer.produce(TOPIC, key=prefix, value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        outbox.insert(TOPIC, prefix, payload)
        return False
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from suggest import outbox  # insert
from suggest.privacy import prefix_hash

TOPIC = "suggest.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def publish_event(tenant: str, kind: str, prefix: str, position: int, latency_ms: int) -> bool:
    """One impression or selection on suggest.event; True once the broker acknowledged it."""
    # The hash joins equal prefixes of one tenant; the text stays in the service.
    payload = {"type": kind, "tenant": tenant, "prefix_hash": prefix_hash(tenant, prefix), "position": position, "latency_ms": latency_ms}
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=tenant, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the count is late, not wrong.
        outbox.insert(TOPIC, tenant, payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {insert} from 'suggest/outbox';
import {prefixHash} from 'suggest/privacy';

export const TOPIC = 'suggest.event';

const kafka = new Kafka({clientId: 'suggestd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One impression or selection on suggest.event; true when the event is on its way. */
export async function publishEvent(tenant: string, kind: string, prefix: string, position: number, latencyMs: number): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = {type: kind, tenant, prefix, position, latency_ms: latencyMs};
  try {
    void producer.send({topic: TOPIC, messages: [{key: prefix, value: JSON.stringify(payload)}], acks: 1});
  } catch {
    await insert(TOPIC, prefix, payload);
    return false;
  }
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {insert} from 'suggest/outbox';
import {prefixHash} from 'suggest/privacy';

export const TOPIC = 'suggest.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'suggestd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One impression or selection on suggest.event; true once the broker acknowledged it. */
export async function publishEvent(tenant: string, kind: string, prefix: string, position: number, latencyMs: number): Promise<boolean> {
  // The hash joins equal prefixes of one tenant; the text stays in the service.
  const payload = {type: kind, tenant, prefix_hash: prefixHash(tenant, prefix), position, latency_ms: latencyMs};
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: tenant, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the count is late, not wrong.
    await insert(TOPIC, tenant, payload);
    return false;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"suggest/outbox" // outbox.Insert
)

const topic = "suggest.event"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// publishEvent produces one impression or selection on suggest.event; true when the event is on its way.
func publishEvent(ctx context.Context, tenant, kind, prefix string, position, latencyMs int) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload := map[string]any{"type": kind, "tenant": tenant, "prefix": prefix, "position": position, "latency_ms": latencyMs}
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(prefix), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, outbox.Insert(ctx, topic, prefix, payload)
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"suggest/outbox"  // outbox.Insert
	"suggest/privacy" // privacy.PrefixHash
)

const (
	topic      = "suggest.event"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// publishEvent produces one impression or selection on suggest.event; true once the broker acknowledged it.
func publishEvent(ctx context.Context, tenant, kind, prefix string, position, latencyMs int) (bool, error) {
	// The hash joins equal prefixes of one tenant; the text stays in the service.
	payload := map[string]any{"type": kind, "tenant": tenant, "prefix_hash": privacy.PrefixHash(tenant, prefix), "position": position, "latency_ms": latencyMs}
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(tenant), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the count is late, not wrong.
		return false, outbox.Insert(ctx, topic, tenant, payload)
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import suggest.{Outbox, Privacy} // Outbox.insert, Privacy.prefixHash

object Events {
  val Topic = "suggest.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** One impression or selection on suggest.event; true when the event is on its way. */
  def publishEvent(tenant: String, kind: String, prefix: String, position: Int, latencyMs: Int): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = JsObject(
      "type" -> JsString(kind),
      "tenant" -> JsString(tenant),
      "prefix" -> JsString(prefix),
      "position" -> JsNumber(position),
      "latency_ms" -> JsNumber(latencyMs)
    )
    try {
      producer.send(new ProducerRecord[String, String](Topic, prefix, payload.compactPrint))
      true
    } catch {
      case _: KafkaException =>
        Outbox.insert(Topic, prefix, payload)
        false
    }
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import suggest.{Outbox, Privacy} // Outbox.insert, Privacy.prefixHash

object Events {
  val Topic = "suggest.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** One impression or selection on suggest.event; true once the broker acknowledged it. */
  def publishEvent(tenant: String, kind: String, prefix: String, position: Int, latencyMs: Int): Boolean = {
    // The hash joins equal prefixes of one tenant; the text stays in the service.
    val payload = JsObject(
      "type" -> JsString(kind),
      "tenant" -> JsString(tenant),
      "prefix_hash" -> JsString(Privacy.prefixHash(tenant, prefix)),
      "position" -> JsNumber(position),
      "latency_ms" -> JsNumber(latencyMs)
    )
    val record = new ProducerRecord[String, String](Topic, tenant, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the count is late, not wrong.
      Outbox.insert(Topic, tenant, payload)
    }
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "suggest/outbox.h"   // outbox::insert
#include "suggest/privacy.h"  // privacy::prefixHash

using json = nlohmann::json;

const std::string kTopic = "suggest.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// One impression or selection on suggest.event; true when the event is on its way.
bool publishEvent(const std::string& tenant, const std::string& kind, const std::string& prefix, int position, int latency_ms) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json payload = {{"type", kind}, {"tenant", tenant}, {"prefix", prefix}, {"position", position}, {"latency_ms", latency_ms}};
  const std::string value = payload.dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), prefix.c_str(), prefix.size(), 0, nullptr);
  producer->poll(0);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox::insert(kTopic, prefix, payload);
    return false;
  }
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "suggest/outbox.h"   // outbox::insert
#include "suggest/privacy.h"  // privacy::prefixHash

using json = nlohmann::json;

const std::string kTopic = "suggest.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishEvent produces one record and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// One impression or selection on suggest.event; true once the broker acknowledged it.
bool publishEvent(const std::string& tenant, const std::string& kind, const std::string& prefix, int position, int latency_ms) {
  // The hash joins equal prefixes of one tenant; the text stays in the service.
  const json payload = {{"type", kind}, {"tenant", tenant}, {"prefix_hash", privacy::prefixHash(tenant, prefix)}, {"position", position}, {"latency_ms", latency_ms}};
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), tenant.c_str(), tenant.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the count is late, not wrong.
    outbox::insert(kTopic, tenant, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from suggest.privacy import prefix_hash

TOPIC = "suggest.event"


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("suggest:outbox", 0, -1)]


def check_tenant_key(ctx):
    m = ctx.load("events")
    m.publish_event("acme", "impression", "ke", 0, 12)
    m.publish_event("acme", "selection", "kettle", 2, 340)
    m.publish_event("globex", "impression", "ke", 0, 9)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_event calls produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"acme", b"acme", b"globex"], f"the records are keyed {keys}, expected the tenants acme, acme, globex"
    assert records[0].partition == records[1].partition, "acme's two events landed on two partitions: one tenant's impressions and selections must stay in order"


def check_prefix_hash(ctx):
    m = ctx.load("events")
    m.publish_event("acme", "selection", "jane do", 1, 80)
    m.publish_event("globex", "selection", "jane do", 1, 75)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 2, f"two publish_event calls produced {len(records)} records"
    text = records[0].value.decode()
    assert "jane do" not in text, f"the event carries the prefix text: {text}. A prefix can be a person's name; carry prefix_hash(tenant, prefix)"
    value = json.loads(text)
    assert value.get("prefix_hash") == prefix_hash("acme", "jane do"), f"prefix_hash is {value.get('prefix_hash')!r}, expected prefix_hash('acme', 'jane do')"
    assert value.get("type") == "selection" and value.get("tenant") == "acme" and value.get("position") == 1 and value.get("latency_ms") == 80, f"the payload is {value}, expected type, tenant, position and latency_ms"
    other = json.loads(records[1].value)
    assert other.get("prefix_hash") == prefix_hash("globex", "jane do"), f"globex's event carries prefix_hash {other.get('prefix_hash')!r}"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_event("acme", "impression", "ke", 0, 12)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_event("acme", "selection", "kettle", 2, 340)
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the event the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_event("acme", "selection", "kettle", 2, 340)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: the event is lost from every trend count"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "acme" and row.get("payload", {}).get("prefix_hash") == prefix_hash("acme", "kettle"), f"the outbox row is {row}, expected the topic, the key acme and the payload"
    assert ok is False, f"publish_event returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_event("acme", "impression", "ke", 0, 12)
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_event waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("prefix_hash") == prefix_hash("acme", "ke"), f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_event returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'suggest.event';

const outboxRows = ctx => (ctx.redis.lrange('suggest:outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_tenant_key(ctx) {
  const m = ctx.load('events');
  await m.publishEvent('acme', 'impression', 'ke', 0, 12);
  await m.publishEvent('acme', 'selection', 'kettle', 2, 340);
  await m.publishEvent('globex', 'impression', 'ke', 0, 9);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishEvent calls produced \${records.length} records on \${TOPIC}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['acme', 'acme', 'globex'], \`the records are keyed \${JSON.stringify(keys)}, expected the tenants acme, acme, globex\`);
  assert.equal(records[0].partition, records[1].partition, "acme's two events landed on two partitions: one tenant's impressions and selections must stay in order");
}

export async function check_prefix_hash(ctx) {
  const m = ctx.load('events');
  const {prefixHash} = ctx.load('/support/suggest/privacy.ts');
  await m.publishEvent('acme', 'selection', 'jane do', 1, 80);
  await m.publishEvent('globex', 'selection', 'jane do', 1, 75);
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 2, \`two publishEvent calls produced \${values.length} records\`);
  assert(!values[0].includes('jane do'), \`the event carries the prefix text: \${values[0]}. A prefix can be a person's name; carry prefix_hash(tenant, prefix)\`);
  const value = JSON.parse(values[0]);
  assert.equal(value.prefix_hash, prefixHash('acme', 'jane do'), \`prefix_hash is \${JSON.stringify(value.prefix_hash)}, expected prefixHash('acme', 'jane do')\`);
  assert(value.type === 'selection' && value.tenant === 'acme' && value.position === 1 && value.latency_ms === 80, \`the payload is \${values[0]}, expected type, tenant, position and latency_ms\`);
  assert.equal(JSON.parse(values[1]).prefix_hash, prefixHash('globex', 'jane do'), "globex's event must carry its own prefix_hash");
}

export async function check_idempotent_producer(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishEvent('acme', 'impression', 'ke', 0, 12);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Make the producer idempotent\`);
  await m.publishEvent('acme', 'selection', 'kettle', 2, 340);
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the event the leader alone had acknowledged: acks -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  const {prefixHash} = ctx.load('/support/suggest/privacy.ts');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishEvent('acme', 'selection', 'kettle', 2, 340);
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: the event is lost from every trend count\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'acme' && rows[0].payload?.prefix_hash === prefixHash('acme', 'kettle'), \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key acme and the payload\`);
  assert.equal(ok, false, \`publishEvent resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishEvent('acme', 'impression', 'ke', 0, 12);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishEvent waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.prefix_hash === prefixHash('acme', 'ke'), \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishEvent resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"suggest/outbox"
	"suggest/privacy"

	"leetbuild/harness"
)

const evTopic = "suggest.event"

var evBg = context.Background()

func evPublish(ctx *harness.Ctx, tenant, kind, prefix string, position, latencyMs int) bool {
	ok, err := publishEvent(evBg, tenant, kind, prefix, position, latencyMs)
	ctx.NoError(err, "publishEvent(%s, %s, %q)", tenant, kind, prefix)
	return ok
}

func CheckTenantKey(ctx *harness.Ctx) {
	evPublish(ctx, "acme", "impression", "ke", 0, 12)
	evPublish(ctx, "acme", "selection", "kettle", 2, 340)
	evPublish(ctx, "globex", "impression", "ke", 0, 9)
	ctx.Settle()
	records := ctx.Kafka.Records(evTopic)
	ctx.Equal(len(records), 3, "three publishEvent calls must produce three records on suggest.event; the records")
	ctx.Equal(ctx.Kafka.Keys(evTopic), []string{"acme", "acme", "globex"}, "the records must be keyed by the tenants")
	ctx.Equal(records[0].Partition, records[1].Partition, "acme's two events must share a partition, or one tenant's impressions and selections arrive out of order; the partitions")
}

func CheckPrefixHash(ctx *harness.Ctx) {
	evPublish(ctx, "acme", "selection", "jane do", 1, 80)
	evPublish(ctx, "globex", "selection", "jane do", 1, 75)
	ctx.Settle()
	values := ctx.Kafka.Values(evTopic)
	ctx.Equal(len(values), 2, "two publishEvent calls must produce two records; the records")
	ctx.Assert(!strings.Contains(values[0], "jane do"), "the event carries the prefix text: %s. A prefix can be a person's name; carry prefix_hash(tenant, prefix)", values[0])
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	ctx.Equal(value["prefix_hash"], privacy.PrefixHash("acme", "jane do"), "the payload's prefix_hash")
	ctx.Assert(value["type"] == "selection" && value["tenant"] == "acme" && value["position"] == 1.0 && value["latency_ms"] == 80.0, "the payload is %s, expected type, tenant, position and latency_ms", values[0])
	var other map[string]any
	json.Unmarshal([]byte(values[1]), &other)
	ctx.Equal(other["prefix_hash"], privacy.PrefixHash("globex", "jane do"), "globex's event's prefix_hash")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(evTopic, 1) // the broker wrote it, the acknowledgement never arrived
	evPublish(ctx, "acme", "impression", "ke", 0, 12)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(evTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	evPublish(ctx, "acme", "selection", "kettle", 2, 340)
	ctx.Settle()
	ctx.Kafka.Failover(evTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(evTopic)), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(evTopic, 1)
	ok := evPublish(ctx, "acme", "selection", "kettle", 2, 340)
	ctx.Settle()
	rows := outbox.Rows(evBg)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the event is lost from every trend count; the rows")
	ctx.Assert(rows[0].Topic == evTopic && rows[0].Key == "acme" && rows[0].Payload["prefix_hash"] == privacy.PrefixHash("acme", "kettle"), "the outbox row is %+v, expected the topic, the key acme and the payload", rows[0])
	ctx.Equal(ok, false, "publishEvent's result after a failed delivery")
	ctx.Kafka.Stall(evTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = evPublish(ctx, "acme", "impression", "ke", 0, 12)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishEvent waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = outbox.Rows(evBg)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["prefix_hash"] == privacy.PrefixHash("acme", "ke"), "no delivery report within the window and the outbox holds %+v", rows)
	ctx.Equal(ok, false, "publishEvent's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "suggest/outbox.h"
#include "suggest/privacy.h"

namespace {

const std::string kEvTopic = "suggest.event";

std::string evField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  publishEvent("acme", "impression", "ke", 0, 12);
  publishEvent("acme", "selection", "kettle", 2, 340);
  publishEvent("globex", "impression", "ke", 0, 9);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEvTopic);
  ctx.Equal(records.size(), 3, "three publishEvent calls must produce three records on suggest.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEvTopic), {"acme", "acme", "globex"}, "the records must be keyed by the tenants");
  ctx.Equal(records[0].Partition, records[1].Partition,
            "acme's two events must share a partition, or one tenant's impressions and selections arrive out of order; the partitions");
}

void CheckPrefixHash(harness::Ctx& ctx) {
  publishEvent("acme", "selection", "jane do", 1, 80);
  publishEvent("globex", "selection", "jane do", 1, 75);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEvTopic);
  ctx.Equal(values.size(), 2, "two publishEvent calls must produce two records; the records");
  ctx.Assert(values[0].find("jane do") == std::string::npos,
             "the event carries the prefix text: %s. A prefix can be a person's name; carry prefix_hash(tenant, prefix)", values[0]);
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Equal(evField(value, "prefix_hash"), privacy::prefixHash("acme", "jane do"), "the payload's prefix_hash");
  ctx.Assert(evField(value, "type") == "selection" && evField(value, "tenant") == "acme" && value.value("position", -1) == 1 &&
                 value.value("latency_ms", -1) == 80,
             "the payload is %s, expected type, tenant, position and latency_ms", values[0]);
  ctx.Equal(evField(nlohmann::json::parse(values[1], nullptr, false), "prefix_hash"), privacy::prefixHash("globex", "jane do"),
            "globex's event's prefix_hash");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEvTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishEvent("acme", "impression", "ke", 0, 12);
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEvTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishEvent("acme", "selection", "kettle", 2, 340);
  ctx.Settle();
  ctx.Kafka.Failover(kEvTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEvTopic).size(), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEvTopic, 1);
  bool ok = publishEvent("acme", "selection", "kettle", 2, 340);
  ctx.Settle();
  auto rows = outbox::rows();
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the event is lost from every trend count; the rows");
  ctx.Assert(evField(rows[0], "topic") == kEvTopic && evField(rows[0], "key") == "acme" && rows[0].contains("payload") &&
                 evField(rows[0]["payload"], "prefix_hash") == privacy::prefixHash("acme", "kettle"),
             "the outbox row is %s, expected the topic, the key acme and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishEvent's result after a failed delivery");
  ctx.Kafka.Stall(kEvTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishEvent("acme", "impression", "ke", 0, 12);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishEvent waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = outbox::rows();
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && evField(rows[1]["payload"], "prefix_hash") == privacy::prefixHash("acme", "ke"),
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishEvent's result without a delivery report");
}
`,
  },
  hints: [
    "Watch the topic while two people search: one tenant's events sit on several partitions, the payload shows what each person typed, and a broker hiccup leaves no trace of the lost event anywhere.",
    'The key decides the partition, and the key is the prefix. The payload copies the prefix. `acks=1` without idempotence duplicates on a retry and loses on a failover, and `except` around `produce` never sees the delivery report.',
    'Key by `tenant`; send `prefix_hash(tenant, prefix)`; set `enable.idempotence` and `acks=all`; produce with `on_delivery`, `flush(ACK_TIMEOUT_S)`, and on an error or anything still in flight `outbox.insert(TOPIC, tenant, payload)` and return `False`.',
  ],
  debrief: `The key is an ordering contract: the trend counter reads one tenant's impressions and selections in the order they happened only if they share a partition. Hashing the prefix with a keyed HMAC keeps the event joinable (one tenant's equal prefixes hash alike) without putting a typed name into a topic every consumer, replica and backup retains. Waiting for the delivery report is what gives the return value a meaning, and the outbox turns a broker outage into a delay rather than a loss; idempotence closes the one gap waiting opens, a retry after a lost acknowledgement. Production pipelines rotate the hashing key on a schedule, drop events under a minimum count before they leave the region, and let a relay do every produce from the outbox.`,
};
